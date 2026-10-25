/**
 * Shared engineering admission, protocol 1 (ADR 0031).
 *
 * ONE host-local ledger that every program able to start a managed agent on this
 * account must pass through: both Ducky profiles and the Agent Flow dispatcher.
 * The coordinator's own `engineering_admission` row stays as the local fact; the
 * ledger is the cross-program fence above it. This module is only the shared
 * vocabulary: the holder identity, the outcomes, the canonical repository key and
 * the conservative defaults. The SQLite implementation lives in
 * `@ducky/persistence`, and the private Agent Flow companion implements the same
 * wire facts (schema, arithmetic, outcome words) in Python.
 *
 * Invariants the ledger enforces by itself, structurally, so that a participant
 * with a bug is still constrained:
 *   - a repository (canonical lower-case GitHub owner/name) is held by at most one;
 *   - at most `globalCap` holds exist (Agent Flow's operator maximum, 2);
 *   - a Ducky hold is exclusive: admitted only into an EMPTY ledger, and while
 *     one exists nothing else is admitted, not the other profile, not Agent Flow;
 *   - the sum of reservations plus the notification reserve never exceeds the
 *     account ceiling;
 *   - a confirmed hold never expires. Only a never-confirmed `pending` hold times
 *     out, and that is safe ONLY because nothing launches before `confirm`.
 */

export const SHARED_ADMISSION_PROTOCOL = 'ducky-shared-admission';
export const SHARED_ADMISSION_SCHEMA_VERSION = 1 as const;

export const ADMISSION_PROGRAMS = ['ducky', 'agent-flow'] as const;
export type AdmissionProgram = (typeof ADMISSION_PROGRAMS)[number];

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Conservative defaults, written into a ledger at `init` and then immutable.
 * Estimates, not measurements and not a new owner decision: the ceiling is the
 * account envelope the owner authorized on 2026-10-19 (14 GiB `MemoryHigh`; the
 * 16 GiB `MemoryMax` is above it), used as a bound. A lower observed ceiling
 * always wins.
 */
export const SHARED_ADMISSION_DEFAULT_POLICY = {
  globalCap: 2,
  repoCap: 1,
  duckyExclusive: true,
  ceilingBytes: 14 * GIB,
  notificationReserveBytes: 512 * MIB,
  pendingTtlSeconds: 120,
} as const;

/** A Ducky hold reserves the engineering plus the provider estimate (executor defaults). */
export const DUCKY_ENGINEERING_RESERVE_DEFAULT_MIB = 2048;
export const DUCKY_PROVIDER_RESERVE_DEFAULT_MIB = 512;

/** The operator's authorized Agent Flow maximum. A ledger can never admit more. */
export const SHARED_ADMISSION_MAX_GLOBAL_CAP = 2;

export interface SharedAdmissionPolicy {
  readonly globalCap: number;
  readonly repoCap: 1;
  readonly duckyExclusive: true;
  readonly ceilingBytes: number;
  readonly notificationReserveBytes: number;
  readonly pendingTtlSeconds: number;
}

/** Who holds, exactly. All three parts must match for any operation on a fence. */
export interface AdmissionHolder {
  readonly program: AdmissionProgram;
  /** Durable per-database identity of the participant (a Ducky profile, one dispatcher). */
  readonly instanceId: string;
  /** The participant's own reference for the job. Never task content. */
  readonly jobRef: string;
}

export interface AdmissionRequest {
  readonly holder: AdmissionHolder;
  /** Canonical lower-case GitHub `owner/repository`; see {@link canonicalAdmissionRepoKey}. */
  readonly repoKey: string;
  readonly reserveBytes: number;
  /**
   * The fence this holder already knows it holds. An existing hold for the same
   * identity is adopted ONLY when this equals its fence; a different fence is
   * `identity_held`. A fence with NO hold behind it (released, reaped, never
   * issued, a ledger that lost it) is `resume_fence_missing`: a holder that says
   * "I already hold fence N" is never given a fresh hold instead, because that
   * would manufacture authority over work that may still be running. This is what stops a delayed release of an old
   * generation from freeing a newly acquired one: the old fence is never reused
   * and a name alone never adopts a hold.
   */
  readonly resumeFence?: number;
}

export type AdmissionRefusal =
  | 'invalid_request'
  | 'unavailable'
  | 'busy'
  | 'ledger_mismatch'
  | 'policy_mismatch'
  | 'global_cap'
  | 'repo_held'
  | 'ducky_exclusive'
  | 'ducky_present'
  | 'identity_held'
  | 'identity_conflict'
  /** A prior fence was presented but no hold stands on it (released, reaped, never issued). */
  | 'resume_fence_missing'
  | 'insufficient_memory'
  | 'observation_failed';

export type AdmissionAcquire =
  | {
      readonly ok: true;
      readonly fence: number;
      readonly state: 'pending' | 'confirmed';
      /** True when an existing hold of the same identity was returned unchanged. */
      readonly adopted: boolean;
    }
  | { readonly ok: false; readonly reason: AdmissionRefusal; readonly detail?: string };

export type AdmissionConfirm =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `gone`: never confirmed in time, released, or reaped. Nothing may launch. */
      readonly reason: 'gone' | 'not_holder' | 'unknown_fence' | 'ledger_mismatch' | 'unavailable';
    };

/**
 * `released` freed the hold. `gone` means the fence was issued and is no longer
 * held (an exact replay, or a hold that was never confirmed): nothing changed.
 * The other three refused and nothing changed.
 */
export type AdmissionReleaseOutcome =
  | 'released'
  | 'gone'
  | 'not_holder'
  | 'unknown_fence'
  | 'ledger_mismatch'
  | 'unavailable';

export type AdmissionVerifyOutcome =
  | 'confirmed'
  | 'pending'
  | 'gone'
  | 'not_holder'
  | 'unknown_fence'
  | 'ledger_mismatch'
  | 'unavailable';

/** Outcomes of a release that mean the delivery is finished and can be forgotten. */
export const RELEASE_SETTLED: readonly AdmissionReleaseOutcome[] = ['released', 'gone'];
/** Outcomes that must stop the runtime rather than be retried quietly. */
export const RELEASE_FATAL: readonly AdmissionReleaseOutcome[] = [
  'not_holder', 'unknown_fence', 'ledger_mismatch',
];

/** The port Ducky's coordinator uses. Synchronous: it runs inside a claim transaction. */
export interface SharedAdmissionLedgerPort {
  /** Verifies identity, policy and schema; throws nothing. */
  check(): { readonly ok: true; readonly ledgerId: string; readonly policyDigest: string } |
    { readonly ok: false; readonly reason: AdmissionRefusal; readonly detail?: string };
  acquire(request: AdmissionRequest): AdmissionAcquire;
  confirm(fence: number, holder: AdmissionHolder): AdmissionConfirm;
  release(fence: number, holder: AdmissionHolder): AdmissionReleaseOutcome;
  verify(fence: number, holder: AdmissionHolder): AdmissionVerifyOutcome;
}

const REPO_PART = /^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/;

/**
 * The cross-program repository key: GitHub `owner/repository`, lower-cased. NOT a
 * profile-local slug and NOT a path, so two programs that name or locate the
 * same repository differently still collide on it. Rejects anything that is not
 * exactly that shape (a `.git` suffix, a dot-segment, whitespace, a URL).
 */
export function canonicalAdmissionRepoKey(input: string): string | undefined {
  if (typeof input !== 'string' || input.length > 140) return undefined;
  const key = input.toLowerCase();
  if (!REPO_PART.test(key)) return undefined;
  const name = key.split('/')[1] ?? '';
  if (name === '.' || name === '..' || name.endsWith('.git') || name.endsWith('.')) return undefined;
  return key;
}

/** A positive, exactly representable reservation, or undefined. */
export const isSafeReserve = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 1024 * GIB;

export const mibToBytes = (mib: number): number => mib * MIB;

/**
 * A policy is acceptable only if every field is an exact integer in range and the
 * global cap does not exceed the authorized maximum. Returns the first problem,
 * or undefined. Used at `init`, on every open and by the tests, so the bound is
 * structural (the schema CHECK) AND an API refusal, not just a default.
 */
export function validateSharedAdmissionPolicy(p: SharedAdmissionPolicy): string | undefined {
  const int = (n: unknown, lo: number, hi: number): boolean =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= lo && n <= hi;
  if (!int(p.globalCap, 1, SHARED_ADMISSION_MAX_GLOBAL_CAP)) {
    return `globalCap must be an integer from 1 to ${SHARED_ADMISSION_MAX_GLOBAL_CAP}`;
  }
  if (p.repoCap !== 1) return 'repoCap must be 1';
  if (p.duckyExclusive !== true) return 'duckyExclusive must be true';
  if (!int(p.ceilingBytes, 1, 1024 * GIB)) return 'ceilingBytes must be a positive exact integer';
  if (!int(p.notificationReserveBytes, 0, 1024 * GIB)) return 'notificationReserveBytes must be a non-negative exact integer';
  if (p.notificationReserveBytes >= p.ceilingBytes) return 'the notification reserve must be below the ceiling';
  if (!int(p.pendingTtlSeconds, 5, 3600)) return 'pendingTtlSeconds must be an integer from 5 to 3600';
  return undefined;
}
