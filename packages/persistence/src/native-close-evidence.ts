import { canonicalStamp, classifyCloseEvidence } from '@ducky/contracts';
import type { Db } from './db.js';

/**
 * Migration 39's reading of the imported pull request closes that existed BEFORE the exact close family did (ADR 0034).
 *
 * A pre-39 close row that carries a delivery or settlement marker (`digested_at` or `alerted_at`) is NOT a receipt:
 * a close alert marker can only have been imported from the source (close is not an alert kind), and a digest
 * settlement says the briefing was sent, not that this one line was shown (a repository or a line can be cut, and
 * the old line carried no close instant). So nothing here is promoted to a delivered claim. Each such row becomes
 * permanent, identifiers-only UNCERTAINTY evidence instead: a later native exact close that matches it is held and
 * counted, never sent, and nothing clears it.
 *
 * The keys are derived through the runtime codec, in the migration's own transaction (so no retention can run
 * first), with the owner and the canonical repository of the row's target. A row whose identity, instant or repository
 * cannot be read is counted separately and never invented a key for: a readable number with an unreadable instant
 * becomes a same-pull-request fallback, and anything else is only counted. A pre-39 close row that is withheld or
 * settled by a native receipt is a state that could not have existed (close had no native counterpart), so it is
 * counted on its own and still treated as evidence when it carries a marker, which can only hold more, never less.
 */
export interface CloseFamilyCapture {
  readonly events: number;
  readonly rows: number;
  readonly itemScopeEvents: number;
  readonly unidentifiable: number;
  readonly impossible: number;
}

export type CloseMarker = 'alert_marker_only' | 'digest_marker' | 'alert_and_digest_markers';

/** The instant text stored for a marker: canonical when it can be, else exactly what the source wrote. */
const markText = (raw: string): string => canonicalStamp(raw) ?? raw;

/** What one stored or imported close row says about itself. Identifiers and timestamps only. */
export interface CloseEvidenceRow {
  readonly id: string;
  /** The owner and repository of the row's TARGET; null when it has none (then the row can only be counted). */
  readonly ownerId: string | null;
  readonly targetRepoKey: string | null;
  readonly identity: string;
  readonly occurredAt: string;
  readonly origin: 'imported' | 'observed';
  readonly alertedAt: string | null;
  readonly digestedAt: string | null;
}

export type CloseEvidenceOutcome = 'none' | 'recorded' | 'item' | 'unidentifiable';

/**
 * Records ONE close row's historical uncertainty, idempotently per row IF the caller calls it once per row: it is called
 * (a) by migration 39 for every pre-39 row with a marker, and (b) by the supported import boundary the moment a source
 * marker first appears on a row (a new row carrying one, or a row that had none gaining its first). A row that already
 * carried a marker never calls it again, so a repeat import adds nothing; a later marker on an already-marked row adds no
 * second row (the first class stands: any marker holds identically). A marker Ducky wrote itself after a proven send is
 * never passed here: that is a real receipt, checked first, and it is not history.
 *
 * Rows of one key, origin and marker class collapse into one row with a multiplicity and a representative that does not
 * depend on the order they arrive in: the earliest marker instant, then the smallest event id. The boundary row's counts
 * move with it.
 */
export function recordCloseUncertainty(db: Db, e: CloseEvidenceRow, at: string): CloseEvidenceOutcome {
  if (e.alertedAt === null && e.digestedAt === null) return 'none';
  const marker: CloseMarker = e.alertedAt !== null && e.digestedAt !== null
    ? 'alert_and_digest_markers'
    : e.digestedAt !== null ? 'digest_marker' : 'alert_marker_only';
  const evidence = e.ownerId === null || e.targetRepoKey === null
    ? ({ kind: 'unidentifiable' } as const)
    : classifyCloseEvidence(e.targetRepoKey, e.identity, e.occurredAt);
  if (e.ownerId === null || evidence.kind === 'unidentifiable') {
    db.prepare('UPDATE native_ledger_boundary SET close_unidentifiable_events = close_unidentifiable_events + 1 WHERE id = 1').run();
    return 'unidentifiable';
  }
  const exact = evidence.kind === 'exact';
  const marked = markText((e.digestedAt ?? e.alertedAt)!);
  db.prepare(
    `INSERT INTO native_close_uncertainty
       (owner_id, repo_key, scope, item, transition_key, origin, marker, multiplicity, representative_ref,
        earliest_marked_at, recorded_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?)
     ON CONFLICT (owner_id, repo_key, scope, transition_key, item, origin, marker) DO UPDATE SET
       multiplicity = multiplicity + 1,
       representative_ref = CASE
         WHEN excluded.earliest_marked_at < earliest_marked_at
           OR (excluded.earliest_marked_at = earliest_marked_at AND excluded.representative_ref < representative_ref)
         THEN excluded.representative_ref ELSE representative_ref END,
       earliest_marked_at = MIN(earliest_marked_at, excluded.earliest_marked_at)`,
  ).run(
    e.ownerId, evidence.repoKey, exact ? 'exact' : 'item', evidence.item, exact ? evidence.transitionKey : '', e.origin, marker,
    e.id, marked, at,
  );
  db.prepare(
    `UPDATE native_ledger_boundary
        SET close_uncertain_events = close_uncertain_events + 1,
            close_item_scope_events = close_item_scope_events + ?,
            close_uncertain_rows = (SELECT COUNT(*) FROM native_close_uncertainty)
      WHERE id = 1`,
  ).run(exact ? 0 : 1);
  return exact ? 'recorded' : 'item';
}

/**
 * Migration 39's reading of every pre-39 close row (see above for why none is a receipt). A pre-39 close that is withheld
 * or settled by a native receipt is a state that could not have existed (close had no native counterpart): counted on its
 * own and, when it carries a marker, still treated as evidence, which can only hold more.
 */
export function captureCloseFamily(db: Db, ctx: { readonly at: string }): CloseFamilyCapture {
  const rows = db
    .prepare(
      `SELECT e.id, e.identity, e.occurred_at, e.origin, e.alerted_at, e.digested_at, e.withheld_reason, e.settled_by,
              t.discord_user_id AS owner_id, t.repo_key AS target_repo_key
         FROM assistant_watch_events e
         LEFT JOIN assistant_watch_targets t ON t.id = e.target_id
        WHERE e.kind = 'pr_closed'
        ORDER BY e.id`,
    )
    .all() as Record<string, unknown>[];
  db.prepare(
    `UPDATE native_ledger_boundary
        SET close_family_at = ?, close_uncertain_events = 0, close_uncertain_rows = 0, close_item_scope_events = 0,
            close_unidentifiable_events = 0, close_impossible_events = 0
      WHERE id = 1`,
  ).run(ctx.at);
  let impossible = 0;
  for (const r of rows) {
    if (r['withheld_reason'] != null || r['settled_by'] != null) impossible += 1;
    recordCloseUncertainty(db, {
      id: String(r['id']), ownerId: r['owner_id'] == null ? null : String(r['owner_id']),
      targetRepoKey: r['target_repo_key'] == null ? null : String(r['target_repo_key']),
      identity: String(r['identity']), occurredAt: String(r['occurred_at']),
      origin: String(r['origin']) === 'observed' ? 'observed' : 'imported',
      alertedAt: r['alerted_at'] == null ? null : String(r['alerted_at']),
      digestedAt: r['digested_at'] == null ? null : String(r['digested_at']),
    }, ctx.at);
  }
  db.prepare('UPDATE native_ledger_boundary SET close_impossible_events = ? WHERE id = 1').run(impossible);
  const b = db.prepare('SELECT * FROM native_ledger_boundary WHERE id = 1').get() as Record<string, unknown>;
  return {
    events: Number(b['close_uncertain_events']), rows: Number(b['close_uncertain_rows']),
    itemScopeEvents: Number(b['close_item_scope_events']), unidentifiable: Number(b['close_unidentifiable_events']), impossible,
  };
}
