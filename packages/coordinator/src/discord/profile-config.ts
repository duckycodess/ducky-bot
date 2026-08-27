import {
  DISCORD_SNOWFLAKE, DUCKY_PROFILES, DuckyError, PROFILE_ENV,
  type CommandScope, type DuckyProfile,
} from '@ducky/contracts';

export interface DiscordProfileConfig {
  readonly profile: DuckyProfile;
  /** Absent means run on the mock transport; only allowed in development. */
  readonly token: string | undefined;
  readonly appId: string | undefined;
  readonly guildId: string | undefined;
}

/**
 * Resolves the Discord identity for the selected profile.
 *
 * The two profiles share nothing: separate token, application id, guild and
 * command scope. There is deliberately no fallback between them, because
 * booting production with the development bot (or the reverse) would put test
 * traffic on the real assistant. A profile reads ONLY its own variables.
 *
 * Development may run without a token, which selects the mock transport and
 * keeps a local run fully exercisable. Production may not: it fails closed.
 */
export function resolveDiscordProfile(
  profileRaw: string,
  env: NodeJS.ProcessEnv,
): DiscordProfileConfig {
  if (!(DUCKY_PROFILES as readonly string[]).includes(profileRaw)) {
    throw new DuckyError(
      'invalid_input',
      `DUCKY_PROFILE must be one of ${DUCKY_PROFILES.join(' | ')}.`,
    );
  }
  const profile = profileRaw as DuckyProfile;
  const names = PROFILE_ENV[profile];

  const token = trimmed(env[names.token]);
  const appId = trimmed(env[names.appId]);
  const guildId = trimmed(env[names.guildId]);

  if (profile === 'production' && !token) {
    throw new DuckyError(
      'credential_unavailable',
      `${names.token} is required for the production profile; it never falls back to the development bot.`,
    );
  }
  if (token && !appId) {
    throw new DuckyError(
      'invalid_input',
      `${names.appId} is required whenever ${names.token} is set.`,
    );
  }
  for (const [label, value] of [
    [names.appId, appId],
    [names.guildId, guildId],
  ] as const) {
    if (value !== undefined && !DISCORD_SNOWFLAKE.test(value)) {
      throw new DuckyError('invalid_input', `${label} must be a Discord snowflake.`);
    }
  }
  if (profile === 'development' && token && !guildId) {
    throw new DuckyError(
      'invalid_input',
      `${names.guildId} is required for the development profile so its commands stay guild-scoped.`,
    );
  }

  return { profile, token, appId, guildId };
}

/**
 * Development registers to one guild, because guild commands appear
 * immediately. Production registers globally unless its OWN guild is
 * configured -- it never borrows the development guild, which would leak test
 * commands into the real bot.
 */
export function commandScopeFor(config: DiscordProfileConfig): CommandScope {
  if (config.profile === 'development') {
    if (!config.guildId) {
      throw new DuckyError(
        'invalid_input',
        `${PROFILE_ENV.development.guildId} is required to register development commands.`,
      );
    }
    return { kind: 'guild', guildId: config.guildId };
  }
  return config.guildId ? { kind: 'guild', guildId: config.guildId } : { kind: 'global' };
}

const trimmed = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};
