import { randomUUID, randomBytes } from 'node:crypto';

export type JobId = string;
export type PublicJobId = string;
export type LeaseId = string;
export type ExecutorId = string;
export type KeyId = string;

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

export const newUuid = (): string => randomUUID();

/** Short, unambiguous, owner-typeable job handle. */
export function newPublicJobId(): PublicJobId {
  const bytes = randomBytes(5);
  let out = '';
  for (const b of bytes) out += BASE32[b % 32];
  return `j${out}`;
}

export const PUBLIC_JOB_ID_RE = /^j[0-9abcdefghjkmnpqrstvwxyz]{5}$/;
export const EXECUTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const REPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

export const newKeyId = (): KeyId => `k${randomBytes(4).toString('hex')}`;
