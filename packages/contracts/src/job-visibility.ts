import type { JobState } from './job-state.js';

/**
 * The visibility vocabulary for jobs, kept in contracts because two very
 * different audiences render from it and neither may invent its own wording.
 *
 * A *phase* is the coarse, plain-language grouping of the persisted
 * `JobState`. The state machine itself is untouched -- `JOB_STATES`,
 * `ALLOWED_TRANSITIONS` and everything persisted stay exactly as they were.
 * This is a presentation-and-projection layer over it, so that:
 *
 * - the owner reads "Waiting for your answer" rather than `needs_owner_input`,
 * - a shared channel sees a deliberately coarser grouping that carries no
 *   private detail, and
 * - both are DETERMINISTIC: a total mapping, exhaustively checked by the type
 *   system, so a new job state cannot ship with no label and fall back to
 *   leaking a raw identifier.
 */
export const JOB_PHASES = [
  'queued',
  'working',
  'awaiting_owner_input',
  'awaiting_approval',
  'complete',
  'failed',
  'cancelled',
] as const;

export type JobPhase = (typeof JOB_PHASES)[number];

/**
 * Total map from persisted state to phase.
 *
 * `queued` and `waiting_for_executor` deliberately collapse into one phase:
 * the difference between them is an internal scheduling detail (whether an
 * executor is currently online), not something either audience can act on.
 */
export const JOB_STATE_PHASE = {
  queued: 'queued',
  waiting_for_executor: 'queued',
  running: 'working',
  needs_owner_input: 'awaiting_owner_input',
  needs_approval: 'awaiting_approval',
  completed: 'complete',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<JobState, JobPhase>;

export const phaseOf = (state: JobState): JobPhase => JOB_STATE_PHASE[state];

/** Plain-language state label. Identical for both audiences. */
export const JOB_PHASE_LABEL = {
  queued: 'Queued — waiting to start',
  working: 'Working',
  awaiting_owner_input: 'Paused — waiting for an answer',
  awaiting_approval: 'Paused — waiting for approval',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const satisfies Record<JobPhase, string>;

/**
 * What happens next, written for the OWNER: it names the controls they
 * actually have, because they are the only person who has them.
 */
export const OWNER_NEXT_STEP = {
  queued: 'Nothing to do. It starts as soon as an executor picks it up.',
  working: 'Nothing to do. You are notified when it needs you or finishes.',
  awaiting_owner_input:
    'Answer the question — use the Answer button, or `/job answer id:<id> answer:<text>`.',
  awaiting_approval:
    'Review each proposed action and Approve or Reject it. Nothing is performed until you do.',
  complete: 'Nothing to do. The result summary is below.',
  failed: 'Read the result, then resubmit if you still want the work. If the repository stayed reserved, use `/job cleanup`.',
  cancelled: 'Nothing to do. Any workspace was retained for inspection.',
} as const satisfies Record<JobPhase, string>;

/**
 * What happens next, written for a SHARED channel reader.
 *
 * Deliberately different copy rather than a reuse of the owner text: a
 * collaborator has no controls, so telling them to press Approve would be
 * both wrong and an invitation to try. It also states plainly that the detail
 * is private, so silence does not read as the system being stuck.
 */
export const SHARED_NEXT_STEP = {
  queued: 'Waiting for a development host to pick it up.',
  working: 'A development agent is working on it now.',
  awaiting_owner_input: 'Paused until the owner answers a question. The question itself is private.',
  awaiting_approval: 'Paused until the owner approves the proposed changes. The details are private.',
  complete: 'Finished. The summary here is the whole shared record.',
  failed: 'Stopped without finishing. The owner has the details.',
  cancelled: 'Stopped by the owner before it finished.',
} as const satisfies Record<JobPhase, string>;

export const ownerStateLabel = (state: JobState): string => JOB_PHASE_LABEL[phaseOf(state)];
export const ownerNextStep = (state: JobState): string => OWNER_NEXT_STEP[phaseOf(state)];
export const sharedNextStep = (state: JobState): string => SHARED_NEXT_STEP[phaseOf(state)];

/**
 * Stand-in emitted instead of a repository slug that is not in the operator's
 * current allowlist -- a job for a repository since removed from
 * configuration, for instance. The slug is operator-curated data, so a slug
 * that is no longer curated is not shared.
 */
export const UNLISTED_REPO_SLUG = 'an unlisted repository';

/** Shared summaries are clamped well below Discord's field limit. */
export const SHARED_SUMMARY_MAX = 400;

/**
 * The COMPLETE set of job information any non-owner may see.
 *
 * This is an allowlist by construction, not a redaction of `JobRow`: the
 * projection is built field by field from named sources, so a field added to
 * `JobRow` later is invisible here until somebody deliberately adds it. The
 * excluded set is the point of the type, so it is written down:
 *
 * NEVER present, in any shared output — task text, context, the owner's
 * Discord id, questions or answers, job events, transitions, reasons, raw
 * executor output, workspace ids or paths, retained workspace ids, executor
 * or lease ids, approval action details, and signed component controls.
 */
export interface SharedJobProjection {
  readonly publicId: string;
  /** An allowlisted slug, or `UNLISTED_REPO_SLUG`. Never a path. */
  readonly repoSlug: string;
  readonly phase: JobPhase;
  readonly label: string;
  readonly nextStep: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** Already redacted at result intake, then clamped. */
  readonly resultSummary: string | null;
  readonly resultVerdict: string | null;
}

/**
 * The projection's field names, so a test can assert the shape has not grown
 * a field without anyone reviewing whether it is safe to share.
 */
export const SHARED_JOB_PROJECTION_KEYS = [
  'publicId',
  'repoSlug',
  'phase',
  'label',
  'nextStep',
  'createdAt',
  'updatedAt',
  'finishedAt',
  'resultSummary',
  'resultVerdict',
] as const satisfies readonly (keyof SharedJobProjection)[];
