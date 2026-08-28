import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_THREAD_ROW_CAP, CONVERSATION_TURN_TEXT_MAX,
  cleanUntrusted,
  type ConversationRole,
} from '@ducky/contracts';
import type { ConversationHistoryTurn } from '@ducky/adapters';
import { withTransaction, type Store } from '@ducky/persistence';
import type { ActorContext } from '../security/authz.js';

export interface ConversationMemoryConfig {
  /** OFF unless an operator says otherwise. See ADR 0021. */
  readonly enabled: boolean;
  /** How many earlier turns are replayed. Bounded well below the row cap. */
  readonly turns: number;
  /**
   * Thread keys that never take part in memory, whatever else is configured.
   *
   * The configured SHARED channels. A message event carries no channel context,
   * but its thread key IS the channel id, so this is the one place the two can
   * be compared -- and a channel other people can read must never become a
   * store of the owner's conversation, nor a source of context replayed back
   * into a prompt.
   */
  readonly excludedThreadKeys: readonly string[];
}

export interface ConversationForgetResult {
  readonly turnsDeleted: number;
  readonly enabled: boolean;
}

/**
 * Bounded per-user, per-thread conversation continuity.
 *
 * Three properties, each structural rather than promised:
 *
 * - **Off unless enabled.** With `enabled: false` nothing is read and nothing
 *   is written, so the previous guarantee ("no transcript exists") holds
 *   exactly. Deletion still works, because an earlier run may have stored rows
 *   before the flag was turned off again.
 * - **Isolated by (user, thread).** Every repository method takes the user id
 *   and puts it in the WHERE clause; there is no method that reads a thread
 *   without one. Two people in the same channel have two histories, and neither
 *   can be read into the other's prompt.
 * - **Never a shared channel.** A thread key that matches a configured shared
 *   channel is excluded from both reading and writing.
 *
 * What it deliberately is NOT: a transcript. The row cap is small, the replay
 * window is smaller, and a turn longer than the cap is stored truncated so the
 * record never silently omits half of what was said.
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

  /** Whether this thread takes part in memory at all. */
  applies(threadKey: string): boolean {
    return this.config.enabled && !this.excluded.has(threadKey);
  }

  /**
   * The earlier turns of one thread, oldest first.
   *
   * `actor` rather than a bare id, so the caller cannot accidentally pass
   * somebody else's: the authorizer has already resolved who is speaking, and
   * this reads only their own rows.
   */
  history(actor: ActorContext, threadKey: string): readonly ConversationHistoryTurn[] {
    if (!this.applies(threadKey)) return [];
    return this.store.conversations
      .recent(actor.discordUserId, threadKey, this.config.turns)
      .map((r) => ({ role: r.role, text: r.content }));
  }

  /**
   * Records one exchange: what was said, and what Ducky answered.
   *
   * Both in ONE transaction, because half an exchange is worse than none -- a
   * stored question with no answer would be replayed as if Ducky had ignored
   * it. Recording never throws: losing continuity is not a reason to fail a
   * reply the owner has already been given.
   */
  record(
    actor: ActorContext,
    threadKey: string,
    exchange: { readonly userText: string; readonly assistantText: string },
  ): void {
    if (!this.applies(threadKey)) return;
    const user = clamp(exchange.userText);
    const assistant = clamp(exchange.assistantText);
    if (user === '' && assistant === '') return;

    try {
      withTransaction(this.store.db, () => {
        if (user !== '') this.append(actor.discordUserId, threadKey, 'user', user);
        if (assistant !== '') this.append(actor.discordUserId, threadKey, 'assistant', assistant);
      });
    } catch {
      /* continuity is a convenience; never fail the reply for it */
    }
  }

  private append(userId: string, threadKey: string, role: ConversationRole, content: string): void {
    this.store.conversations.append({
      id: randomUUID(),
      discordUserId: userId,
      threadKey,
      role,
      content,
      rowCap: CONVERSATION_THREAD_ROW_CAP,
    });
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
   * Counts, never content: a record of a deletion that quoted what it deleted
   * would defeat the deletion.
   */
  forgetConversationFor(actor: ActorContext): ConversationForgetResult {
    const turnsDeleted = withTransaction(this.store.db, () =>
      this.store.conversations.deleteForUser(actor.discordUserId),
    );
    return { turnsDeleted, enabled: this.config.enabled };
  }

  /** Deletes one thread of one user. Same rules as `forgetAll`. */
  forgetThread(actor: ActorContext, threadKey: string): ConversationForgetResult {
    const turnsDeleted = withTransaction(this.store.db, () =>
      this.store.conversations.deleteThread(actor.discordUserId, threadKey),
    );
    return { turnsDeleted, enabled: this.config.enabled };
  }

  storedFor(actor: ActorContext): number {
    return this.store.conversations.countForUser(actor.discordUserId);
  }
}

/**
 * Control characters and mention syntax stripped, then length-capped.
 *
 * `cleanUntrusted` is the same treatment every other stored string gets. The
 * truncation is visible on purpose: a silently halved sentence replayed as
 * context is a small lie about what was said.
 */
function clamp(text: string): string {
  const clean = cleanUntrusted(text).trim();
  if (clean.length <= CONVERSATION_TURN_TEXT_MAX) return clean;
  return `${clean.slice(0, CONVERSATION_TURN_TEXT_MAX - 1)}…`;
}
