import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_ANCHOR_TEXT_MAX, CONVERSATION_CHECKPOINT_TEXT_MAX,
  CONVERSATION_COMPACT_KEEP_TURNS, CONVERSATION_THREAD_ROW_CAP, CONVERSATION_TURN_TEXT_MAX,
  DuckyError, cleanUntrusted,
  type ConversationRole,
} from '@ducky/contracts';
import type { ConversationHistoryTurn } from '@ducky/adapters';
import { withTransaction, type ParticipationProof, type Store } from '@ducky/persistence';
import type { ActorContext } from '../security/authz.js';

export interface ConversationMemoryConfig {
  /** OFF unless an operator says otherwise. See ADR 0021. */
  readonly enabled: boolean;
  /** How many earlier turns are replayed. Bounded well below the row cap. */
  readonly turns: number;
  /**
   * Channel ids that never take part in memory, whatever else is configured.
   *
   * The configured SHARED channels: a channel other people can read must never
   * become a store of the owner's conversation, nor a source of context
   * replayed back into a prompt.
   *
   * Matched against the message's CHANNEL context now, not against its thread
   * key. The two are the same string, so the old comparison got the right
   * answer -- but it got it for the wrong reason, and it could not tell a guild
   * channel from a DM that happened to share an id. `applies` still accepts a
   * bare thread key so a context-less event keeps failing closed.
   */
  readonly excludedThreadKeys: readonly string[];
  /**
   * How many BYTES of context one turn may carry to the provider.
   *
   * Bytes rather than tokens, because bytes are what this host can actually
   * measure: no provider here reports a token limit, and converting characters
   * to tokens would be a number nobody observed. A turn whose context cannot
   * be brought under this is REFUSED, never silently trimmed.
   */
  readonly contextBudgetBytes: number;
}

export interface ConversationForgetResult {
  readonly turnsDeleted: number;
  readonly enabled: boolean;
  /**
   * How many provider sessions were ROTATED. Rotation is not deletion: see
   * `ProviderDeletionOutcome`.
   */
  readonly providerSessionsRotated: number;
}

/** One turn's worth of prompt context, with its provenance kept separate. */
export interface ConversationContext {
  /**
   * The compact checkpoint, when one exists. Rendered to the provider as a
   * clearly labelled summary rather than as something somebody said.
   */
  readonly checkpoint?: string;
  /** Recent turns, oldest first. */
  readonly turns: readonly ConversationHistoryTurn[];
  /** True when a compaction ran to make this turn fit. */
  readonly compacted: boolean;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly turnsCovered: number;
  readonly turnsKept: number;
  /** Always zero. Compaction never deletes a stored turn; this asserts it. */
  readonly turnsDeleted: 0;
  readonly message: string;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Bounded per-user continuity, and durable per-thread conversation.
 *
 * Two shapes live here, and the difference is which conversation an operator
 * opted into:
 *
 * - **An ordinary channel or DM** behaves exactly as ADR 0021 shipped it:
 *   isolated by (user, thread), capped at `CONVERSATION_THREAD_ROW_CAP` rows,
 *   replayed only to the person who said it.
 * - **A native conversation thread** (issue #4) keeps its FULL transcript while
 *   the thread lives, is shared among the people who have actually spoken in
 *   it, and is replayed through a bounded checkpoint plus recent turns rather
 *   than through the raw tail.
 *
 * The properties that made storing anybody's words defensible are unchanged,
 * and two are now structural in a stronger way than before:
 *
 * - **Off unless enabled.** `enabled: false` reads nothing and writes nothing.
 *   Deletion still works, because an earlier run may have stored rows.
 * - **Never a shared channel**, now including a thread UNDER one.
 * - **A thread read requires a participation PROOF.** ADR 0021 §2 said no
 *   method may read a thread without a user id; that rule cannot express a
 *   shared conversation, so it is superseded by a stronger one: the only way
 *   to read a thread is to hold a proof, and the only way to get a proof is for
 *   a participation row to exist. Seeing a thread is not being in it.
 */
export class ConversationMemoryService {
  private readonly store: Store;
  private readonly config: ConversationMemoryConfig;
  private readonly excluded: ReadonlySet<string>;

  constructor(deps: { store: Store; config: ConversationMemoryConfig }) {
    this.store = deps.store;
    this.config = deps.config;
    this.excluded = new Set(deps.config.excludedThreadKeys);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get contextBudgetBytes(): number {
    return this.config.contextBudgetBytes;
  }

  /**
   * Whether this thread takes part in memory at all.
   *
   * `context` is optional and its absence is not a free pass: the thread key is
   * still checked against the excluded set, so an event that arrives without
   * context is treated exactly as it was before -- excluded if its key matches
   * a shared channel. Supplying context only ever ADDS a reason to exclude, and
   * a thread's PARENT is one of those reasons: a thread under a channel other
   * people can read is no more private than the channel is.
   */
  applies(
    threadKey: string,
    context?: { channelId?: string | undefined; parentChannelId?: string | undefined },
  ): boolean {
    if (!this.config.enabled) return false;
    if (this.excluded.has(threadKey)) return false;
    const channelId = context?.channelId;
    if (channelId !== undefined && this.excluded.has(channelId)) return false;
    const parentId = context?.parentChannelId;
    return !(parentId !== undefined && this.excluded.has(parentId));
  }

  /** Whether this thread key is a native conversation thread Ducky recorded. */
  isNativeThread(threadKey: string): boolean {
    return this.store.conversationThreads.byThreadId(threadKey) !== undefined;
  }

  /**
   * The proof that lets this actor read this thread, or undefined.
   *
   * Public so the router can re-check participation on a control press without
   * reimplementing the rule.
   */
  participation(actor: ActorContext, threadKey: string): ParticipationProof | undefined {
    return this.store.conversationThreads.proveParticipation(threadKey, actor.discordUserId);
  }

  /**
   * The earlier turns of one thread, oldest first.
   *
   * Kept for the ordinary channel and DM path, and for every caller that only
   * wants the legacy per-user tail. A native thread goes through `contextFor`,
   * which is the one that honours the checkpoint and the byte budget.
   */
  history(
    actor: ActorContext,
    threadKey: string,
    context?: { channelId?: string | undefined; parentChannelId?: string | undefined },
  ): readonly ConversationHistoryTurn[] {
    if (!this.applies(threadKey, context)) return [];
    return this.store.conversations
      .recent(actor.discordUserId, threadKey, this.config.turns)
      .map((r) => ({ role: r.role, text: r.content }));
  }

  /**
   * Everything this turn should carry to the provider, inside the byte budget.
   *
   * The order is the design:
   *
   * 1. Not a thread, or memory does not apply: the legacy tail, unchanged.
   * 2. A native thread: the checkpoint plus every turn after it, newest-first,
   *    until the budget is spent.
   * 3. If the whole thing does not fit, COMPACT and try once more. Manual
   *    Compact and this automatic one are the same method, so the two cannot
   *    behave differently.
   * 4. If it still does not fit, REFUSE the turn. A model answering from half a
   *    conversation it was not told it was missing is worse than a clear
   *    refusal, and silently dropping the checkpoint would throw away exactly
   *    the durable part.
   */
  contextFor(
    actor: ActorContext,
    threadKey: string,
    newText: string,
    context?: { channelId?: string | undefined; parentChannelId?: string | undefined },
  ): ConversationContext {
    if (!this.applies(threadKey, context)) return { turns: [], compacted: false };
    if (!this.isNativeThread(threadKey)) {
      return { turns: this.history(actor, threadKey, context), compacted: false };
    }

    const proof = this.participation(actor, threadKey);
    // No participation row yet: this is their first turn in the thread, so
    // there is nothing of theirs to replay and nothing they may read.
    if (!proof) return { turns: [], compacted: false };

    const budget = this.config.contextBudgetBytes - bytes(newText);
    let compacted = false;

    /**
     * Try as-is, then compact progressively harder.
     *
     * `undefined` means *do not compact, just try*. Each later pass folds more
     * of the conversation into the checkpoint and keeps fewer turns verbatim,
     * so nothing is ever dropped silently: what leaves the verbatim window
     * arrives in the summary instead. The last pass keeps nothing verbatim,
     * which is the most a checkpoint can carry.
     */
    for (const keep of [undefined, CONVERSATION_COMPACT_KEEP_TURNS, 5, 2, 0] as const) {
      if (keep !== undefined) {
        compacted = this.compactWith(proof, keep).compacted || compacted;
      }
      const assembled = this.assemble(proof, budget);
      if (assembled) return { ...assembled, compacted };
    }

    throw new DuckyError(
      'invalid_input',
      'That message is too large to send with this conversation. ' +
        'Even after compacting, the context would exceed the configured budget, so nothing was ' +
        'sent to the model and nothing was stored. Shorten it, or branch into a new thread.',
    );
  }

  /**
   * How much of the budget a checkpoint may ever take.
   *
   * Half, at most, and never more than the absolute cap. A checkpoint that
   * could fill the whole budget would leave no room for the turns it exists to
   * sit beside, and the result would be a context of pure summary -- which is
   * a conversation nobody is having.
   */
  private get checkpointBudget(): number {
    return Math.min(CONVERSATION_CHECKPOINT_TEXT_MAX, Math.floor(this.config.contextBudgetBytes / 2));
  }

  /**
   * The checkpoint plus EVERY turn after it, or undefined if that does not fit.
   *
   * All-or-nothing on purpose. A version that filled the budget newest-first
   * and stopped would work, and would be wrong: the turns it dropped would
   * leave no trace anywhere, so the model would answer from a conversation it
   * was never told was incomplete. Failing instead sends the caller to
   * compaction, which moves those turns into the checkpoint rather than
   * discarding them.
   *
   * The checkpoint itself is non-negotiable: it IS the compacted form of
   * everything older, so a context without it is a context that forgot the
   * beginning.
   */
  private assemble(
    proof: ParticipationProof,
    budget: number,
  ): { checkpoint?: string; turns: ConversationHistoryTurn[] } | undefined {
    const checkpoint = this.store.conversationThreads.checkpointFor(proof.threadId);
    let remaining = budget - (checkpoint ? bytes(checkpoint.summary) : 0);
    if (remaining < 0) return undefined;

    const rows = this.store.conversations.threadTurns(proof, {
      ...(checkpoint ? { sinceRowid: checkpoint.throughRowid } : {}),
    });

    const picked: ConversationHistoryTurn[] = [];
    for (const row of rows) {
      const cost = bytes(row.content) + row.role.length + 2;
      if (cost > remaining) return undefined;
      remaining -= cost;
      picked.push({ role: row.role, text: row.content });
    }
    return checkpoint ? { checkpoint: checkpoint.summary, turns: picked } : { turns: picked };
  }

  /**
   * Records one exchange: what was said, and what Ducky answered.
   *
   * Both in ONE transaction, because half an exchange is worse than none -- a
   * stored question with no answer would be replayed as if Ducky had ignored
   * it. Recording never throws: losing continuity is not a reason to fail a
   * reply the owner has already been given.
   *
   * In a native thread the same transaction also records PARTICIPATION, which
   * is what makes a later read possible at all, and notes that a provider
   * session now exists for this (thread, actor) pair -- so a deletion can
   * address it later without having to guess who was in the room.
   */
  record(
    actor: ActorContext,
    threadKey: string,
    exchange: {
      readonly userText: string;
      readonly assistantText: string;
      /** The Discord message the user's half came from, when there was one. */
      readonly userMessageId?: string | undefined;
    },
    context?: { channelId?: string | undefined; parentChannelId?: string | undefined },
  ): void {
    if (!this.applies(threadKey, context)) return;
    const user = clamp(exchange.userText);
    const assistant = clamp(exchange.assistantText);
    if (user === '' && assistant === '') return;

    const native = this.isNativeThread(threadKey);
    // A native thread keeps its full transcript while it lives (issue #4),
    // which is why the cap is zero here and only here.
    const rowCap = native ? 0 : CONVERSATION_THREAD_ROW_CAP;

    try {
      withTransaction(this.store.db, () => {
        if (native) {
          this.store.conversationThreads.observeParticipant(threadKey, actor.discordUserId);
          this.store.conversationThreads.observeSession(threadKey, actor.discordUserId);
        }
        if (user !== '') {
          this.append(actor.discordUserId, threadKey, 'user', user, rowCap, exchange.userMessageId);
        }
        if (assistant !== '') {
          this.append(actor.discordUserId, threadKey, 'assistant', assistant, rowCap);
        }
      });
    } catch {
      /* continuity is a convenience; never fail the reply for it */
    }
  }

  /**
   * Seeds a BRANCH with the one anchor its presser selected.
   *
   * Written as a checkpoint and not as a turn, deliberately. The anchor is
   * something that was said in ANOTHER thread, and putting it in
   * `conversation_turns` would claim it was said in this one -- which is the
   * exact dishonesty the table's missing `system` role exists to prevent. As a
   * checkpoint it is labelled for what it is: carried-over context.
   */
  seedBranch(actor: ActorContext, threadId: string, anchor: ConversationHistoryTurn): void {
    try {
      withTransaction(this.store.db, () => {
        this.store.conversationThreads.observeParticipant(threadId, actor.discordUserId);
        this.store.conversationThreads.observeSession(threadId, actor.discordUserId);
        this.store.conversationThreads.putCheckpoint({
          threadId,
          summary:
            'Carried over from the message this conversation was branched from ' +
            `(${anchor.role}): ${clampTo(anchor.text, CONVERSATION_ANCHOR_TEXT_MAX)}`,
          throughRowid: 0,
          turnsCovered: 1,
        });
      });
    } catch {
      /* a branch that could not be seeded is still a usable empty branch */
    }
  }

  /**
   * Compacts a thread: summarize the older turns, keep the recent ones.
   *
   * **Nothing is deleted.** The checkpoint is written to its own table and the
   * transcript is untouched, which is what lets `/forget` and the retention
   * pass stay the only things that remove a turn -- and what lets the owner be
   * told truthfully that compacting cost them no history.
   *
   * The summary is built DETERMINISTICALLY, by excerpting, not by asking a
   * model. A generated summary would need a provider call that can fail, can
   * cost budget, and can invent a decision nobody made; an excerpt can only
   * ever under-report. It says how many turns it covers so the owner can see
   * what it stands for.
   */
  compact(actor: ActorContext, threadKey: string): CompactionResult {
    const proof = this.participation(actor, threadKey);
    if (!proof) {
      return {
        compacted: false,
        turnsCovered: 0,
        turnsKept: 0,
        turnsDeleted: 0,
        message: 'There is no conversation here to compact.',
      };
    }
    return this.compactWith(proof, CONVERSATION_COMPACT_KEEP_TURNS);
  }

  /**
   * `keep` is how many of the newest turns stay verbatim.
   *
   * A parameter rather than a constant because the automatic path tightens it
   * when a conversation still will not fit, and because manual Compact and
   * automatic compaction must otherwise be the SAME code -- two
   * implementations would eventually disagree about what compacting means.
   */
  private compactWith(proof: ParticipationProof, keep: number): CompactionResult {
    const threads = this.store.conversationThreads;
    const existing = threads.checkpointFor(proof.threadId);
    const rows = this.store.conversations.threadTurns(proof, {
      ...(existing ? { sinceRowid: existing.throughRowid } : {}),
    });

    if (rows.length <= keep) {
      return {
        compacted: false,
        turnsCovered: existing?.turnsCovered ?? 0,
        turnsKept: rows.length,
        turnsDeleted: 0,
        message:
          'Nothing to compact yet: this conversation still fits in the model context. ' +
          'No stored turn was touched.',
      };
    }

    const fold = rows.slice(0, rows.length - keep);
    const kept = rows.length - fold.length;
    const throughRowid = Number(
      (
        this.store.db
          .prepare('SELECT rowid AS r FROM conversation_turns WHERE id = ?')
          .get(fold[fold.length - 1]!.id) as { r: number }
      ).r,
    );

    const covered = (existing?.turnsCovered ?? 0) + fold.length;
    const summary = buildCheckpoint(existing?.summary, fold, covered, this.checkpointBudget);

    threads.putCheckpoint({
      threadId: proof.threadId,
      summary,
      throughRowid,
      turnsCovered: covered,
    });

    return {
      compacted: true,
      turnsCovered: covered,
      turnsKept: kept,
      turnsDeleted: 0,
      message:
        `Compacted. ${covered} earlier turn(s) are now carried as a summary and the last ` +
        `${kept} are sent in full. Nothing was deleted: the whole conversation is still stored, ` +
        'and every Discord message is still in the thread.',
    };
  }

  private append(
    userId: string,
    threadKey: string,
    role: ConversationRole,
    content: string,
    rowCap: number,
    messageId?: string | undefined,
  ): void {
    this.store.conversations.append({
      id: randomUUID(),
      discordUserId: userId,
      threadKey,
      role,
      content,
      ...(messageId === undefined ? {} : { messageId }),
      rowCap,
    });
  }

  /**
   * The one turn a Branch control names, if the presser may see it.
   *
   * Returns undefined for a message that is not a turn of this thread, which
   * is what the caller reports as *that message is not part of this
   * conversation* rather than silently branching from nothing.
   */
  anchorFor(
    actor: ActorContext,
    threadKey: string,
    messageId: string,
  ): ConversationHistoryTurn | undefined {
    const proof = this.participation(actor, threadKey);
    if (!proof) return undefined;
    const row = this.store.conversations.threadTurnByMessageId(proof, messageId);
    return row ? { role: row.role, text: row.content } : undefined;
  }

  // ------------------------------------------------- provider session keys --

  /**
   * The current provider-session epoch for one (thread, actor).
   *
   * Folded into the provider's own session key, so bumping it opens a
   * different session rather than clearing the old one. That distinction is
   * reported to the owner rather than smoothed over.
   */
  epochFor(actor: ActorContext, threadKey: string): number {
    return this.store.conversationThreads.epochFor(threadKey, actor.discordUserId);
  }

  /**
   * Deletes ONE person's stored conversation, and reports the COUNT.
   *
   * Named for its scope rather than for its breadth: "this user's conversation"
   * is a single entity the owner can point at, which is what `/forget` deals
   * in. It cannot reach anyone else's rows, it takes no filter, and there is no
   * variant that deletes across users -- `forget.service.ts` is scanned by a
   * test for exactly that kind of method.
   *
   * It additionally ROTATES every provider session this user's conversation
   * produced. Ducky cannot delete an OpenClaw session, so the next best honest
   * thing is to stop using the contaminated one: after this, a further turn
   * opens a new session and cannot pick the old context back up.
   *
   * Counts, never content: a record of a deletion that quoted what it deleted
   * would defeat the deletion.
   */
  forgetConversationFor(actor: ActorContext): ConversationForgetResult {
    const threads = this.store.conversationThreads;
    return withTransaction(this.store.db, () => {
      const turnsDeleted = this.store.conversations.deleteForUser(actor.discordUserId);
      let rotated = 0;
      for (const session of threads.sessionsFor(actor.discordUserId)) {
        threads.rotate(session.threadKey, actor.discordUserId);
        rotated += 1;
      }
      // A checkpoint is derived from turns that are now gone, so it has to go
      // with them: leaving it would replay a summary of deleted words.
      for (const threadId of threads.threadsFor(actor.discordUserId)) {
        if (this.store.conversations.countForThread(actor.discordUserId, threadId) === 0) {
          threads.deleteCheckpoint(threadId);
        }
      }
      return { turnsDeleted, enabled: this.config.enabled, providerSessionsRotated: rotated };
    });
  }

  /** Deletes one thread of one user. Same rules as `forgetConversationFor`. */
  forgetThread(actor: ActorContext, threadKey: string): ConversationForgetResult {
    const threads = this.store.conversationThreads;
    return withTransaction(this.store.db, () => {
      const turnsDeleted = this.store.conversations.deleteThread(
        actor.discordUserId,
        threadKey,
      );
      threads.rotate(threadKey, actor.discordUserId);
      if (this.store.conversations.countForThread(actor.discordUserId, threadKey) === 0) {
        threads.deleteCheckpoint(threadKey);
      }
      return { turnsDeleted, enabled: this.config.enabled, providerSessionsRotated: 1 };
    });
  }

  storedFor(actor: ActorContext): number {
    return this.store.conversations.countForUser(actor.discordUserId);
  }
}

/**
 * The checkpoint text: the previous summary, then an excerpt of each folded
 * turn, clamped overall by dropping the OLDEST lines first.
 *
 * Dropping the oldest is a real loss and it is stated rather than hidden: the
 * header carries the number of turns the checkpoint stands for, so a reader can
 * see that it covers more than it quotes, and the full transcript is still
 * stored and still queryable by a participant.
 */
function buildCheckpoint(
  previous: string | undefined,
  fold: readonly { role: ConversationRole; content: string }[],
  covered: number,
  maxBytes: number,
): string {
  const header = `Earlier in this conversation, compacted (${covered} turn(s)):`;
  const lines = [
    ...(previous ? stripHeader(previous) : []),
    ...fold.map((t) => `- ${t.role}: ${clampTo(t.content, 240)}`),
  ];

  let body = lines.join('\n');
  while (lines.length > 1 && bytes(`${header}\n${body}`) > maxBytes) {
    lines.shift();
    body = lines.join('\n');
  }
  return clampTo(`${header}\n${body}`, maxBytes);
}

const stripHeader = (summary: string): string[] =>
  summary.split('\n').filter((l) => l.startsWith('- '));

/**
 * Control characters and mention syntax stripped, then length-capped.
 *
 * `cleanUntrusted` is the same treatment every other stored string gets. The
 * truncation is visible on purpose: a silently halved sentence replayed as
 * context is a small lie about what was said.
 */
function clamp(text: string): string {
  return clampTo(cleanUntrusted(text).trim(), CONVERSATION_TURN_TEXT_MAX);
}

function clampTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
