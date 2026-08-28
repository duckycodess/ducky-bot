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

export interface IncomingCommand {
  readonly kind: 'command';
  readonly name: string;
  readonly subcommand?: string;
  readonly userId: string;
  readonly context?: IncomingContext;
  readonly options: Record<string, string | number | boolean | undefined>;
  readonly attachment?: {
    readonly filename: string;
    readonly contentType: string | null;
    readonly size: number;
    readonly url: string;
  };
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
