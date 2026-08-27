/**
 * Ducky runs as one of two completely separate Discord identities.
 *
 * The profiles never share a token, an application id, a database, a port or a
 * command-registration target. There is deliberately no fallback between them:
 * booting production with the development bot (or the reverse) would put test
 * traffic on the real assistant, so a missing credential is a startup failure
 * rather than something to paper over.
 */
export const DUCKY_PROFILES = ['development', 'production'] as const;
export type DuckyProfile = (typeof DUCKY_PROFILES)[number];

export const isDuckyProfile = (v: unknown): v is DuckyProfile =>
  typeof v === 'string' && (DUCKY_PROFILES as readonly string[]).includes(v);

/** Env var names per profile. Kept here so nothing has to guess at them. */
export const PROFILE_ENV = {
  development: {
    token: 'DISCORD_DEV_TOKEN',
    appId: 'DISCORD_DEV_APP_ID',
    guildId: 'DISCORD_DEV_GUILD_ID',
  },
  production: {
    token: 'DISCORD_PROD_TOKEN',
    appId: 'DISCORD_PROD_APP_ID',
    guildId: 'DISCORD_PROD_GUILD_ID',
  },
} as const satisfies Record<DuckyProfile, { token: string; appId: string; guildId: string }>;

/**
 * Where slash commands are registered.
 *
 * Development registers to a single guild because guild commands appear
 * immediately, which matters when iterating. Production registers globally
 * unless a production guild is explicitly configured — and it never falls back
 * to the development guild, which would leak test commands into the real bot.
 */
export type CommandScope =
  | { readonly kind: 'guild'; readonly guildId: string }
  | { readonly kind: 'global' };

export const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
