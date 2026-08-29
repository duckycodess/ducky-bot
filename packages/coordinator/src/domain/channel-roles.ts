import { CHANNEL_ROLES, type ChannelRole } from '@ducky/contracts';
import type { IncomingContext } from '../discord/transport.js';

/**
 * The owner's configured private assistant channels, by role.
 *
 * Deliberately the same shape as `SharedChannelPolicy`, and for the same
 * reasons: frozen at boot from environment configuration, never reads the
 * database, and fails closed on every ambiguous case. The two are siblings, and
 * the difference between them is the whole point:
 *
 * - **A SHARED channel** says *other people may see a narrow projection here.*
 *   Owner replies there stay ephemeral and no control ever appears.
 * - **A ROLE channel** says *this is the owner's own private channel for a kind
 *   of output, and their replies here persist.*
 *
 * One channel cannot be both. That is refused at boot rather than resolved by
 * precedence, because whichever way it resolved, the failure would be silent
 * and the blast radius would be the owner's full task list in a channel
 * somebody configured for coarse job status.
 *
 * **This is not an authorizer, and nothing here grants anything.** A role
 * decides where output belongs and whether it persists. Who may act is decided
 * by `Authorizer` from frozen configuration, exactly as before: a non-owner who
 * types an owner-only command in a role channel is refused identically to
 * anywhere else. A friend reading the channel may SEE the owner's persistent
 * messages -- that is what configuring a private channel for this means -- and
 * still cannot do anything.
 */
export class ChannelRolePolicy {
  private readonly byRole: ReadonlyMap<ChannelRole, string>;
  private readonly byChannel: ReadonlyMap<string, ChannelRole>;

  constructor(roles: Partial<Record<ChannelRole, string | undefined>> = {}) {
    const byRole = new Map<ChannelRole, string>();
    const byChannel = new Map<string, ChannelRole>();
    for (const role of CHANNEL_ROLES) {
      const id = roles[role];
      if (id === undefined || id === '') continue;
      byRole.set(role, id);
      byChannel.set(id, role);
    }
    this.byRole = byRole;
    this.byChannel = byChannel;
  }

  /** Empty means the whole feature is off, exactly like shared visibility. */
  get enabled(): boolean {
    return this.byRole.size > 0;
  }

  get configured(): { readonly role: ChannelRole; readonly channelId: string }[] {
    return [...this.byRole.entries()]
      .map(([role, channelId]) => ({ role, channelId }))
      .sort((a, b) => a.role.localeCompare(b.role));
  }

  channelFor(role: ChannelRole): string | undefined {
    return this.byRole.get(role);
  }

  /**
   * The role of the channel a request arrived in, or undefined.
   *
   * A DM returns undefined, and that is deliberate rather than an oversight: a
   * DM channel has an id like any other, so matching on channel id alone would
   * let a configured role collide with a private conversation. Requiring a
   * guild id is the same rule `SharedChannelPolicy` uses, and a DM needs
   * nothing from this class anyway -- replies there already persist, because
   * there is nobody else in the conversation to hide them from.
   */
  roleOf(context: IncomingContext | undefined): ChannelRole | undefined {
    if (!context) return undefined;
    if (context.guildId === undefined) return undefined;
    if (context.channelId === undefined) return undefined;
    return this.byChannel.get(context.channelId);
  }

  /** Whether a request arrived in one of the owner's configured channels. */
  isRoleChannel(context: IncomingContext | undefined): boolean {
    return this.roleOf(context) !== undefined;
  }
}

/**
 * Refuses a configuration where one channel means two different things.
 *
 * Two separate collisions, both fatal at boot:
 *
 * 1. **A channel that is both a role and a shared channel.** Shared means
 *    others read a narrow projection; role means the owner's replies persist in
 *    full. Together they mean the owner's full output in a channel chosen for
 *    coarse status.
 * 2. **One channel serving two roles.** Not dangerous, but certainly a typo,
 *    and a typo that would send briefings to the coding channel forever without
 *    anybody noticing.
 *
 * Thrown as a plain `Error` with the VARIABLE NAMES rather than a `DuckyError`,
 * because this runs during configuration resolution, before any owner-facing
 * surface exists -- the audience is whoever is editing the env file.
 */
export function assertNoChannelRoleConflicts(
  roles: Partial<Record<ChannelRole, string | undefined>>,
  sharedChannelIds: readonly string[],
  nameOf: (role: ChannelRole) => string,
): void {
  const shared = new Set(sharedChannelIds);
  const seen = new Map<string, ChannelRole>();

  for (const role of CHANNEL_ROLES) {
    const id = roles[role];
    if (id === undefined || id === '') continue;

    if (shared.has(id)) {
      throw new Error(
        `${nameOf(role)} names a channel that is also in the shared-channel list. A channel ` +
          'cannot be both: a shared channel shows other people a narrow projection, while a ' +
          "role channel persists the owner's replies in full. Pick one.",
      );
    }

    const already = seen.get(id);
    if (already !== undefined) {
      throw new Error(
        `${nameOf(role)} and ${nameOf(already)} name the same channel. One channel serves one ` +
          'role.',
      );
    }
    seen.set(id, role);
  }
}
