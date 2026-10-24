import { describe, expect, it } from 'vitest';
import {
  hashProviderRef, hashSourceIdentity, observedReviewTransition, transitionKey, type ReviewObservedState, type Transition,
} from '@ducky/contracts';
import { openDatabase, type Db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * The observed-state review families against the real ledger (ADR 0034, migration 38): an approved, a commented
 * and a dismissed review are three different tellings, compared only with a compatible state, by hash within its
 * domain first and then by reservation and by provider instant. Invented data only.
 */
const OWNER = '100000000000000001';
const OTHER_OWNER = '100000000000000002';
const REPO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T01:00:00.000Z';
const T2 = '2026-10-01T02:00:00.000Z';
const T3 = '2026-10-01T03:00:00.000Z';
const T4 = '2026-10-01T04:00:00.000Z';

const fresh = (cutoffFresh = true): { db: Db; store: Store } => {
  const db = openDatabase({ location: ':memory:' });
  if (cutoffFresh) runMigrations(db);
  else {
    // A database that is NOT new: every migration but the last two ran earlier.
    runMigrations(db, { upTo: 35, now: () => T0 });
    runMigrations(db, { now: () => T0 });
  }
  return { db, store: createStore(db) };
};

const NATIVE = hashProviderRef('PRR_native')!;
const OTHER = hashProviderRef('PRR_other')!;
const nativeFact = (state: ReviewObservedState, hash = NATIVE, n = 7): Transition =>
  observedReviewTransition(n, hash, 'provider', state)!;

type Kind = 'review_approved' | 'review_commented';
const row = (kind: Kind, n: number, extra: { providerHash?: string | null; providerState?: string | null; providerAt?: string | null; createdAt?: string | null; rest?: number }) => ({
  kind, identity: `${n}:review:${extra.rest ?? 1}`, occurredAt: T1, providerHash: extra.providerHash ?? null, attempt: null,
  providerState: extra.providerState ?? null, providerAt: extra.providerAt ?? null, createdAt: extra.createdAt ?? T1,
});

const nativeTold = (store: Store, t: Transition, ref = 'n1', observedAt = T2, repo = REPO, owner = OWNER, providerAt: string | null = T1) => {
  store.nativeTransitions.reserveNative(owner, repo, t, 'watch_summary', ref, observedAt, observedAt, providerAt);
  store.nativeTransitions.markNativeDelivered('watch_summary', ref, 'owner_dm', observedAt);
};
const nativeReserved = (store: Store, t: Transition, ref = 'n1', observedAt = T2, providerAt: string | null = T1) =>
  store.nativeTransitions.reserveNative(OWNER, REPO, t, 'watch_summary', ref, observedAt, observedAt, providerAt);
const targetSend = (store: Store, f: ReturnType<typeof row>, ref = 'e1', deliver = true) => {
  const out = store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', ref, T3);
  if (deliver && out.reserved) store.nativeTransitions.markTargetDelivered('target_alert', ref, T3);
  return out;
};
const resolve = (store: Store, f: ReturnType<typeof row>, owner = OWNER, repo = REPO) =>
  store.nativeTransitions.resolveTarget(owner, repo, f);

describe('an imported review is covered only by the same review in the same observed state', () => {
  it('settles an approved row whose provider hash a native holder delivered, and waits while that holder only reserved it', () => {
    const { store } = fresh();
    nativeReserved(store, nativeFact('APPROVED'));
    const f = row('review_approved', 7, { providerHash: NATIVE, providerState: 'APPROVED', providerAt: T1 });
    expect(resolve(store, f)).toEqual({ outcome: 'wait' });
    store.nativeTransitions.markNativeDelivered('watch_summary', 'n1', 'owner_dm', T2);
    expect(resolve(store, f)).toEqual({ outcome: 'covered' });
  });

  it('keeps an approved and a dismissed telling of one review apart: neither covers, holds or waits for the other', () => {
    const { store } = fresh();
    nativeTold(store, nativeFact('APPROVED'));
    // Same review (same hash), now observed DISMISSED by the importer: a different fact, told.
    const dismissed = row('review_commented', 7, { providerHash: NATIVE, providerState: 'DISMISSED', providerAt: T1, rest: 2 });
    expect(resolve(store, dismissed)).toEqual({ outcome: 'deliver' });
    // And the reverse: the target told it dismissed, the native path may still tell it approved.
    const { store: s2 } = fresh();
    expect(targetSend(s2, row('review_commented', 7, { providerHash: NATIVE, providerState: 'DISMISSED', providerAt: T1 })).reserved).toBe(true);
    expect(s2.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('free');
  });

  it('never compares an approved review with a commented one on the same pull request', () => {
    const { store } = fresh();
    nativeTold(store, nativeFact('COMMENTED', OTHER));
    expect(resolve(store, row('review_approved', 7, { providerHash: NATIVE, providerState: 'APPROVED', providerAt: T1 }))).toEqual({ outcome: 'deliver' });
  });

  it('is isolated by repository and by owner', () => {
    const { store } = fresh();
    nativeTold(store, nativeFact('APPROVED'));
    const f = row('review_approved', 7, { providerHash: NATIVE, providerState: 'APPROVED', providerAt: T1 });
    expect(resolve(store, f, OWNER, 'acme/other')).toEqual({ outcome: 'deliver' });
    expect(resolve(store, f, OTHER_OWNER)).toEqual({ outcome: 'deliver' });
    expect(resolve(store, { ...f, identity: '8:review:1' })).toEqual({ outcome: 'deliver' });
  });
});

describe('a row whose hash cannot be compared is decided by reservation and by instant, never by guessing', () => {
  // The importer's row has NO provider hash (an imported-document row, or an id the read did not carry), so its
  // identity is its own source-identity hash, which can never equal the native provider hash.
  const sourceRow = (providerAt: string | null, state: string | null = 'APPROVED') =>
    row('review_approved', 7, { providerHash: null, providerState: state, providerAt });

  it('delivers when no native holder of a compatible state exists on that pull request', () => {
    const { store } = fresh();
    expect(resolve(store, sourceRow(T1))).toEqual({ outcome: 'deliver' });
    nativeTold(store, nativeFact('COMMENTED'));
    expect(resolve(store, sourceRow(T1))).toEqual({ outcome: 'deliver' });
  });

  it('waits for a reserved compatible holder, and withholds against a delivered one it cannot prove different', () => {
    const { store } = fresh();
    nativeReserved(store, nativeFact('APPROVED'), 'n1', T2);
    expect(resolve(store, sourceRow(T1))).toEqual({ outcome: 'wait' });
    store.nativeTransitions.markNativeDelivered('watch_summary', 'n1', 'owner_dm', T2);
    expect(resolve(store, sourceRow(T1))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
  });

  it('withholds a row with an UNKNOWN instant: only a known, later submission proves a different review', () => {
    const { store } = fresh();
    nativeTold(store, nativeFact('APPROVED'), 'n1', T2);
    expect(resolve(store, sourceRow(null))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    // Submitted after the native observation plus the margin: provably another review.
    expect(resolve(store, sourceRow('2026-10-01T02:00:05.000Z'))).toEqual({ outcome: 'deliver' });
    // Within the margin, or before the observation: still not provable.
    expect(resolve(store, sourceRow('2026-10-01T02:00:00.500Z'))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    expect(resolve(store, sourceRow(T1))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
  });

  it('proves a later submission against EVERY delivered holder, not just one', () => {
    const { store } = fresh();
    nativeTold(store, nativeFact('APPROVED', OTHER), 'n1', T2);
    nativeTold(store, nativeFact('APPROVED', hashProviderRef('PRR_third')!), 'n2', T4);
    expect(resolve(store, sourceRow('2026-10-01T03:00:00.000Z'))).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    expect(resolve(store, sourceRow('2026-10-01T04:30:00.000Z'))).toEqual({ outcome: 'deliver' });
  });

  it('is NOT withheld by the migration-36 cutoff, even on a database that is not new and for an old event', () => {
    const { store } = fresh(false);
    expect(store.nativeTransitions.boundary()!.fresh).toBe(false);
    expect(resolve(store, { ...sourceRow(T0), occurredAt: '2026-01-01T00:00:00.000Z' })).toEqual({ outcome: 'deliver' });
  });

  it('treats a stateless commented row as compatible with BOTH commented and dismissed native facts, and with no other', () => {
    const { store } = fresh();
    const stateless = row('review_commented', 7, { providerHash: null, providerState: null, providerAt: null });
    nativeTold(store, nativeFact('APPROVED'), 'a1');
    expect(resolve(store, stateless)).toEqual({ outcome: 'deliver' });
    nativeTold(store, nativeFact('DISMISSED'), 'd1');
    expect(resolve(store, stateless)).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
    const { store: s2 } = fresh();
    nativeTold(s2, nativeFact('COMMENTED'), 'c1');
    expect(resolve(s2, stateless)).toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
  });

  it('a known COMMENTED row is not compatible with a native dismissal, and a DISMISSED one is not with a native comment', () => {
    const { store } = fresh();
    nativeTold(store, nativeFact('DISMISSED'));
    expect(resolve(store, row('review_commented', 7, { providerHash: null, providerState: 'COMMENTED', providerAt: T1 }))).toEqual({ outcome: 'deliver' });
    expect(resolve(store, row('review_commented', 7, { providerHash: null, providerState: 'DISMISSED', providerAt: T1 })))
      .toEqual({ outcome: 'withhold', reason: 'ambiguous_evidence' });
  });
});

describe('the target reserves and delivers an exact review fact, and a native path sees it', () => {
  it('records the domain, the state and the commit instant, and keeps an unknown submission instant unknown', () => {
    const { db, store } = fresh();
    const out = store.nativeTransitions.reserveTarget(
      OWNER, REPO, row('review_commented', 7, { providerHash: null, providerState: 'DISMISSED', providerAt: null, createdAt: T1 }), 'target_alert', 'e1', T4,
    );
    expect(out.reserved).toBe(true);
    const claim = db.prepare('SELECT * FROM native_transition_claims').get() as Record<string, unknown>;
    expect(claim).toMatchObject({
      kind: 'review_dismissed', hash_domain: 'source_identity', provider_state: 'DISMISSED', observed_at: T1, provider_at: null,
      path: 'target', state: 'reserved',
    });
    expect(claim['provider_hash']).toBe(hashSourceIdentity('7:review:1', 'DISMISSED'));
  });

  it('reserves a stateless commented row under its target-only key', () => {
    const { db, store } = fresh();
    store.nativeTransitions.reserveTarget(OWNER, REPO, row('review_commented', 7, { providerState: null }), 'target_alert', 'e1', T4);
    const claim = db.prepare('SELECT transition_key, provider_state, hash_domain FROM native_transition_claims').get() as Record<string, string>;
    expect(claim['transition_key']).toMatch(/^review_commented:7:src:[0-9a-f]{64}:unknown_state$/);
    expect(claim).toMatchObject({ provider_state: 'COMMENTED|DISMISSED', hash_domain: 'source_identity' });
  });

  it('lets the native path skip exactly what the target delivered and wait for what it is sending', () => {
    const { store } = fresh();
    const f = row('review_approved', 7, { providerHash: NATIVE, providerState: 'APPROVED', providerAt: T1 });
    expect(targetSend(store, f, 'e1', false).reserved).toBe(true);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('target_in_flight');
    store.nativeTransitions.markTargetDelivered('target_alert', 'e1', T3);
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('target_delivered');
    // Another review of the same state is not it.
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED', OTHER), '2026-10-01T05:00:00.000Z')).toBe('free');
  });

  it('a failed send releases the reservation, so the native path is free again', () => {
    const { store } = fresh();
    targetSend(store, row('review_approved', 7, { providerHash: NATIVE, providerState: 'APPROVED', providerAt: T1 }), 'e1', false);
    store.nativeTransitions.releaseTarget('target_alert', 'e1');
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('free');
  });
});

describe('a native fact is held, not told, when it cannot be told from a review the target delivered', () => {
  const sourceDelivered = (store: Store, providerAt: string | null, createdAt = T1, state: 'review_approved' | 'review_commented' = 'review_approved', st = 'APPROVED', ref = 'e1') =>
    targetSend(store, row(state, 7, { providerHash: null, providerState: st, providerAt, createdAt }), ref);

  it('holds on an equal or an unknown instant, tells a provably different one', () => {
    const { store } = fresh();
    sourceDelivered(store, T1);
    const probe = (at: string | null) => store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), at);
    expect(probe(T1)).toBe('ambiguous');
    expect(probe(null)).toBe('ambiguous');
    expect(probe('2026-10-01T01:00:07.000Z')).toBe('free');
    const { store: s2 } = fresh();
    sourceDelivered(s2, null);
    expect(s2.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('ambiguous');
  });

  it('is not held against a target claim of ANOTHER state', () => {
    const { store } = fresh();
    sourceDelivered(store, T1, T1, 'review_commented', 'DISMISSED');
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('free');
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('DISMISSED'), T1)).toBe('ambiguous');
  });

  it('a stateless target claim is compatible with a native commented and a native dismissed fact, not an approved one', () => {
    const { store } = fresh();
    targetSend(store, row('review_commented', 7, { providerHash: null, providerState: null, providerAt: null }));
    const probe = (s: ReviewObservedState) => store.nativeTransitions.probeNative(OWNER, REPO, nativeFact(s), T1);
    expect(probe('COMMENTED')).toBe('ambiguous');
    expect(probe('DISMISSED')).toBe('ambiguous');
    expect(probe('APPROVED')).toBe('free');
  });

  describe('the boundary proof: the target review existed before the previous complete read began', () => {
    it('frees a NEW review fact when the target claim was committed before that read began, by more than the skew margin', () => {
      const { store } = fresh();
      sourceDelivered(store, T1, T1); // committed at T1
      const probe = (boundary: string | null) =>
        store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1, { boundary });
      expect(probe('2026-10-01T02:00:00.000Z')).toBe('free');
      // Not before it: committed at the boundary, or inside the margin, or after it.
      expect(probe(T1)).toBe('ambiguous');
      expect(probe('2026-10-01T01:00:00.900Z')).toBe('ambiguous');
      expect(probe('2026-10-01T00:30:00.000Z')).toBe('ambiguous');
      // No proof at all (a legacy or first observation, a newly entering pull request, an unbound watch).
      expect(probe(null)).toBe('ambiguous');
    });

    it('never applies to a known review changing state: that review is in the previous set', () => {
      const { store } = fresh();
      targetSend(store, row('review_commented', 7, { providerHash: null, providerState: 'DISMISSED', providerAt: T1, createdAt: T1 }));
      const dismissed = nativeFact('DISMISSED');
      expect(store.nativeTransitions.probeNative(OWNER, REPO, dismissed, T1, { boundary: '2026-10-01T05:00:00.000Z', stateChange: true }))
        .toBe('ambiguous');
      expect(store.nativeTransitions.probeNative(OWNER, REPO, dismissed, T1, { boundary: '2026-10-01T05:00:00.000Z' })).toBe('free');
    });

    it('uses the instant the event was committed, never the provider time it carries', () => {
      const { store } = fresh();
      // The review says it was submitted long ago, but the row was committed late: no proof.
      sourceDelivered(store, T1, '2026-10-01T03:30:00.000Z');
      expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED'), T1, { boundary: T3 })).toBe('ambiguous');
    });
  });

  it('is isolated by owner and repository', () => {
    const { store } = fresh();
    sourceDelivered(store, T1);
    expect(store.nativeTransitions.probeNative(OTHER_OWNER, REPO, nativeFact('APPROVED'), T1)).toBe('free');
    expect(store.nativeTransitions.probeNative(OWNER, 'acme/other', nativeFact('APPROVED'), T1)).toBe('free');
    expect(store.nativeTransitions.probeNative(OWNER, REPO, nativeFact('APPROVED', NATIVE, 8), T1)).toBe('free');
  });
});

describe('a native review claim records its state and domain', () => {
  it('keys it per state and keeps two holders of one fact', () => {
    const { db, store } = fresh();
    nativeTold(store, nativeFact('APPROVED'), 'n1');
    nativeTold(store, nativeFact('DISMISSED'), 'n2');
    expect(db.prepare('SELECT transition_key, hash_domain, provider_state, provider_at FROM native_transition_claims ORDER BY provider_state').all())
      .toEqual([
        { transition_key: transitionKey(nativeFact('APPROVED')), hash_domain: 'provider', provider_state: 'APPROVED', provider_at: T1 },
        { transition_key: transitionKey(nativeFact('DISMISSED')), hash_domain: 'provider', provider_state: 'DISMISSED', provider_at: T1 },
      ]);
    // A second native holder of the same fact is accepted; the same holder twice is one row.
    expect(store.nativeTransitions.reserveNative(OWNER, REPO, nativeFact('APPROVED'), 'feed_event', 'f1', T3, T3, T1)).toBe(true);
    expect(store.nativeTransitions.reserveNative(OWNER, REPO, nativeFact('APPROVED'), 'feed_event', 'f1', T3, T3, T1)).toBe(false);
  });

  it('refuses a malformed fact instead of writing it', () => {
    const { db, store } = fresh();
    const bad: Transition = { kind: 'review_approved', item: '7', stamp: null, hash: NATIVE, attempt: null, domain: 'provider', state: 'DISMISSED' };
    expect(store.nativeTransitions.reserveNative(OWNER, REPO, bad, 'watch_summary', 'n1', T1, T1)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM native_transition_claims').get()).toEqual({ n: 0 });
  });
});
