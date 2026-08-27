import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SCHEDULE_ATTACHMENTS_PER_HOUR, SCHEDULE_MAX_ATTACHMENT_BYTES } from '@ducky/contracts';

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? dflt : v === '1' || v.toLowerCase() === 'true'));

export const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DUCKY_DB_PATH: z.string().default('./data/ducky.db'),
  DUCKY_HTTP_HOST: z.string().default('127.0.0.1'),
  DUCKY_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  OWNER_DISCORD_USER_ID: z.string(),
  CHAT_WHITELIST_USER_IDS: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_APP_ID: z.string().optional(),
  DISCORD_CDN_HOSTS: z.string().default('cdn.discordapp.com,media.discordapp.net'),

  DUCKY_COMPONENT_SIGNING_KEY: z.string(),
  DUCKY_EXECUTOR_CREDENTIALS_FILE: z.string().optional(),
  DUCKY_EXECUTOR_CREDENTIALS: z.string().optional(),

  DUCKY_REPOS_FILE: z.string().default('./config/repos.json'),

  OPENCLAW_BASE_URL: z.string().optional(),
  SCHEDULE_BINARY_EXTRACTION_ENABLED: bool(false),
  SCHEDULE_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(SCHEDULE_MAX_ATTACHMENT_BYTES),
  SCHEDULE_ATTACHMENTS_PER_HOUR: z.coerce.number().int().positive().default(SCHEDULE_ATTACHMENTS_PER_HOUR),

  DUCKY_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}

export const cdnHosts = (env: Env): string[] =>
  env.DISCORD_CDN_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export const readReposFile = (path: string): string => readFileSync(path, 'utf8');
