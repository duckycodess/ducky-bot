import {
  DISCORD_SNOWFLAKE, THREAD_AUTO_ARCHIVE_MINUTES, THREAD_NAME_EXCERPT_MAX, THREAD_NAME_MAX,
  cleanUntrusted,
} from '@ducky/contracts';
import { redact } from '@ducky/adapters';
import type { Store } from '@ducky/persistence';
import type { IncomingMessage } from '../discord/transport.js';
import type { Authorizer } from '../security/authz.js';
import type { SharedChannelPolicy } from './shared-visibility.js';

/**
 * Why a message cannot start a native thread.
 *
 * Every value is a REASON somebody could act on, not a generic failure. The
 * ones that mean "this is simply not a thread channel" are silent; the ones
 * that mean "Discord refused us" are reported, because an owner who configured
 * a channel and sees nothing happen deserves to know which.
 */
export type ThreadStartFailure =
  | 'forbidden'
  | 'rate_limited'
  | 'archived_locked'
  | 'unavailable';

export type ThreadStartOutcome =
  | { readonly ok: true; readonly threadId: string }
  /**
   * Discord's `MESSAGE_ALREADY_HAS_THREAD` (code 160004).
   *
   * Recoverable rather than fatal, and recoverable by a DOCUMENTED identity: a
   * thread created from a message carries that message's id. So the starter
   * message id IS the thread id, and a retry after a crash between "Discord
   * created the thread" and "we wrote the row" finds the same conversation
   * instead of opening a second one beside it.
   */
  | { readonly ok: false; readonly alreadyExists: true; readonly threadId: string }
  | { readonly ok: false; readonly alreadyExists?: false; readonly failure: ThreadStartFailure };

/**
 * Creates a native thread.
 *
 * A port, implemented by the Discord transport (the only module that may touch
 * discord.js) and faked in tests. The policy above it decides WHETHER; this
 * does only the effect.
 *
 * `messageId` present means *start a thread on that message*, which is what a
 * conversation starter does. Absent means *open a standalone thread in that
 * channel*, which is what Branch does: the message a Branch control sits on is
 * itself inside a thread, and Discord has no thread-on-a-thread, so a branch
 * has to be opened beside it in the parent instead.
 */
export type ThreadStarter = (input: {
  readonly channelId: string;
  readonly messageId?: string | undefined;
  readonly name: string;
  readonly autoArchiveMinutes: number;
}) => Promise<ThreadStartOutcome>;

export type ThreadEntryOutcome =
  /** Not a thread-eligible message. Route it exactly as before. */
  | { readonly kind: 'unchanged' }
  /** Route this message into the thread, and answer there. */
  | { readonly kind: 'thread'; readonly threadId: string; readonly created: boolean }
  /**
   * Refuse visibly. **Never a fallback into the parent conversation**: a reply
   * that silently landed in the shared parent session is the leak this whole
   * feature exists to avoid, so a thread that cannot be created or reached
   * produces a refusal and no answer.
   */
  | { readonly kind: 'refused'; readonly message: string };

export interface ConversationThreadConfig {
  /**
   * The channels that may sprout conversation threads. EMPTY MEANS OFF: an
   * instance that configures nothing creates no thread, which is exactly how
   * every instance behaved before this existed.
   */
  readonly parentChannelIds: readonly string[];
}

/**
 * Which messages start a thread, and which merely continue one.
 *
 * Deliberately a pure decision over frozen configuration and transport
 * context, with no Discord call and no database read, so every branch is
 * testable without either. The EFFECT is `ThreadStarter`'s problem.
 *
 * **Creating a thread is a write into the owner's guild**, which is why the
 * parent list is opt-in and empty by default (the roadmap flagged exactly
 * this). Nothing infers a parent: a channel sprouts threads because somebody
 * named it.
 */
export class ConversationThreadPolicy {
  private readonly parents: ReadonlySet<string>;

  constructor(
    config: ConversationThreadConfig,
    private readonly authz: Authorizer,
    private readonly shared: SharedChannelPolicy,
  ) {
    this.parents = new Set(config.parentChannelIds);
  }

  /** Empty means the whole feature is off. */
  get enabled(): boolean {
    return this.parents.size > 0;
  }

  get configuredParents(): string[] {
    return [...this.parents].sort();
  }

  isParent(channelId: string | undefined): boolean {
    return channelId !== undefined && this.parents.has(channelId);
  }

  /**
   * Whether this message is already INSIDE a thread of a configured parent.
   *
   * A child thread never spawns another: `parentChannelId` is present only for
   * a thread, and Discord has no threads-on-threads, but checking it here is
   * what makes "do not recursively spawn threads" a property of the policy
   * rather than of the platform.
   */
  isChildOfParent(event: IncomingMessage): boolean {
    const parent = event.context?.parentChannelId;
    if (parent === undefined) return false;
    if (event.context?.guildId === undefined) return false;
    return this.parents.has(parent);
  }

  /**
   * Whether this message should START a thread.
   *
   * Every condition, written out because the ORDER is not the point but the
   * COMPLETENESS is:
   *
   * - the feature is configured at all;
   * - a person sent it. A bot, a webhook, or an author kind the transport
   *   could not determine is excluded, so a notification feed in a configured
   *   channel cannot carpet it with threads;
   * - it arrived in a GUILD channel. A DM has nobody to hide a thread from and
   *   Discord cannot thread one anyway;
   * - that channel is a configured parent, and is not itself a thread;
   * - the channel is not a configured SHARED channel, and neither is its
   *   parent. A channel other people read is not a place to open the owner's
   *   conversation;
   * - the sender is conversationally authorized by the frozen `Authorizer` --
   *   the SAME authority every other surface uses. A stranger posting in a
   *   configured channel gets no thread, because they would get no answer;
   * - the message carries its own id, without which no thread can be started
   *   from it.
   */
  startsThread(event: IncomingMessage): boolean {
    if (!this.enabled) return false;
    if ((event.authorKind ?? 'unknown') !== 'user') return false;

    const context = event.context;
    if (!context || context.guildId === undefined) return false;
    if (context.channelId === undefined) return false;
    // A message already in a thread continues it; it never sprouts another.
    if (context.parentChannelId !== undefined) return false;
    if (!this.parents.has(context.channelId)) return false;
    if (this.shared.touchesSharedChannel(context)) return false;
    if (this.authz.roleOf(event.userId) === 'none') return false;
    return event.messageId !== undefined && DISCORD_SNOWFLAKE.test(event.messageId);
  }
}

/**
 * A fixed, sanitized thread name.
 *
 * Fixed PREFIX plus a short excerpt, clamped twice: once to the excerpt length
 * and once to Discord's own ceiling. The excerpt goes through the same
 * untrusted-text cleaning and the same redactor every outbound string does,
 * because a thread name is visible to everyone who can see the parent channel
 * -- including people who cannot read a single turn inside the thread.
 *
 * Newlines collapse to spaces: a name is one line, and a message with a
 * newline in it would otherwise produce something Discord renders oddly or
 * refuses.
 */
export function threadNameFor(text: string, prefix = 'Chat'): string {
  const cleaned = redact(cleanUntrusted(text)).replace(/\s+/g, ' ').trim();
  const excerpt = cleaned.length > THREAD_NAME_EXCERPT_MAX
    ? `${cleaned.slice(0, THREAD_NAME_EXCERPT_MAX - 1)}…`
    : cleaned;
  const name = excerpt === '' ? prefix : `${prefix}: ${excerpt}`;
  return name.length > THREAD_NAME_MAX ? name.slice(0, THREAD_NAME_MAX) : name;
}

/**
 * The thread id an outcome carries, whether Discord created it or told us it
 * already existed.
 *
 * Written as a function rather than inline narrowing because the two success
 * shapes are deliberately different values of `ok`: "we made it" and "it was
 * already there" are not the same event, and a caller that only needs the id
 * should not have to care which happened.
 */
export const threadIdOf = (outcome: ThreadStartOutcome): string | undefined => {
  if (outcome.ok) return outcome.threadId;
  return outcome.alreadyExists === true ? outcome.threadId : undefined;
};

export const failureOf = (outcome: ThreadStartOutcome): ThreadStartFailure | undefined =>
  !outcome.ok && outcome.alreadyExists !== true ? outcome.failure : undefined;

const REFUSALS: Record<ThreadStartFailure, string> = {
  forbidden:
    'I could not open a thread here. The bot needs Create Public Threads and Send Messages in ' +
    'Threads in this channel. Nothing was answered in the channel instead.',
  rate_limited:
    'Discord is rate-limiting thread creation here, so I could not open one for this message. ' +
    'Try again in a moment; nothing was answered in the channel instead.',
  archived_locked:
    'That thread is locked or archived beyond recovery, so I cannot answer in it. ' +
    'Nothing was answered anywhere else.',
  unavailable:
    'I could not open a thread for this message, so I have not answered. ' +
    'Nothing was answered in the channel instead.',
};

export interface ConversationThreadServiceDeps {
  readonly store: Store;
  readonly policy: ConversationThreadPolicy;
  /**
   * OMITTING IT DISABLES THREAD CREATION ENTIRELY, which is the same
   * fail-closed posture every other optional wiring here takes: an unwired
   * instance opens no thread and routes exactly as it did before.
   */
  readonly startThread?: ThreadStarter | undefined;
}

/**
 * Turns an incoming message into the conversation it belongs to.
 *
 * One native thread per qualifying starter, every later message routed into
 * it, and an honest refusal when Discord will not let that happen. The thread
 * id becomes the conversation's `threadKey`, so memory, participation and the
 * provider session are all scoped by it without anything having to translate.
 */
export class ConversationThreadService {
  constructor(private readonly deps: ConversationThreadServiceDeps) {}

  get enabled(): boolean {
    return this.deps.policy.enabled;
  }

  /** Whether this thread key is a native conversation thread Ducky knows. */
  isNativeThread(threadKey: string): boolean {
    return this.deps.store.conversationThreads.byThreadId(threadKey) !== undefined;
  }

  /**
   * Decides where a message's conversation lives, creating the thread if this
   * is a qualifying starter.
   */
  async enter(input: { readonly event: IncomingMessage }): Promise<ThreadEntryOutcome> {
    const { event } = input;
    const start = this.deps.startThread;
    const threads = this.deps.store.conversationThreads;

    // Already inside a thread of a configured parent: continue it. The thread
    // may be one Ducky started or one the owner made by hand; both are the
    // same conversation from here on, and the mapping row is only needed for
    // the ones Ducky is responsible for.
    if (this.deps.policy.isChildOfParent(event)) {
      return { kind: 'thread', threadId: event.threadKey, created: false };
    }

    if (!this.deps.policy.startsThread(event)) return { kind: 'unchanged' };
    if (!start) return { kind: 'unchanged' };

    const context = event.context!;
    const messageId = event.messageId!;

    // A mapping that already exists wins without calling Discord at all: the
    // starter message id is unique, so a retry is free.
    const existing = threads.byStarterMessage(messageId);
    if (existing) return { kind: 'thread', threadId: existing.threadId, created: false };

    let outcome: ThreadStartOutcome;
    try {
      outcome = await start({
        channelId: context.channelId!,
        messageId,
        name: threadNameFor(event.text),
        autoArchiveMinutes: THREAD_AUTO_ARCHIVE_MINUTES,
      });
    } catch {
      // A port that threw is a port that failed. Refuse rather than guess.
      return { kind: 'refused', message: REFUSALS.unavailable };
    }

    const failure = failureOf(outcome);
    if (failure) return { kind: 'refused', message: REFUSALS[failure] };

    const threadId = threadIdOf(outcome);
    if (threadId === undefined || !DISCORD_SNOWFLAKE.test(threadId)) {
      return { kind: 'refused', message: REFUSALS.unavailable };
    }

    threads.record({
      threadId,
      parentChannelId: context.channelId!,
      guildId: context.guildId!,
      starterMessageId: messageId,
      startedBy: event.userId,
      origin: 'starter',
    });

    return { kind: 'thread', threadId, created: outcome.ok };
  }

  /** The recorded mapping for a thread, or undefined. */
  threadRow(threadId: string) {
    return this.deps.store.conversationThreads.byThreadId(threadId);
  }

  /**
   * Opens a BRANCH: a separate visible thread beside the one the control was
   * pressed in.
   *
   * Beside rather than inside, because Discord has no thread-on-a-thread -- so
   * the branch is a standalone thread in the SAME parent channel, which also
   * keeps it visible to exactly the people who could already see the source.
   *
   * Its provenance is written down (`branched_from`), and that record is the
   * only link between the two conversations. **No context is ever read along
   * it**: a branch starts with the one anchor its presser explicitly selected
   * and nothing else, which is what stops Branch from being a way to copy a
   * conversation somewhere new.
   */
  async branch(input: {
    readonly sourceThreadId: string;
    readonly anchorMessageId: string;
    readonly startedBy: string;
    readonly name: string;
  }): Promise<ThreadEntryOutcome> {
    const start = this.deps.startThread;
    const source = this.deps.store.conversationThreads.byThreadId(input.sourceThreadId);
    if (!source || !start) return { kind: 'refused', message: REFUSALS.unavailable };

    const existing = this.deps.store.conversationThreads.byStarterMessage(input.anchorMessageId);
    if (existing) return { kind: 'thread', threadId: existing.threadId, created: false };

    let outcome: ThreadStartOutcome;
    try {
      outcome = await start({
        channelId: source.parentChannelId,
        name: input.name,
        autoArchiveMinutes: THREAD_AUTO_ARCHIVE_MINUTES,
      });
    } catch {
      return { kind: 'refused', message: REFUSALS.unavailable };
    }
    const failure = failureOf(outcome);
    if (failure) return { kind: 'refused', message: REFUSALS[failure] };
    const threadId = threadIdOf(outcome);
    if (threadId === undefined || !DISCORD_SNOWFLAKE.test(threadId)) {
      return { kind: 'refused', message: REFUSALS.unavailable };
    }

    this.deps.store.conversationThreads.record({
      threadId,
      parentChannelId: source.parentChannelId,
      guildId: source.guildId,
      starterMessageId: input.anchorMessageId,
      startedBy: input.startedBy,
      origin: 'branch',
      branchedFrom: input.sourceThreadId,
    });
    return { kind: 'thread', threadId, created: true };
  }

  /** What `/status` says about native threads. */
  describe(): string {
    if (!this.enabled) {
      return 'off; no channel is configured to open conversation threads';
    }
    const parents = this.deps.policy.configuredParents.length;
    const open = this.deps.store.conversationThreads.countOpen();
    return `on for ${parents} parent channel(s); ${open} live thread(s)`;
  }
}

export { REFUSALS as THREAD_REFUSAL_MESSAGE };
