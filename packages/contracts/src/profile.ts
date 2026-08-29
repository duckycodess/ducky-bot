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

/**
 * Default database and credential-file locations per profile, kept here so
 * every place that resolves them -- the coordinator's own startup path, the
 * migration CLI, the credentials CLI -- reads the same table instead of each
 * maintaining its own copy that can drift.
 */
export const PROFILE_DEFAULT_DB_PATH: Record<DuckyProfile, string> = {
  development: './data/ducky-dev.db',
  production: './data/ducky-prod.db',
};

export const PROFILE_DEFAULT_CREDENTIALS_FILE: Record<DuckyProfile, string> = {
  development: './config/executor-credentials.dev.json',
  production: '/etc/ducky/executor-credentials-production.json',
};

/**
 * An env-file assignment like `FOO=` loads as an empty string, not an unset
 * variable. Node's --env-file-if-exists does not distinguish the two, so every
 * optional-with-default env read normalizes blank to unset here, once.
 */
export const blankToUndefined = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * Resolves DUCKY_PROFILE the same way everywhere: blank or unset defaults to
 * development, and anything else must be a known profile. Used by call sites
 * that cannot pull in the coordinator's full env schema (the CLIs).
 */
export function resolveDuckyProfile(raw: string | undefined): DuckyProfile {
  const v = blankToUndefined(raw);
  if (v === undefined) return 'development';
  if (!isDuckyProfile(v)) {
    throw new Error(`DUCKY_PROFILE must be one of ${DUCKY_PROFILES.join(' | ')}.`);
  }
  return v;
}

/**
 * Env var names per profile. Kept here so nothing has to guess at them.
 *
 * Every secret is profile-scoped, not just the Discord ones: sharing an
 * executor credential file would let a development executor claim production
 * jobs, and sharing a component signing key would make a control minted by one
 * bot verify on the other.
 *
 * `sharedChannels` is not a secret, but it IS profile-scoped for the same
 * reason: it decides where job information becomes visible to people other
 * than the owner, and a development channel id inherited by production would
 * publish real job activity into a test channel.
 */
export const PROFILE_ENV = {
  development: {
    token: 'DISCORD_DEV_TOKEN',
    appId: 'DISCORD_DEV_APP_ID',
    guildId: 'DISCORD_DEV_GUILD_ID',
    credentialsFile: 'DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE',
    componentKey: 'DUCKY_DEV_COMPONENT_SIGNING_KEY',
    sharedChannels: 'DUCKY_DEV_SHARED_CHANNEL_IDS',
    approvedActions: 'DUCKY_DEV_APPROVED_ACTIONS_ENABLED',
    roleChannels: {
      briefing: 'DUCKY_DEV_BRIEFING_CHANNEL_ID',
      task: 'DUCKY_DEV_TASK_CHANNEL_ID',
      coding: 'DUCKY_DEV_CODING_CHANNEL_ID',
      gpt: 'DUCKY_DEV_GPT_CHANNEL_ID',
    },
  },
  production: {
    token: 'DISCORD_PROD_TOKEN',
    appId: 'DISCORD_PROD_APP_ID',
    guildId: 'DISCORD_PROD_GUILD_ID',
    credentialsFile: 'DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE',
    componentKey: 'DUCKY_PROD_COMPONENT_SIGNING_KEY',
    sharedChannels: 'DUCKY_PROD_SHARED_CHANNEL_IDS',
    approvedActions: 'DUCKY_PROD_APPROVED_ACTIONS_ENABLED',
    roleChannels: {
      briefing: 'DUCKY_PROD_BRIEFING_CHANNEL_ID',
      task: 'DUCKY_PROD_TASK_CHANNEL_ID',
      coding: 'DUCKY_PROD_CODING_CHANNEL_ID',
      gpt: 'DUCKY_PROD_GPT_CHANNEL_ID',
    },
  },
} as const satisfies Record<
  DuckyProfile,
  {
    token: string;
    appId: string;
    guildId: string;
    credentialsFile: string;
    componentKey: string;
    sharedChannels: string;
    approvedActions: string;
    roleChannels: Record<ChannelRole, string>;
  }
>;

/**
 * The private assistant channels an owner may configure.
 *
 * A role says WHERE a kind of output belongs and whether the owner's replies
 * there persist. It says nothing whatever about who may act: authorization is
 * frozen environment configuration and a role channel grants nobody anything.
 * See ADR 0023.
 */
export const CHANNEL_ROLES = ['briefing', 'task', 'coding', 'gpt'] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

/**
 * The unscoped names, accepted on a single-profile development box only.
 *
 * Production reads its own `DUCKY_PROD_*` and never these -- the same rule
 * every other cross-profile setting follows, and for the same reason: a
 * development channel id inherited by production would publish the owner's
 * real assistant output into a test channel.
 */
export const UNSCOPED_ROLE_CHANNEL_ENV = {
  briefing: 'DUCKY_BRIEFING_CHANNEL_ID',
  task: 'DUCKY_TASK_CHANNEL_ID',
  coding: 'DUCKY_CODING_CHANNEL_ID',
  gpt: 'DUCKY_GPT_CHANNEL_ID',
} as const satisfies Record<ChannelRole, string>;

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
