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

type Marker = 'alert_marker_only' | 'digest_marker' | 'alert_and_digest_markers';

interface Group {
  ownerId: string;
  repoKey: string;
  scope: 'exact' | 'item';
  item: string;
  transitionKey: string;
  origin: 'imported' | 'observed';
  marker: Marker;
  multiplicity: number;
  representative: { digestedAt: string | null; id: string };
  earliest: string | null;
}

const ms = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso));

/** Whether `a` is strictly earlier than `b`, by instant when both read and by text otherwise. */
const earlier = (a: string, b: string): boolean => {
  const x = ms(a);
  const y = ms(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x < y : a < b;
};

/**
 * The deterministic representative of a group of colliding rows: the earliest `digested_at` (a row that was never
 * digested sorts after every one that was), then the smallest event id. Multiplicity and provenance are kept in the
 * group row, so the choice never hides evidence.
 */
const betterRepresentative = (
  a: { digestedAt: string | null; id: string }, b: { digestedAt: string | null; id: string },
): boolean => {
  if (a.digestedAt !== b.digestedAt) {
    if (a.digestedAt === null) return false;
    if (b.digestedAt === null) return true;
    return earlier(a.digestedAt, b.digestedAt);
  }
  return a.id < b.id;
};

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

  const groups = new Map<string, Group>();
  let events = 0;
  let itemScopeEvents = 0;
  let unidentifiable = 0;
  let impossible = 0;

  for (const r of rows) {
    const alerted = r['alerted_at'] == null ? null : String(r['alerted_at']);
    const digested = r['digested_at'] == null ? null : String(r['digested_at']);
    if (r['withheld_reason'] != null || r['settled_by'] != null) impossible += 1;
    // No marker, no evidence: a pending close proceeds through the prospective reservation protocol.
    if (alerted === null && digested === null) continue;
    const marker: Marker = alerted !== null && digested !== null
      ? 'alert_and_digest_markers'
      : digested !== null ? 'digest_marker' : 'alert_marker_only';
    const owner = r['owner_id'] == null ? null : String(r['owner_id']);
    const evidence = owner === null || r['target_repo_key'] == null
      ? ({ kind: 'unidentifiable' } as const)
      : classifyCloseEvidence(String(r['target_repo_key']), String(r['identity']), String(r['occurred_at']));
    if (owner === null || evidence.kind === 'unidentifiable') {
      unidentifiable += 1;
      continue;
    }
    const exact = evidence.kind === 'exact';
    const transitionKey = exact ? evidence.transitionKey : '';
    const origin = String(r['origin']) === 'observed' ? 'observed' : 'imported';
    const key = [owner, evidence.repoKey, exact ? 'exact' : 'item', transitionKey, evidence.item, origin, marker].join('\u0000');
    const rep = { digestedAt: digested, id: String(r['id']) };
    const marked = digested ?? alerted!;
    const g = groups.get(key);
    events += 1;
    if (!exact) itemScopeEvents += 1;
    if (!g) {
      groups.set(key, {
        ownerId: owner, repoKey: evidence.repoKey, scope: exact ? 'exact' : 'item', item: evidence.item, transitionKey,
        origin, marker, multiplicity: 1, representative: rep, earliest: marked,
      });
      continue;
    }
    g.multiplicity += 1;
    if (betterRepresentative(rep, g.representative)) g.representative = rep;
    if (g.earliest === null || earlier(marked, g.earliest)) g.earliest = marked;
  }

  const insert = db.prepare(
    `INSERT INTO native_close_uncertainty
       (owner_id, repo_key, scope, item, transition_key, origin, marker, multiplicity, representative_ref,
        earliest_marked_at, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const g of [...groups.values()].sort((a, b) =>
    `${a.ownerId}|${a.repoKey}|${a.scope}|${a.transitionKey}|${a.item}|${a.origin}|${a.marker}`
      .localeCompare(`${b.ownerId}|${b.repoKey}|${b.scope}|${b.transitionKey}|${b.item}|${b.origin}|${b.marker}`))) {
    insert.run(
      g.ownerId, g.repoKey, g.scope, g.item, g.transitionKey, g.origin, g.marker, g.multiplicity, g.representative.id,
      g.earliest !== null && canonicalStamp(g.earliest) !== null ? canonicalStamp(g.earliest) : g.earliest, ctx.at,
    );
  }

  db.prepare(
    `UPDATE native_ledger_boundary
        SET close_family_at = ?, close_uncertain_events = ?, close_uncertain_rows = ?, close_item_scope_events = ?,
            close_unidentifiable_events = ?, close_impossible_events = ?
      WHERE id = 1`,
  ).run(ctx.at, events, groups.size, itemScopeEvents, unidentifiable, impossible);
  return { events, rows: groups.size, itemScopeEvents, unidentifiable, impossible };
}
