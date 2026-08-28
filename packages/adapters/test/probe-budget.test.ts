import { describe, expect, it } from 'vitest';
import { JOB_MAX_WALL_CLOCK_MS } from '@ducky/contracts';
import {
  MAX_WATCH_BUDGET_MS, MIN_WATCH_BUDGET_MS, resolveWatchBudgetMs,
} from '../../../scripts/probe-live-job.js';

/**
 * The live probe's watch budget.
 *
 * `Number(process.env.PROBE_TIMEOUT_MS)` was unbounded and unvalidated, which
 * broke the bounded-probe contract two ways: a large value leaves a real Pi
 * agent with edit capability running for as long as somebody typed, and a
 * non-numeric value yields `NaN` — making `elapsed < NaN` false, so the watch
 * loop never ran and the probe read evidence from a job that had not started.
 * That second failure looks like a fast failure rather than a misconfiguration,
 * which is why it is refused rather than defaulted.
 */
describe('resolveWatchBudgetMs', () => {
  it('defaults when unset or blank', () => {
    expect(resolveWatchBudgetMs(undefined)).toBe(900_000);
    expect(resolveWatchBudgetMs('')).toBe(900_000);
    expect(resolveWatchBudgetMs('   ')).toBe(900_000);
  });

  it('accepts a sensible explicit value', () => {
    expect(resolveWatchBudgetMs('600000')).toBe(600_000);
  });

  it('REFUSES a non-numeric value rather than silently skipping the watch loop', () => {
    for (const bad of ['abc', 'ten minutes', 'NaN', '1e', '--5']) {
      expect(() => resolveWatchBudgetMs(bad), bad).toThrow(/must be a number/i);
    }
  });

  it('refuses Infinity, which would be an unbounded probe', () => {
    expect(() => resolveWatchBudgetMs('Infinity')).toThrow(/must be a number/i);
  });

  it('clamps below the floor, so the loop can always observe a turn', () => {
    expect(resolveWatchBudgetMs('0')).toBe(MIN_WATCH_BUDGET_MS);
    expect(resolveWatchBudgetMs('-1')).toBe(MIN_WATCH_BUDGET_MS);
    expect(resolveWatchBudgetMs('500')).toBe(MIN_WATCH_BUDGET_MS);
  });

  it('clamps above the ceiling, so a real Pi agent is never left running longer', () => {
    expect(resolveWatchBudgetMs('999999999')).toBe(MAX_WATCH_BUDGET_MS);
    expect(resolveWatchBudgetMs(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_WATCH_BUDGET_MS);
  });

  it('ceils no higher than a job can actually live', () => {
    // Watching longer than the job's own wall clock observes nothing.
    expect(MAX_WATCH_BUDGET_MS).toBeGreaterThan(JOB_MAX_WALL_CLOCK_MS);
    expect(MAX_WATCH_BUDGET_MS).toBeLessThanOrEqual(JOB_MAX_WALL_CLOCK_MS + 10 * 60_000);
  });

  it('returns a whole number of milliseconds', () => {
    expect(resolveWatchBudgetMs('120000.7')).toBe(120_000);
  });
});
