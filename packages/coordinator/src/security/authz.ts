import { DISCORD_SNOWFLAKE_RE, DuckyError, unauthorized } from '@ducky/contracts';

export type Role = 'owner' | 'chat';

export interface ActorContext {
  readonly discordUserId: string;
  readonly role: Role | 'none';
}

export interface AuthzConfig {
  readonly ownerId: string;
  readonly chatWhitelist: readonly string[];
  /**
   * Whether a whitelisted (non-owner) user may reach the model at all: plain
   * conversation and the Branch and Compact controls alike. Frozen at boot like
   * everything else here, and OFF unless configuration says otherwise.
   */
  readonly additionalUserAi: boolean;
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
  DUCKY_ADDITIONAL_USER_AI_ENABLED?: boolean | undefined;
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

  return Object.freeze({
    ownerId: owner,
    chatWhitelist: Object.freeze([...new Set(raw)]),
    // Absent means off. Being on the whitelist says who MAY be offered chat
    // once it is authorized; it is not itself that authorization.
    additionalUserAi: env.DUCKY_ADDITIONAL_USER_AI_ENABLED === true,
  });
}

/**
 * Notified when a privileged surface refuses somebody.
 *
 * Optional and fire-and-forget: authorization must not depend on the audit log
 * being writable, and a refusal is still a refusal if nobody wrote it down.
 * `route` is a fixed label supplied by the caller, never user input.
 */
export type AuthzRefusalSink = (info: { role: 'chat' | 'none' | 'owner' }) => void;

export class Authorizer {
  #onRefused: AuthzRefusalSink | undefined;

  constructor(private readonly config: AuthzConfig, onRefused?: AuthzRefusalSink) {
    this.#onRefused = onRefused;
  }

  /**
   * Attached after construction because the store is built later in the
   * composition root, and authorization must not wait on it.
   */
  onRefused(sink: AuthzRefusalSink): void {
    this.#onRefused = sink;
  }

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
    if (!this.isOwner(actor)) {
      this.#notifyRefused(actor);
      throw unauthorized();
    }
  }

  /**
   * Whether this person may reach the model: the owner always, a whitelisted
   * user only while additional-user AI is enabled, anybody else never.
   *
   * The ONE question every model-reaching path asks -- a plain message, a reply
   * anchor, a thread, and the Branch and Compact controls -- so there is no
   * second place that could keep treating the whitelist as permission after the
   * switch is off.
   */
  mayConverse(discordUserId: string): boolean {
    const role = this.roleOf(discordUserId);
    return role === 'owner' || (role === 'chat' && this.config.additionalUserAi);
  }

  /**
   * Conversation is the only surface a whitelist user can reach, and for them
   * it is itself disabled by default. A refusal is audited by role like any
   * other, and reaches no provider.
   */
  requireConversational(actor: ActorContext): void {
    if (!this.mayConverse(actor.discordUserId) || actor.role === 'none') {
      this.#notifyRefused(actor);
      throw unauthorized();
    }
  }

  /**
   * Records the ROLE that was refused, never the Discord id.
   *
   * There is exactly one owner, so "a chat user was refused" and "a stranger
   * was refused" are the only two facts an auditor can act on; the id would be
   * unnecessary personal data in a long-lived table, exactly as it is
   * everywhere else in the audit log.
   */
  #notifyRefused(actor: ActorContext): void {
    try {
      this.#onRefused?.({ role: actor.role });
    } catch {
      /* authorization never depends on recording */
    }
  }

  allConfiguredIds(): string[] {
    return [this.config.ownerId, ...this.config.chatWhitelist];
  }
}
