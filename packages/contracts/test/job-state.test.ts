import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS, InvalidTransitionError, JOB_STATES, assertTransition, canTransition,
  isTerminal,
} from '../src/job-state.js';

describe('job state machine', () => {
  it('allows every documented edge', () => {
    const legal: [string, string][] = [
      ['queued', 'running'],
      ['queued', 'waiting_for_executor'],
      ['waiting_for_executor', 'running'],
      ['running', 'needs_approval'],
      ['running', 'needs_owner_input'],
      ['running', 'waiting_for_executor'],
      ['needs_owner_input', 'queued'],
      ['needs_owner_input', 'cancelled'],
      ['needs_approval', 'cancelled'],
      ['needs_approval', 'completed'],
    ];
    for (const [from, to] of legal) {
      expect(canTransition(from as never, to as never), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects illegal edges', () => {
    const illegal: [string, string][] = [
      ['queued', 'needs_approval'],
      ['completed', 'running'],
      ['cancelled', 'queued'],
      ['failed', 'completed'],
      ['needs_approval', 'running'],
      ['needs_owner_input', 'running'],
      ['waiting_for_executor', 'needs_approval'],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from as never, to as never), `${from} -> ${to}`).toBe(false);
      expect(() => assertTransition(from as never, to as never)).toThrow(InvalidTransitionError);
    }
  });

  it('treats exactly the three end states as terminal with no outgoing edges', () => {
    for (const s of JOB_STATES) {
      if (isTerminal(s)) expect(ALLOWED_TRANSITIONS[s]).toHaveLength(0);
      else expect(ALLOWED_TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });
});
