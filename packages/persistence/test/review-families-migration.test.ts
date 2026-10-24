import { describe, expect, it } from 'vitest';
import { RETENTION_FORBIDDEN_TABLES } from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore } from '../src/index.js';
import { MIGRATIONS } from '../src/migrations.js';

/**
 * Migration 38 (ADR 0034): the observed-state review families. It rebuilds the claims ledger (a wider kind CHECK,
 * the domain of a hash, the state a review fact names) and the imported event rows (a new withheld reason, the
 * state, the provider's own instant), and proves in its own transaction that no row or value was lost. Invented
 * data only.
 */
const OWNER = '100000000000000001';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const T3 = '2026-10-01T03:00:00.000Z';
const H1 = 'a'.repeat(64);

const at37 = (rows: (db: Db) => void): Db => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db, { upTo: 37, now: () => T0 });
  rows(db);
  return db;
};

const populate = (db: Db): void => {
  db.prepare(
    `INSERT INTO assistant_watch_targets (id, public_id, discord_user_id, repo_key, display, state, created_at, updated_at)
     VALUES ('t1','wtarget',?, ?, 'demo','active',?,?)`,
  ).run(OWNER, REPO, T0, T0);
  const ev = db.prepare(
    `INSERT INTO assistant_watch_events
       (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at, withheld_reason, settled_by, provider_hash, attempt)
     VALUES (?, 't1', ?, 'pulls', ?, ?, '{}', 'observed', ?, ?, ?, ?, ?)`,
  );
  ev.run('e1', 'review_approved', '7:review:1', T1, T1, null, null, null, null);
  ev.run('e2', 'review_commented', '7:review:2', T1, T1, 'legacy_unproven', null, null, null);
  ev.run('e3', 'review_requested_changes', '7:review:3', T1, T1, null, 'native_receipt', H1, null);
  ev.run('e4', 'ci_failed', '9:ci_failed', T1, T1, 'ambiguous_evidence', null, null, '2');
  db.prepare(
    `INSERT INTO native_transition_claims
       (owner_id, repo_key, transition_key, kind, item, stamp, provider_hash, attempt, provider_at, path, state, via, ref,
        observed_at, delivered_to, delivered_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    OWNER, REPO, `changes_requested:7:${H1}`, 'changes_requested', '7', null, H1, null, T1, 'native', 'delivered',
    'watch_summary', 's1', T0, 'owner_dm', T1, T0, T1,
  );
};

const all = (db: Db, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const only = (rows: unknown[], cols: string[]): unknown[] =>
  rows.map((r) => Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c]])));

describe('migration 38 rebuilds from a populated migration 37 without losing a row or a value', () => {
  it('keeps every claim and every imported event, as provider-domain rows with no recorded state or instant', () => {
    const db = at37(populate);
    const claimCols = [
      'owner_id', 'repo_key', 'transition_key', 'kind', 'item', 'stamp', 'provider_hash', 'attempt', 'provider_at',
      'path', 'state', 'via', 'ref', 'observed_at', 'delivered_to', 'delivered_at', 'created_at', 'updated_at',
    ];
    const eventCols = [
      'id', 'target_id', 'kind', 'surface', 'held', 'identity', 'occurred_at', 'payload_json', 'origin', 'alerted_at',
      'alert_attempts', 'alert_abandoned_at', 'digested_at', 'created_at', 'withheld_reason', 'settled_by',
      'provider_hash', 'attempt',
    ];
    const claimsBefore = only(all(db, 'native_transition_claims', 'transition_key'), claimCols);
    const eventsBefore = only(all(db, 'assistant_watch_events', 'id'), eventCols);
    expect(claimsBefore).toHaveLength(1);
    expect(eventsBefore).toHaveLength(4);

    expect(runMigrations(db, { now: () => T3 })).toEqual([38]);

    expect(only(all(db, 'native_transition_claims', 'transition_key'), claimCols)).toEqual(claimsBefore);
    expect(only(all(db, 'assistant_watch_events', 'id'), eventCols)).toEqual(eventsBefore);
    expect(all(db, 'native_transition_claims', 'transition_key')).toMatchObject([{ hash_domain: 'provider', provider_state: null }]);
    expect(all(db, 'assistant_watch_events', 'id')).toSatisfy((rows: unknown[]) =>
      rows.every((r) => {
        const x = r as Record<string, unknown>;
        return x['hash_domain'] === 'provider' && x['provider_state'] === null && x['provider_at'] === null;
      }));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%v37%'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 38').get()).toEqual({ n: 1 });
  });

  it('recreates every index, including the per-target uniqueness and the two event indexes', () => {
    const db = at37(populate);
    runMigrations(db, { now: () => T3 });
    const idx = (table: string): string[] =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'").all(table) as { name: string }[])
        .map((r) => r.name).sort();
    expect(idx('native_transition_claims')).toEqual(['ix_native_claims_family', 'ix_native_claims_ref', 'ux_native_claims_one_target']);
    expect(idx('assistant_watch_events')).toEqual(['ix_assistant_watch_events_alert', 'ix_assistant_watch_events_digest']);
    // The unique (target, kind, identity) is kept.
    expect(() => db.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at)
       VALUES ('dup','t1','review_approved','pulls','7:review:1',?, '{}','observed',?)`,
    ).run(T1, T1)).toThrow(/UNIQUE/);
  });

  it('accepts the new kinds, states and withheld reason, and refuses a value outside them', () => {
    const db = at37(populate);
    runMigrations(db, { now: () => T3 });
    const claim = db.prepare(
      `INSERT INTO native_transition_claims
         (owner_id, repo_key, transition_key, kind, item, provider_hash, hash_domain, provider_state, path, state, via, ref,
          observed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'target','reserved','target_alert','e1',?,?,?)`,
    );
    for (const [kind, state] of [
      ['review_approved', 'APPROVED'], ['review_commented', 'COMMENTED'], ['review_dismissed', 'DISMISSED'],
      ['review_commented', 'COMMENTED|DISMISSED'],
    ] as const) {
      claim.run(OWNER, REPO, `${kind}:7:src:${state}`, kind, '7', H1, 'source_identity', state, T0, T0, T0);
    }
    expect(() => claim.run(OWNER, REPO, 'x', 'review_other', '7', H1, 'provider', null, T0, T0, T0)).toThrow(/CHECK/);
    expect(() => claim.run(OWNER, REPO, 'y', 'review_approved', '7', H1, 'bogus', null, T0, T0, T0)).toThrow(/CHECK/);
    expect(() => claim.run(OWNER, REPO, 'z', 'review_approved', '7', H1, 'provider', 'PENDING', T0, T0, T0)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE assistant_watch_events SET withheld_reason = 'state_conflict' WHERE id = 'e1'").run()).not.toThrow();
    expect(() => db.prepare("UPDATE assistant_watch_events SET withheld_reason = 'other' WHERE id = 'e1'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE assistant_watch_events SET provider_state = 'PENDING' WHERE id = 'e1'").run()).toThrow(/CHECK/);
  });

  it('records provenance only: the migration-36 cutoff and fresh flag are untouched', () => {
    const db = at37(populate);
    const before = db.prepare('SELECT cutoff_at, fresh FROM native_ledger_boundary WHERE id = 1').get();
    runMigrations(db, { now: () => T3 });
    expect(db.prepare('SELECT cutoff_at, fresh FROM native_ledger_boundary WHERE id = 1').get()).toEqual(before);
    expect(db.prepare('SELECT review_families_at FROM native_ledger_boundary WHERE id = 1').get()).toEqual({ review_families_at: T3 });
  });

  it('adds the domain and the pending-marker columns without inventing a value, and a durable gap-marker table', () => {
    const db = at37((d) => {
      d.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo',?)`).run(T0);
      d.prepare(`INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
                 VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo')`).run(OWNER, T0, T0, T0);
      d.prepare(`INSERT INTO github_watch_events (id, watch_id, fingerprint, summary, created_at, repo_key) VALUES ('s1','w1','fp','s',?, 'acme/demo')`).run(T0);
      d.prepare(
        `INSERT INTO native_legacy_seed (repo_key, transition_key, kind, item, via, ref, observed_at)
         VALUES ('acme/demo','pr_opened:9','pr_opened','9','feed_event','f9',?)`,
      ).run(T0);
    });
    runMigrations(db, { now: () => T3 });
    expect(db.prepare('SELECT hash_domain, gap_markers FROM github_watch_events').get()).toEqual({ hash_domain: 'provider', gap_markers: null });
    expect(db.prepare('SELECT hash_domain FROM native_legacy_seed').get()).toEqual({ hash_domain: 'provider' });
    const marker = db.prepare(
      `INSERT INTO github_watch_gap_markers (owner_id, watch_id, repo_key, pr_number, review_class, reason, shown, outbox_ref, delivered_at)
       VALUES (?, 'w1', 'acme/demo', ?, ?, ?, ?, 's1', ?)`,
    );
    marker.run(OWNER, 7, 'approval', 'unavailable', 'shown', T3);
    expect(() => marker.run(OWNER, 7, 'approval', 'unavailable', 'shown', T3)).toThrow(/UNIQUE/);
    expect(() => marker.run(OWNER, 7, 'approval', 'truncated', 'maybe', T3)).toThrow(/CHECK/);
    expect(() => marker.run(OWNER, 7, 'decision', 'truncated', 'shown', T3)).toThrow(/CHECK/);
    // Independent of the watch and its outbox: nothing here cascades from either.
    db.prepare('DELETE FROM github_watch_events').run();
    db.prepare('DELETE FROM github_watches').run();
    expect(db.prepare('SELECT COUNT(*) n FROM github_watch_gap_markers').get()).toEqual({ n: 1 });
  });

  it('keeps the gap markers on the retention-forbidden list', () => {
    expect(RETENTION_FORBIDDEN_TABLES).toContain('github_watch_gap_markers');
  });
});

describe('migration 38 is atomic', () => {
  const run = (mutate: (db: Db) => void): Db => {
    const db = at37(populate);
    const m = MIGRATIONS.find((x) => x.version === 38)!;
    db.exec('BEGIN');
    db.exec(m.sql);
    mutate(db);
    return db;
  };
  const verify = (db: Db): void => MIGRATIONS.find((x) => x.version === 38)!.after!(db, { fresh: false, at: T3 });

  it('rolls everything back when a claim row was lost', () => {
    const db = run((d) => d.prepare('DELETE FROM native_transition_claims').run());
    expect(() => verify(db)).toThrow(/does not hold exactly the rows/);
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT COUNT(*) n FROM native_transition_claims').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 38').get()).toEqual({ n: 0 });
    expect(() => db.prepare('SELECT hash_domain FROM native_transition_claims').get()).toThrow();
  });

  it('rolls everything back when an imported event lost a value', () => {
    const db = run((d) => d.prepare("UPDATE assistant_watch_events SET payload_json = '{\"x\":1}' WHERE id = 'e3'").run());
    expect(() => verify(db)).toThrow(/does not hold exactly the rows/);
    db.exec('ROLLBACK');
    expect(db.prepare("SELECT payload_json FROM assistant_watch_events WHERE id = 'e3'").get()).toEqual({ payload_json: '{}' });
  });

  it('refuses a copied row that is not a plain provider-domain row with no state or instant', () => {
    const db = run((d) => d.prepare("UPDATE assistant_watch_events SET provider_state = 'APPROVED' WHERE id = 'e1'").run());
    expect(() => verify(db)).toThrow(/does not hold exactly the rows/);
    db.exec('ROLLBACK');
  });
});

describe('a gap marker becomes durable only through a DELIVERED outbox row', () => {
  const world = () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    const store = createStore(db);
    db.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo',?)`).run(T0);
    db.prepare(
      `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
       VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo')`,
    ).run(OWNER, T0, T0, T0);
    const markers = [
      { pr: 7, cls: 'approval' as const, reason: 'unavailable' as const, shown: 'shown' as const },
      { pr: 8, cls: 'changes_requested' as const, reason: 'truncated' as const, shown: 'delivered_not_provably_shown' as const },
    ];
    expect(store.githubWatches.observe({
      id: 'w1', expectedNextCheckAt: T0, expectedRepoKey: 'acme/demo', repoKey: 'acme/demo', snapshotHash: 'h', snapshotJson: '{}',
      nextCheckAt: T1, atIso: T1, changed: true, readBoundaryAt: T1,
      events: [{ id: 's1', fingerprint: 'fp', summary: 'Update', gapMarkers: markers }],
    })).toBe(true);
    return { db, store };
  };
  const count = (db: Db): number => (db.prepare('SELECT COUNT(*) n FROM github_watch_gap_markers').get() as { n: number }).n;

  it('promotes nothing for a row that was queued, failed or abandoned', () => {
    const { db, store } = world();
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(0); // queued
    store.githubWatches.recordEventFailure('s1', T1, 8); // a failed attempt
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(0);
    store.githubWatches.recordEventFailure('s1', T1, 1); // spent: abandoned
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(0);
    expect(count(db)).toBe(0);
  });

  it('promotes both markers once the row is delivered, idempotently, with the owner, repository and how provably shown', () => {
    const { db, store } = world();
    store.githubWatches.markEventDelivered('s1', T3);
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(2);
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(0);
    expect(store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 1, notProvablyShown: 1 });
    expect(store.githubWatches.gapMarkers(OWNER, 10)).toMatchObject([
      { ownerId: OWNER, watchId: 'w1', repoKey: 'acme/demo', pr: 7, reviewClass: 'approval', reason: 'unavailable', shown: 'shown', outboxRef: 's1', deliveredAt: T3 },
      { pr: 8, reviewClass: 'changes_requested', reason: 'truncated', shown: 'delivered_not_provably_shown' },
    ]);
    expect(store.githubWatches.gapMarkerCounts('100000000000000009')).toEqual({ shown: 0, notProvablyShown: 0 });
    expect(count(db)).toBe(2);
  });

  it('keeps the markers when the outbox row and then the watch are deleted', () => {
    const { db, store } = world();
    store.githubWatches.markEventDelivered('s1', T3);
    store.githubWatches.promoteGapMarkers('s1');
    db.prepare('DELETE FROM github_watch_events').run();
    db.prepare('DELETE FROM github_watches').run();
    expect(store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 1, notProvablyShown: 1 });
    expect(store.githubWatches.gapMarkers(OWNER, 10)[0]).toMatchObject({ publicWatchId: null, repoKey: 'acme/demo' });
  });

  it('ignores a pending list that is not exactly what this build writes', () => {
    const { db, store } = world();
    db.prepare("UPDATE github_watch_events SET gap_markers = '[{\"pr\":0,\"cls\":\"x\",\"reason\":\"y\",\"shown\":\"z\"}]'").run();
    store.githubWatches.markEventDelivered('s1', T3);
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(0);
    db.prepare("UPDATE github_watch_events SET gap_markers = 'not json'").run();
    expect(store.githubWatches.promoteGapMarkers('s1')).toBe(0);
  });
});
