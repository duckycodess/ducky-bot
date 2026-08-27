import { z } from 'zod';
import { CLAIM_MAX_WAIT_MS, EXECUTOR_ID_RE, KEY_ID_RE, LEASE_HEARTBEAT_MS } from '@ducky/contracts';

export const ExecutorEnvSchema = z.object({
  DUCKY_COORDINATOR_URL: z.string().url(),
  DUCKY_EXECUTOR_ID: z.string().regex(EXECUTOR_ID_RE),
  DUCKY_EXECUTOR_KEY_ID: z.string().regex(KEY_ID_RE),
  DUCKY_EXECUTOR_TOKEN: z.string().min(16),
  DUCKY_EXECUTOR_HMAC_SECRET: z.string().min(16),
  DUCKY_EXECUTOR_VERSION: z.string().default('0.1.0'),
  DUCKY_POLL_WAIT_MS: z.coerce.number().int().min(0).max(CLAIM_MAX_WAIT_MS).default(CLAIM_MAX_WAIT_MS),
  DUCKY_LEASE_HEARTBEAT_MS: z.coerce.number().int().positive().default(LEASE_HEARTBEAT_MS),
  DUCKY_HERDR_BIN: z.string().default('herdr'),
  DUCKY_HERDR_VERIFIED: z.string().optional(),
});

export type ExecutorEnv = z.infer<typeof ExecutorEnvSchema>;

export const loadExecutorEnv = (src: NodeJS.ProcessEnv = process.env): ExecutorEnv =>
  ExecutorEnvSchema.parse(src);
