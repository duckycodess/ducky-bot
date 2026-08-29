import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  BRIEFING_DELIVERY_MODES, assertValidSlotTime, type BriefingDelivery,
} from './domain/briefing-notifications.service.js';
import { assertNoChannelRoleConflicts } from './domain/channel-roles.js';
import {
  CHANNEL_ROLES, UNSCOPED_ROLE_CHANNEL_ENV, type ChannelRole,
  DISCORD_SNOWFLAKE, DUCKY_PROFILES, DuckyError, PROFILE_DEFAULT_CREDENTIALS_FILE,
  PROFILE_DEFAULT_DB_PATH, PROFILE_ENV,
  CONVERSATION_ATTACHMENTS_PER_HOUR, CONVERSATION_MAX_ATTACHMENT_BYTES,
  CONVERSATION_MEMORY_TURNS_DEFAULT, CONVERSATION_MEMORY_TURNS_MAX, DEFAULT_OWNER_TIMEZONE,
  SCHEDULE_ATTACHMENTS_PER_HOUR, SCHEDULE_MAX_ATTACHMENT_BYTES, assertValidTimeZone,
  blankToUndefined, resolveConversationMode, resolveDuckyProfile,
  type ConversationProviderMode, type DuckyProfile,
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

  /**
   * The owner's PRIVATE assistant channels, one per role.
   *
   * Distinct from the shared-channel list in what they mean, not just in who
   * reads them: a role channel is where a kind of output belongs AND where the
   * owner's replies persist instead of vanishing. Configuring one is a
   * statement that the channel is private enough for that; Ducky cannot check
   * channel membership and does not pretend to.
   *
   * Profile-scoped like every other cross-profile setting. The unscoped names
   * stay accepted for a single-profile development box; production reads ONLY
   * its own.
   */
  DUCKY_BRIEFING_CHANNEL_ID: z.string().optional(),
  DUCKY_TASK_CHANNEL_ID: z.string().optional(),
  DUCKY_CODING_CHANNEL_ID: z.string().optional(),
  DUCKY_GPT_CHANNEL_ID: z.string().optional(),
  DUCKY_DEV_BRIEFING_CHANNEL_ID: z.string().optional(),
  DUCKY_DEV_TASK_CHANNEL_ID: z.string().optional(),
  DUCKY_DEV_CODING_CHANNEL_ID: z.string().optional(),
  DUCKY_DEV_GPT_CHANNEL_ID: z.string().optional(),
  DUCKY_PROD_BRIEFING_CHANNEL_ID: z.string().optional(),
  DUCKY_PROD_TASK_CHANNEL_ID: z.string().optional(),
  DUCKY_PROD_CODING_CHANNEL_ID: z.string().optional(),
  DUCKY_PROD_GPT_CHANNEL_ID: z.string().optional(),

  // Consequential action execution is separately opt-in per profile. The
  // default is false, so an approval remains a recorded decision unless an
  // operator deliberately enables the matching profile flag.
  DUCKY_APPROVED_ACTIONS_ENABLED: bool(false),
  DUCKY_DEV_APPROVED_ACTIONS_ENABLED: bool(false),
  DUCKY_PROD_APPROVED_ACTIONS_ENABLED: bool(false),

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

  /**
   * Which conversational backend answers. Explicit, never inferred.
   *
   * Development may omit it and get the marked mock. PRODUCTION MUST CHOOSE:
   * see `resolveConversationMode`, which refuses an unset value and refuses
   * `mock` outright for production, because a canned reply must never be
   * mistaken for a real one.
   */
  DUCKY_CONVERSATION_PROVIDER: z.string().optional(),
  OPENCLAW_BASE_URL: z.string().optional(),
  /**
   * Which OpenClaw PROFILE store to run turns under: `dev` (the isolated
   * `~/.openclaw-dev` state) or `default`.
   *
   * A choice about which local account store to use, not a claim that a backend
   * exists -- so it does not offend ADR 0019, which forbids asserting a
   * provider into existence from configuration. `dev` is the default because
   * that is where the recorded contract was observed and where the signed-in
   * account on this host lives; a production host that signed in under its own
   * default profile sets `default`.
   */
  OPENCLAW_PROFILE: z.enum(['dev', 'default']).default('dev'),
  /**
   * A real model turn is not a fast HTTP call. The old 30 s default was a
   * gateway-request timeout inherited from the adapter that assumed HTTP, and
   * it would kill a normal reasoning turn.
   */
  OPENCLAW_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /**
   * Operator opt-in for conversation attachments. Default OFF.
   *
   * This is the answer to "does the owner confirm per upload, per provider, or
   * once in configuration?" -- once, in configuration, and it is one of three
   * conditions rather than the only one: the provider must also report itself
   * verified AND attachment-capable before a single byte is fetched. Enabling
   * this alone changes nothing while every provider on this host is
   * unverified.
   */
  CONVERSATION_ATTACHMENTS_ENABLED: bool(false),
  CONVERSATION_MAX_ATTACHMENT_BYTES: z.coerce
    .number().int().positive().default(CONVERSATION_MAX_ATTACHMENT_BYTES),
  CONVERSATION_ATTACHMENTS_PER_HOUR: z.coerce
    .number().int().positive().default(CONVERSATION_ATTACHMENTS_PER_HOUR),

  /**
   * Bounded conversation continuity. Default OFF.
   *
   * Until this existed the honest answer to "is my conversation stored?" was
   * "nothing is stored", and `/forget conversation` said so. Enabling this
   * changes that answer, so it is a decision an operator makes rather than one
   * they inherit -- see ADR 0021. With it off, nothing is written, nothing is
   * replayed, and `/forget conversation` still deletes anything an earlier run
   * stored.
   */
  DUCKY_CONVERSATION_MEMORY_ENABLED: bool(false),
  /** How many earlier turns are replayed as context. */
  DUCKY_CONVERSATION_MEMORY_TURNS: z.coerce
    .number().int().min(2).max(CONVERSATION_MEMORY_TURNS_MAX)
    .default(CONVERSATION_MEMORY_TURNS_DEFAULT),

  /**
   * Proactive briefings, pushed to the owner's DM. Default OFF.
   *
   * A briefing was pulled until now, and pushing one needs a delivery time --
   * which is exactly why 2B deferred it rather than guessing an hour. Times are
   * LOCAL wall clock in `DUCKY_OWNER_TIMEZONE` and validated at startup, so a
   * typo fails at boot rather than at 07:00.
   */
  DUCKY_BRIEFING_ENABLED: bool(false),
  DUCKY_BRIEFING_MORNING_AT: z.string().max(5).default('07:30'),
  DUCKY_BRIEFING_EVENING_AT: z.string().max(5).default('20:30'),
  /**
   * Where a proactive briefing goes. `dm` is the default and is what every
   * existing instance already does, so an upgrade changes nothing.
   */
  DUCKY_BRIEFING_DELIVERY: z.enum(BRIEFING_DELIVERY_MODES).default('dm'),

  SCHEDULE_BINARY_EXTRACTION_ENABLED: bool(false),
  SCHEDULE_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(SCHEDULE_MAX_ATTACHMENT_BYTES),
  SCHEDULE_ATTACHMENTS_PER_HOUR: z.coerce.number().int().positive().default(SCHEDULE_ATTACHMENTS_PER_HOUR),

  /**
   * Which checker answers "is this dependency ready yet?".
   *
   * `none` (the default) is the shipped `UnavailableDependencyChecker`: it
   * answers `pending` for everything, so a wait always ends at the owner's desk.
   * `github` reads CI status from the existing READ-ONLY `gh` surface. It can
   * fail a job on a definite CI failure; it cannot resume one here, because it
   * reports itself unverified and the resolver refuses a `ready` from an
   * unexercised checker.
   */
  DUCKY_DEPENDENCY_CHECKER: z.enum(['none', 'github']).default('none'),

  DUCKY_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  /** `json` (default) or `text` for a readable local run. */
  DUCKY_LOG_FORMAT: z.enum(['json', 'text']).default('json'),

  /**
   * Retention. OFF by default, because this deletes the owner's own records.
   *
   * With `ENABLED` false no window below is consulted and nothing is ever
   * removed, so an operator has to choose retention rather than inherit it.
   * Every window is a floor of one day: a zero would mean "delete as soon as it
   * finishes", which is not a retention policy.
   */
  DUCKY_RETENTION_ENABLED: bool(false),
  /**
   * Per-record-kind windows. The defaults are deliberately conservative and
   * deliberately DIFFERENT from each other: a job's shape, a job's detailed
   * result, a finished task and a past schedule entry are not the same kind of
   * thing, and one number for all of them meant choosing which to get wrong.
   */
  DUCKY_RETENTION_JOB_METADATA_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_JOB_DETAIL_DAYS: z.coerce.number().int().min(1).default(30),
  DUCKY_RETENTION_DONE_CAPTURE_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_CLOSED_TASK_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_CLOSED_REMINDER_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_PAST_SCHEDULE_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_AUDIT_DAYS: z.coerce.number().int().min(1).default(90),
  /**
   * DEPRECATED aliases, still honoured. An operator who set one expressed an
   * intent, and silently ignoring a variable still sitting in their env file is
   * worse than honouring it. An explicit new value always wins.
   */
  DUCKY_RETENTION_TERMINAL_JOBS_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS: z.coerce.number().int().min(1).optional(),
  DUCKY_RETENTION_WATCH_EVENTS_DAYS: z.coerce.number().int().min(1).default(90),
  DUCKY_RETENTION_IDEMPOTENCY_DAYS: z.coerce.number().int().min(1).default(7),
  /**
   * Stored conversation turns, by who said them. The owner's own history is
   * kept longer than a whitelist guest's, because they are not the same thing.
   */
  DUCKY_RETENTION_CONVERSATION_OWNER_DAYS: z.coerce.number().int().min(1).default(30),
  DUCKY_RETENTION_CONVERSATION_OTHER_DAYS: z.coerce.number().int().min(1).default(7),
  DUCKY_RETENTION_BATCH: z.coerce.number().int().min(1).max(10_000).default(200),

  /**
   * The owner's own timezone, as an IANA name (`Asia/Manila`, `UTC`).
   *
   * Used ONLY as a projection: to decide which civil day an instant falls in,
   * and to turn a typed wall-clock time into an instant. Every timestamp is
   * still stored as ISO-8601 UTC, so changing this re-renders existing rows
   * and never rewrites them.
   *
   * Validated at startup rather than at first use -- see `assertValidTimeZone`
   * -- so a typo fails loudly at boot instead of silently shifting a day
   * boundary months later.
   */
  DUCKY_OWNER_TIMEZONE: z.string().max(64).default(DEFAULT_OWNER_TIMEZONE),
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
export const resolveApprovedActionsEnabled = (env: Env): boolean =>
  env.DUCKY_PROFILE === 'production'
    ? env.DUCKY_PROD_APPROVED_ACTIONS_ENABLED
    : env.DUCKY_DEV_APPROVED_ACTIONS_ENABLED || env.DUCKY_APPROVED_ACTIONS_ENABLED;

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

/**
 * The owner's private assistant channels, per role, for THIS profile.
 *
 * Same authority model and same isolation as `resolveSharedChannelIds`:
 * frozen environment configuration, validated as Discord snowflakes, and
 * production never inheriting the unscoped name.
 *
 * Conflicts are refused here rather than resolved, so a channel that means two
 * things fails at boot instead of quietly picking one.
 */
export function resolveChannelRoles(env: Env): Partial<Record<ChannelRole, string>> {
  const names = PROFILE_ENV[env.DUCKY_PROFILE];
  const isProd = env.DUCKY_PROFILE === 'production';

  const roles: Partial<Record<ChannelRole, string>> = {};
  for (const role of CHANNEL_ROLES) {
    const scopedName = names.roleChannels[role];
    const scoped = blankToUndefined(env[scopedName as keyof Env] as string | undefined);
    const unscoped = isProd
      ? undefined
      : blankToUndefined(env[UNSCOPED_ROLE_CHANNEL_ENV[role] as keyof Env] as string | undefined);
    const raw = scoped ?? unscoped;
    if (raw === undefined) continue;

    if (!DISCORD_SNOWFLAKE.test(raw)) {
      throw new DuckyError(
        'invalid_input',
        `${scopedName} is not a Discord channel id.`,
      );
    }
    roles[role] = raw;
  }

  assertNoChannelRoleConflicts(
    roles,
    resolveSharedChannelIds(env),
    (role) => names.roleChannels[role],
  );
  return roles;
}

/**
 * The configured owner timezone, validated.
 *
 * Not profile-scoped: it describes the person, not the bot, and the two
 * profiles are the same person's development and production assistants.
 */
export const resolveOwnerTimeZone = (env: Env): string =>
  assertValidTimeZone(env.DUCKY_OWNER_TIMEZONE.trim());

/**
 * The conversational backend for THIS profile, decided at startup.
 *
 * Not profile-scoped in name -- there is one variable -- but the RULES are
 * profile-dependent, and production fails closed rather than defaulting.
 */
export const resolveConversationProvider = (env: Env): ConversationProviderMode =>
  resolveConversationMode(env.DUCKY_CONVERSATION_PROVIDER, env.DUCKY_PROFILE);

/**
 * Conversation continuity, resolved for this profile.
 *
 * The excluded thread keys are the configured SHARED channels. A conversation
 * message carries no channel context, but its thread key IS the channel id --
 * so this is the one place the two can be compared, and a channel other people
 * can read never becomes a store of the owner's words nor a source of context.
 */
export const resolveConversationMemory = (env: Env): {
  enabled: boolean;
  turns: number;
  excludedThreadKeys: readonly string[];
} => ({
  enabled: env.DUCKY_CONVERSATION_MEMORY_ENABLED,
  turns: env.DUCKY_CONVERSATION_MEMORY_TURNS,
  excludedThreadKeys: resolveSharedChannelIds(env),
});

/**
 * The proactive-briefing schedule, validated.
 *
 * Both times are checked here, at startup, for the same reason the timezone is:
 * a briefing that fired at an hour nobody configured would be worse than none.
 */
export const resolveBriefingSchedule = (env: Env): {
  enabled: boolean;
  morningAt: string;
  eveningAt: string;
  delivery: BriefingDelivery;
  channelId?: string | undefined;
} => {
  const delivery = env.DUCKY_BRIEFING_DELIVERY;
  const channelId = resolveChannelRoles(env).briefing;

  /**
   * A briefing addressed to a channel that is not configured would fail once a
   * day, quietly, forever. Refused at startup instead -- and never silently
   * downgraded to a DM, because the owner said where they wanted it.
   */
  if (delivery !== 'dm' && channelId === undefined) {
    const name = PROFILE_ENV[env.DUCKY_PROFILE].roleChannels.briefing;
    throw new DuckyError(
      'invalid_input',
      `DUCKY_BRIEFING_DELIVERY=${delivery} needs ${name} to name the channel it delivers to.`,
    );
  }

  return {
    enabled: env.DUCKY_BRIEFING_ENABLED,
    morningAt: assertValidSlotTime(env.DUCKY_BRIEFING_MORNING_AT, 'DUCKY_BRIEFING_MORNING_AT'),
    eveningAt: assertValidSlotTime(env.DUCKY_BRIEFING_EVENING_AT, 'DUCKY_BRIEFING_EVENING_AT'),
    delivery,
    ...(channelId === undefined ? {} : { channelId }),
  };
};

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
