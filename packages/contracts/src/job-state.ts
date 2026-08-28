export const JOB_STATES = [
  'queued',
  'waiting_for_executor',
  'running',
  'waiting_on_dependency',
  'needs_owner_input',
  'needs_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (s: JobState): boolean => TERMINAL_STATES.includes(s);

export const NONTERMINAL_STATES: readonly JobState[] = JOB_STATES.filter((s) => !isTerminal(s));

/**
 * The states in which an executor holds a live lease and may be writing.
 *
 * `running` is deliberately the ONLY one. The finer-grained engineering
 * progress -- preparing, planning, implementing, reviewing, fixing, verifying
 * -- is tracked as a WORK PHASE on the same row rather than as separate job
 * states, because the single-writer guarantees are all keyed on this set:
 * the partial unique index, the lease-expiry sweep, the cancel path and the
 * claim predicate. Splitting `running` into six states would have meant
 * rewriting every one of them, which is exactly the Phase 1 rewrite this
 * milestone is not. See ADR 0016.
 */
export const LEASE_BEARING_STATES: readonly JobState[] = ['running'];
export const isLeaseBearing = (s: JobState): boolean => LEASE_BEARING_STATES.includes(s);

/**
 * States in which the job is paused, holds NO lease, and is still expected to
 * make progress later. Each retains its repository reservation, so the work it
 * has already done is not raced by another job.
 */
export const PAUSED_STATES: readonly JobState[] = [
  'needs_owner_input',
  'needs_approval',
  'waiting_on_dependency',
];

export const ALLOWED_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['waiting_for_executor', 'running', 'cancelled', 'failed'],
  waiting_for_executor: ['running', 'cancelled', 'failed'],
  running: [
    'needs_approval',
    'needs_owner_input',
    'waiting_on_dependency',
    'completed',
    'failed',
    'cancelled',
    'waiting_for_executor',
  ],
  /**
   * A dependency wait resumes by being requeued, exactly as an answered
   * question is. It can also end at the owner's desk when the bounded check
   * budget runs out -- "I could not confirm this, you decide" -- which is the
   * honest outcome when no real checker is configured.
   */
  waiting_on_dependency: ['queued', 'needs_owner_input', 'failed', 'cancelled'],
  needs_owner_input: ['queued', 'cancelled', 'failed'],
  needs_approval: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: JobState, readonly to: JobState) {
    super(`invalid job transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

// ------------------------------------------------------------ work phases --

/**
 * Where a RUNNING job is in the engineering loop.
 *
 * This is a second, orthogonal dimension to `JobState`, not a replacement for
 * it. The job state answers "who owns this job right now and what may touch
 * it"; the work phase answers "what is the agent actually doing". Keeping them
 * apart is what lets the executor report fine-grained progress without any of
 * the single-writer machinery having to change.
 *
 * A phase is only ever set while the job is lease-bearing, and is cleared the
 * moment it stops being. A paused or finished job has no phase, because
 * nothing is happening.
 */
export const JOB_WORK_PHASES = [
  'preparing',
  'planning',
  'implementing',
  'reviewing',
  'fixing',
  'verifying',
] as const;

export type JobWorkPhase = (typeof JOB_WORK_PHASES)[number];

/** Where a freshly claimed job starts. */
export const INITIAL_WORK_PHASE: JobWorkPhase = 'preparing';

/**
 * The allowed moves, exhaustively.
 *
 * The loop is real, not decorative: review can send work back to fixing,
 * verification can fail and send it back to review or to fixing, and a fix can
 * reopen implementation. What is NOT allowed is going backwards to preparing
 * or planning once implementation has started -- that would be a new job, not a
 * phase change -- so those edges are absent and a report claiming one is
 * refused rather than silently accepted.
 *
 * Reporting the SAME phase again is always allowed and is a no-op; a retried
 * heartbeat must not be an error.
 */
export const ALLOWED_WORK_PHASE_TRANSITIONS: Record<JobWorkPhase, readonly JobWorkPhase[]> = {
  preparing: ['planning', 'implementing'],
  planning: ['implementing'],
  implementing: ['reviewing', 'verifying'],
  reviewing: ['fixing', 'verifying'],
  fixing: ['implementing', 'reviewing', 'verifying'],
  verifying: ['reviewing', 'fixing'],
};

export class InvalidWorkPhaseTransitionError extends Error {
  constructor(readonly from: JobWorkPhase | null, readonly to: JobWorkPhase) {
    super(`invalid work phase transition ${from ?? 'none'} -> ${to}`);
    this.name = 'InvalidWorkPhaseTransitionError';
  }
}

/**
 * `from === null` means the job has no phase yet, which only the first report
 * after a claim should see; any phase is a valid start from there.
 */
export function canTransitionWorkPhase(from: JobWorkPhase | null, to: JobWorkPhase): boolean {
  if (from === null) return true;
  if (from === to) return true;
  return ALLOWED_WORK_PHASE_TRANSITIONS[from].includes(to);
}

export function assertWorkPhaseTransition(from: JobWorkPhase | null, to: JobWorkPhase): void {
  if (!canTransitionWorkPhase(from, to)) throw new InvalidWorkPhaseTransitionError(from, to);
}
