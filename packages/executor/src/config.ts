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
  /**
   * Where this profile's durable executor state lives (the pause outbox and the
   * dispatch journal). REQUIRED, absolute, and never defaulted: a path derived
   * from the executor id alone collides across profiles that share one, and an
   * implicit location is how state ends up where a cleanup timer can reach it.
   * Refused when it is under a temp or runtime directory.
   */
  DUCKY_EXECUTOR_STATE_DIR: z.string().startsWith('/'),
  DUCKY_HERDR_BIN: z.string().default('herdr'),
  DUCKY_HERDR_VERIFIED: z.string().optional(),

  /**
   * Whether to check the account's memory cgroup before every claim. `off` is
   * the default so a laptop or CI is unaffected; the remote runtime sets
   * `cgroup`, and with it on an unreadable or unlimited slice REFUSES to claim.
   */
  DUCKY_MEMORY_GUARD: z.enum(['off', 'cgroup']).default('off'),
  /** Overrides the user slice directory. Absolute, and only read when the guard is on. */
  DUCKY_MEMORY_CGROUP_DIR: z.string().startsWith('/').optional(),
  /**
   * Room one engineering job is assumed to need, and room kept free so the
   * coordinator can still notify the owner. Operator estimates in MiB, NOT
   * measurements of Pi's footprint: tune them from observed peak usage.
   */
  DUCKY_MEMORY_RESERVE_ENGINEERING_MIB: z.coerce.number().int().min(1).default(2048),
  DUCKY_MEMORY_RESERVE_NOTIFICATIONS_MIB: z.coerce.number().int().min(1).default(512),
  /**
   * Room kept free for the model provider's own process on this host. An
   * operator estimate like the others, not a measurement; set 0 only where no
   * provider process shares the account.
   */
  DUCKY_MEMORY_RESERVE_PROVIDER_MIB: z.coerce.number().int().min(0).default(512),
});

export type ExecutorEnv = z.infer<typeof ExecutorEnvSchema>;

export const loadExecutorEnv = (src: NodeJS.ProcessEnv = process.env): ExecutorEnv =>
  ExecutorEnvSchema.parse(src);
