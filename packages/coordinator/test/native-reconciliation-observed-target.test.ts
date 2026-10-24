import { describe, expect, it } from 'vitest';
import {
  hashProviderRef, hashSourceIdentity, observedReviewTransition, WATCH_EVENT_KINDS, type ImportedPreferences,
  type ReviewObservedState,
} from '@ducky/contracts';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * The imported target and the observed-state review families (ADR 0034, migration 38), driven by the real typed
 * engine: what a review row records (state, hash, the provider's own instant), the two tellings the source
 * accepts for one review, the dismissal it never reports, and the impossible lifecycle changes it refuses.
 * Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;
const at = (day: number, hour = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const PREFS: ImportedPreferences = {
  timeZone: 'UTC', morningEnabled: true, morningTime: '07:00', eveningEnabled: true, eveningTime: '21:00',
  weekendBriefings: true, lookaheadDays: 3, includeWeather: false, includeGithub: true, includeCaptures: false,
  includeMeal: false, assistantWording: false, defaultReminderOffsetsMinutes: [1440, 60],
};

const boot = (cursor = at(10)) => {
  const clock = new TestClock(NOW, 'UTC');
  const reader = new FakeWatchReader();
  reader.capabilities = { observableKinds: [...WATCH_EVENT_KINDS], discovery: false };
  reader.pageSize = 10;
  const h = makeHarness({
    clock, assistantWatchReader: reader, env: { DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true' },
  });
  h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify(PREFS), source: 'import', at: NOW });
  h.store.assistantWatch.insertTarget({
    id: 't1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/demo', display: 'acme/demo', defaultBranch: 'main',
    state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
  });
  h.store.assistantWatch.insertCheckpoint({ targetId: 't1', surface: 'pulls', state: 'imported', cursor, nextDueAt: NOW, updatedAt: NOW });
  const tick = async () => {
    clock.advance(20 * MIN);
    return h.app.assistantWatch.tick();
  };
  return { h, clock, reader, tick };
};
const events = (h: Harness) => h.store.db.prepare('SELECT * FROM assistant_watch_events WHERE kind != ? ORDER BY created_at, kind, identity').all('review_pending') as Record<string, unknown>[];
const reviewsOf = (h: Harness) => events(h).filter((e) => String(e['kind']).startsWith('review_'));
const pr = (n: number, updatedAt: string) => ({ number: n, title: `PR ${n}`, state: 'open' as const, createdAt: at(1), updatedAt, mergedAt: null, closedAt: null });
const rv = (id: string, state: string, submittedAt: string | null, nodeId?: string | null) =>
  ({ id, state, submittedAt, body: 'text', ...(nodeId === undefined ? {} : { nodeId }) });
const claims = (h: Harness) => h.store.nativeTransitions.all();

describe('an imported review row records what it was OBSERVED as', () => {
  it('stores the hash of the node id, the state and the provider instant for approved, commented and dismissed, never an id', async () => {
    const { h, reader, tick } = boot();
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [
      rv('11', 'APPROVED', at(12, 1), 'PRR_a'), rv('12', 'COMMENTED', at(12, 2), 'PRR_c'), rv('13', 'DISMISSED', at(12, 3), 'PRR_d'),
    ]);
    await tick();
    const byId = Object.fromEntries(reviewsOf(h).map((e) => [String(e['identity']), e]));
    expect(byId['2:review:11']).toMatchObject({
      kind: 'review_approved', provider_state: 'APPROVED', provider_hash: hashProviderRef('PRR_a'), provider_at: '2026-10-12T01:00:00.000Z',
      hash_domain: 'provider',
    });
    expect(byId['2:review:12']).toMatchObject({ kind: 'review_commented', provider_state: 'COMMENTED', provider_hash: hashProviderRef('PRR_c') });
    // The source's collapsed vocabulary is kept: a dismissed review is a review_commented row, told apart only by state.
    expect(byId['2:review:13']).toMatchObject({ kind: 'review_commented', provider_state: 'DISMISSED', provider_hash: hashProviderRef('PRR_d') });
    expect(JSON.stringify(reviewsOf(h))).not.toMatch(/PRR_/);
    h.close();
  });

  it('keeps an unknown instant unknown: a review with no submission time is never given the update time as one', async () => {
    const { h, reader, tick } = boot();
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', null, 'PRR_a')]);
    await tick();
    const [row] = reviewsOf(h);
    expect(row).toMatchObject({ kind: 'review_approved', provider_at: null });
    // The event's own occurrence still falls back (the source does), but that is not evidence of a submission.
    expect(row!['occurred_at']).toBe('2026-10-12T00:00:00.000Z');
    h.close();
  });

  it('records no hash when the read carried none, and the claim its send reserves is in the source-identity domain', async () => {
    const { h, reader, tick } = boot();
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(12, 1))]);
    await tick();
    const [row] = reviewsOf(h);
    expect(row).toMatchObject({ provider_hash: null, provider_state: 'APPROVED' });
    const decision = h.store.assistantWatch.reserveSend(
      {
        id: String(row!['id']), targetRepoKey: 'acme/demo', discordUserId: OWNER, kind: 'review_approved',
        identity: String(row!['identity']), occurredAt: String(row!['occurred_at']), providerHash: null, attempt: null,
        providerState: 'APPROVED', providerAt: '2026-10-12T01:00:00.000Z', createdAt: String(row!['created_at']),
      },
      'target_digest', '2026-10-13T05:00:00.000Z',
    );
    expect(decision).toBe('send');
    const [claim] = claims(h);
    expect(claim).toMatchObject({
      path: 'target', state: 'reserved', via: 'target_digest',
      // The commit instant of the event row, not the later moment of the send and not the provider's time.
      observedAt: String(row!['created_at']),
      transition: { kind: 'review_approved', domain: 'source_identity', state: 'APPROVED', hash: hashSourceIdentity('2:review:11', 'APPROVED') },
    });
    expect(claim!.observedAt).not.toBe('2026-10-13T05:00:00.000Z');
    h.close();
  });
});

describe('the source accepts two tellings of one review, and never reports a dismissal it has already passed', () => {
  // The cursor sits on the very second the review was submitted, so a re-read at the boundary sees the review
  // again, in whatever state it is in by then.
  const atBoundary = async () => {
    const b = boot(at(10));
    b.reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    b.reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(12), 'PRR_a')]);
    await b.tick();
    b.h.store.db.prepare("UPDATE assistant_watch_checkpoints SET state = 'ready', boundary_known = 1").run();
    return b;
  };

  it('tells a review approved and, while it is still at the cursor, once more as dismissed: two rows, two keys', async () => {
    const { h, reader, tick } = await atBoundary();
    expect(reviewsOf(h).map((e) => `${e['kind']}:${e['provider_state']}`)).toEqual(['review_approved:APPROVED']);
    // Dismissed before the cursor passed it.
    reader.pullsBy.set('acme/demo', [pr(2, at(12, 1))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'DISMISSED', at(12), 'PRR_a')]);
    await tick();
    expect(reviewsOf(h).map((e) => `${e['kind']}:${e['provider_state']}`).sort()).toEqual([
      'review_approved:APPROVED', 'review_commented:DISMISSED',
    ]);
    // Both are accepted, and neither is withheld: approved then dismissed is a possible lifecycle.
    expect(reviewsOf(h).every((e) => e['withheld_reason'] === null)).toBe(true);
    expect(new Set(reviewsOf(h).map((e) => e['identity']))).toEqual(new Set(['2:review:11']));
    h.close();
  });

  it('never reports a dismissal of a review the cursor has already passed', async () => {
    const { h, reader, tick } = boot(at(10));
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(11, 5), 'PRR_a')]);
    await tick();
    expect(reviewsOf(h)).toHaveLength(1);
    // Later the review is dismissed: the pull request moves, the review's own submission time does not.
    reader.pullsBy.set('acme/demo', [pr(2, at(14))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'DISMISSED', at(11, 5), 'PRR_a')]);
    await tick();
    await tick();
    expect(reviewsOf(h).map((e) => `${e['kind']}:${e['provider_state']}`)).toEqual(['review_approved:APPROVED']);
    h.close();
  });
});

describe('an impossible lifecycle change is recorded but withheld, counted, and never delivered as a fact', () => {
  const changeAtBoundary = async (first: string, second: string) => {
    const b = boot(at(10));
    b.reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    b.reader.reviewsBy.set('acme/demo#2', [rv('11', first, at(12), 'PRR_a')]);
    await b.tick();
    b.h.store.db.prepare("UPDATE assistant_watch_checkpoints SET state = 'ready', boundary_known = 1").run();
    b.reader.pullsBy.set('acme/demo', [pr(2, at(12, 1))]);
    b.reader.reviewsBy.set('acme/demo#2', [rv('11', second, at(12), 'PRR_a')]);
    await b.tick();
    return b.h;
  };
  const withheld = (h: Harness) => reviewsOf(h).filter((e) => e['withheld_reason'] === 'state_conflict').map((e) => `${e['provider_state']}`);

  it.each([
    ['APPROVED', 'CHANGES_REQUESTED'],
    ['CHANGES_REQUESTED', 'APPROVED'],
    ['COMMENTED', 'APPROVED'],
    ['DISMISSED', 'APPROVED'],
    ['DISMISSED', 'CHANGES_REQUESTED'],
  ])('refuses %s then %s', async (first, second) => {
    const h = await changeAtBoundary(first, second);
    expect(withheld(h)).toEqual([second]);
    // The row is kept (nothing deleted), never delivered, and counted.
    const row = reviewsOf(h).find((e) => e['withheld_reason'] === 'state_conflict')!;
    expect(row).toMatchObject({ digested_at: null, alerted_at: null, settled_by: null });
    expect(h.store.assistantWatch.withheldCounts(OWNER).stateConflict).toBe(1);
    expect(JSON.stringify(h.transport.sent)).not.toContain('PR 2 was approved');
    h.close();
  });

  it.each([
    ['APPROVED', 'DISMISSED'],
    ['CHANGES_REQUESTED', 'DISMISSED'],
    ['COMMENTED', 'DISMISSED'],
  ])('allows %s then %s', async (first, second) => {
    const h = await changeAtBoundary(first, second);
    expect(withheld(h)).toEqual([]);
    expect(h.store.assistantWatch.withheldCounts(OWNER).stateConflict).toBe(0);
    h.close();
  });

  it.each([['COMMENTED', 'DISMISSED'], ['DISMISSED', 'COMMENTED']])(
    'records nothing new for %s then %s: the source keeps ONE row per kind and identity, and both share a kind',
    async (first, second) => {
      const h = await changeAtBoundary(first, second);
      expect(reviewsOf(h)).toHaveLength(1);
      expect(reviewsOf(h)[0]).toMatchObject({ provider_state: first, withheld_reason: null });
      h.close();
    },
  );

  it('never conflicts for a row whose state was not recorded (observed before migration 38, imported from a document)', async () => {
    const b = boot(at(10));
    b.reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    b.reader.reviewsBy.set('acme/demo#2', [rv('11', 'DISMISSED', at(12), 'PRR_a')]);
    await b.tick();
    b.h.store.db.prepare('UPDATE assistant_watch_events SET provider_state = NULL').run();
    b.h.store.db.prepare("UPDATE assistant_watch_checkpoints SET state = 'ready', boundary_known = 1").run();
    b.reader.pullsBy.set('acme/demo', [pr(2, at(12, 1))]);
    b.reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(12), 'PRR_a')]);
    await b.tick();
    expect(withheld(b.h)).toEqual([]);
    b.h.close();
  });
});

describe('a native receipt settles an imported review only for the exact fact it conveyed', () => {
  const nativeTold = (h: Harness, state: ReviewObservedState, hash: string, observedAt: string) => {
    const t = observedReviewTransition(2, hash, 'provider', state)!;
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', t, 'watch_summary', `s-${state}`, observedAt, observedAt, at(12));
    h.store.nativeTransitions.markNativeDelivered('watch_summary', `s-${state}`, 'owner_dm', observedAt);
  };

  it('settles an approved review the ordinary summary already told, silently, with no digest line', async () => {
    const { h, reader, tick } = boot();
    nativeTold(h, 'APPROVED', hashProviderRef('PRR_a')!, at(12, 2));
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(12, 1), 'PRR_a')]);
    await tick();
    expect(reviewsOf(h)[0]).toMatchObject({ settled_by: 'native_receipt', withheld_reason: null });
    expect(h.app.assistantWatch.digest().repos.flatMap((r) => r.lines).join(' ')).not.toContain('approved');
    h.close();
  });

  it('does NOT settle a dismissed review by a native approval of the same review: that is another telling', async () => {
    const { h, reader, tick } = boot();
    nativeTold(h, 'APPROVED', hashProviderRef('PRR_a')!, at(12, 2));
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'DISMISSED', at(12, 1), 'PRR_a')]);
    await tick();
    expect(reviewsOf(h)[0]).toMatchObject({ settled_by: null, withheld_reason: null, provider_state: 'DISMISSED' });
    expect(h.app.assistantWatch.digest().repos.flatMap((r) => r.lines).join(' ')).toMatch(/PR #2 has new review comments/);
    h.close();
  });

  it('withholds a review whose id the read did not carry while a compatible native fact could be it, never delivering it', async () => {
    const { h, reader, tick } = boot();
    nativeTold(h, 'APPROVED', hashProviderRef('PRR_other')!, at(12, 2));
    reader.pullsBy.set('acme/demo', [pr(2, at(12))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(12, 1))]);
    await tick();
    expect(reviewsOf(h)[0]).toMatchObject({ withheld_reason: 'ambiguous_evidence', settled_by: null, digested_at: null });
    h.close();
  });

  it('delivers a review submitted after the native observation, which provably is not the one it told', async () => {
    const { h, reader, tick } = boot();
    nativeTold(h, 'APPROVED', hashProviderRef('PRR_other')!, at(12, 2));
    reader.pullsBy.set('acme/demo', [pr(2, at(12, 9))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(12, 8))]);
    await tick();
    expect(reviewsOf(h)[0]).toMatchObject({ withheld_reason: null, settled_by: null });
    h.close();
  });

  it('is not withheld by the migration-36 cutoff, whatever the event time', async () => {
    const { h, reader, tick } = boot(at(1));
    h.store.db.prepare("UPDATE native_ledger_boundary SET fresh = 0, cutoff_at = ?").run('2026-10-12T23:00:00.000Z');
    reader.pullsBy.set('acme/demo', [pr(2, at(11))]);
    reader.reviewsBy.set('acme/demo#2', [rv('11', 'APPROVED', at(11, 1), 'PRR_a')]);
    await tick();
    expect(reviewsOf(h)[0]).toMatchObject({ withheld_reason: null });
    h.close();
  });
});
