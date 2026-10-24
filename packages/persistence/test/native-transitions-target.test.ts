import { beforeEach, describe, expect, it } from 'vitest';
import { hashProviderRef } from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * The imported side of exact reconciliation, at the repository: events are decided against the
 * ledger in the same atomic step that moves their cursor, a withheld event is neither delivered nor
 * settled, and nothing a failed step wrote survives it. Invented data only.
 */
const OWNER = '100000000000000001';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const T2 = '2026-10-01T02:00:00.000Z';
let store: Store;
let db: Db;

const setup = (legacy = false) => {
  db = openDatabase({ location: ':memory:' });
  if (legacy) {
    runMigrations(db, { upTo: 35 });
    runMigrations(db, { now: () => '2026-10-10T00:00:00.000Z' });
  } else runMigrations(db);
  store = createStore(db);
  store.assistantWatch.insertTarget({
    id: 't1', publicId: 'wabcde', discordUserId: OWNER, repoKey: REPO, display: REPO,
    defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
  });
  store.assistantWatch.insertCheckpoint({ targetId: 't1', surface: 'pulls', state: 'imported', cursor: T0, nextDueAt: T0, updatedAt: T0 });
};
beforeEach(() => setup());

const ev = (id: string, kind: string, identity: string, extra: Record<string, unknown> = {}) => ({
  id, kind: kind as never, identity, occurredAt: T1, payloadJson: '{}', settled: false, ...extra,
});
const row = (id: string) => db.prepare('SELECT * FROM assistant_watch_events WHERE id = ?').get(id) as Record<string, unknown>;
const told = (kind: 'pr_opened' | 'pr_merged', item: string, stamp: string | null = null) => {
  store.nativeTransitions.reserveNative(OWNER, REPO, { kind, item, stamp, hash: null, attempt: null }, 'feed_event', `n-${kind}-${item}`, T0, T0);
  store.nativeTransitions.markNativeDelivered('feed_event', `n-${kind}-${item}`, 'owner_dm', T0);
};

describe('events are decided in the same atomic step as their cursor', () => {
  it('settles an event a native path already delivered, withholds one nothing can place, and leaves the rest', () => {
    told('pr_opened', '1');
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T1, nextDueAt: T1, atIso: T1,
      events: [ev('e1', 'pr_opened', '1:opened'), ev('e2', 'pr_opened', '2:opened'), ev('e3', 'pr_closed', '3:closed')],
    });
    expect(row('e1')).toMatchObject({ settled_by: 'native_receipt', withheld_reason: null });
    expect(row('e1')['digested_at']).not.toBeNull();
    expect(row('e2')).toMatchObject({ settled_by: null, digested_at: null, withheld_reason: null });
    expect(row('e3')).toMatchObject({ settled_by: null, digested_at: null });
    expect(store.assistantWatch.undigested(OWNER, 10).map((e) => e.id).sort()).toEqual(['e2', 'e3']);
  });

  it('rolls the cursor back too when the decision cannot be made (an unreadable boundary)', () => {
    db.exec('DELETE FROM native_ledger_boundary');
    expect(() => store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T1, nextDueAt: T1, atIso: T1,
      events: [ev('e1', 'pr_opened', '1:opened')],
    })).toThrow(/unreadable/);
    expect(store.assistantWatch.checkpoint('t1', 'pulls')).toMatchObject({ cursor: T0, state: 'imported' });
    expect(db.prepare('SELECT COUNT(*) n FROM assistant_watch_events').get()).toEqual({ n: 0 });
  });

  it('decides a HELD event when its window closes, against what native paths told in between', () => {
    store.assistantWatch.savePending({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, pendingCursor: T1, pendingPage: 1, nextDueAt: T1, atIso: T1,
      events: [ev('h1', 'pr_opened', '5:opened'), ev('h2', 'pr_opened', '6:opened')],
    });
    expect(row('h1')).toMatchObject({ held: 1, settled_by: null });
    // While the read is unfinished a native path tells #5 and holds #6.
    told('pr_opened', '5');
    store.nativeTransitions.reserveNative(OWNER, REPO, { kind: 'pr_opened', item: '6', stamp: null, hash: null, attempt: null }, 'feed_event', 'n6', T0, T0);
    const cp = store.assistantWatch.checkpoint('t1', 'pulls')!;
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: cp.updatedAt, cursor: T2, nextDueAt: T2, atIso: T2, events: [],
    });
    expect(row('h1')).toMatchObject({ held: 0, settled_by: 'native_receipt' });
    // #6 is merely held by a native send that has not happened: it waits, settled by nothing.
    expect(row('h2')).toMatchObject({ held: 0, settled_by: null, digested_at: null });
    expect(store.assistantWatch.waitingOnNative(OWNER)).toBe(1);
    expect(store.assistantWatch.undigested(OWNER, 10).filter((e) => store.assistantWatch.deliverableNow(OWNER, e))).toEqual([]);
    // The native card is abandoned: the reservation goes and the event is deliverable.
    store.nativeTransitions.releaseNative('feed_event', 'n6');
    expect(store.assistantWatch.waitingOnNative(OWNER)).toBe(0);
    expect(store.assistantWatch.undigested(OWNER, 10).filter((e) => store.assistantWatch.deliverableNow(OWNER, e)).map((e) => e.id)).toEqual(['h2']);
  });
});

describe('a withheld event is neither delivered nor settled, and is counted by reason', () => {
  beforeEach(() => setup(true));

  it('is excluded from alerts, digests and the undigested count, and survives reconciliation untouched', () => {
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T1, nextDueAt: T1, atIso: T1,
      events: [
        ev('old', 'review_requested_changes', '3:review:1', { occurredAt: '2026-10-09T00:00:00.000Z', providerHash: hashProviderRef('X') }),
        ev('late', 'pr_opened', '4:opened', { occurredAt: '2026-10-11T00:00:00.000Z' }),
      ],
    });
    expect(row('old')).toMatchObject({ withheld_reason: 'legacy_unproven', alerted_at: null, digested_at: null, settled_by: null });
    expect(row('late')['withheld_reason']).toBeNull();
    expect(store.assistantWatch.pendingAlerts(OWNER, 10).map((e) => e.id)).toEqual([]);
    expect(store.assistantWatch.undigested(OWNER, 10).map((e) => e.id)).toEqual(['late']);
    expect(store.assistantWatch.counts(OWNER).undigested).toBe(1);
    expect(store.assistantWatch.withheldCounts(OWNER)).toEqual({ legacyUnproven: 1, ambiguousEvidence: 0, settledByReceipt: 0 });
    // Repeated reconciliation never settles it, and markDigested cannot either.
    store.assistantWatch.reconcileOwner(OWNER, T2);
    expect(store.assistantWatch.markDigested(['old'], T2)).toBe(0);
    expect(row('old')).toMatchObject({ withheld_reason: 'legacy_unproven', digested_at: null });
    // Verification counts the target whose cursor still sits at or before the cutoff (here T1, in early October).
    expect(store.assistantWatch.cursorsAtOrBefore(OWNER, Date.parse('2026-10-10T00:00:01.000Z'))).toBe(1);
    expect(store.assistantWatch.cursorsAtOrBefore(OWNER, Date.parse('2026-09-30T00:00:00.000Z'))).toBe(0);
  });

  it('resolves an UNSETTLED imported event at import time, with the same decision', () => {
    store.assistantWatch.insertImportedEvent({
      id: 'imp', targetId: 't1', kind: 'pr_opened', identity: '8:opened', occurredAt: '2026-10-05T00:00:00.000Z',
      payloadJson: '{}', alertedAt: null, digestedAt: null, createdAt: T0,
    });
    expect(row('imp')['withheld_reason']).toBe('legacy_unproven');
    // An event the source already SETTLED is history, not news: untouched.
    store.assistantWatch.insertImportedEvent({
      id: 'imp2', targetId: 't1', kind: 'pr_opened', identity: '9:opened', occurredAt: '2026-10-05T00:00:00.000Z',
      payloadJson: '{}', alertedAt: T0, digestedAt: T0, createdAt: T0,
    });
    expect(row('imp2')).toMatchObject({ withheld_reason: null, settled_by: null });
  });
});

describe('a target send reserves the transition around exactly one attempt', () => {
  const alertable = () => {
    store.assistantWatch.insertImportedEvent({
      id: 'a1', targetId: 't1', kind: 'pr_merged', identity: '5:merged', occurredAt: T1, payloadJson: '{}',
      alertedAt: null, digestedAt: null, createdAt: T0,
    });
    return store.assistantWatch.undigested(OWNER, 5)[0]!;
  };

  it('reserves for a digest send, settles and records a receipt on success, and releases on failure', () => {
    const e = alertable();
    expect(store.assistantWatch.reserveSend(e, 'target_digest', T1)).toBe('send');
    expect(store.nativeTransitions.counts().reservedTarget).toBe(1);
    store.assistantWatch.releaseDigest([e.id]);
    expect(store.nativeTransitions.counts().reservedTarget).toBe(0);
    expect(row('a1')['digested_at']).toBeNull();
    expect(store.assistantWatch.reserveSend(e, 'target_digest', T1)).toBe('send');
    expect(store.assistantWatch.markDigested([e.id], T2)).toBe(1);
    expect(store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 1 });
  });

  it('refuses to start a second send of the transition while the first is in flight', () => {
    const e = alertable();
    expect(store.assistantWatch.reserveSend(e, 'target_digest', T1)).toBe('send');
    expect(store.assistantWatch.reserveSend(e, 'target_digest', T1)).toBe('wait');
    expect(store.nativeTransitions.counts().reservedTarget).toBe(1);
  });

  it('settles, without a send, an event whose transition a native path already delivered', () => {
    const e = alertable();
    told('pr_merged', '5', T1);
    expect(store.assistantWatch.reserveSend(e, 'target_digest', T1)).toBe('settled');
    expect(row('a1')).toMatchObject({ settled_by: 'native_receipt' });
    expect(store.nativeTransitions.counts().reservedTarget).toBe(0);
  });
});
