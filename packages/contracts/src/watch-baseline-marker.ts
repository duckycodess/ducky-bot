/**
 * Baseline identity markers: the one place that says what one is (ADR 0031).
 *
 * A first observation of workflow runs freezes a boundary, and a run that was already
 * queued or running at it must not announce a historical `ci_started` when it is next
 * updated. The baseline's atomic commit therefore records each such run as a MARKER: a
 * watch event of kind `ci_started` in a reserved identity namespace that no real event
 * can occupy, settled at birth, with an empty payload.
 *
 * A marker is deliberately NOT the real `<run>:ci_started` identity. A real identity that
 * was settled as suppression would silence that start forever, including after an import
 * rewinds the cursor below the boundary, where the start must be announced. A marker only
 * says "this run was underway at boundary B"; whether to suppress is a rule applied with
 * the pass's own cursor.
 *
 * Everything here is pure. Suppression, counts, the export and the importer's refusal all
 * call `classifyBaselineMarker` and `isReservedMarkerIdentity`, so they cannot drift. The
 * reserved prefix is refused BROADLY (an import may not use it at all) and classified
 * NARROWLY: a row that nearly matches is an ordinary event and never suppresses anything.
 */

/** Refused broadly: no imported event identity may begin with this. */
export const BASELINE_MARKER_PREFIX = 'baseline-marker:';

/** The only version this build writes and trusts. Any other version is an ordinary event. */
const MARKER_HEAD = `${BASELINE_MARKER_PREFIX}v1:ci_started:`;

/** run id, boundary. Plain decimal only: no sign, no exponent, no leading zero, no suffix. */
const MARKER_IDENTITY = /^baseline-marker:v1:ci_started:(0|[1-9]\d{0,15}):([1-9]\d{12})$/;

/**
 * Most markers a baseline can write: the runs inventory a first observation can prove
 * (nine full pages and a partial tenth). A lookup reads one more than this and refuses to
 * guess if the extra row exists.
 */
export const BASELINE_MARKER_MAX = 99;
/** The candidate rows a lookup may read; near-miss rows also count against it. */
export const BASELINE_MARKER_CANDIDATE_LIMIT = 200;

/** The columns the classifier reads, in the store's own words (booleans as 0/1 or true/false). */
export interface MarkerCandidate {
  readonly kind: string;
  readonly origin: string;
  readonly identity: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
  readonly held: boolean | number;
  readonly alertedAt: string | null;
  readonly digestedAt: string | null;
  readonly createdAt: string;
}

export interface BaselineMarker {
  readonly runId: string;
  readonly boundaryMs: number;
}

/** Whether an identity is in the reserved namespace at all. Broad on purpose. */
export const isReservedMarkerIdentity = (identity: string): boolean =>
  identity.startsWith(BASELINE_MARKER_PREFIX);

const safeInt = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * The marker a row is, or null. The ONLY authority: nothing else decides.
 *
 * Every condition must hold. A different kind or origin, an imported row, a held row, a
 * payload with anything in it, a boundary that is not the second-before shape the baseline
 * produces (`B % 1000 === 999`), a timestamp that does not match the boundary in the
 * identity, a settlement that is not at birth, a leading zero, a case change, a suffix, an
 * unsafe run id and any other version all make it an ordinary event.
 */
export function classifyBaselineMarker(row: MarkerCandidate): BaselineMarker | null {
  if (row.kind !== 'ci_started' || row.origin !== 'observed') return null;
  const m = MARKER_IDENTITY.exec(row.identity);
  if (!m) return null;
  const runId = m[1]!;
  const boundaryMs = Number(m[2]);
  if (!safeInt(Number(runId)) || !safeInt(boundaryMs) || boundaryMs % 1000 !== 999) return null;
  if (row.occurredAt !== new Date(boundaryMs).toISOString()) return null;
  if (row.payloadJson !== '{}' || (row.held !== false && row.held !== 0)) return null;
  const { alertedAt, digestedAt, createdAt } = row;
  if (alertedAt === null || digestedAt === null || createdAt === '') return null;
  if (alertedAt !== digestedAt || digestedAt !== createdAt) return null;
  if (createdAt < row.occurredAt) return null;
  return { runId, boundaryMs };
}

/**
 * What a baseline writes for a run that was underway at its boundary, or null when it
 * cannot be encoded (a run id that is not plain decimal or not a safe integer, or a
 * boundary of the wrong shape). The caller must refuse the surface on null: it is never
 * skipped, which would announce history, and never replaced by the real identity.
 *
 * The result is checked against the classifier before it is returned, so a generator that
 * drifts from the classifier fails here, not silently in production.
 */
export function encodeBaselineMarker(
  runId: string,
  boundaryMs: number,
  committedAtIso: string,
): { readonly identity: string; readonly occurredAt: string } | null {
  if (!/^(0|[1-9]\d{0,15})$/.test(runId) || !safeInt(Number(runId))) return null;
  if (!safeInt(boundaryMs) || boundaryMs % 1000 !== 999 || String(boundaryMs).length !== 13) return null;
  const identity = `${MARKER_HEAD}${runId}:${boundaryMs}`;
  const occurredAt = new Date(boundaryMs).toISOString();
  const accepted = classifyBaselineMarker({
    kind: 'ci_started', origin: 'observed', identity, occurredAt, payloadJson: '{}', held: false,
    alertedAt: committedAtIso, digestedAt: committedAtIso, createdAt: committedAtIso,
  });
  return accepted && accepted.runId === runId && accepted.boundaryMs === boundaryMs ? { identity, occurredAt } : null;
}
