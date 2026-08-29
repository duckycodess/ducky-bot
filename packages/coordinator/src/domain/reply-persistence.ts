import type { IncomingContext } from '../discord/transport.js';
import type { ChannelRolePolicy } from './channel-roles.js';

/**
 * Commands whose reply stays ephemeral even in a role channel.
 *
 * `/forget` is two-step: it shows what will go and returns a signed control
 * that DELETES when pressed. The control is exempt not because its signature is
 * weak -- it refuses anybody but the owner, like every other -- but because a
 * durable one-press delete sitting in scrollback is a different class of object
 * from a task list. The owner is the person who scrolls back through their own
 * channel, so a stale confirm button is a hazard to *them*.
 *
 * This is the only exception, and it is a list rather than a condition so that
 * adding to it is a visible, reviewable act. See ADR 0023.
 */
export const PERSISTENCE_EXEMPT_COMMANDS: readonly string[] = Object.freeze(['forget']);

/**
 * The single rule deciding whether an owner reply persists.
 *
 * It exists as its own module because **two callers must agree and cannot be
 * allowed to drift**:
 *
 * 1. `DiscordJsTransport`, which must choose ephemerality at `deferReply` --
 *    before routing, because an interaction has a three-second budget and the
 *    work behind it can take longer. Whatever it picks there is FINAL: an
 *    `editReply` cannot change a reply's visibility afterwards.
 * 2. `DuckyRouter`, which sets the flag on the message it returns, and is the
 *    only place that sees non-interaction replies at all.
 *
 * They were briefly two rules, and the result was a bug that looked like the
 * feature working: the router faithfully marked a reply persistent and the
 * transport had already deferred it ephemeral, so nothing changed in Discord.
 * One rule, one module, both callers.
 *
 * ## What it decides on, and what it refuses to look at
 *
 * Only trusted transport context and the configured owner id:
 *
 * - the actor must BE the owner -- a non-owner's reply is a refusal or ordinary
 *   conversation, and neither becomes persistent because somebody configured a
 *   channel;
 * - the request must have arrived in a configured ROLE channel, which requires
 *   a guild id, so a DM never reaches this;
 * - the command must not be exempt.
 *
 * It never looks at a channel NAME (Discord names are not identity and change
 * freely) and never at the reply TEXT (output must not decide its own
 * visibility). Both would be ways for something outside the operator's
 * configuration to widen exposure.
 *
 * It is not an authorizer and grants nothing: `Authorizer` decides who may act,
 * from frozen configuration, and a non-owner is refused in a role channel
 * exactly as anywhere else.
 */
export class ReplyPersistencePolicy {
  constructor(
    private readonly channelRoles: ChannelRolePolicy,
    private readonly ownerId: string,
  ) {}

  /**
   * Whether a reply to this request should be visible in the channel.
   *
   * `commandName` is undefined for anything that is not a slash command. That
   * is deliberately NOT treated as "no exemption applies": a component press
   * and a modal submit both return false below, because their visibility is
   * fixed at a deferral that happens before the signature has been checked,
   * and a refusal for an invalid control must not be published.
   */
  persists(input: {
    readonly userId: string;
    readonly context: IncomingContext | undefined;
    readonly kind: 'command' | 'component' | 'message';
    readonly commandName?: string | undefined;
  }): boolean {
    if (input.userId !== this.ownerId) return false;
    if (!this.channelRoles.isRoleChannel(input.context)) return false;

    if (input.kind === 'command') {
      const name = input.commandName;
      return name === undefined || !PERSISTENCE_EXEMPT_COMMANDS.includes(name);
    }

    /**
     * A plain message reply is already visible -- Ducky replies in the channel
     * rather than through an interaction -- so there is nothing to decide.
     * Returning true keeps the two callers describing the same world.
     */
    if (input.kind === 'message') return true;

    /**
     * A component press. Its visibility is fixed at a deferral that happens
     * BEFORE the signature is verified, so publishing it would mean publishing
     * the refusal for an invalid or replayed control. The message CARRYING the
     * control already persists, which is what the owner scrolls back to.
     */
    return false;
  }
}
