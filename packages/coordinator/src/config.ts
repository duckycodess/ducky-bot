import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DUCKY_PROFILES, SCHEDULE_ATTACHMENTS_PER_HOUR, SCHEDULE_MAX_ATTACHMENT_BYTES,
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

  DUCKY_COMPONENT_SIGNING_KEY: z.string(),
  DUCKY_EXECUTOR_CREDENTIALS_FILE: z.string().optional(),
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
const PROFILE_DEFAULTS: Record<DuckyProfile, { db: string; port: number; repos: string }> = {
  development: { db: './data/ducky-dev.db', port: 8787, repos: './config/repos.dev.json' },
  production: { db: './data/ducky-prod.db', port: 8788, repos: './config/repos.json' },
};

export interface ResolvedPaths {
  readonly dbPath: string;
  readonly httpPort: number;
  readonly reposFile: string;
  readonly instanceLabel: string;
}

export function resolvePaths(env: Env): ResolvedPaths {
  const d = PROFILE_DEFAULTS[env.DUCKY_PROFILE];
  return {
    dbPath: env.DUCKY_DB_PATH ?? d.db,
    httpPort: env.DUCKY_HTTP_PORT ?? d.port,
    reposFile: env.DUCKY_REPOS_FILE ?? d.repos,
    instanceLabel: env.DUCKY_INSTANCE_LABEL ?? `ducky-${env.DUCKY_PROFILE}`,
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}

export const cdnHosts = (env: Env): string[] =>
  env.DISCORD_CDN_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export const readReposFile = (path: string): string => readFileSync(path, 'utf8');
