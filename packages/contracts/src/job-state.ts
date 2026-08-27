export const JOB_STATES = [
  'queued',
  'waiting_for_executor',
  'running',
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

export const ALLOWED_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['waiting_for_executor', 'running', 'cancelled', 'failed'],
  waiting_for_executor: ['running', 'cancelled', 'failed'],
  running: [
    'needs_approval',
    'needs_owner_input',
    'completed',
    'failed',
    'cancelled',
    'waiting_for_executor',
  ],
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
