import { z } from 'zod';
import {
  DEPENDENCY_DESCRIPTION_MAX, DEPENDENCY_EXTERNAL_KEY_MAX,
  DEPENDENCY_MAX_CHECKS, DEPENDENCY_MAX_WAIT_MS, DEPENDENCY_MIN_CHECK_INTERVAL_MS,
} from './limits.js';

/**
 * What a job can be blocked on.
 *
 * A CLOSED set, and narrow. A dependency is something the coordinator will
 * periodically ask about, so every value here has to be a thing a checker
 * could plausibly answer; an open string would be an invitation to encode a
 * whole workflow in free text and then have nothing able to resolve it.
 */
export const DEPENDENCY_TYPES = [
  /** A build or test run somewhere else has to finish. */
  'ci_run',
  /** A third-party service has to come back, or finish something. */
  'external_service',
  /** A package or artifact has to appear in a registry. */
  'package_publish',
  /** Another repository or branch has to change first. */
  'upstream_change',
  /** A person has to do something outside Ducky. */
  'human_action',
  /** Genuinely something else. Still bounded, still checked, still expires. */
  'other',
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/**
 * The lifecycle of one dependency record.
 *
 * `expired` and `failed` are kept distinct: expired means the bounded check
 * budget ran out without an answer (which hands the job to the owner), failed
 * means a checker positively reported that the dependency will not be
 * satisfied (which fails the job). Collapsing them would lose exactly the
 * distinction the owner needs.
 */
export const DEPENDENCY_STATES = [
  'waiting',
  'ready',
  'failed',
  'expired',
  'cancelled',
] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

/** What a single check can conclude. Deliberately three-valued. */
export const DEPENDENCY_CHECK_STATUSES = ['pending', 'ready', 'failed'] as const;
export type DependencyCheckStatus = (typeof DEPENDENCY_CHECK_STATUSES)[number];

export const DEPENDENCY_TYPE_LABEL = {
  ci_run: 'a CI run',
  external_service: 'an external service',
  package_publish: 'a package to be published',
  upstream_change: 'an upstream change',
  human_action: 'someone to do something',
  other: 'something else',
} as const satisfies Record<DependencyType, string>;

export const DEPENDENCY_STATE_LABEL = {
  waiting: 'Waiting',
  ready: 'Ready',
  failed: 'Will not be satisfied',
  expired: 'Gave up checking',
  cancelled: 'Cancelled',
} as const satisfies Record<DependencyState, string>;

/**
 * What an executor may ask for when it reports `waiting_on_dependency`.
 *
 * Closed and bounded in every field. There is no open `metadata` object and no
 * free-form schedule: a dependency the coordinator agrees to hold a repository
 * reservation for has to say what it is, roughly when to look again, and when
 * to stop looking. Every optional field has a safe default, and every value is
 * clamped again on the coordinator side — the executor proposes, the
 * coordinator decides.
 */
export const DependencyRequestSchema = z.strictObject({
  type: z.enum(DEPENDENCY_TYPES),
  description: z.string().min(1).max(DEPENDENCY_DESCRIPTION_MAX),
  /**
   * An opaque handle a checker can use: a run id, a package version, a ticket
   * reference. Never a URL to fetch and never a credential.
   */
  externalKey: z.string().max(DEPENDENCY_EXTERNAL_KEY_MAX).optional(),
  /** How long to wait before the FIRST check. Clamped to the configured floor. */
  nextCheckInSeconds: z
    .number()
    .int()
    .min(Math.floor(DEPENDENCY_MIN_CHECK_INTERVAL_MS / 1000))
    .max(Math.floor(DEPENDENCY_MAX_WAIT_MS / 1000))
    .optional(),
  /** Hard ceiling on how many times this will ever be checked. */
  maxChecks: z.number().int().min(1).max(DEPENDENCY_MAX_CHECKS).optional(),
  /** Wall-clock ceiling, independent of the check count. */
  deadlineInSeconds: z
    .number()
    .int()
    .min(Math.floor(DEPENDENCY_MIN_CHECK_INTERVAL_MS / 1000))
    .max(Math.floor(DEPENDENCY_MAX_WAIT_MS / 1000))
    .optional(),
});
export type DependencyRequest = z.infer<typeof DependencyRequestSchema>;

/** What a checker is told. No credentials, no URLs, no job internals. */
export interface DependencyCheckInput {
  readonly dependencyId: string;
  readonly type: DependencyType;
  readonly description: string;
  readonly externalKey: string | null;
  /** How many checks have already been made, including none. */
  readonly checksMade: number;
  readonly maxChecks: number;
  readonly deadlineAt: string;
}

export interface DependencyCheckOutcome {
  readonly status: DependencyCheckStatus;
  /** Owner-facing, redacted and clamped before it is stored. */
  readonly detail?: string;
}

/**
 * The reason a job left `waiting_on_dependency`, in the transition ledger.
 * Written down so the presenter and the tests read the same vocabulary.
 */
export const DEPENDENCY_RESOLUTIONS = {
  ready: 'dependency_ready',
  failed: 'dependency_failed',
  expired: 'dependency_check_budget_exhausted',
  cancelled: 'dependency_cancelled',
} as const;
