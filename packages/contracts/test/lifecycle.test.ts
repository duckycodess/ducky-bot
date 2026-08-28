import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS, ALLOWED_WORK_PHASE_TRANSITIONS, INITIAL_WORK_PHASE,
  InvalidWorkPhaseTransitionError, JOB_STATES, JOB_WORK_PHASES, LEASE_BEARING_STATES,
  PAUSED_STATES, TERMINAL_STATES,
  assertWorkPhaseTransition, canTransition, canTransitionWorkPhase, isLeaseBearing,
  isTerminal,
} from '../src/job-state.js';
import {
  DEPENDENCY_MAX_WAIT_MS, JOB_PHASE_LABEL, JOB_STATE_PHASE, OWNER_NEXT_STEP,
  RESERVATION_TTL_MS, SHARED_NEXT_STEP, ownerDetailedLabel, phaseOf,
} from '../src/index.js';

describe('waiting_on_dependency as a job state', () => {
  it('is nonterminal, holds no lease, and is a paused state', () => {
    expect(JOB_STATES).toContain('waiting_on_dependency');
    expect(isTerminal('waiting_on_dependency')).toBe(false);
    expect(isLeaseBearing('waiting_on_dependency')).toBe(false);
    expect(PAUSED_STATES).toContain('waiting_on_dependency');
  });

  it('is reachable only from running, and leaves only in four ways', () => {
    const reachesIt = JOB_STATES.filter((s) => canTransition(s, 'waiting_on_dependency'));
    expect(reachesIt).toEqual(['running']);
    expect([...ALLOWED_TRANSITIONS.waiting_on_dependency].sort()).toEqual(
      ['cancelled', 'failed', 'needs_owner_input', 'queued'].sort(),
    );
  });

  it('can be requeued, which is what makes resuming possible at all', () => {
    expect(canTransition('waiting_on_dependency', 'queued')).toBe(true);
    // ...and cannot skip straight to a finished result.
    expect(canTransition('waiting_on_dependency', 'completed')).toBe(false);
    expect(canTransition('waiting_on_dependency', 'running')).toBe(false);
  });

  it('holds a reservation that outlives the longest permitted wait', () => {
    const ttl = RESERVATION_TTL_MS['waiting_on_dependency'];
    expect(typeof ttl).toBe('number');
    // Otherwise the reservation sweep would fail a job that was still on
    // schedule and still inside its own bounds.
    expect(ttl as number).toBeGreaterThan(DEPENDENCY_MAX_WAIT_MS);
  });

  it('has a phase, a label and both next-step strings, like every other state', () => {
    const phase = phaseOf('waiting_on_dependency');
    expect(phase).toBe('awaiting_dependency');
    expect(JOB_PHASE_LABEL[phase]).toMatch(/waiting on something else/i);
    expect(OWNER_NEXT_STEP[phase].length).toBeGreaterThan(0);
    expect(SHARED_NEXT_STEP[phase].length).toBeGreaterThan(0);
    // The shared copy must not describe what is being waited for.
    expect(SHARED_NEXT_STEP[phase]).toMatch(/private/i);
  });
});

describe('the state machine is still exhaustive and still safe', () => {
  it('maps every state to a phase, a label and both next steps', () => {
    for (const state of JOB_STATES) {
      const phase = JOB_STATE_PHASE[state];
      expect(phase, state).toBeDefined();
      expect(JOB_PHASE_LABEL[phase], state).not.toBe(state);
      expect(OWNER_NEXT_STEP[phase], state).toBeTruthy();
      expect(SHARED_NEXT_STEP[phase], state).toBeTruthy();
    }
  });

  it('keeps `running` as the ONLY lease-bearing state', () => {
    // The partial unique index, the lease-expiry sweep and the cancel path are
    // all keyed on this. Widening it is a deliberate migration, never a
    // side effect of adding a state.
    expect(LEASE_BEARING_STATES).toEqual(['running']);
  });

  it('lets no terminal state transition anywhere', () => {
    for (const t of TERMINAL_STATES) expect(ALLOWED_TRANSITIONS[t]).toEqual([]);
  });

  it('gives every nonterminal state a reservation TTL', () => {
    for (const state of JOB_STATES) {
      if (isTerminal(state)) continue;
      expect(RESERVATION_TTL_MS[state], state).toBeDefined();
    }
  });
});

describe('work phases', () => {
  it('starts a claimed job at preparing', () => {
    expect(INITIAL_WORK_PHASE).toBe('preparing');
    expect(JOB_WORK_PHASES).toContain(INITIAL_WORK_PHASE);
  });

  it('accepts the engineering loop and refuses going backwards to planning', () => {
    expect(canTransitionWorkPhase('preparing', 'planning')).toBe(true);
    expect(canTransitionWorkPhase('planning', 'implementing')).toBe(true);
    expect(canTransitionWorkPhase('implementing', 'reviewing')).toBe(true);
    // The loop is real: review sends work back, verification can too.
    expect(canTransitionWorkPhase('reviewing', 'fixing')).toBe(true);
    expect(canTransitionWorkPhase('fixing', 'reviewing')).toBe(true);
    expect(canTransitionWorkPhase('verifying', 'fixing')).toBe(true);

    // Re-planning after implementation started would be a new job, not a phase.
    expect(canTransitionWorkPhase('implementing', 'planning')).toBe(false);
    expect(canTransitionWorkPhase('reviewing', 'preparing')).toBe(false);
    expect(() => assertWorkPhaseTransition('implementing', 'preparing')).toThrow(
      InvalidWorkPhaseTransitionError,
    );
  });

  it('treats the same phase as a no-op, because a retried heartbeat is normal', () => {
    for (const phase of JOB_WORK_PHASES) {
      expect(canTransitionWorkPhase(phase, phase), phase).toBe(true);
      expect(() => assertWorkPhaseTransition(phase, phase)).not.toThrow();
    }
  });

  it('accepts any phase as a first report, when there is none yet', () => {
    for (const phase of JOB_WORK_PHASES) {
      expect(canTransitionWorkPhase(null, phase), phase).toBe(true);
    }
  });

  it('names only known phases on every edge, so nothing is unreachable or invented', () => {
    for (const [from, tos] of Object.entries(ALLOWED_WORK_PHASE_TRANSITIONS)) {
      expect(JOB_WORK_PHASES, from).toContain(from);
      for (const to of tos) expect(JOB_WORK_PHASES, `${from}->${to}`).toContain(to);
    }
    // Every phase except the first is reachable from somewhere.
    const reachable = new Set(Object.values(ALLOWED_WORK_PHASE_TRANSITIONS).flat());
    for (const phase of JOB_WORK_PHASES) {
      if (phase === INITIAL_WORK_PHASE) continue;
      expect(reachable.has(phase), phase).toBe(true);
    }
  });
});

describe('the detailed owner label', () => {
  it('refines only a running job, and never invents a phase', () => {
    expect(ownerDetailedLabel('running', 'reviewing')).toBe('Working — reviewing');
    expect(ownerDetailedLabel('running', null)).toBe('Working');
    // A stale phase on a paused or finished job must never be rendered.
    expect(ownerDetailedLabel('needs_approval', 'reviewing')).toBe(
      JOB_PHASE_LABEL.awaiting_approval,
    );
    expect(ownerDetailedLabel('completed', 'verifying')).toBe(JOB_PHASE_LABEL.complete);
    expect(ownerDetailedLabel('waiting_on_dependency', 'implementing')).toBe(
      JOB_PHASE_LABEL.awaiting_dependency,
    );
  });
});
