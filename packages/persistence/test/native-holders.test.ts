import { describe, expect, it } from 'vitest';
import { hashProviderRef, transitionKey, type Transition } from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import { createStore, type Store } from '../src/index.js';

/**
 * Migration 37 and the multi-holder protocol (ADR 0034). Several NATIVE paths can tell one exact transition
 * (a feed card and an ordinary summary); each keeps its own row, a delivery or release touches only its own,
 * and the target is decided against the aggregate. Invented data only.
 */
const OWNER = '100000000000000001';
const OTHER_OWNER = '100000000000000002';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const T2 = '2026-10-01T02:00:00.000Z';
const T3 = '2026-10-01T03:00:00.000Z';

const fresh = (): { db: Db; store: Store } => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return { db, store: createStore(db) };
};
const t = (kind: Transition['kind'], item: string, extra: Partial<Transition> = {}): Transition => ({
  kind, item, stamp: null, hash: null, attempt: null, ...extra,
});
const NATIVE = hashProviderRef('native-graphql-id')!;
const REST = hashProviderRef('rest-node-id')!;
const cr = (hash: string, n = '7') => t('changes_requested', n, { hash });
const opened = t('pr_opened', '7');
const review = (hash: string | null, at: string) => ({
  kind: 'review_requested_changes' as const, identity: '7:review:1', occurredAt: at, providerHash: hash, attempt: null,
});
const openedFacts = { kind: 'pr_opened' as const, identity: '7:opened', occurredAt: T1, providerHash: null, attempt: null };
const resolve = (store: Store, f: Parameters<Store['nativeTransitions']['resolveTarget']>[2], repo = REPO, owner = OWNER) =>
  store.nativeTransitions.resolveTarget(owner, repo, f);
const reserve = (store: Store, tr: Transition, via: 'feed_event' | 'watch_summary', ref: string, at = T0, repo = REPO, owner = OWNER) =>
  store.nativeTransitions.reserveNative(owner, repo, tr, via, ref, at, at);
const deliver = (store: Store, via: 'feed_event' | 'watch_summary', ref: string, at = T0) =>
  store.nativeTransitions.markNativeDelivered(via, ref, 'owner_dm', at);
const claimRows = (db: Db, key: string): number =>
  (db.prepare('SELECT COUNT(*) n FROM native_transition_claims WHERE transition_key = ?').get(key) as { n: number }).n;

describe('migration 37 rebuilds the ledger from a populated migration 36 without losing a row or a value', () => {
  const at36 = (rows: (db: Db) => void): Db => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db, { upTo: 36, now: () => T0 });
    rows(db);
    return db;
  };
  const insertClaim = (db: Db, over: Record<string, unknown>): void => {
    const c = {
      owner_id: OWNER, repo_key: REPO, transition_key: 'pr_opened:7', kind: 'pr_opened', item: '7', stamp: null,
      provider_hash: null, attempt: null, provider_at: null, path: 'native', state: 'reserved', via: 'feed_event',
      ref: 'f1', observed_at: T0, delivered_to: null, delivered_at: null, created_at: T0, updated_at: T0, ...over,
    };
    const cols = Object.keys(c);
    db.prepare(`INSERT INTO native_transition_claims (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...(Object.values(c) as (string | null)[]));
  };
  const populate = (db: Db): void => {
    insertClaim(db, {});
    insertClaim(db, { transition_key: 'pr_opened:8', item: '8', ref: 'f2', state: 'delivered', delivered_to: 'owner_dm', delivered_at: T1 });
    insertClaim(db, {
      transition_key: `changes_requested:7:${REST}`, kind: 'changes_requested', provider_hash: REST,
      provider_at: T1, path: 'target', state: 'delivered', via: 'target_alert', ref: 'e1', delivered_to: 'owner_dm', delivered_at: T2,
    });
    insertClaim(db, { owner_id: OTHER_OWNER, repo_key: 'acme/other', transition_key: 'commit:abc1234', kind: 'commit', item: 'abc1234', via: 'feed_commit', ref: 'abc1234' });
    db.prepare(
      `INSERT INTO native_legacy_seed (repo_key, transition_key, kind, item, via, ref, observed_at, delivered_to, delivered_at)
       VALUES ('acme/demo','pr_opened:9','pr_opened','9','feed_event','f9',?, 'owner_dm', ?)`,
    ).run(T0, T1);
  };
  const snapshot = (db: Db, table: string, order: string): unknown[] =>
    db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();

  it('keeps every row and every value, in both ledger tables, and drops only the originals', () => {
    const db = at36(populate);
    const claimsBefore = snapshot(db, 'native_transition_claims', 'owner_id, repo_key, transition_key');
    const seedBefore = snapshot(db, 'native_legacy_seed', 'repo_key, transition_key');
    expect(claimsBefore).toHaveLength(4);
    expect(runMigrations(db, { now: () => T3 })).toEqual([37]);
    expect(snapshot(db, 'native_transition_claims', 'owner_id, repo_key, transition_key')).toEqual(claimsBefore);
    expect(snapshot(db, 'native_legacy_seed', 'repo_key, transition_key')).toEqual(seedBefore);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%v36%'").all() as { name: string }[]);
    expect(names).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version = 37").get()).toEqual({ n: 1 });
  });

  it('recreates the indexes and the per-target uniqueness, and lets two native holders share a transition', () => {
    const db = at36(populate);
    runMigrations(db, { now: () => T3 });
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='native_transition_claims'").all() as { name: string }[])
      .map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['ix_native_claims_family', 'ix_native_claims_ref', 'ux_native_claims_one_target']));
    // The same transition, a second NATIVE holder: accepted (it was silently ignored before).
    const store = createStore(db);
    expect(store.nativeTransitions.reserveNative(OWNER, REPO, t('pr_opened', '8'), 'watch_summary', 's1', T2, T2)).toBe(true);
    expect(claimRows(db, 'pr_opened:8')).toBe(2);
    // The same holder twice stays one row; a second TARGET claim of one transition is refused.
    expect(store.nativeTransitions.reserveNative(OWNER, REPO, t('pr_opened', '8'), 'watch_summary', 's1', T2, T2)).toBe(false);
    const f = { kind: 'review_requested_changes' as const, identity: '7:review:2', occurredAt: T3, providerHash: REST, attempt: null };
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_digest', 'e2', T3).reserved).toBe(false);
    expect(() => db.prepare(
      `INSERT INTO native_transition_claims (owner_id, repo_key, transition_key, kind, item, provider_hash, path, state, via, ref, observed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'target','reserved','target_digest','e9',?,?,?)`,
    ).run(OWNER, REPO, `changes_requested:7:${REST}`, 'changes_requested', '7', REST, T3, T3, T3)).toThrow(/UNIQUE/);
  });

  it('adds the held-fact columns and the read boundary without inventing a value for an existing watch', () => {
    const db = at36((d) => {
      d.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo',?)`).run(T0);
      d.prepare(`INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
                 VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo')`).run(OWNER, T0, T0, T0);
      d.prepare(`INSERT INTO github_watch_events (id, watch_id, fingerprint, summary, created_at, repo_key) VALUES ('s1','w1','fp','s',?, 'acme/demo')`).run(T0);
    });
    runMigrations(db, { now: () => T3 });
    expect(db.prepare('SELECT read_boundary_at FROM github_watches').get()).toEqual({ read_boundary_at: null });
    expect(db.prepare('SELECT held_reason, held_key, provider_at FROM github_watch_events').get())
      .toEqual({ held_reason: null, held_key: null, provider_at: null });
    // A pending legacy row stays pending work for the existing outbox.
    expect(createStore(db).githubWatches.pendingEvents(10).map((e) => e.id)).toEqual(['s1']);
  });

  it('is atomic: a rebuilt table that differs from the original rolls the whole migration back', () => {
    const db = at36(populate);
    const m = MIGRATIONS.find((x) => x.version === 37)!;
    db.exec('BEGIN');
    db.exec(m.sql);
    // A lost row, as a defect in the copy would produce.
    db.prepare("DELETE FROM native_transition_claims WHERE transition_key = 'pr_opened:8'").run();
    expect(() => m.after!(db, { fresh: false, at: T3 })).toThrow(/does not hold exactly the rows/);
    db.exec('ROLLBACK');
    // Nothing of migration 37 survived: the originals are intact and the migration is still pending.
    expect(snapshot(db, 'native_transition_claims', 'owner_id, repo_key, transition_key')).toHaveLength(4);
    expect(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version = 37").get()).toEqual({ n: 0 });
    expect(() => db.prepare('SELECT held_reason FROM github_watch_events').get()).toThrow();
  });

  it('keeps a value that differs as a failure too, not only a missing row', () => {
    const db = at36(populate);
    const m = MIGRATIONS.find((x) => x.version === 37)!;
    db.exec('BEGIN');
    db.exec(m.sql);
    db.prepare("UPDATE native_transition_claims SET observed_at = ? WHERE transition_key = 'pr_opened:7'").run(T3);
    expect(() => m.after!(db, { fresh: false, at: T3 })).toThrow(/does not hold exactly the rows/);
    db.exec('ROLLBACK');
  });

  it('migrates the legacy staging per holder, so both holders of one staged transition survive seeding', () => {
    const db = at36((d) => {
      const seed = d.prepare(
        `INSERT INTO native_legacy_seed (repo_key, transition_key, kind, item, via, ref, observed_at, delivered_to, delivered_at)
         VALUES ('acme/demo','pr_opened:9','pr_opened','9','feed_event','f9',?, ?, ?)`,
      );
      seed.run(T0, 'owner_dm', T1);
    });
    runMigrations(db, { now: () => T3 });
    // After migration 37 a second staged holder of the same transition is no longer ignored.
    db.prepare(
      `INSERT INTO native_legacy_seed (repo_key, transition_key, kind, item, via, ref, observed_at)
       VALUES ('acme/demo','pr_opened:9','pr_opened','9','feed_event','f10',?)`,
    ).run(T0);
    const store = createStore(db);
    store.nativeTransitions.ensureSeeded(OWNER, T3);
    expect(claimRows(db, 'pr_opened:9')).toBe(2);
  });
});

describe('several native holders of one exact transition', () => {
  it('keeps the summary receipt when the feed card that reserved first is abandoned', () => {
    const { db, store } = fresh();
    expect(reserve(store, cr(NATIVE), 'feed_event', 'card', T0)).toBe(true);
    expect(reserve(store, cr(NATIVE), 'watch_summary', 'sum', T1)).toBe(true); // was silently ignored before
    deliver(store, 'watch_summary', 'sum', T1);
    store.nativeTransitions.releaseNative('feed_event', 'card'); // the card will never be sent
    expect(claimRows(db, transitionKey(cr(NATIVE)))).toBe(1);
    expect(resolve(store, review(NATIVE, T0))).toEqual({ outcome: 'covered' });
  });

  it('keeps the card receipt when the summary reserved first and is abandoned', () => {
    const { db, store } = fresh();
    reserve(store, opened, 'watch_summary', 'sum', T0);
    reserve(store, opened, 'feed_event', 'card', T1);
    deliver(store, 'feed_event', 'card', T1);
    store.nativeTransitions.releaseNative('watch_summary', 'sum');
    expect(claimRows(db, 'pr_opened:7')).toBe(1);
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'covered' });
  });

  it('a delivery converts only its own holder; the other stays a reservation and the target waits only if none delivered', () => {
    const { store } = fresh();
    reserve(store, opened, 'feed_event', 'card', T0);
    reserve(store, opened, 'watch_summary', 'sum', T0);
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'wait' });
    deliver(store, 'watch_summary', 'sum', T1);
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsNative: 1, reservedNative: 1 });
    // Any delivered exact holder settles it, whatever the other holder is doing.
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'covered' });
  });

  it('a release removes only its own reservation, and the target keeps waiting on the other', () => {
    const { store } = fresh();
    reserve(store, opened, 'feed_event', 'card', T0);
    reserve(store, opened, 'watch_summary', 'sum', T0);
    store.nativeTransitions.releaseNative('feed_event', 'card');
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'wait' });
    store.nativeTransitions.releaseNative('watch_summary', 'sum');
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'deliver' });
  });

  it('a path or repository release touches only that path and repository', () => {
    const { store } = fresh();
    reserve(store, opened, 'feed_event', 'card', T0);
    reserve(store, opened, 'watch_summary', 'sum', T0);
    reserve(store, opened, 'feed_event', 'card2', T0, 'acme/other');
    store.nativeTransitions.releaseNativeVia('feed_event');
    expect(store.nativeTransitions.counts().reservedNative).toBe(1);
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'wait' }); // the summary still holds it
    expect(resolve(store, openedFacts, 'acme/other')).toEqual({ outcome: 'deliver' });
  });

  it('isolates owners and repositories', () => {
    const { store } = fresh();
    reserve(store, opened, 'feed_event', 'card', T0, REPO, OWNER);
    deliver(store, 'feed_event', 'card');
    expect(resolve(store, openedFacts, REPO, OTHER_OWNER)).toEqual({ outcome: 'deliver' });
    expect(resolve(store, openedFacts, 'acme/other', OWNER)).toEqual({ outcome: 'deliver' });
  });

  it('survives a restart: a pending holder keeps its reservation, a receipt keeps its row', () => {
    const { db, store } = fresh();
    db.prepare(`INSERT INTO github_feed_repos (repo_key, display, source, state, created_at, updated_at) VALUES ('acme/demo','acme/demo','explicit','active',?,?)`).run(T0, T0);
    db.prepare(`INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at)
                VALUES ('card','pr_opened:acme/demo#7','pr_opened','acme/demo','selected',NULL,'pending',?)`).run(T0);
    reserve(store, opened, 'feed_event', 'card', T0);
    reserve(store, opened, 'watch_summary', 'sum', T0);
    deliver(store, 'watch_summary', 'sum', T1);
    store.nativeTransitions.recoverTargetSends();
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsNative: 1, reservedNative: 1 });
    expect(resolve(store, openedFacts)).toEqual({ outcome: 'covered' });
  });
});

describe('a review of another id is judged against EVERY native holder', () => {
  const REVIEW_SUBMITTED = T2;

  it('is delivered only when it was submitted after every delivered holder observed the pull request', () => {
    const { store } = fresh();
    reserve(store, cr(NATIVE), 'feed_event', 'card', T0);
    deliver(store, 'feed_event', 'card', T0);
    reserve(store, cr(hashProviderRef('other')!), 'watch_summary', 'sum', T3);
    deliver(store, 'watch_summary', 'sum', T3);
    // After the FIRST holder but before the LATEST one: the latest could have contained it.
    expect(resolve(store, review(REST, REVIEW_SUBMITTED))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    // After both.
    expect(resolve(store, review(REST, '2026-10-01T04:00:00.000Z'))).toEqual({ outcome: 'deliver' });
  });

  it('waits while ANY holder of that pull request is reserved, even when another delivered long before', () => {
    const { store } = fresh();
    reserve(store, cr(NATIVE), 'feed_event', 'card', T0);
    deliver(store, 'feed_event', 'card', T0);
    reserve(store, cr(hashProviderRef('other')!), 'watch_summary', 'sum', T0);
    expect(resolve(store, review(REST, '2026-10-01T04:00:00.000Z'))).toEqual({ outcome: 'wait' });
    store.nativeTransitions.releaseNative('watch_summary', 'sum');
    expect(resolve(store, review(REST, '2026-10-01T04:00:00.000Z'))).toEqual({ outcome: 'deliver' });
  });

  it('an equal id still settles it, whichever holder delivered', () => {
    const { store } = fresh();
    reserve(store, cr(NATIVE), 'feed_event', 'card', T0);
    reserve(store, cr(NATIVE), 'watch_summary', 'sum', T0);
    deliver(store, 'watch_summary', 'sum', T1);
    store.nativeTransitions.releaseNative('feed_event', 'card');
    expect(resolve(store, review(NATIVE, REVIEW_SUBMITTED))).toEqual({ outcome: 'covered' });
  });
});

describe('the target keeps exactly one claim per transition and native holders may coexist with it', () => {
  it('refuses a second target claim and a native holder may still reserve beside a target receipt', () => {
    const { db, store } = fresh();
    const first = store.nativeTransitions.reserveTarget(OWNER, REPO, openedFacts, 'target_alert', 'e1', T1);
    expect(first.reserved).toBe(true);
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, openedFacts, 'target_digest', 'e2', T1))
      .toMatchObject({ reserved: false, resolution: { outcome: 'wait' } });
    store.nativeTransitions.markTargetDelivered('target_alert', 'e1', T2);
    // The native side skips an item the target delivered (and so never reserves it) ...
    expect(store.nativeTransitions.probeNative(OWNER, REPO, opened)).toBe('target_delivered');
    // ... and the ledger itself does not forbid a native holder beside it.
    expect(reserve(store, opened, 'watch_summary', 'sum', T2)).toBe(true);
    expect(claimRows(db, 'pr_opened:7')).toBe(2);
  });
});

describe('held ordinary requested-changes facts and the read boundary', () => {
  const REPO_ROW = (db: Db): void => {
    db.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo',?)`).run(T0);
    db.prepare(`INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
                VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo')`).run(OWNER, T0, T0, T0);
  };
  const observe = (store: Store, over: Record<string, unknown> = {}) =>
    store.githubWatches.observe({
      id: 'w1', expectedNextCheckAt: T0, expectedRepoKey: 'acme/demo', repoKey: 'acme/demo', snapshotHash: 'h', snapshotJson: '{}',
      nextCheckAt: T1, atIso: T0, changed: true, readBoundaryAt: T0, ...over,
    } as Parameters<Store['githubWatches']['observe']>[0]);
  const heldRow = { id: 'h1', heldKey: transitionKey(cr(NATIVE)), summary: 'held, not sent', providerAt: T0 };

  it('commits the snapshot, the boundary and the held row together, and is unique per watch and transition', () => {
    const { db, store } = fresh();
    REPO_ROW(db);
    expect(observe(store, { held: [heldRow, { ...heldRow, id: 'h2' }] })).toBe(true);
    expect(store.githubWatches.heldCount()).toBe(1);
    expect(store.githubWatches.byId('w1')!.readBoundaryAt).toBe(T0);
    expect(store.githubWatches.pendingEvents(10)).toEqual([]);
    // A replay (the same fact on a later observation) is ignored, not duplicated.
    observe(store, { expectedNextCheckAt: T1, held: [{ ...heldRow, id: 'h3' }] });
    expect(store.githubWatches.heldCount()).toBe(1);
  });

  it('a lost compare-and-set writes no held row', () => {
    const { db, store } = fresh();
    REPO_ROW(db);
    expect(observe(store, { expectedNextCheckAt: T3, held: [heldRow] })).toBe(false);
    expect(store.githubWatches.heldCount()).toBe(0);
  });

  it('is never sent, charged an attempt, delivered or abandoned, and a cancel does not free it', () => {
    const { db, store } = fresh();
    REPO_ROW(db);
    observe(store, { held: [heldRow], events: [{ id: 'e1', fingerprint: 'f', summary: 'real' }] });
    store.githubWatches.markEventDelivered('h1', T1);
    store.githubWatches.recordEventFailure('h1', T1, 1);
    expect(db.prepare("SELECT attempts, delivered_at, abandoned_at FROM github_watch_events WHERE id = 'h1'").get())
      .toEqual({ attempts: 0, delivered_at: null, abandoned_at: null });
    store.githubWatches.cancel(OWNER, 'w1', T2);
    expect(db.prepare("SELECT abandoned_at FROM github_watch_events WHERE id = 'e1'").get()).toEqual({ abandoned_at: T2 });
    expect(db.prepare("SELECT abandoned_at FROM github_watch_events WHERE id = 'h1'").get()).toEqual({ abandoned_at: null });
    expect(store.githubWatches.heldCount()).toBe(1);
    expect(store.githubWatches.heldReviews(10)).toMatchObject([{ publicWatchId: 'wabcde', watchState: 'cancelled', providerAt: T0 }]);
  });

  it('holds no reservation, so a held fact never makes the target wait', () => {
    const { db, store } = fresh();
    REPO_ROW(db);
    observe(store, { held: [heldRow] });
    expect(store.nativeTransitions.counts().reservedNative).toBe(0);
    store.nativeTransitions.sweepOrphans();
    expect(store.githubWatches.heldCount()).toBe(1);
  });

  it('survives retention, and a cancelled watch holding one is kept whole', () => {
    const { db, store } = fresh();
    REPO_ROW(db);
    observe(store, { held: [heldRow] });
    store.githubWatches.cancel(OWNER, 'w1', T0);
    const far = '2027-10-01T00:00:00.000Z';
    expect(store.retention.deleteSettledWatchEvents(far, 100)).toBe(0);
    expect(store.retention.deleteCancelledWatches(far, 100)).toEqual({ watches: 0, events: 0 });
    expect(store.githubWatches.heldCount()).toBe(1);
    // Without a held fact the same cancelled watch is retained away as before.
    db.prepare("DELETE FROM github_watch_events WHERE held_reason IS NOT NULL").run();
    expect(store.retention.deleteCancelledWatches(far, 100)).toEqual({ watches: 1, events: 0 });
  });

  it('a failed read invalidates the boundary; a good one sets it', () => {
    const { db, store } = fresh();
    REPO_ROW(db);
    observe(store);
    expect(store.githubWatches.byId('w1')!.readBoundaryAt).toBe(T0);
    store.githubWatches.recordFailure('w1', T1, T2, 'failed', T1);
    expect(store.githubWatches.byId('w1')!.readBoundaryAt).toBeNull();
  });
});
