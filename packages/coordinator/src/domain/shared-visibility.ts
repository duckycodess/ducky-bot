import type { IncomingContext } from '../discord/transport.js';

/**
 * Decides whether a request arrived somewhere job information may be shown to
 * people other than the owner.
 *
 * This is deliberately NOT an authorizer. It answers "may this be seen here?",
 * never "may this person do this?". Every write stays owner-only and every
 * owner-only reply stays ephemeral no matter what this returns, so a
 * mis-listed channel widens what is *visible* and can never widen what is
 * *possible*.
 *
 * Every ambiguous case fails closed to private:
 *
 * - no context at all (a transport that did not populate it, an internal
 *   call, a test constructing a bare event),
 * - a DM, identified by the absence of a guild id -- a DM channel has a
 *   channel id like any other, so matching on channel id alone would let a
 *   configured id collide with a private conversation,
 * - a guild channel that is not in the configured set.
 *
 * The configured set is frozen at boot from environment configuration, the
 * same authority model authorization uses: nothing here ever reads the
 * database.
 */
export class SharedChannelPolicy {
  private readonly ids: ReadonlySet<string>;

  constructor(channelIds: Iterable<string> = []) {
    this.ids = new Set(channelIds);
  }

  /** Empty means the whole shared-visibility feature is off. */
  get enabled(): boolean {
    return this.ids.size > 0;
  }

  get configuredChannelIds(): string[] {
    return [...this.ids].sort();
  }

  has(channelId: string | undefined | null): boolean {
    return channelId != null && this.ids.has(channelId);
  }

  isSharedRequest(context: IncomingContext | undefined): boolean {
    if (!context) return false;
    // A DM has no guild. Requiring one is what stops a configured id from
    // ever matching a private conversation.
    if (context.guildId === undefined) return false;
    return this.has(context.channelId);
  }
}
