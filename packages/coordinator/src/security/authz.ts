import { DISCORD_SNOWFLAKE_RE, DuckyError, unauthorized } from '@ducky/contracts';

export type Role = 'owner' | 'chat';

export interface ActorContext {
  readonly discordUserId: string;
  readonly role: Role | 'none';
}

export interface AuthzConfig {
  readonly ownerId: string;
  readonly chatWhitelist: readonly string[];
}

/**
 * Frozen at boot from environment configuration.
 *
 * Authorization NEVER reads the database. `authorized_user_audit` exists only
 * so the trail shows who was configured when; a row there granting `owner` to
 * an arbitrary id confers nothing, and removing an id from config revokes it
 * immediately with no migration.
 */
export function loadAuthzConfig(env: {
  OWNER_DISCORD_USER_ID?: string | undefined;
  CHAT_WHITELIST_USER_IDS?: string | undefined;
}): AuthzConfig {
  const owner = (env.OWNER_DISCORD_USER_ID ?? '').trim();
  if (owner === '') {
    throw new DuckyError('invalid_input', 'OWNER_DISCORD_USER_ID is required.');
  }
  if (/[,;\s]/.test(owner)) {
    throw new DuckyError(
      'invalid_input',
      'OWNER_DISCORD_USER_ID must be exactly one Discord user id.',
    );
  }
  if (!DISCORD_SNOWFLAKE_RE.test(owner)) {
    throw new DuckyError('invalid_input', 'OWNER_DISCORD_USER_ID must be a Discord snowflake.');
  }

  const raw = (env.CHAT_WHITELIST_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of raw) {
    if (!DISCORD_SNOWFLAKE_RE.test(id)) {
      throw new DuckyError('invalid_input', `CHAT_WHITELIST_USER_IDS contains an invalid id.`);
    }
    if (id === owner) {
      throw new DuckyError(
        'invalid_input',
        'CHAT_WHITELIST_USER_IDS must not contain the owner id; the owner is not a chat user.',
      );
    }
  }

  return Object.freeze({ ownerId: owner, chatWhitelist: Object.freeze([...new Set(raw)]) });
}

export class Authorizer {
  constructor(private readonly config: AuthzConfig) {}

  get ownerId(): string {
    return this.config.ownerId;
  }

  roleOf(discordUserId: string): Role | 'none' {
    if (discordUserId === this.config.ownerId) return 'owner';
    if (this.config.chatWhitelist.includes(discordUserId)) return 'chat';
    return 'none';
  }

  actor(discordUserId: string): ActorContext {
    return { discordUserId, role: this.roleOf(discordUserId) };
  }

  isOwner(actor: ActorContext): boolean {
    return actor.role === 'owner' && actor.discordUserId === this.config.ownerId;
  }

  /**
   * Called as the first statement of every privileged service method, not only
   * at the command router, so a routing bug cannot escalate.
   */
  requireOwner(actor: ActorContext): void {
    if (!this.isOwner(actor)) throw unauthorized();
  }

  /** Conversation is the only surface a whitelist user can reach. */
  requireConversational(actor: ActorContext): void {
    if (actor.role === 'none') throw unauthorized();
  }

  allConfiguredIds(): string[] {
    return [this.config.ownerId, ...this.config.chatWhitelist];
  }
}
