import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DISCORD_SNOWFLAKE, DUCKY_PROFILES, DuckyError, PROFILE_DEFAULT_CREDENTIALS_FILE,
  PROFILE_DEFAULT_DB_PATH, PROFILE_ENV,
  SCHEDULE_ATTACHMENTS_PER_HOUR, SCHEDULE_MAX_ATTACHMENT_BYTES, blankToUndefined, resolveDuckyProfile,
  type DuckyProfile,
} from '@ducky/contracts';

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? dflt : v === '1' || v.toLowerCase() === 'true'));

export const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),

  /**
   * Which Discord identity this instance is. The profiles are isolated: they
   * share no token, database, port or command scope, and never fall back to
   * one another.
   */
  DUCKY_PROFILE: z.enum(DUCKY_PROFILES).default('development'),
  /** Shown in diagnostics so two instances are never confused. */
  DUCKY_INSTANCE_LABEL: z.string().max(64).optional(),

  DUCKY_DB_PATH: z.string().optional(),
  DUCKY_HTTP_HOST: z.string().default('127.0.0.1'),
  DUCKY_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),

  OWNER_DISCORD_USER_ID: z.string(),
  CHAT_WHITELIST_USER_IDS: z.string().optional(),

  // Per-profile Discord credentials. Never shared, never cross-read.
  DISCORD_DEV_TOKEN: z.string().optional(),
  DISCORD_DEV_APP_ID: z.string().optional(),
  DISCORD_DEV_GUILD_ID: z.string().optional(),
  DISCORD_PROD_TOKEN: z.string().optional(),
  DISCORD_PROD_APP_ID: z.string().optional(),
  DISCORD_PROD_GUILD_ID: z.string().optional(),

  DISCORD_CDN_HOSTS: z.string().default('cdn.discordapp.com,media.discordapp.net'),

  /**
   * Opt-in shared job visibility. Comma-separated Discord channel ids;
   * default empty, which is the whole feature switched off.
   *
   * Profile-scoped like every other cross-profile setting. The unscoped name
   * stays accepted for a single-profile development box; production reads
   * ONLY its own, because inheriting a development channel id would publish
   * real job activity into a test channel.
   */
  DUCKY_SHARED_CHANNEL_IDS: z.string().optional(),
  DUCKY_DEV_SHARED_CHANNEL_IDS: z.string().optional(),
  DUCKY_PROD_SHARED_CHANNEL_IDS: z.string().optional(),

  // Profile-scoped secrets. The shared names remain accepted for a
  // single-profile development box, but production requires its own.
  DUCKY_COMPONENT_SIGNING_KEY: z.string().optional(),
  DUCKY_DEV_COMPONENT_SIGNING_KEY: z.string().optional(),
  DUCKY_PROD_COMPONENT_SIGNING_KEY: z.string().optional(),
  DUCKY_EXECUTOR_CREDENTIALS_FILE: z.string().optional(),
  DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE: z.string().optional(),
  DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE: z.string().optional(),
  DUCKY_EXECUTOR_CREDENTIALS: z.string().optional(),

  DUCKY_REPOS_FILE: z.string().optional(),

  OPENCLAW_BASE_URL: z.string().optional(),
  SCHEDULE_BINARY_EXTRACTION_ENABLED: bool(false),
  SCHEDULE_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(SCHEDULE_MAX_ATTACHMENT_BYTES),
  SCHEDULE_ATTACHMENTS_PER_HOUR: z.coerce.number().int().positive().default(SCHEDULE_ATTACHMENTS_PER_HOUR),

  DUCKY_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Per-profile defaults, so two instances cannot collide on a database file or
 * a port by accident. An explicit value always wins.
 */
const PROFILE_DEFAULTS: Record<
  DuckyProfile,
  { db: string; port: number; repos: string; credentials: string }
> = {
  development: {
    db: PROFILE_DEFAULT_DB_PATH.development,
    port: 8787,
    repos: './config/repos.dev.json',
    credentials: PROFILE_DEFAULT_CREDENTIALS_FILE.development,
  },
  production: {
    db: PROFILE_DEFAULT_DB_PATH.production,
    port: 8788,
    repos: './config/repos.json',
    credentials: PROFILE_DEFAULT_CREDENTIALS_FILE.production,
  },
};

export interface ResolvedPaths {
  readonly dbPath: string;
  readonly httpPort: number;
  readonly reposFile: string;
  readonly instanceLabel: string;
  readonly credentialsFile: string;
}

/**
 * Secrets resolved for the SELECTED profile only.
 *
 * Production must supply its own: falling back to a shared value would let a
 * development process hold production executor credentials, or let a control
 * minted by one bot verify on the other. Development may still use the shared
 * names, which keeps a single-profile local box simple.
 */
export interface ProfileSecrets {
  readonly componentSigningKey: string;
  readonly credentialsFile: string | undefined;
  readonly inlineCredentials: string | undefined;
}

/** The configured credential-file path for this profile, if any. */
function credentialsFileFor(env: Env): string | undefined {
  const isProd = env.DUCKY_PROFILE === 'production';
  const scoped = isProd
    ? env.DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE
    : env.DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE;
  // Production never inherits the shared variable.
  return scoped ?? (isProd ? undefined : env.DUCKY_EXECUTOR_CREDENTIALS_FILE);
}

export function resolveProfileSecrets(env: Env): ProfileSecrets {
  const names = PROFILE_ENV[env.DUCKY_PROFILE];
  const isProd = env.DUCKY_PROFILE === 'production';

  const scopedKey = isProd ? env.DUCKY_PROD_COMPONENT_SIGNING_KEY : env.DUCKY_DEV_COMPONENT_SIGNING_KEY;
  const componentSigningKey = scopedKey ?? (isProd ? undefined : env.DUCKY_COMPONENT_SIGNING_KEY);
  if (!componentSigningKey) {
    throw new DuckyError(
      'invalid_input',
      isProd
        ? `${names.componentKey} is required for the production profile; it never shares the development key.`
        : `${names.componentKey} or DUCKY_COMPONENT_SIGNING_KEY is required.`,
    );
  }

  return {
    componentSigningKey,
    credentialsFile: credentialsFileFor(env),
    // Inline credentials are a development convenience and are refused in
    // production by the store itself.
    inlineCredentials: isProd ? undefined : env.DUCKY_EXECUTOR_CREDENTIALS,
  };
}

export function resolvePaths(env: Env): ResolvedPaths {
  const d = PROFILE_DEFAULTS[env.DUCKY_PROFILE];
  return {
    dbPath: env.DUCKY_DB_PATH ?? d.db,
    httpPort: env.DUCKY_HTTP_PORT ?? d.port,
    reposFile: env.DUCKY_REPOS_FILE ?? d.repos,
    instanceLabel: env.DUCKY_INSTANCE_LABEL ?? `ducky-${env.DUCKY_PROFILE}`,
    // Path resolution stays independent of secret validation, so a missing
    // key surfaces as its own clear startup error rather than as a path error.
    credentialsFile: credentialsFileFor(env) ?? d.credentials,
  };
}

/**
 * An env-file assignment like `FOO=` loads as an empty string, not an unset
 * variable -- Node's --env-file-if-exists does not distinguish the two. Every
 * optional field in EnvSchema must therefore see blank the same as absent, or
 * a leftover blank line in .env.production silently overrides a profile
 * default instead of falling through to it.
 */
function blankValuesToUndefined(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = value === '' ? undefined : value;
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(blankValuesToUndefined(source));
}

/**
 * The channels in which a non-owner may see the safe job projection.
 *
 * This is a *visibility* setting, not an authorization one: it says WHERE
 * information may be shown, never WHO may act. Every write stays owner-only
 * and every owner-only reply stays ephemeral regardless of what is listed
 * here. Membership of a listed channel is enforced by Discord's own channel
 * permissions, so the channel must be locked down to the people intended to
 * see it -- exactly as the environment documentation says.
 *
 * Ids are validated as snowflakes at boot rather than trusted, so a typo
 * fails loudly instead of silently never matching.
 */
export function resolveSharedChannelIds(env: Env): readonly string[] {
  const names = PROFILE_ENV[env.DUCKY_PROFILE];
  const isProd = env.DUCKY_PROFILE === 'production';
  const scoped = isProd ? env.DUCKY_PROD_SHARED_CHANNEL_IDS : env.DUCKY_DEV_SHARED_CHANNEL_IDS;
  // Production never inherits the unscoped variable.
  const raw = scoped ?? (isProd ? undefined : env.DUCKY_SHARED_CHANNEL_IDS);

  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!DISCORD_SNOWFLAKE.test(id)) {
      throw new DuckyError(
        'invalid_input',
        `${names.sharedChannels} contains a value that is not a Discord channel id.`,
      );
    }
  }
  return Object.freeze([...new Set(ids)]);
}

export const cdnHosts = (env: Env): string[] =>
  env.DISCORD_CDN_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export const readReposFile = (path: string): string => readFileSync(path, 'utf8');

/**
 * DB and credential-file defaults for scripts that operate on a profile's
 * SQLite file directly (the `credentials` CLI) and cannot run the full env
 * schema -- it has no business requiring OWNER_DISCORD_USER_ID or a component
 * signing key just to issue a credential. Mirrors resolvePaths'/
 * credentialsFileFor's precedence: an explicit scoped var wins, then the
 * shared var (development only -- production never inherits it), then the
 * profile default.
 */
export function resolveCliPaths(env: NodeJS.ProcessEnv): { dbPath: string; credentialsFile: string } {
  const profile = resolveDuckyProfile(env['DUCKY_PROFILE']);
  const isProd = profile === 'production';
  const names = PROFILE_ENV[profile];

  const dbPath = blankToUndefined(env['DUCKY_DB_PATH']) ?? PROFILE_DEFAULT_DB_PATH[profile];

  const scoped = blankToUndefined(env[names.credentialsFile]);
  const shared = isProd ? undefined : blankToUndefined(env['DUCKY_EXECUTOR_CREDENTIALS_FILE']);
  const credentialsFile = scoped ?? shared ?? PROFILE_DEFAULT_CREDENTIALS_FILE[profile];

  return { dbPath, credentialsFile };
}
