import { randomUUID, randomBytes } from 'node:crypto';

export type JobId = string;
export type PublicJobId = string;
export type LeaseId = string;
export type ExecutorId = string;
export type KeyId = string;

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

export type PublicTaskId = string;
export type PublicReminderId = string;

export const newUuid = (): string => randomUUID();

/**
 * A short, unambiguous, owner-typeable handle.
 *
 * The alphabet excludes i, l, o and u, so a handle read off a phone screen
 * cannot be mistyped into a different one. The one-letter prefix says what
 * kind of thing it names, which is what lets `/task done id:` refuse a
 * reminder id outright rather than reporting "not found".
 *
 * These are also DELIBERATELY not UUIDs on the display path: the outbound
 * redactor rewrites any bare GUID it sees, so a UUID printed in a message
 * would reach the owner as `[REDACTED:guid]` and be untypeable.
 */
function newShortHandle(prefix: string): string {
  const bytes = randomBytes(5);
  let out = '';
  for (const b of bytes) out += BASE32[b % 32];
  return `${prefix}${out}`;
}

export const newPublicJobId = (): PublicJobId => newShortHandle('j');
export const newPublicTaskId = (): PublicTaskId => newShortHandle('t');
export const newPublicReminderId = (): PublicReminderId => newShortHandle('r');

export const PUBLIC_JOB_ID_RE = /^j[0-9abcdefghjkmnpqrstvwxyz]{5}$/;
export const PUBLIC_TASK_ID_RE = /^t[0-9abcdefghjkmnpqrstvwxyz]{5}$/;
export const PUBLIC_REMINDER_ID_RE = /^r[0-9abcdefghjkmnpqrstvwxyz]{5}$/;
export const EXECUTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const REPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

export const newKeyId = (): KeyId => `k${randomBytes(4).toString('hex')}`;
