import { describe, expect, it } from 'vitest';
import {
  BASELINE_MARKER_CANDIDATE_LIMIT, BASELINE_MARKER_MAX, BASELINE_MARKER_PREFIX, classifyBaselineMarker,
  encodeBaselineMarker, isReservedMarkerIdentity, type MarkerCandidate,
} from '../src/watch-baseline-marker.js';

/**
 * The classifier is the only authority on what a baseline marker is. A row that nearly
 * matches is an ordinary event and must never suppress, count as a marker, or be flagged.
 */
const B = 1_760_313_599_999; // 2025-10-12T23:59:59.999Z: the second-before shape (B % 1000 === 999)
const AT = new Date(B).toISOString();
const COMMIT = new Date(B + 5_000).toISOString();

const good = (over: Partial<MarkerCandidate> = {}): MarkerCandidate => ({
  kind: 'ci_started', origin: 'observed', identity: `baseline-marker:v1:ci_started:12345:${B}`,
  occurredAt: AT, payloadJson: '{}', held: 0, alertedAt: COMMIT, digestedAt: COMMIT, createdAt: COMMIT,
  ...over,
});

describe('classifyBaselineMarker', () => {
  it('accepts exactly the row a baseline writes', () => {
    expect(classifyBaselineMarker(good())).toEqual({ runId: '12345', boundaryMs: B });
    expect(classifyBaselineMarker(good({ held: false }))).toEqual({ runId: '12345', boundaryMs: B });
    expect(classifyBaselineMarker(good({ identity: `baseline-marker:v1:ci_started:0:${B}` }))?.runId).toBe('0');
  });

  const near: readonly (readonly [string, Partial<MarkerCandidate>])[] = [
    ['wrong kind', { kind: 'ci_failed' }],
    ['imported origin', { origin: 'imported' }],
    ['non-empty payload', { payloadJson: '{"workflow":"x"}' }],
    ['spaced empty payload', { payloadJson: '{ }' }],
    ['occurred_at not the boundary', { occurredAt: new Date(B - 1000).toISOString() }],
    ['boundary not ending 999', { identity: `baseline-marker:v1:ci_started:12345:${B - 1}`, occurredAt: new Date(B - 1).toISOString() }],
    ['leading zero in the run id', { identity: `baseline-marker:v1:ci_started:012345:${B}` }],
    ['leading zero in the boundary', { identity: `baseline-marker:v1:ci_started:12345:0${B}` }],
    ['version 2', { identity: `baseline-marker:v2:ci_started:12345:${B}` }],
    ['unknown version', { identity: `baseline-marker:v10:ci_started:12345:${B}` }],
    ['unsafe run id', { identity: `baseline-marker:v1:ci_started:9007199254740993:${B}` }],
    ['trailing suffix', { identity: `baseline-marker:v1:ci_started:12345:${B}x` }],
    ['trailing newline', { identity: `baseline-marker:v1:ci_started:12345:${B}\n` }],
    ['case change', { identity: `Baseline-marker:v1:ci_started:12345:${B}` }],
    ['other event name', { identity: `baseline-marker:v1:ci_failed:12345:${B}` }],
    ['sign in the run id', { identity: `baseline-marker:v1:ci_started:-5:${B}` }],
    ['exponent run id', { identity: `baseline-marker:v1:ci_started:1e5:${B}` }],
    ['the real identity', { identity: '12345:ci_started' }],
    ['held', { held: 1 }],
    ['held (boolean)', { held: true }],
    ['never alerted', { alertedAt: null }],
    ['never digested', { digestedAt: null }],
    ['alert and digest differ', { alertedAt: new Date(B + 6_000).toISOString() }],
    ['created differs from settlement', { createdAt: new Date(B + 6_000).toISOString() }],
    ['settled before the boundary', {
      alertedAt: new Date(B - 5_000).toISOString(), digestedAt: new Date(B - 5_000).toISOString(),
      createdAt: new Date(B - 5_000).toISOString(),
    }],
  ];
  it.each(near)('treats a row with %s as an ordinary event', (_name, over) => {
    expect(classifyBaselineMarker(good(over))).toBeNull();
  });

  it('is pure: the same row always gives the same answer and nothing is mutated', () => {
    const row = good();
    const copy = JSON.stringify(row);
    expect(classifyBaselineMarker(row)).toEqual(classifyBaselineMarker(row));
    expect(JSON.stringify(row)).toBe(copy);
  });
});

describe('encodeBaselineMarker', () => {
  it('round-trips through the classifier, for run ids at both ends', () => {
    for (const run of ['0', '1', '9007199254740991']) {
      const m = encodeBaselineMarker(run, B, COMMIT)!;
      expect(m).not.toBeNull();
      expect(classifyBaselineMarker(good({ identity: m.identity, occurredAt: m.occurredAt }))?.runId).toBe(run);
    }
  });

  it('cannot encode what the classifier would refuse', () => {
    for (const run of ['', '01', '-1', '1e+21', 'abc', ' 1', '1 ', '9007199254740993', '1.5', '12345678901234567']) {
      expect(encodeBaselineMarker(run, B, COMMIT), run).toBeNull();
    }
    for (const boundary of [B - 1, 999, 12_345_999, Number.NaN, Number.POSITIVE_INFINITY, B + 0.5, -1]) {
      expect(encodeBaselineMarker('1', boundary, COMMIT), String(boundary)).toBeNull();
    }
    // A commit time before the boundary is not a marker either.
    expect(encodeBaselineMarker('1', B, new Date(B - 1000).toISOString())).toBeNull();
  });

  it('fits the importer\'s 200-character identity limit at its longest', () => {
    const m = encodeBaselineMarker('9007199254740991', 9_999_999_999_999, new Date(10_000_000_000_000).toISOString());
    // 9_999_999_999_999 % 1000 === 999 and is 13 digits: the longest boundary there is.
    expect(m!.identity.length).toBeLessThan(200);
    expect(m!.identity.length).toBe(60);
  });
});

describe('the reserved namespace', () => {
  it('is reserved broadly, whatever follows the prefix', () => {
    expect(isReservedMarkerIdentity(BASELINE_MARKER_PREFIX)).toBe(true);
    expect(isReservedMarkerIdentity('baseline-marker:v2:anything')).toBe(true);
    expect(isReservedMarkerIdentity('baseline-marker:junk')).toBe(true);
    expect(isReservedMarkerIdentity('12345:ci_started')).toBe(false);
    expect(isReservedMarkerIdentity('Baseline-marker:v1')).toBe(false);
    expect(isReservedMarkerIdentity(' baseline-marker:')).toBe(false);
  });

  it('bounds the lookup above what a baseline can write', () => {
    expect(BASELINE_MARKER_CANDIDATE_LIMIT).toBeGreaterThan(BASELINE_MARKER_MAX);
    expect(BASELINE_MARKER_MAX).toBe(99);
  });
});
