import { describe, expect, it } from 'vitest';
import { hashProviderRef, type Transition } from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * The native/target reconciliation ledger (ADR 0034), against the real schema. Invented data only.
 * A transition is told by exactly one path: a native path reserves it with its outbox row and
 * delivers it; the imported target reserves it only around one send. Nothing weaker than an exact
 * identity is ever a receipt.
 */
const OWNER = '100000000000000001';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const T2 = '2026-10-01T02:00:00.000Z';

const fresh = (): { db: Db; store: Store } => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return { db, store: createStore(db) };
};

const t = (kind: Transition['kind'], item: string, extra: Partial<Transition> = {}): Transition => ({
  kind, item, stamp: null, hash: null, attempt: null, ...extra,
});
const facts = (
  kind: 'commit' | 'pr_opened' | 'pr_updated' | 'pr_merged' | 'review_requested_changes' | 'issue_opened' | 'ci_failed' | 'release',
  identity: string, occurredAt = T1, extra: { providerHash?: string | null; attempt?: string | null } = {},
) => ({ kind, identity, occurredAt, providerHash: extra.providerHash ?? null, attempt: extra.attempt ?? null });

const nativeTold = (store: Store, tr: Transition, ref = 'n1', repo = REPO, observedAt = T0) => {
  store.nativeTransitions.reserveNative(OWNER, repo, tr, 'feed_event', ref, observedAt, observedAt);
  store.nativeTransitions.markNativeDelivered('feed_event', ref, 'owner_dm', observedAt);
};
const nativeHeld = (store: Store, tr: Transition, ref = 'n1', repo = REPO, observedAt = T0) =>
  store.nativeTransitions.reserveNative(OWNER, repo, tr, 'feed_event', ref, observedAt, observedAt);

const resolve = (store: Store, f: ReturnType<typeof facts>, repo = REPO) =>
  store.nativeTransitions.resolveTarget(OWNER, repo, f);

describe('an exact native receipt settles the imported event; a reservation only makes it wait', () => {
  const cases: [string, Transition, ReturnType<typeof facts>][] = [
    ['an opened pull request', t('pr_opened', '7'), facts('pr_opened', '7:opened')],
    ['an opened issue', t('issue_opened', '3'), facts('issue_opened', '3:issue_opened:2026-10-01T00:00:00Z')],
    ['a named commit', t('commit', 'abc1234'), facts('commit', 'abc1234')],
    ['a merge by its merge instant', t('pr_merged', '7', { stamp: T1 }), facts('pr_merged', '7:merged', T1)],
    ['an update by its update instant', t('pr_updated', '7', { stamp: T1 }), facts('pr_updated', `7:updated:${T1}`, T1)],
    ['a requested-changes review by the hash of its id', t('changes_requested', '7', { hash: hashProviderRef('PRR_x')! }),
      facts('review_requested_changes', '7:review:99', T1, { providerHash: hashProviderRef('PRR_x') })],
    ['a failed run by id and attempt', t('ci_failed', '55', { attempt: '2' }), facts('ci_failed', '55:ci_failed', T1, { attempt: '2' })],
  ];

  it.each(cases)('%s', (_name, tr, f) => {
    const { store } = fresh();
    expect(resolve(store, f)).toEqual({ outcome: 'deliver' });
    nativeHeld(store, tr);
    expect(resolve(store, f)).toEqual({ outcome: 'wait' });
    store.nativeTransitions.markNativeDelivered('feed_event', 'n1', 'github_channel', T0);
    expect(resolve(store, f)).toEqual({ outcome: 'covered' });
    // A reservation released because its row will not be sent lets the target deliver.
    const other = fresh();
    nativeHeld(other.store, tr);
    other.store.nativeTransitions.releaseNative('feed_event', 'n1');
    expect(resolve(other.store, f)).toEqual({ outcome: 'deliver' });
  });

  it('is exact: a different repository, number, instant, attempt or review hash is not the same fact', () => {
    const { store } = fresh();
    nativeTold(store, t('pr_merged', '7', { stamp: T1 }), 'n1');
    nativeTold(store, t('ci_failed', '55', { attempt: '1' }), 'n2');
    nativeTold(store, t('changes_requested', '7', { hash: hashProviderRef('A')! }), 'n3');
    expect(resolve(store, facts('pr_merged', '7:merged', T1), 'acme/other')).toEqual({ outcome: 'deliver' });
    expect(resolve(store, facts('pr_merged', '8:merged', T1))).toEqual({ outcome: 'deliver' });
    expect(resolve(store, facts('pr_merged', '7:merged', T2))).toEqual({ outcome: 'deliver' });
    expect(resolve(store, facts('ci_failed', '55:ci_failed', T2, { attempt: '2' }))).toEqual({ outcome: 'deliver' });
    // A requested change submitted AFTER the native observation was not in it, whatever its hash.
    expect(resolve(store, facts('review_requested_changes', '7:review:5', T2, { providerHash: hashProviderRef('B') })))
      .toEqual({ outcome: 'deliver' });
  });

  it('never matches on a timestamp alone', () => {
    const { store } = fresh();
    nativeTold(store, t('pr_merged', '7', { stamp: T1 }));
    // Same instant, different pull request: nothing.
    expect(resolve(store, facts('pr_merged', '9:merged', T1))).toEqual({ outcome: 'deliver' });
  });

  it('covers an update by a native update at or after it, never before it, never another pull request', () => {
    const { store } = fresh();
    nativeTold(store, t('pr_updated', '7', { stamp: T2 }));
    expect(resolve(store, facts('pr_updated', `7:updated:${T1}`, T1))).toEqual({ outcome: 'covered' });
    expect(resolve(store, facts('pr_updated', `7:updated:${T2}`, T2))).toEqual({ outcome: 'covered' });
    expect(resolve(store, facts('pr_updated', '7:updated:2026-10-01T03:00:00Z', '2026-10-01T03:00:00.000Z')))
      .toEqual({ outcome: 'deliver' });
    expect(resolve(store, facts('pr_updated', `8:updated:${T1}`, T1))).toEqual({ outcome: 'deliver' });
  });

  it('gives kinds with no native counterpart no ledger decision at all', () => {
    const { store } = fresh();
    for (const k of ['release', 'ci_started', 'pr_closed', 'issue_updated', 'default_branch_change'] as const) {
      expect(resolve(store, facts(k as never, '1:x'))).toEqual({ outcome: 'deliver' });
    }
  });
});

describe('a review that cannot be named exactly is never sent while a native path could tell it', () => {
  const noHash = facts('review_requested_changes', '7:review:99', T1);

  it('is withheld, not delivered, when the repository has a feed row: a later exact native receipt would repeat it', () => {
    const { store } = fresh();
    expect(resolve(store, noHash)).toEqual({ outcome: 'deliver' }); // no native path could ever tell it
    store.githubFeed.insertRepo({ repoKey: REPO, display: REPO, source: 'explicit', atIso: T0 });
    expect(resolve(store, noHash)).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    // Even a cancelled selection is a durable tombstone: native history may exist.
    store.githubFeed.cancelRepo(REPO, T0);
    expect(resolve(store, noHash)).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
  });

  it('waits on a native reservation for the same pull request, and is withheld by a delivered one', () => {
    const { store } = fresh();
    nativeHeld(store, t('changes_requested', '7', { hash: hashProviderRef('A')! }), 'n1', REPO, T2);
    expect(resolve(store, noHash)).toEqual({ outcome: 'wait' });
    store.nativeTransitions.markNativeDelivered('feed_event', 'n1', 'owner_dm', T2);
    expect(resolve(store, noHash)).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    // A review submitted after the native observation (and its margin) could not have been in it:
    // the timestamp only proves a DIFFERENCE, and the review is not held back by that card.
    expect(resolve(store, facts('review_requested_changes', '7:review:100', '2026-10-01T03:00:00.000Z')))
      .toEqual({ outcome: 'deliver' });
  });

  it('treats a run without its attempt the same way, and never matches across attempts', () => {
    const { store } = fresh();
    const noAttempt = facts('ci_failed', '55:ci_failed', T1);
    expect(resolve(store, noAttempt)).toEqual({ outcome: 'deliver' });
    store.githubFeed.insertRepo({ repoKey: REPO, display: REPO, source: 'explicit', atIso: T0 });
    expect(resolve(store, noAttempt)).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    nativeTold(store, t('ci_failed', '55', { attempt: '1' }));
    // Attempt 2 is a different fact from the told attempt 1.
    expect(resolve(store, facts('ci_failed', '55:ci_failed', T1, { attempt: '2' }))).toEqual({ outcome: 'deliver' });
  });
});

describe('the target reserves only around one send, and two sends of one transition never run at once', () => {
  const f = facts('pr_opened', '7:opened');

  it('reserves, becomes a receipt on success and is released on failure', () => {
    const { store } = fresh();
    const r = store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1);
    expect(r).toMatchObject({ reserved: true, resolution: { outcome: 'deliver' } });
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_opened', '7'))).toBe('target_in_flight');
    store.nativeTransitions.releaseTarget('target_alert', 'e1');
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_opened', '7'))).toBe('free');
    store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1);
    store.nativeTransitions.markTargetDelivered('target_alert', 'e1', T1);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_opened', '7'))).toBe('target_delivered');
  });

  it('makes a second send wait while the first is in flight, whichever mode or event asks', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1);
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_digest', 'e1', T1))
      .toMatchObject({ reserved: false, resolution: { outcome: 'wait' } });
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_digest', 'e2', T1))
      .toMatchObject({ reserved: false, resolution: { outcome: 'wait' } });
  });

  it('lets the SAME event be told in its other mode once the first was delivered, and not another event', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1);
    store.nativeTransitions.markTargetDelivered('target_alert', 'e1', T1);
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_digest', 'e1', T2))
      .toMatchObject({ reserved: false, resolution: { outcome: 'deliver' } });
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_digest', 'e2', T2))
      .toMatchObject({ reserved: false, resolution: { outcome: 'covered' }, selfCovered: true });
  });

  it('does not reserve when a native path already delivered or holds the transition', () => {
    const { store } = fresh();
    nativeHeld(store, t('pr_opened', '7'));
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1))
      .toMatchObject({ reserved: false, resolution: { outcome: 'wait' } });
    store.nativeTransitions.markNativeDelivered('feed_event', 'n1', 'owner_dm', T0);
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1))
      .toMatchObject({ reserved: false, resolution: { outcome: 'covered' } });
    expect(store.nativeTransitions.counts().reservedTarget).toBe(0);
  });

  it('recovers a send of unknown outcome to pending, never to a receipt', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', 'e1', T1);
    store.nativeTransitions.reserveNative(OWNER, REPO, t('issue_opened', '3'), 'feed_event', 'n9', T0, T0);
    expect(store.nativeTransitions.recoverTargetSends()).toBe(1);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_opened', '7'))).toBe('free');
    expect(store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 0, reservedNative: 1 });
  });

  it('keeps a native reservation across a restart: its outbox row is still pending', () => {
    const { store } = fresh();
    nativeHeld(store, t('pr_opened', '7'));
    store.nativeTransitions.recoverTargetSends();
    expect(resolve(store, f)).toEqual({ outcome: 'wait' });
  });
});

describe('a native path skips an item only for a transition the target actually delivered', () => {
  it('is free before, in flight during, and skipped after; for updates a later target update covers an earlier one', () => {
    const { store } = fresh();
    const upd = t('pr_updated', '7', { stamp: T1 });
    expect(store.nativeTransitions.probeNative(OWNER, REPO, upd)).toBe('free');
    store.nativeTransitions.reserveTarget(OWNER, REPO, facts('pr_updated', `7:updated:${T2}`, T2), 'target_digest', 'e1', T2);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, upd)).toBe('target_in_flight');
    store.nativeTransitions.markTargetDelivered('target_digest', 'e1', T2);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, upd)).toBe('target_delivered');
    // A native update NEWER than the target's was not told by it.
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_updated', '7', { stamp: '2026-10-01T05:00:00.000Z' }))).toBe('free');
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_updated', '8', { stamp: T1 }))).toBe('free');
  });

  it('does not count an imported event that merely exists, or another owner', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget('100000000000000099', REPO, facts('pr_opened', '7:opened'), 'target_alert', 'e1', T1);
    store.nativeTransitions.markTargetDelivered('target_alert', 'e1', T1);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, t('pr_opened', '7'))).toBe('free');
  });
});

describe('the ledger answers from indexes, not from every row', () => {
  it('uses the family index for each lookup', () => {
    const { db } = fresh();
    const plan = (sql: string, ...p: (string | number)[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((r) => r.detail).join(' | ');
    const agg = `SELECT MAX(CASE WHEN state = 'delivered' THEN 2 ELSE 1 END) FROM native_transition_claims
                  WHERE owner_id = ? AND repo_key = ? AND kind = ? AND item = ? AND path = ? AND stamp >= ?`;
    expect(plan(agg, OWNER, REPO, 'pr_updated', '7', 'native', T0)).toMatch(/USING (COVERING )?INDEX ix_native_claims_family/);
    const key = 'SELECT path, state, ref FROM native_transition_claims WHERE owner_id = ? AND repo_key = ? AND transition_key = ?';
    expect(plan(key, OWNER, REPO, 'pr_opened:7')).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_native_transition_claims/);
  });

  it('stays correct with thousands of unrelated rows', () => {
    const { db, store } = fresh();
    const ins = db.prepare(
      `INSERT INTO native_transition_claims (owner_id, repo_key, transition_key, kind, item, path, state, via, ref, observed_at, delivered_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pr_opened', ?, 'native', 'delivered', 'feed_event', ?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i <= 3000; i += 1) ins.run(OWNER, 'acme/bulk', `pr_opened:${i}`, String(i), `b${i}`, T0, T0, T0, T0);
    nativeTold(store, t('pr_opened', '7'));
    expect(resolve(store, facts('pr_opened', '7:opened'))).toEqual({ outcome: 'covered' });
    expect(resolve(store, facts('pr_opened', '7:opened'), 'acme/bulk')).toEqual({ outcome: 'covered' });
    expect(resolve(store, facts('pr_opened', '9999:opened'), 'acme/bulk')).toEqual({ outcome: 'deliver' });
  });
});

describe('what predates the ledger (migration 36 from a populated v35 database)', () => {
  const populated = (rows?: (db: Db) => void): { db: Db; store: Store } => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db, { upTo: 35 });
    rows?.(db);
    runMigrations(db, { now: () => '2026-10-10T00:00:00.000Z' });
    return { db, store: createStore(db) };
  };
  const CUT = '2026-10-10T00:00:00.000Z';

  it('is fresh only for a database created by one run of every migration', () => {
    expect(fresh().store.nativeTransitions.boundary()).toMatchObject({ fresh: true });
    expect(populated().store.nativeTransitions.boundary()).toMatchObject({ fresh: false, cutoffAt: CUT });
  });

  it('withholds EVERY counterpart event at or before the cutoff, even after retention pruned every native row', () => {
    // No watch, no feed row, no event survives: absence proves nothing on a database that is not new.
    const { store } = populated();
    for (const f of [
      facts('pr_opened', '7:opened', '2026-10-09T00:00:00.000Z'),
      facts('pr_merged', '7:merged', '2026-10-09T00:00:00.000Z'),
      facts('commit', 'abc1234', '2026-10-09T00:00:00.000Z'),
      facts('ci_failed', '5:ci_failed', '2026-10-09T00:00:00.000Z', { attempt: '1' }),
      facts('review_requested_changes', '7:review:1', '2026-10-09T00:00:00.000Z', { providerHash: hashProviderRef('x') }),
    ]) {
      expect(resolve(store, f), f.kind).toEqual({ outcome: 'withhold', reason: 'legacy_unproven' });
    }
    // The skew margin: one second past the cutoff is still held, a second more is not.
    expect(resolve(store, facts('pr_opened', '8:opened', '2026-10-10T00:00:01.000Z'))).toMatchObject({ outcome: 'withhold' });
    expect(resolve(store, facts('pr_opened', '8:opened', '2026-10-10T00:00:01.001Z'))).toEqual({ outcome: 'deliver' });
    // Kinds with no native counterpart are never withheld.
    expect(resolve(store, facts('release', 'release:1', '2026-10-09T00:00:00.000Z'))).toEqual({ outcome: 'deliver' });
  });

  it('an exact receipt seeded from a surviving delivered feed row clears the hold', () => {
    const { store } = populated((db) => {
      db.prepare(`INSERT INTO github_feed_repos (repo_key, display, source, state, created_at, updated_at) VALUES ('acme/demo','acme/demo','explicit','active',?,?)`).run(T0, T0);
      const ev = db.prepare(
        `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, delivered_at, delivered_to, created_at)
         VALUES (?,?,?,?, 'selected', NULL, ?, ?, ?, ?)`,
      );
      ev.run('f1', 'pr_opened:acme/demo#7', 'pr_opened', 'acme/demo', 'delivered', T0, 'owner_dm', T0);
      ev.run('f2', 'pr_opened:acme/demo#8', 'pr_opened', 'acme/demo', 'pending', null, null, T0);
      ev.run('f3', 'pr_opened:acme/demo#9', 'pr_opened', 'acme/demo', 'skipped', null, null, T0);
      ev.run('f4', 'pr_opened:acme/demo#10', 'pr_opened', 'acme/demo', 'baseline', null, null, T0);
      ev.run('f5', 'pr_opened:acme/demo#11', 'pr_opened', 'acme/demo', 'abandoned', null, null, T0);
      db.prepare(`INSERT INTO github_feed_commits (repo_key, sha, branch, headline, author, committed_at, observed_at, consumed_at, consumed_target)
                  VALUES ('acme/demo','aaaaaaa','main','h','a',?,?,NULL,NULL), ('acme/demo','bbbbbbb','main','h','a',?,?,?, 'owner_dm')`).run(T0, T0, T0, T0, T0);
    });
    store.nativeTransitions.ensureSeeded(OWNER, '2026-10-10T00:00:01.000Z');
    const early = '2026-10-09T00:00:00.000Z';
    expect(resolve(store, facts('pr_opened', '7:opened', early))).toEqual({ outcome: 'covered' }); // delivered row
    expect(resolve(store, facts('pr_opened', '8:opened', early))).toEqual({ outcome: 'wait' }); // pending row: reserved
    for (const n of ['9', '10', '11']) {
      // skipped, baseline and abandoned rows prove NO delivery
      expect(resolve(store, facts('pr_opened', `${n}:opened`, early)), n).toEqual({ outcome: 'withhold', reason: 'legacy_unproven' });
    }
    expect(resolve(store, facts('commit', 'aaaaaaa', early))).toEqual({ outcome: 'wait' }); // unconsumed: reserved
    expect(resolve(store, facts('commit', 'bbbbbbb', early))).toEqual({ outcome: 'withhold', reason: 'legacy_unproven' }); // consumed: named or counted unknown
    expect(store.nativeTransitions.boundary()?.seededAt).not.toBeNull();
    // Seeding happens once, and the staged rows are gone.
    expect((store.db.prepare('SELECT COUNT(*) n FROM native_legacy_seed').get() as { n: number }).n).toBe(0);
    store.nativeTransitions.ensureSeeded(OWNER, '2026-10-11T00:00:00.000Z');
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsNative: 1, reservedNative: 2 });
  });

  it('stages the rows in the migration itself, before any retention could prune them', () => {
    const { db } = populated((d) => {
      d.prepare(`INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, delivered_at, delivered_to, created_at)
                 VALUES ('f1','pr_opened:acme/demo#7','pr_opened','acme/demo','selected',NULL,'delivered',?,?,?)`).run(T0, 'github_channel', T0);
    });
    // Retention deletes the settled row before anyone has read the owner.
    db.prepare('DELETE FROM github_feed_events').run();
    const store = createStore(db);
    store.nativeTransitions.ensureSeeded(OWNER, '2026-10-10T00:00:01.000Z');
    expect(resolve(store, facts('pr_opened', '7:opened', '2026-10-09T00:00:00.000Z'))).toEqual({ outcome: 'covered' });
  });

  it('is additive: no legacy repo_key is invented, the old columns keep their rows, and a rollback of the code ignores the new ones', () => {
    const { db } = populated((d) => {
      d.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo',?)`).run(T0);
      d.prepare(`INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at)
                 VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?)`).run(OWNER, T0, T0, T0);
      d.prepare(`INSERT INTO github_watch_events (id, watch_id, fingerprint, summary, created_at) VALUES ('e1','w1','fp','s',?)`).run(T0);
    });
    expect(db.prepare('SELECT repo_key, cancel_reason FROM github_watches').get()).toEqual({ repo_key: null, cancel_reason: null });
    expect(db.prepare('SELECT repo_key FROM github_watch_events').get()).toEqual({ repo_key: null });
  });

  it('backfills an existing pause as an open period with unknown origin and no real start', () => {
    const { store } = populated((db) => {
      db.prepare(`INSERT INTO assistant_watch_settings (discord_user_id, monitoring_enabled, updated_at) VALUES (?, 0, ?)`).run(OWNER, T0);
    });
    expect(store.assistantWatch.pausePeriods(OWNER)).toEqual([
      { startedAt: null, startedOrigin: 'unknown', startBoundAt: T0, endedAt: null },
    ]);
  });

  it('refuses to decide anything against an unreadable boundary', () => {
    const { db, store } = fresh();
    db.exec('DELETE FROM native_ledger_boundary');
    expect(() => resolve(store, facts('pr_opened', '7:opened'))).toThrow(/unreadable/);
  });
});

describe('sweeping releases a native reservation only when its outbox row can no longer be sent', () => {
  const setup = () => {
    const { db, store } = fresh();
    db.prepare(`INSERT INTO github_feed_repos (repo_key, display, source, state, created_at, updated_at) VALUES ('acme/demo','acme/demo','explicit','active',?,?)`).run(T0, T0);
    const ev = (id: string, status: string) =>
      db.prepare(`INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at)
                  VALUES (?,?, 'pr_opened', 'acme/demo', 'selected', NULL, ?, ?)`).run(id, `pr_opened:acme/demo#${id.slice(1)}`, status, T0);
    return { db, store, ev };
  };

  it.each([
    ['a pending feed event', 'pending', true],
    ['an abandoned feed event', 'abandoned', false],
    ['a skipped (retired, deselected or stale) feed event', 'skipped', false],
    ['a delivered feed event whose reservation was never converted', 'delivered', false],
  ])('%s', (_name, status, kept) => {
    const { store, ev } = setup();
    ev('f1', status);
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('pr_opened', '1'), 'feed_event', 'f1', T0, T0);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts().reservedNative).toBe(kept ? 1 : 0);
  });

  it('keeps a receipt whatever happens to its row, and releases a commit that was consumed or deselected', () => {
    const { db, store } = setup();
    nativeTold(store, t('pr_opened', '2'), 'f2', 'acme/demo');
    db.prepare(`INSERT INTO github_feed_commits (repo_key, sha, branch, headline, author, committed_at, observed_at) VALUES ('acme/demo','ccccccc','main','h','a',?,?), ('acme/demo','ddddddd','main','h','a',?,?)`).run(T0, T0, T0, T0);
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('commit', 'ccccccc'), 'feed_commit', 'ccccccc', T0, T0);
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('commit', 'ddddddd'), 'feed_commit', 'ddddddd', T0, T0);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsNative: 1, reservedNative: 2 });
    db.prepare("UPDATE github_feed_commits SET consumed_at = ? WHERE sha = 'ccccccc'").run(T1); // expired or digested
    db.prepare("UPDATE github_feed_repos SET state = 'cancelled', cancelled_at = ? WHERE repo_key = 'acme/demo'").run(T1);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsNative: 1, reservedNative: 0 });
  });

  it('keeps a feed reservation when the feed is simply idle, and releases a whole path on request', () => {
    const { store, ev } = setup();
    ev('f1', 'pending');
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('pr_opened', '1'), 'feed_event', 'f1', T0, T0);
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('commit', 'eeeeeee'), 'feed_commit', 'eeeeeee', T0, T0);
    store.nativeTransitions.releaseNativeVia('feed_event');
    expect(store.nativeTransitions.counts().reservedNative).toBe(1);
    store.nativeTransitions.releaseNativeForRepo('feed_commit', 'acme/demo');
    expect(store.nativeTransitions.counts().reservedNative).toBe(0);
  });

  it('releases an ordinary summary reservation when its event was abandoned or its watch cancelled, not while it is pending', () => {
    const { db, store } = fresh();
    db.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo',?)`).run(T0);
    db.prepare(`INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
                VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo')`).run(OWNER, T0, T0, T0);
    const ev = db.prepare(`INSERT INTO github_watch_events (id, watch_id, fingerprint, summary, created_at, repo_key) VALUES (?, 'w1', ?, 's', ?, 'acme/demo')`);
    ev.run('s1', 'fp1', T0);
    ev.run('s2', 'fp2', T0);
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('pr_merged', '1', { stamp: T0 }), 'watch_summary', 's1', T0, T0);
    store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t('pr_merged', '2', { stamp: T0 }), 'watch_summary', 's2', T0, T0);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts().reservedNative).toBe(2);
    db.prepare("UPDATE github_watch_events SET abandoned_at = ? WHERE id = 's1'").run(T1);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts().reservedNative).toBe(1);
    // A remapped (identity-stopped) watch keeps its deliverable pending outbox, and so its reservation.
    store.githubWatches.cancelForIdentity('w1', T1);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts().reservedNative).toBe(1);
    // The owner's own cancel abandons what is pending, which releases it.
    db.prepare("UPDATE github_watch_events SET abandoned_at = ? WHERE id = 's2'").run(T1);
    store.nativeTransitions.sweepOrphans();
    expect(store.nativeTransitions.counts().reservedNative).toBe(0);
  });
});

/**
 * B1 regression (persisted from the reproduction that found it): a requested-changes review compared
 * by the hash of its id when the native id and the REST id may not be comparable on a live provider.
 * Whatever the order, a review is never told twice by a deterministic id mismatch, and a distinct
 * review is never dropped.
 */
describe('a requested-changes review is never told twice by an id mismatch, whichever path is first', () => {
  const NATIVE = hashProviderRef('native-graphql-id')!;
  const REST = hashProviderRef('rest-node-id')!;
  const review = (hash: string | null, at: string) => facts('review_requested_changes', '7:review:1', at, { providerHash: hash });
  const cr = (hash: string) => t('changes_requested', '7', { hash });
  const OBSERVED = '2026-10-01T01:00:00.000Z';
  const SUBMITTED = '2026-10-01T00:30:00.000Z';

  describe('native first', () => {
    it('waits while the native card is reserved, is withheld once it is delivered, and a missing id is the same', () => {
      const { store } = fresh();
      store.nativeTransitions.reserveNative(OWNER, REPO, cr(NATIVE), 'feed_event', 'n', OBSERVED, OBSERVED, SUBMITTED);
      expect(resolve(store, review(REST, SUBMITTED))).toEqual({ outcome: 'wait' });
      store.nativeTransitions.markNativeDelivered('feed_event', 'n', 'owner_dm', OBSERVED);
      expect(resolve(store, review(REST, SUBMITTED))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
      expect(resolve(store, review(null, SUBMITTED))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    });

    it('delivers a review submitted after the native observation: it could not have been in that card', () => {
      const { store } = fresh();
      nativeTold(store, cr(NATIVE), 'n', REPO, OBSERVED);
      expect(resolve(store, review(REST, '2026-10-01T03:00:00.000Z'))).toEqual({ outcome: 'deliver' });
    });

    it('is covered when the ids are equal', () => {
      const { store } = fresh();
      nativeTold(store, cr(NATIVE), 'n', REPO, OBSERVED);
      expect(resolve(store, review(NATIVE, SUBMITTED))).toEqual({ outcome: 'covered' });
    });
  });

  describe('target first', () => {
    const targetDelivered = (store: Store, hash: string, at: string) => {
      store.nativeTransitions.reserveTarget(OWNER, REPO, review(hash, at), 'target_digest', 'e1', '2026-10-01T02:00:00.000Z');
      store.nativeTransitions.markTargetDelivered('target_digest', 'e1', '2026-10-01T02:00:00.000Z');
    };

    it('HOLDS a native card whose provider instant equals the target review\'s, when the hashes differ', () => {
      const { store } = fresh();
      targetDelivered(store, REST, SUBMITTED);
      expect(store.nativeTransitions.probeNative(OWNER, REPO, cr(NATIVE), SUBMITTED)).toBe('ambiguous');
    });

    it('HOLDS a native card whose provider instant is unknown, or whose target review instant is unknown', () => {
      const { store, db } = fresh();
      targetDelivered(store, REST, SUBMITTED);
      expect(store.nativeTransitions.probeNative(OWNER, REPO, cr(NATIVE), null)).toBe('ambiguous');
      db.prepare('UPDATE native_transition_claims SET provider_at = NULL').run();
      expect(store.nativeTransitions.probeNative(OWNER, REPO, cr(NATIVE), '2026-10-01T05:00:00.000Z')).toBe('ambiguous');
    });

    it('SENDS a native card whose provider instant provably differs from the delivered target review\'s', () => {
      const { store } = fresh();
      targetDelivered(store, REST, SUBMITTED);
      expect(store.nativeTransitions.probeNative(OWNER, REPO, cr(NATIVE), '2026-10-01T05:00:00.000Z')).toBe('free');
    });

    it('makes the native card WAIT while a target send of a review of that pull request is in flight', () => {
      const { store } = fresh();
      store.nativeTransitions.reserveTarget(OWNER, REPO, review(REST, SUBMITTED), 'target_alert', 'e1', OBSERVED);
      expect(store.nativeTransitions.probeNative(OWNER, REPO, cr(NATIVE), '2026-10-01T05:00:00.000Z')).toBe('target_in_flight');
    });

    it('skips only for the SAME id, and another pull request is unaffected', () => {
      const { store } = fresh();
      targetDelivered(store, REST, SUBMITTED);
      expect(store.nativeTransitions.probeNative(OWNER, REPO, cr(REST), SUBMITTED)).toBe('target_delivered');
      expect(store.nativeTransitions.probeNative(OWNER, REPO, t('changes_requested', '8', { hash: NATIVE }), SUBMITTED)).toBe('free');
      expect(store.nativeTransitions.probeNative(OWNER, 'acme/other', cr(NATIVE), SUBMITTED)).toBe('free');
    });

    it('records the canonical provider instant of the target review on its claim, and none on a kind that needs none', () => {
      const { store } = fresh();
      targetDelivered(store, REST, '2026-10-01T08:30:00+08:00');
      const row = store.db.prepare("SELECT provider_at FROM native_transition_claims WHERE kind = 'changes_requested'").get() as { provider_at: string };
      expect(row.provider_at).toBe(SUBMITTED);
    });
  });
});
