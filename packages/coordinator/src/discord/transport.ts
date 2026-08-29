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
}

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

export interface DiscordTransport {
  readonly kind: 'real' | 'mock';
  start(handler: IncomingHandler): Promise<void>;
  stop(): Promise<void>;
  send(target: SendTarget, message: OutboundMessage): Promise<void>;
}

/** What a transport hands to the underlying client after sanitization. */
export interface DiscordSink {
  deliver(target: SendTarget, message: OutboundMessage): Promise<void>;
}
