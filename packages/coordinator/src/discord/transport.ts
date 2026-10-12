import type {
  ThreadEntryOutcome, ThreadStartOutcome,
} from '../domain/conversation-threads.js';
import type { OutboundMessage, SendTarget } from './message.js';

/**
 * Where a Discord event arrived from.
 *
 * Carried so the router can tell a DM from a guild channel, and one guild
 * channel from another. It is optional, and its absence is treated exactly
 * like an unconfigured channel: the request falls through to the private,
 * owner-only path. Failing closed matters more here than completeness --
 * a transport that forgets to populate it must lose shared visibility, never
 * gain it.
 */
export interface IncomingContext {
  /** Present for both DMs and guild channels. */
  readonly channelId: string | undefined;
  /** Absent in a DM. Presence is what distinguishes a guild channel. */
  readonly guildId: string | undefined;
  /**
   * The channel a THREAD hangs under, and nothing else.
   *
   * Present only when `channelId` is a thread; absent for a top-level channel
   * and absent in a DM. It exists because a thread's id is not its parent's,
   * so without it every policy that matches on a configured channel id answers
   * "no" for a thread under that channel -- which is how a thread under the
   * configured GPT channel ended up silenced and a thread under a role channel
   * lost its role.
   *
   * **It is routing and presentation input, never an authority of its own.** A
   * parent channel can make a thread inherit a ROLE (where output belongs,
   * whether replies persist) and can make it inherit an EXCLUSION (a thread
   * under a shared channel is still a shared channel for the purposes of
   * memory). It can never make anybody able to do anything: `Authorizer` reads
   * frozen configuration and nothing here.
   */
  readonly parentChannelId?: string | undefined;
}

/**
 * The message a reply points at, as the reader sees it.
 *
 * Carried as metadata, resolved later, and never trusted: the router checks
 * that the referenced message really is in the SAME visible thread before any
 * of its text is included, and labels it unavailable otherwise. A reference
 * never changes which conversation a message belongs to.
 */
export interface IncomingReference {
  readonly messageId: string;
  /** The channel the referenced message lives in, when Discord reported one. */
  readonly channelId?: string | undefined;
  /** Absent when the referenced message could not be read back. */
  readonly text?: string | undefined;
  /** Who wrote it, when known. */
  readonly authorId?: string | undefined;
}

/**
 * Who sent a message.
 *
 * `bot` and `webhook` are separated because they fail differently: a bot is
 * another application talking, a webhook is a notification nobody is behind.
 * Neither starts a conversation thread, and a transport that cannot tell must
 * say `unknown`, which is treated exactly like a bot.
 */
export type IncomingAuthorKind = 'user' | 'bot' | 'webhook' | 'unknown';

/**
 * Attachment METADATA only. Discord-supplied, entirely untrusted, and never
 * accompanied by bytes: whether anything is downloaded is decided later, by
 * policy, and for conversation only after a capability check.
 */
export interface IncomingAttachment {
  readonly filename: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly url: string;
}

export interface IncomingCommand {
  readonly kind: 'command';
  readonly name: string;
  readonly subcommand?: string;
  readonly userId: string;
  readonly context?: IncomingContext;
  readonly options: Record<string, string | number | boolean | undefined>;
  readonly attachment?: IncomingAttachment;
}

export interface IncomingComponent {
  readonly kind: 'component';
  readonly customId: string;
  readonly userId: string;
  readonly values?: Record<string, string>;
}

export interface IncomingMessage {
  readonly kind: 'message';
  readonly userId: string;
  readonly text: string;
  readonly threadKey: string;
  /**
   * The Discord id of THIS message.
   *
   * Needed because a native thread is started FROM a message: the id is the
   * idempotency key for "has this message already sprouted a thread?", and
   * Discord's own recovery path for `MESSAGE_ALREADY_HAS_THREAD` is that the
   * thread's id IS the starter message's id. Absent means no thread can be
   * started from it, which is the fail-closed direction.
   */
  readonly messageId?: string | undefined;
  /**
   * Whether a person sent this. Absent is treated as `unknown`, so a transport
   * that does not populate it cannot cause a bot post to start a thread.
   */
  readonly authorKind?: IncomingAuthorKind | undefined;
  /** The message this one replies to, when it replies to one. */
  readonly reference?: IncomingReference | undefined;
  /**
   * Where the message arrived, on the same terms as a command.
   *
   * Until this existed a message carried only `threadKey`, which IS the channel
   * id -- so code that needed to know "which channel is this?" compared thread
   * keys against configured ids and got the right answer for the wrong reason.
   * It could not tell a guild channel from a DM at all, because a DM channel
   * has an id like any other. Every routing decision that depends on WHERE a
   * message came from needs the guild id to make that distinction, and
   * `SharedChannelPolicy` has always refused to make it without one.
   *
   * Optional, and its absence is treated exactly as an unconfigured channel:
   * a transport that forgets to populate it loses channel-specific behaviour
   * and never gains it.
   */
  readonly context?: IncomingContext;
  /**
   * Every attachment on the message, as metadata. All of them, not the first:
   * the router must be able to SEE that there were several and refuse, rather
   * than silently pick one. Absent and empty mean the same thing.
   */
  readonly attachments?: readonly IncomingAttachment[];
}

export type Incoming = IncomingCommand | IncomingComponent | IncomingMessage;

export type IncomingHandler = (event: Incoming) => Promise<OutboundMessage | undefined>;

/**
 * Decides which conversation a message belongs to, creating a native thread
 * when it should.
 *
 * Installed by the composition root rather than constructed by the transport,
 * so the DECISION stays in the domain (testable with no Discord) and only the
 * EFFECT lives here. Absent means no message is ever rerouted, which is how
 * every instance behaved before threads existed.
 */
export type ConversationThreadEntry = (event: IncomingMessage) => Promise<ThreadEntryOutcome>;

export interface DiscordTransport {
  readonly kind: 'real' | 'mock';
  start(handler: IncomingHandler): Promise<void>;
  stop(): Promise<void>;
  send(target: SendTarget, message: OutboundMessage): Promise<void>;
  /**
   * Opens a native thread. Absent means this transport cannot, and the thread
   * service then refuses rather than pretending one was created.
   */
  startThread?(input: {
    readonly channelId: string;
    readonly messageId?: string | undefined;
    readonly name: string;
    readonly autoArchiveMinutes: number;
  }): Promise<ThreadStartOutcome>;
  /**
   * Installs the hook above, and the one that records a thread as GONE.
   *
   * Called once, by the composition root. `onGone` fires only on Discord's
   * `Unknown Channel`, which is the single durable signal that a thread has
   * been deleted; closing a mapping starts the retention clock and removes
   * nothing.
   */
  useConversationThreads?(
    enter: ConversationThreadEntry,
    onGone?: (threadId: string) => void,
  ): void;
}

/** What a transport hands to the underlying client after sanitization. */
export interface DiscordSink {
  deliver(target: SendTarget, message: OutboundMessage): Promise<void>;
}
