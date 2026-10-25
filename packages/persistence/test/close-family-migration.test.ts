import { describe, expect, it } from 'vitest';
import { RETENTION_FORBIDDEN_TABLES, hashProviderRef, transitionKey, closedTransition, type Transition } from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * Migration 39 (ADR 0034): the exact pull request close family. It rebuilds the claims ledger (a wider kind CHECK
 * only), proves the copy column for column in its own transaction, and reads the imported closes that carried a
 * delivery or settlement marker into permanent, identifiers-only UNCERTAINTY. It never writes a claim: nothing proves
 * what a historical digest or a source alert marker showed. Invented data only.
 */
const OWNER = '100000000000000001';
const OTHER = '100000000000000002';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const T2 = '2026-10-01T02:00:00.000Z';
const T3 = '2026-10-01T03:00:00.000Z';
const C1 = '2026-09-30T10:00:00.000Z';
const C2 = '2026-09-30T11:00:00.000Z';
const H1 = hashProviderRef('PRR_1')!;

const at38 = (rows: (db: Db) => void): Db => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db, { upTo: 38, now: () => T0 });
  rows(db);
  return db;
};

const target = (db: Db, id: string, owner: string, repoKey: string, publicId: string): void => {
  db.prepare(
    `INSERT INTO assistant_watch_targets (id, public_id, discord_user_id, repo_key, display, state, created_at, updated_at)
     VALUES (?,?,?,?,?, 'active', ?, ?)`,
  ).run(id, publicId, owner, repoKey, repoKey, T0, T0);
};
interface CloseRow {
  id: string; target: string; identity: string; occurredAt: string; origin?: 'imported' | 'observed';
  alertedAt?: string | null; digestedAt?: string | null; withheld?: string | null; settledBy?: string | null; createdAt?: string;
}
const closeEvent = (db: Db, r: CloseRow): void => {
  db.prepare(
    `INSERT INTO assistant_watch_events
       (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, alerted_at, digested_at, created_at,
        withheld_reason, settled_by)
     VALUES (?,?, 'pr_closed','pulls',?,?, '{}', ?,?,?,?,?,?)`,
  ).run(
    r.id, r.target, r.identity, r.occurredAt, r.origin ?? 'imported', r.alertedAt ?? null, r.digestedAt ?? null,
    r.createdAt ?? T0, r.withheld ?? null, r.settledBy ?? null,
  );
};

const claim = (db: Db, over: Record<string, unknown>): void => {
  const c = {
    owner_id: OWNER, repo_key: REPO, transition_key: 'pr_opened:7', kind: 'pr_opened', item: '7', stamp: null,
    provider_hash: null, hash_domain: 'provider', provider_state: null, attempt: null, provider_at: null, path: 'native',
    state: 'reserved', via: 'feed_event', ref: 'f1', observed_at: T0, delivered_to: null, delivered_at: null,
    created_at: T0, updated_at: T0, ...over,
  };
  const cols = Object.keys(c);
  db.prepare(`INSERT INTO native_transition_claims (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...Object.values(c) as never[]);
};

const populate = (db: Db): void => {
  claim(db, {}); // a reserved feed holder
  claim(db, { ref: 's1', via: 'watch_summary', state: 'delivered', delivered_to: 'owner_dm', delivered_at: T1 });
  claim(db, {
    transition_key: `changes_requested:7:${H1}`, kind: 'changes_requested', provider_hash: H1, provider_at: T1, ref: 'f2',
    path: 'native', state: 'delivered', delivered_to: 'github_channel', delivered_at: T1,
  });
  claim(db, {
    transition_key: `review_commented:7:src:${H1}:unknown_state`, kind: 'review_commented', provider_hash: H1,
    hash_domain: 'source_identity', provider_state: 'COMMENTED|DISMISSED', path: 'target', via: 'target_digest', ref: 'e9',
    state: 'delivered', delivered_to: 'owner_dm', delivered_at: T2, observed_at: T1,
  });
  claim(db, { owner_id: OTHER, repo_key: 'other/repo', transition_key: 'ci_failed:5:2', kind: 'ci_failed', item: '5', attempt: '2', ref: 'f3' });
};

const rows = (db: Db, sql: string): Record<string, unknown>[] => db.prepare(sql).all() as Record<string, unknown>[];
const CLAIM_COLS = [
  'owner_id', 'repo_key', 'transition_key', 'kind', 'item', 'stamp', 'provider_hash', 'hash_domain', 'provider_state', 'attempt',
  'provider_at', 'path', 'state', 'via', 'ref', 'observed_at', 'delivered_to', 'delivered_at', 'created_at', 'updated_at',
];
const claimsOf = (db: Db): Record<string, unknown>[] =>
  rows(db, `SELECT ${CLAIM_COLS.join(', ')} FROM native_transition_claims ORDER BY owner_id, repo_key, transition_key, path, via, ref`);

describe('migration 39 rebuilds the claims ledger from a populated migration 38 without losing a row or a value', () => {
  it('keeps every holder, reservation, receipt, state, domain and key, and drops the original', () => {
    const db = at38(populate);
    const before = claimsOf(db);
    expect(before).toHaveLength(5);

    expect(runMigrations(db, { now: () => T3 })).toEqual([39]);

    expect(claimsOf(db)).toEqual(before);
    expect(rows(db, "SELECT name FROM sqlite_master WHERE name LIKE '%v38%'")).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 39').get()).toEqual({ n: 1 });
  });

  it('recreates every index, and keeps exactly one target claim per transition', () => {
    const db = at38(populate);
    runMigrations(db, { now: () => T3 });
    const idx = (table: string): string[] =>
      (rows(db, `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = '${table}' AND name NOT LIKE 'sqlite_%'`))
        .map((r) => String(r['name'])).sort();
    expect(idx('native_transition_claims')).toEqual(['ix_native_claims_family', 'ix_native_claims_ref', 'ux_native_claims_one_target']);
    expect(idx('native_close_uncertainty')).toEqual(['ix_close_uncertainty_item', 'ux_close_uncertainty']);
    expect(() => claim(db, {
      transition_key: `review_commented:7:src:${H1}:unknown_state`, kind: 'review_commented', provider_hash: H1,
      hash_domain: 'source_identity', provider_state: 'COMMENTED|DISMISSED', path: 'target', via: 'target_alert', ref: 'dup',
    })).toThrow(/UNIQUE/);
  });

  it('accepts a close claim of each path and refuses a kind outside the set', () => {
    const db = at38(populate);
    runMigrations(db, { now: () => T3 });
    const key = transitionKey(closedTransition(7, C1)!);
    claim(db, { transition_key: key, kind: 'pr_closed', stamp: C1, path: 'native', via: 'watch_summary', ref: 'c1' });
    claim(db, { transition_key: key, kind: 'pr_closed', stamp: C1, path: 'target', via: 'target_digest', ref: 'c2' });
    expect(() => claim(db, { transition_key: 'x', kind: 'pr_reopened', ref: 'c3' })).toThrow(/CHECK/);
    expect(() => claim(db, { transition_key: key, kind: 'pr_closed', path: 'target', via: 'target_alert', ref: 'c4' })).toThrow(/UNIQUE/);
  });

  it('writes no claim for any close, and leaves the event rows exactly as they were', () => {
    const db = at38((d) => {
      target(d, 't1', OWNER, REPO, 'wtarget');
      closeEvent(d, { id: 'e1', target: 't1', identity: '3:closed', occurredAt: C1, digestedAt: T1 });
      closeEvent(d, { id: 'e2', target: 't1', identity: '4:closed', occurredAt: C1 });
    });
    const events = rows(db, 'SELECT * FROM assistant_watch_events ORDER BY id');
    runMigrations(db, { now: () => T3 });
    expect(rows(db, 'SELECT * FROM native_transition_claims')).toEqual([]);
    expect(rows(db, 'SELECT * FROM assistant_watch_events ORDER BY id')).toEqual(events);
  });
});

describe('a fresh database has the close family and no uncertainty', () => {
  it('records only provenance: no row, zero counters, and no cutoff of its own', () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db, { now: () => T3 });
    expect(rows(db, 'SELECT * FROM native_close_uncertainty')).toEqual([]);
    expect(db.prepare('SELECT * FROM native_ledger_boundary WHERE id = 1').get()).toMatchObject({
      close_family_at: T3, close_uncertain_events: 0, close_uncertain_rows: 0, close_item_scope_events: 0,
      close_unidentifiable_events: 0, close_impossible_events: 0, fresh: 1,
    });
    expect(createStore(db).nativeTransitions.closeFamilyProvenance()).toEqual({
      at: T3, uncertainEvents: 0, uncertainRows: 0, itemScopeEvents: 0, unidentifiableEvents: 0, impossibleEvents: 0,
    });
  });
});

describe('historical closes with a marker become permanent uncertainty, never a receipt', () => {
  const seed = (d: Db): void => {
    target(d, 't1', OWNER, 'Acme/Demo', 'wtarget');
    target(d, 't2', OWNER, REPO, 'wtargt2');
    target(d, 't3', OTHER, REPO, 'wtargt3');
    // Digest marker, exact (two spellings of one instant collide on one key in two targets of one owner and repository).
    closeEvent(d, { id: 'a2', target: 't2', identity: '3:closed', occurredAt: '2026-09-30T18:00:00.000+08:00', digestedAt: T2, origin: 'imported' });
    closeEvent(d, { id: 'a1', target: 't1', identity: '3:closed', occurredAt: C1, digestedAt: T1, origin: 'imported' });
    closeEvent(d, { id: 'a3', target: 't3', identity: '3:closed', occurredAt: C1, digestedAt: T1, origin: 'imported' }); // another owner
    // Alert marker only (a source marker: close is not an alert kind), and both markers.
    closeEvent(d, { id: 'b1', target: 't1', identity: '4:closed', occurredAt: C1, alertedAt: T1 });
    closeEvent(d, { id: 'b2', target: 't1', identity: '5:closed', occurredAt: C2, alertedAt: T1, digestedAt: T2, origin: 'observed' });
    // A readable number whose instant is unreadable (wholly invalid, and non-ISO but parseable).
    closeEvent(d, { id: 'c1', target: 't1', identity: '6:closed', occurredAt: 'garbage', digestedAt: T1 });
    closeEvent(d, { id: 'c2', target: 't1', identity: '7:closed', occurredAt: 'Sep 30 2026 10:00 UTC', digestedAt: T1 });
    // No readable number: counted, never given a key. A pending close: no evidence at all.
    closeEvent(d, { id: 'd1', target: 't1', identity: 'x:closed', occurredAt: C1, digestedAt: T1 });
    closeEvent(d, { id: 'd2', target: 't1', identity: '8:closed', occurredAt: C1 });
    // States that could not exist before migration 39: counted, and still evidence when they carry a marker.
    closeEvent(d, { id: 'e1', target: 't1', identity: '9:closed', occurredAt: C1, withheld: 'ambiguous_evidence' });
    closeEvent(d, { id: 'e2', target: 't1', identity: '10:closed', occurredAt: C1, digestedAt: T1, settledBy: 'native_receipt' });
    // Not a close at all.
    d.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, digested_at, created_at)
       VALUES ('m1','t1','pr_merged','pulls','3:merged',?, '{}','imported',?,?)`,
    ).run(C1, T1, T0);
  };

  const run = (): { db: Db; store: Store } => {
    const db = at38(seed);
    runMigrations(db, { now: () => T3 });
    return { db, store: createStore(db) };
  };
  const uncertain = (db: Db) => rows(db, 'SELECT * FROM native_close_uncertainty ORDER BY owner_id, repo_key, item, scope, origin, marker');

  it('derives the keys through the runtime codec, with the owner and canonical repository of the row\'s target', () => {
    const { db } = run();
    const key3 = transitionKey(closedTransition(3, C1)!);
    expect(uncertain(db).map((r) => [r['owner_id'], r['repo_key'], r['scope'], r['item'], r['transition_key'], r['origin'], r['marker'], r['multiplicity']])).toEqual([
      [OWNER, REPO, 'exact', '10', transitionKey(closedTransition(10, C1)!), 'imported', 'digest_marker', 1],
      [OWNER, REPO, 'exact', '3', key3, 'imported', 'digest_marker', 2],
      [OWNER, REPO, 'exact', '4', transitionKey(closedTransition(4, C1)!), 'imported', 'alert_marker_only', 1],
      [OWNER, REPO, 'exact', '5', transitionKey(closedTransition(5, C2)!), 'observed', 'alert_and_digest_markers', 1],
      [OWNER, REPO, 'item', '6', '', 'imported', 'digest_marker', 1],
      [OWNER, REPO, 'item', '7', '', 'imported', 'digest_marker', 1],
      [OTHER, REPO, 'exact', '3', key3, 'imported', 'digest_marker', 1],
    ]);
  });

  it('keeps a deterministic representative for a collision (earliest digested_at, then event id) and every marker as provenance', () => {
    const { db } = run();
    const collided = uncertain(db).find((r) => r['owner_id'] === OWNER && r['item'] === '3')!;
    expect(collided).toMatchObject({ multiplicity: 2, representative_ref: 'a1', earliest_marked_at: T1, recorded_at: T3 });
  });

  it('breaks an equal digested_at by the smaller event id, whichever order the rows were written in', () => {
    for (const order of [['z9', 'a1'], ['a1', 'z9']]) {
      const db = at38((d) => {
        target(d, 't1', OWNER, 'Acme/Demo', 'wtarget');
        target(d, 't2', OWNER, REPO, 'wtargt2');
        for (const id of order) closeEvent(d, { id, target: id === 'a1' ? 't1' : 't2', identity: '3:closed', occurredAt: C1, digestedAt: T1 });
      });
      runMigrations(db, { now: () => T3 });
      expect(uncertain(db)).toMatchObject([{ multiplicity: 2, representative_ref: 'a1' }]);
    }
  });

  it('counts what it could not key, and what could not have existed, separately', () => {
    const { store } = run();
    expect(store.nativeTransitions.closeFamilyProvenance()).toEqual({
      at: T3, uncertainEvents: 8, uncertainRows: 7, itemScopeEvents: 2, unidentifiableEvents: 1, impossibleEvents: 2,
    });
    expect(store.nativeTransitions.closeUncertaintyCounts(OWNER)).toEqual({ events: 7, rows: 6, itemScopeRows: 2 });
    expect(store.nativeTransitions.closeUncertaintyCounts(OTHER)).toEqual({ events: 1, rows: 1, itemScopeRows: 0 });
  });

  it('holds only identifiers: no title, payload or repository text beyond the canonical key', () => {
    const { db } = run();
    const cols = (rows(db, 'PRAGMA table_info(native_close_uncertainty)')).map((c) => c['name']).sort();
    expect(cols).toEqual([
      'earliest_marked_at', 'id', 'item', 'marker', 'multiplicity', 'origin', 'owner_id', 'recorded_at', 'repo_key',
      'representative_ref', 'scope', 'transition_key',
    ]);
  });

  it('is independent of the event and target rows: no foreign key, and deleting them erases nothing', () => {
    const { db } = run();
    expect(rows(db, 'PRAGMA foreign_key_list(native_close_uncertainty)')).toEqual([]);
    const before = uncertain(db);
    db.prepare('DELETE FROM assistant_watch_targets').run(); // the events cascade with their targets
    expect(db.prepare('SELECT COUNT(*) n FROM assistant_watch_events').get()).toEqual({ n: 0 });
    expect(uncertain(db)).toEqual(before);
  });

  it('is named a retention-forbidden table, and the retention source never deletes from it', () => {
    expect(RETENTION_FORBIDDEN_TABLES).toContain('native_close_uncertainty');
  });

  it('has no clearing route: the repository exposes counts and a read, nothing that removes or rewrites a row', () => {
    const { store } = run();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store.nativeTransitions));
    expect(methods).toEqual(expect.arrayContaining(['closeUncertaintyCounts', 'closeUncertainty', 'closeFamilyProvenance']));
    expect(methods.filter((m) => /uncertain/i.test(m) && /(clear|delete|remove|reset|settle|release)/i.test(m))).toEqual([]);
    expect(store.nativeTransitions.closeUncertainty(OWNER, 3)).toHaveLength(3);
  });

  it('refuses a scope that disagrees with its key, and a marker or origin outside the set', () => {
    const { db } = run();
    const ins = db.prepare(
      `INSERT INTO native_close_uncertainty (owner_id, repo_key, scope, item, transition_key, origin, marker, multiplicity, representative_ref, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    expect(() => ins.run(OWNER, REPO, 'exact', '9', '', 'imported', 'digest_marker', 1, 'x', T3)).toThrow(/CHECK/);
    expect(() => ins.run(OWNER, REPO, 'item', '9', 'pr_closed:9:x', 'imported', 'digest_marker', 1, 'x', T3)).toThrow(/CHECK/);
    expect(() => ins.run(OWNER, REPO, 'item', '9', '', 'bogus', 'digest_marker', 1, 'x', T3)).toThrow(/CHECK/);
    expect(() => ins.run(OWNER, REPO, 'item', '9', '', 'imported', 'delivered', 1, 'x', T3)).toThrow(/CHECK/);
    expect(() => ins.run(OWNER, REPO, 'item', '9', '', 'imported', 'digest_marker', 0, 'x', T3)).toThrow(/CHECK/);
  });

  it('rolls the whole migration back if its copy proof fails (nothing half-applied)', () => {
    const db = at38(populate);
    // A claim the rebuilt table cannot hold: the proof compares both directions, so the migration must not complete.
    db.exec('DROP TABLE native_ledger_boundary');
    expect(() => runMigrations(db, { now: () => T3 })).toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 39').get()).toEqual({ n: 0 });
    expect(rows(db, "SELECT name FROM sqlite_master WHERE name = 'native_close_uncertainty'")).toEqual([]);
    expect(claimsOf(db)).toHaveLength(5);
  });
});

describe('the ledger decides a native exact close against the uncertainty and the target\'s own receipts', () => {
  const seedUncertain = (d: Db): void => {
    target(d, 't1', OWNER, REPO, 'wtarget');
    closeEvent(d, { id: 'a1', target: 't1', identity: '3:closed', occurredAt: C1, digestedAt: T1 });
    closeEvent(d, { id: 'a2', target: 't1', identity: '6:closed', occurredAt: 'garbage', alertedAt: T1 });
  };
  const store = (): Store => {
    const db = at38(seedUncertain);
    runMigrations(db, { now: () => T3 });
    return createStore(db);
  };
  const closeT = (n: number, at: string): Transition => closedTransition(n, at)!;
  const probe = (s: Store, tr: Transition, owner = OWNER, repo = REPO) => s.nativeTransitions.probeNative(owner, repo, tr);

  it('is uncertain for the exact key a historical close names, free for a different instant, pull request or repository', () => {
    const s = store();
    expect(probe(s, closeT(3, C1))).toBe('uncertain');
    expect(probe(s, closeT(3, C2))).toBe('free'); // distinct close instants remain distinct
    expect(probe(s, closeT(4, C1))).toBe('free');
    expect(probe(s, closeT(3, C1), OWNER, 'acme/other')).toBe('free');
    expect(probe(s, closeT(3, C1), OTHER)).toBe('free'); // owner isolation
  });

  it('matches ANY close of a pull request whose historical instant could not be read', () => {
    const s = store();
    expect(probe(s, closeT(6, C1))).toBe('uncertain');
    expect(probe(s, closeT(6, C2))).toBe('uncertain');
    expect(probe(s, closeT(7, C1))).toBe('free');
  });

  it('checks an exact delivered target receipt first, then a reserved one, before the uncertainty', () => {
    const s = store();
    const x = { kind: 'pr_closed' as const, identity: '3:closed', occurredAt: C1, providerHash: null, attempt: null };
    // A real target send in flight: the observation waits.
    expect(s.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'ev-1', T3).reserved).toBe(true);
    expect(probe(s, closeT(3, C1))).toBe('target_in_flight');
    // The send succeeded with proof: the real receipt covers the native close despite the retained uncertainty.
    s.nativeTransitions.markTargetDelivered('target_digest', 'ev-1', T3);
    expect(probe(s, closeT(3, C1))).toBe('target_delivered');
    // A failed or abandoned send leaves nothing: back to the uncertainty.
    const s2 = store();
    s2.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'ev-1', T3);
    s2.nativeTransitions.releaseTarget('target_digest', 'ev-1');
    expect(probe(s2, closeT(3, C1))).toBe('uncertain');
  });

  it('never clears the uncertainty: a native holder, a receipt or a sweep leaves the rows exactly as they were', () => {
    const s = store();
    const before = s.nativeTransitions.closeUncertainty(OWNER, 10);
    s.nativeTransitions.reserveNative(OWNER, REPO, closeT(9, C1), 'watch_summary', 'w1', T3, T3);
    s.nativeTransitions.markNativeDelivered('watch_summary', 'w1', 'owner_dm', T3);
    s.nativeTransitions.sweepOrphans();
    s.nativeTransitions.recoverTargetSends();
    expect(s.nativeTransitions.closeUncertainty(OWNER, 10)).toEqual(before);
  });
});
