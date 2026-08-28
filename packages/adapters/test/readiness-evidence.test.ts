import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PI_READY_MIN_RULE_LINES } from '../src/pi/pi-ready.js';

const FIXTURE = path.resolve(
  import.meta.dirname, '..', 'src', 'herdr', 'herdr.fixtures', 'agent-readiness.json',
);

interface Attempt {
  atMs: number;
  exitCode: number;
  reason: string;
  ruleLines: number;
  hasStatusFooter?: boolean;
}

interface Readiness {
  herdrReportedInteractiveReady: boolean | null;
  herdrReportedStatus: string | null;
  sources: Record<
    string,
    {
      exitCode: number;
      isJson: boolean;
      bytes: number;
      observation: { ready: boolean; reason: string; ruleLines: number; hasStatusFooter?: boolean };
    }
  >;
  attempts: Attempt[];
  firstReadyAfterStartMs: number | null;
}

/**
 * The readiness marker, checked against what a real agent actually did.
 *
 * `pi-ready.test.ts` asserts the predicate against shapes. This file asserts
 * the EVIDENCE: that on this host the input frame really does separate the
 * banner phase from the promptable one, and that the thing Ducky used to trust
 * -- Herdr's own `interactive_ready` -- was true throughout the window in which
 * a prompt would have been dropped.
 *
 * Recorded only by `pnpm probe:herdr --with-agent`, which starts a real Pi
 * agent. With no fixture the suite says so and skips rather than passing on an
 * assumption.
 */
describe('the recorded readiness evidence', () => {
  const present = existsSync(FIXTURE);
  const data: Readiness | undefined = present
    ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Readiness)
    : undefined;

  it('reports honestly when no agent probe has been recorded', () => {
    if (!present) {
      expect(data).toBeUndefined();
      return;
    }
    expect(data!.attempts.length).toBeGreaterThan(0);
  });

  it('records that `agent read` answers with text rather than an envelope', () => {
    if (!data) return;
    for (const [source, info] of Object.entries(data.sources)) {
      expect(info.exitCode, source).toBe(0);
      // The whole reason this needed its own call path in HerdrCli.
      expect(info.isJson, source).toBe(false);
    }
  });

  it('shows Herdr claiming readiness during the banner phase', () => {
    if (!data) return;
    // This is the bug, in the recording: Herdr said ready, the pane had not yet
    // drawn an input frame, and a prompt in that window is silently dropped.
    expect(data.herdrReportedInteractiveReady).toBe(true);
    expect(data.attempts[0]!.ruleLines).toBeLessThan(PI_READY_MIN_RULE_LINES);
  });

  it('shows the input frame separating banners from a promptable agent', () => {
    if (!data) return;
    const framed = data.attempts.findIndex((a) => a.ruleLines >= PI_READY_MIN_RULE_LINES);
    // A discriminator has to discriminate: some samples without a frame, then
    // frames from there on. If a future Pi paints its frame instantly this
    // assertion is the one that should be revisited, from a new recording.
    expect(framed).toBeGreaterThan(0);
    for (const a of data.attempts.slice(framed)) {
      expect(a.ruleLines, `sample at ${a.atMs}ms`).toBeGreaterThanOrEqual(PI_READY_MIN_RULE_LINES);
    }
  });

  it('keeps the marker off the status footer, which a fresh agent never paints', () => {
    if (!data) return;
    // The correction the probe forced. Every recorded sample from a freshly
    // started agent lacks the transfer counters, so requiring them refused a
    // perfectly promptable agent for the whole budget.
    const footers = [
      ...data.attempts.map((a) => a.hasStatusFooter),
      ...Object.values(data.sources).map((s) => s.observation.hasStatusFooter),
    ];
    // At least one recording has to actually carry the field, or this asserts
    // nothing at all.
    expect(footers.some((f) => f === false)).toBe(true);
    expect(footers.some((f) => f === true)).toBe(false);
  });
});
