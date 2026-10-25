import { describe, expect, it } from 'vitest';
import { closedTransition, mergedTransition, transitionKey, type Transition } from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * The exact pull request close against the native/target ledger (ADR 0034, migration 39): who covers whom, what waits,
 * what is withheld when the instant cannot be read, and what the legacy cutoff does NOT touch. Invented data only.
 */
const OWNER = '100000000000000001';
const OTHER = '100000000000000002';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const C1 = '2026-09-30T10:00:00.000Z';
const C2 = '2026-09-30T11:00:00.000Z';

const fresh = (): { db: Db; store: Store } => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db, { now: () => T0 });
  return { db, store: createStore(db) };
};
const closeT = (n: number, at: string): Transition => closedTransition(n, at)!;
const facts = (identity: string, occurredAt: string) => ({
  kind: 'pr_closed' as const, identity, occurredAt, providerHash: null, attempt: null,
});
const resolve = (s: Store, f: ReturnType<typeof facts>, repo = REPO, owner = OWNER) => s.nativeTransitions.resolveTarget(owner, repo, f);
const nativeHeld = (s: Store, tr: Transition, ref = 'w1', repo = REPO) =>
  s.nativeTransitions.reserveNative(OWNER, repo, tr, 'watch_summary', ref, T0, T0);
const nativeTold = (s: Store, tr: Transition, ref = 'w1', repo = REPO) => {
  nativeHeld(s, tr, ref, repo);
  s.nativeTransitions.markNativeDelivered('watch_summary', ref, 'owner_dm', T0);
};
const watch = (db: Db, over: Partial<{ id: string; owner: string; repoKey: string | null; state: string; publicId: string; slug: string }> = {}): void => {
  const w = { id: 'w1', owner: OWNER, repoKey: REPO as string | null, state: 'active', publicId: 'wabcde', slug: 'demo', ...over };
  db.prepare(`INSERT OR IGNORE INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES (?, '/x/' || ?, 'acme', ?, ?)`)
    .run(w.slug, w.slug, w.slug, T0);
  db.prepare(
    `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
     VALUES (?,?,?,?, 15, ?, ?, ?, ?, ?)`,
  ).run(w.id, w.publicId, w.owner, w.slug, T0, w.state, T0, T0, w.repoKey);
};

describe('an exact close is covered only by a native receipt of that very close', () => {
  const f = facts('3:closed', C1);

  it('delivers when nothing native told it, covers it by a delivered holder, and waits on a reserved one', () => {
    const { store } = fresh();
    expect(resolve(store, f)).toEqual({ outcome: 'deliver' });
    nativeHeld(store, closeT(3, C1));
    expect(resolve(store, f)).toEqual({ outcome: 'wait' });
    store.nativeTransitions.markNativeDelivered('watch_summary', 'w1', 'owner_dm', T1);
    expect(resolve(store, f)).toEqual({ outcome: 'covered' });
  });

  it('releases a native reservation that will never be sent, so the imported close is told', () => {
    const { store } = fresh();
    nativeHeld(store, closeT(3, C1));
    store.nativeTransitions.releaseNative('watch_summary', 'w1');
    expect(resolve(store, f)).toEqual({ outcome: 'deliver' });
  });

  it('never lets a native close at another instant, another pull request, another repository or another kind cover it', () => {
    const { store } = fresh();
    nativeTold(store, closeT(3, C2), 'a');
    nativeTold(store, closeT(4, C1), 'b');
    nativeTold(store, closeT(3, C1), 'c', 'acme/other');
    nativeTold(store, mergedTransition(3, C1)!, 'd');
    store.nativeTransitions.reserveNative(OWNER, REPO, { kind: 'pr_updated', item: '3', stamp: C1, hash: null, attempt: null }, 'watch_summary', 'e', T0, T0);
    store.nativeTransitions.markNativeDelivered('watch_summary', 'e', 'owner_dm', T0);
    expect(resolve(store, f)).toEqual({ outcome: 'deliver' });
    expect(resolve(store, f, REPO, OTHER)).toEqual({ outcome: 'deliver' });
  });

  it('spells one instant one way: an offset and a canonical instant are the same close', () => {
    const { store } = fresh();
    nativeTold(store, closeT(3, C1));
    expect(resolve(store, facts('3:closed', '2026-09-30T18:00:00+08:00'))).toEqual({ outcome: 'covered' });
  });
});

describe('a close was always deliverable, so the migration-36 legacy cutoff never holds it', () => {
  it('delivers an old close on a database that is not new, while an old merge of the same time is withheld', () => {
    const { db, store } = fresh();
    db.prepare('UPDATE native_ledger_boundary SET fresh = 0, cutoff_at = ? WHERE id = 1').run(T1);
    expect(resolve(store, facts('3:closed', C1))).toEqual({ outcome: 'deliver' });
    expect(store.nativeTransitions.resolveTarget(OWNER, REPO, { kind: 'pr_merged', identity: '3:merged', occurredAt: C1, providerHash: null, attempt: null }))
      .toEqual({ outcome: 'withhold', reason: 'legacy_unproven' });
  });
});

describe('a close whose instant cannot be read is withheld only where a native path could tell it', () => {
  const unreadable = ['garbage', 'Sep 30 2026 10:00 UTC', '', '2026-09-30'];

  it('is delivered when no ordinary watch of the owner has ever been bound to the repository', () => {
    const { db, store } = fresh();
    for (const at of unreadable) expect(resolve(store, facts('3:closed', at)), at).toEqual({ outcome: 'deliver' });
    watch(db, { owner: OTHER, publicId: 'wother' }); // another owner's watch is no native path for this owner
    watch(db, { id: 'w2', repoKey: 'acme/elsewhere', slug: 'elsewhere', publicId: 'welsew' }); // another repository
    watch(db, { id: 'w3', repoKey: null, slug: 'legacy', publicId: 'wlegac' }); // a legacy watch has no recorded repository
    for (const at of unreadable) expect(resolve(store, facts('3:closed', at)), at).toEqual({ outcome: 'deliver' });
  });

  it('is withheld, counted, never sent, when this owner has a watch bound to the repository, in ANY state', () => {
    for (const state of ['active', 'cancelled']) {
      const { db, store } = fresh();
      watch(db);
      if (state === 'cancelled') expect(store.githubWatches.cancel(OWNER, 'w1', T1)).toBe(true);
      for (const at of unreadable) {
        expect(resolve(store, facts('3:closed', at)), `${state} ${at}`).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
      }
    }
  });

  it('applies neither the feed test nor the legacy time cutoff', () => {
    const { db, store } = fresh();
    db.prepare('UPDATE native_ledger_boundary SET fresh = 0, cutoff_at = ? WHERE id = 1').run(T1).toString();
    store.githubFeed.insertRepo({ repoKey: REPO, display: REPO, source: 'explicit', atIso: T0 });
    // The feed tells no close, and the close family was always deliverable.
    expect(resolve(store, facts('3:closed', 'garbage'))).toEqual({ outcome: 'deliver' });
  });

  it('is decided before any other test of the time: an unreadable instant never withholds by itself', () => {
    const { store } = fresh();
    expect(resolve(store, facts('3:closed', 'garbage'))).toEqual({ outcome: 'deliver' });
    // An unreadable NUMBER has no counterpart at all.
    expect(resolve(store, facts('x:closed', C1))).toEqual({ outcome: 'deliver' });
  });
});

describe('the target reserves an exact close around one send and settles it only on success', () => {
  const x = facts('3:closed', C1);

  it('reserves, waits on a second send, turns the reservation into a receipt, and covers another event of the close', () => {
    const { store } = fresh();
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e1', T0)).toMatchObject({ reserved: true });
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e2', T0)).toMatchObject({ reserved: false, resolution: { outcome: 'wait' } });
    expect(store.nativeTransitions.probeNative(OWNER, REPO, closeT(3, C1))).toBe('target_in_flight');
    expect(store.nativeTransitions.markTargetDelivered('target_digest', 'e1', T1)).toBe(1);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, closeT(3, C1))).toBe('target_delivered');
    // The same close again, for another event of the target: settled as told by this target.
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e3', T1))
      .toMatchObject({ reserved: false, selfCovered: true, resolution: { outcome: 'covered' } });
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsTarget: 1, reservedTarget: 0 });
  });

  it('writes a different claim for a close at a different instant: distinct closes are distinct receipts', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e1', T0);
    store.nativeTransitions.markTargetDelivered('target_digest', 'e1', T1);
    const later = facts('3:closed', C2);
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, later, 'target_digest', 'e2', T1)).toMatchObject({ reserved: true });
    expect(store.nativeTransitions.all().map((c) => transitionKey(c.transition)).sort())
      .toEqual([transitionKey(closeT(3, C1)), transitionKey(closeT(3, C2))].sort());
  });

  it('leaves no receipt for a failed or abandoned send, or for one that was in flight at a crash', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e1', T0);
    expect(store.nativeTransitions.releaseTarget('target_digest', 'e1')).toBe(1);
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsTarget: 0, reservedTarget: 0 });
    store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e1', T0);
    expect(store.nativeTransitions.recoverTargetSends()).toBe(1);
    expect(store.nativeTransitions.counts()).toMatchObject({ receiptsTarget: 0, reservedTarget: 0 });
    expect(resolve(store, x)).toEqual({ outcome: 'deliver' });
  });

  it('does not reserve a close a native path already told, an ambiguous one, or one with no exact key', () => {
    const { db, store } = fresh();
    nativeTold(store, closeT(3, C1));
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e1', T0))
      .toMatchObject({ reserved: false, resolution: { outcome: 'covered' } });
    watch(db);
    expect(store.nativeTransitions.reserveTarget(OWNER, REPO, facts('4:closed', 'garbage'), 'target_digest', 'e2', T0))
      .toMatchObject({ reserved: false, resolution: { outcome: 'withhold' } });
    expect(store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 0 });
  });

  it('is owner and repository isolated', () => {
    const { store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, x, 'target_digest', 'e1', T0);
    store.nativeTransitions.markTargetDelivered('target_digest', 'e1', T1);
    expect(store.nativeTransitions.probeNative(OTHER, REPO, closeT(3, C1))).toBe('free');
    expect(store.nativeTransitions.probeNative(OWNER, 'acme/other', closeT(3, C1))).toBe('free');
  });
});
