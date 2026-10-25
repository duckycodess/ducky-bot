import { describe, expect, it } from 'vitest';
import { GITHUB_FEED_EVENT_BATCH, GITHUB_FEED_MAX_DELIVERY_ATTEMPTS, hashProviderRef, type ImportedPreferences, type WatchEventKind } from '@ducky/contracts';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { FeedReader, commit, issue, pr, review, sentTo } from './github-feed-helpers.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * Exact native/target reconciliation (ADR 0034), end to end: the real feed, the imported
 * target, the briefing and the ledger, with scripted readers and an invented repository.
 * Whoever delivers a transition first owns it; the other path tells nothing about it, and
 * nothing is ever settled by a promise, a count, a skip or a baseline.
 */
const DEMO = 'acme/demo';
const T0 = '2026-10-01T00:00:00.000Z';
const MIN = 60_000;
const CHANNEL = '900000000000000021';
const PREFS: ImportedPreferences = {
  timeZone: 'UTC', morningEnabled: true, morningTime: '07:00', eveningEnabled: true, eveningTime: '21:00',
  weekendBriefings: true, lookaheadDays: 3, includeWeather: false, includeGithub: true, includeCaptures: false,
  includeMeal: false, assistantWording: false, defaultReminderOffsetsMinutes: [1440, 60],
};

const boot = (env: Record<string, string> = {}, channel = false) => {
  const clock = new TestClock(T0, 'UTC');
  const reader = new FeedReader();
  reader.setView(DEMO);
  const h = makeHarness({
    clock, github: reader, assistantWatchReader: new FakeWatchReader(),
    env: {
      DUCKY_GITHUB_FEED_ENABLED: 'true', DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true',
      ...(channel ? { DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL } : {}), ...env,
    },
  });
  h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify(PREFS), source: 'import', at: T0 });
  h.store.assistantWatch.insertTarget({
    id: 'w1', publicId: 'wabcde', discordUserId: OWNER, repoKey: DEMO, display: DEMO, defaultBranch: 'main',
    state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
  });
  const feedTick = async (min = 16) => {
    clock.advance(min * MIN);
    return h.app.githubFeed.tick();
  };
  return { h, clock, reader, feedTick };
};

const baseline = async (reader: FeedReader, feedTick: (min?: number) => Promise<unknown>) => {
  reader.prs.set(DEMO, [pr(1)]);
  reader.issues.set(DEMO, [issue(1)]);
  reader.commitList.set(DEMO, [commit(1, '2026-09-29T00:00:00Z')]);
  await feedTick(0);
};

const importedEvent = (
  h: Harness, id: string, kind: WatchEventKind, identity: string, over: { occurredAt?: string; hash?: string | null; attempt?: string | null } = {},
) => {
  h.store.assistantWatch.insertImportedEvent({
    id, targetId: 'w1', kind, identity, occurredAt: over.occurredAt ?? '2026-10-01T00:20:00.000Z',
    payloadJson: JSON.stringify({ number: 3, title: 'Add the feed' }), alertedAt: null, digestedAt: null, createdAt: T0,
  });
};
/** An event the engine OBSERVED, with its comparison identity present at birth, decided like a real one. */
const observedEvent = (
  h: Harness, id: string, kind: WatchEventKind, identity: string, over: { occurredAt?: string; hash?: string | null; attempt?: string | null },
) => {
  h.store.db.prepare(
    `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at, provider_hash, attempt)
     VALUES (?, 'w1', ?, ?, ?, ?, '{"number":2,"title":"Add the feed"}', 'observed', ?, ?, ?)`,
  ).run(id, kind, kind.startsWith('review') ? 'pulls' : 'runs', identity, over.occurredAt ?? '2026-10-01T00:20:00.000Z', T0,
    over.hash ?? null, over.attempt ?? null);
  h.store.assistantWatch.reconcileOwner(OWNER, T0);
};
const row = (h: Harness, id: string) =>
  h.store.db.prepare('SELECT * FROM assistant_watch_events WHERE id = ?').get(id) as Record<string, unknown>;
const texts = (h: Harness) => JSON.stringify(h.transport.sent);

describe('a native card delivered first settles the matching imported event silently', () => {
  it('for an opened pull request, an opened issue and a review the feed named by its id; not for what no card told', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    reader.prs.set(DEMO, [
      pr(3, { createdAt: '2026-10-01T00:10:00Z', title: 'Add the feed' }), pr(1),
      pr(2, { latestReviews: [review('R9', 'CHANGES_REQUESTED', '2026-10-01T00:11:00Z', 'dave')] }),
    ]);
    reader.issues.set(DEMO, [issue(2, { createdAt: '2026-10-01T00:12:00Z' }), issue(1)]);
    await feedTick();
    expect(texts(h)).toContain('Pull request opened');
    expect(texts(h)).toContain('Changes requested');
    expect(texts(h)).toContain('Issue opened');
    h.transport.clear();

    // The imported target sees the same facts a moment later.
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    importedEvent(h, 'e-pr2', 'pr_opened', '2:opened');
    importedEvent(h, 'e-iss2', 'issue_opened', `2:issue_opened:2026-10-01T00:12:00Z`);
    observedEvent(h, 'e-rev', 'review_requested_changes', '2:review:777', { hash: hashProviderRef('R9') });
    // Things no native card told: a merge, and a pull request the feed never saw.
    importedEvent(h, 'e-merge', 'pr_merged', '3:merged');
    importedEvent(h, 'e-pr9', 'pr_opened', '9:opened');

    for (const id of ['e-pr3', 'e-pr2', 'e-iss2', 'e-rev']) {
      expect(row(h, id), id).toMatchObject({ settled_by: 'native_receipt', withheld_reason: null });
      expect(row(h, id)['digested_at'], id).not.toBeNull();
    }
    for (const id of ['e-merge', 'e-pr9']) expect(row(h, id), id).toMatchObject({ settled_by: null, digested_at: null });

    // The imported alert is not sent for the review the feed already told.
    expect((await h.app.assistantWatch.tick()).alertsSent).toBe(0);
    // And the briefing carries only what no native card told.
    const digest = h.app.assistantWatch.digest();
    expect(digest.repos.flatMap((r) => r.lines).sort()).toEqual(['PR #3 merged: Add the feed', 'PR #3 opened: Add the feed'].sort());
    h.close();
  });

  it('counts a card sent to the configured public channel exactly as one sent to the DM', async () => {
    const { h, reader, feedTick } = boot({}, true);
    await baseline(reader, feedTick);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' }), pr(1)]);
    await feedTick();
    const sentWhere = sentTo(h.transport.sent).map((s) => s.where);
    expect(sentWhere.some((w) => w === `channel:${CHANNEL}`)).toBe(true);
    const claim = h.store.nativeTransitions.all().find((c) => c.transition.kind === 'pr_opened')!;
    expect(claim).toMatchObject({ path: 'native', state: 'delivered', deliveredTo: 'github_channel' });
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    expect(row(h, 'e-pr3')).toMatchObject({ settled_by: 'native_receipt' });
    h.close();
  });

  it('counts nothing that was not delivered: a failed send, then abandonment, never a receipt', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' }), pr(1)]);
    h.transport.failSends = true;
    await feedTick();
    const n = h.store.nativeTransitions;
    expect(n.counts()).toMatchObject({ receiptsNative: 0, reservedNative: 1 });
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    // The native card is still owed: the imported event waits, is not told, and is not settled.
    expect(row(h, 'e-pr3')).toMatchObject({ digested_at: null, settled_by: null });
    expect(h.app.assistantWatch.digest().repos).toEqual([]);
    expect(h.app.assistantWatch.statusLine()).toMatch(/1 event\(s\) waiting on a native notification/);
    // Retries fail until the card is abandoned; abandonment is explicit and releases the reservation.
    for (let i = 0; i < GITHUB_FEED_MAX_DELIVERY_ATTEMPTS + 1; i += 1) await feedTick();
    expect(h.store.githubFeed.listEvents('abandoned')).toHaveLength(1);
    expect(n.counts()).toMatchObject({ receiptsNative: 0, reservedNative: 0 });
    expect(h.app.assistantWatch.digest().repos.flatMap((r) => r.lines)).toEqual(['PR #3 opened: Add the feed']);
    h.close();
  });
});

describe('an imported delivery first stops the native card for exactly that transition', () => {
  it('skips the card (skipped, not sent) once the briefing that carried it was sent', async () => {
    const { h, reader, feedTick, clock } = boot();
    await baseline(reader, feedTick);
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    clock.set('2026-10-01T08:00:00.000Z'); // the morning briefing is due
    expect((await h.app.briefingNotifier.tick()).delivered).toBe(1);
    expect(texts(h)).toContain('PR #3 opened');
    expect(row(h, 'e-pr3')['digested_at']).not.toBeNull();
    expect(h.store.nativeTransitions.counts().receiptsTarget).toBe(1);
    h.transport.clear();

    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' }), pr(1)]);
    await feedTick();
    expect(texts(h)).not.toContain('Pull request opened');
    expect(h.store.githubFeed.listEvents('skipped').map((e) => e.kind)).toEqual(['pr_opened']);
    h.close();
  });

  it('leaves the card pending, charging nothing, while an imported send of that transition is in flight', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' }), pr(1)]);
    h.store.nativeTransitions.reserveTarget(OWNER, DEMO, {
      kind: 'pr_opened', identity: '3:opened', occurredAt: T0, providerHash: null, attempt: null,
    }, 'target_digest', 'tgt', T0);
    await feedTick();
    expect(texts(h)).not.toContain('Pull request opened');
    expect(h.store.githubFeed.listEvents('pending')).toHaveLength(1);
    expect(h.store.githubFeed.listEvents('pending')[0]).toMatchObject({ attempts: 0 });
    // The imported send failed and released: the card goes out on the next pass.
    h.store.nativeTransitions.releaseTarget('target_digest', 'tgt');
    await feedTick();
    expect(texts(h)).toContain('Pull request opened');
    h.close();
  });

  it('keeps a failed briefing send from claiming anything: the events stay pending and the reservation is released', async () => {
    const { h, clock } = boot();
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    clock.set('2026-10-01T08:00:00.000Z');
    h.transport.failSends = true;
    expect((await h.app.briefingNotifier.tick()).failed).toBe(1);
    expect(row(h, 'e-pr3')['digested_at']).toBeNull();
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 0 });
    h.transport.failSends = false;
    expect((await h.app.briefingNotifier.tick()).delivered).toBe(1);
    expect(row(h, 'e-pr3')['digested_at']).not.toBeNull();
    h.close();
  });
});

describe('a commit digest records which commits it NAMED', () => {
  it('names the first lines and only counts the rest; a counted commit is no receipt', async () => {
    const clock = new TestClock('2026-10-01T00:00:00Z', 'UTC');
    const reader = new FeedReader();
    reader.setView(DEMO);
    const h = makeHarness({
      clock, github: reader, assistantWatchReader: new FakeWatchReader(),
      env: { DUCKY_GITHUB_FEED_ENABLED: 'true', DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL },
    });
    h.store.assistantWatch.insertTarget({
      id: 'w1', publicId: 'wabcde', discordUserId: OWNER, repoKey: DEMO, display: DEMO, defaultBranch: 'main',
      state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
    });
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await h.app.githubFeed.tick();
    const many = Array.from({ length: 16 }, (_, i) => commit(i + 2, `2026-10-01T00:${String(10 + i).padStart(2, '0')}:00Z`, `Work ${i + 2}`));
    reader.commitList.set(DEMO, [...many.reverse(), commit(1, '2026-09-30T00:00:00Z')]);
    clock.set('2026-10-01T00:30:00Z');
    await h.app.githubFeed.tick();
    // Every new commit is reserved the moment it is recorded.
    expect(h.store.nativeTransitions.counts().reservedNative).toBe(16);
    clock.set('2026-10-01T09:05:00Z');
    expect((await h.app.githubFeed.tick()).digestsDelivered).toBeGreaterThan(0);
    const c = h.store.nativeTransitions.counts();
    expect(c.reservedNative).toBe(0);
    expect(c.receiptsNative).toBe(12); // GITHUB_FEED_DIGEST_MAX_LINES lines were written
    const told = h.store.db.prepare("SELECT told_as, COUNT(*) n FROM github_feed_commits WHERE consumed_target IS NOT NULL GROUP BY told_as").all();
    expect(told).toEqual([{ told_as: 'counted', n: 4 }, { told_as: 'named', n: 12 }]);
    // The newest 12 were named. Commit 2 (oldest of the new) was only counted.
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    importedEvent(h, 'c-named', 'commit', sha(17), { occurredAt: '2026-10-01T00:25:00.000Z' });
    importedEvent(h, 'c-counted', 'commit', sha(2), { occurredAt: '2026-10-01T00:10:00.000Z' });
    expect(row(h, 'c-named')).toMatchObject({ settled_by: 'native_receipt' });
    expect(row(h, 'c-counted')).toMatchObject({ settled_by: null, digested_at: null, withheld_reason: null });
    h.close();
  });

  it('retires a buffered commit an imported digest already delivered, never telling it natively', async () => {
    const clock = new TestClock('2026-10-01T00:00:00Z', 'UTC');
    const reader = new FeedReader();
    reader.setView(DEMO);
    const h = makeHarness({
      clock, github: reader, assistantWatchReader: new FakeWatchReader(),
      env: { DUCKY_GITHUB_FEED_ENABLED: 'true' },
    });
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await h.app.githubFeed.tick();
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    h.store.nativeTransitions.reserveTarget(OWNER, DEMO, {
      kind: 'commit', identity: sha(2), occurredAt: T0, providerHash: null, attempt: null,
    }, 'target_digest', 'tgt', T0);
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'tgt', T0);
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:10:00Z', 'Told by the briefing'), commit(1, '2026-09-30T00:00:00Z')]);
    clock.set('2026-10-01T00:30:00Z');
    await h.app.githubFeed.tick();
    expect(h.store.githubFeed.openCommits(DEMO)).toEqual([]);
    expect(h.store.nativeTransitions.counts().reservedNative).toBe(0);
    h.close();
  });
});

describe('a native requested-changes card that cannot be told from the target\'s review is HELD', () => {
  const REVIEW_AT = '2026-10-01T00:11:00Z';
  const targetDelivered = (h: Harness, hash: string, occurredAt: string) => {
    h.store.nativeTransitions.reserveTarget(OWNER, DEMO, {
      kind: 'review_requested_changes', identity: '2:review:777', occurredAt, providerHash: hash, attempt: null,
    }, 'target_digest', 'tgt', T0);
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'tgt', T0);
  };
  const withReview = (reader: FeedReader) =>
    reader.prs.set(DEMO, [pr(1), pr(2, { latestReviews: [review('R9', 'CHANGES_REQUESTED', REVIEW_AT, 'dave')] })]);
  const cards = (h: Harness) => h.store.githubFeed.listEvents('pending').filter((e) => e.kind === 'changes_requested');
  const nativeReviewClaims = (h: Harness) =>
    h.store.nativeTransitions.all().filter((c) => c.path === 'native' && c.transition.kind === 'changes_requested');

  it('neither sends, skips nor receipts it, charges no attempt and holds no reservation; and says so in /status', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    // The target already delivered a review of #2 under an id that does not equal the native id.
    targetDelivered(h, hashProviderRef('rest-node-id')!, '2026-10-01T00:11:00.000Z');
    withReview(reader);
    await feedTick();
    expect(texts(h)).not.toContain('Changes requested');
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]).toMatchObject({ attempts: 0, heldReason: 'ambiguous_review', providerAt: '2026-10-01T00:11:00.000Z' });
    expect(h.store.githubFeed.listEvents('skipped').filter((e) => e.kind === 'changes_requested')).toEqual([]);
    // (The unrelated pull request #2 card is a different transition and is delivered as usual.)
    expect(nativeReviewClaims(h)).toEqual([]);
    expect(h.store.githubFeed.heldEventCount()).toBe(1);
    expect(h.app.githubFeed.statusLine()).toMatch(/1 requested-changes card HELD, neither sent nor skipped/);
    // More ticks change nothing: it is not retried, charged or sent.
    await feedTick();
    await feedTick();
    expect(texts(h)).not.toContain('Changes requested');
    expect(cards(h)[0]).toMatchObject({ attempts: 0, heldReason: 'ambiguous_review' });
    h.close();
  });

  it('keeps the hold across a restart and the orphan sweep', async () => {
    const { h, reader, feedTick, clock } = boot();
    await baseline(reader, feedTick);
    targetDelivered(h, hashProviderRef('rest-node-id')!, '2026-10-01T00:11:00.000Z');
    withReview(reader);
    await feedTick();
    expect(h.store.githubFeed.heldEventCount()).toBe(1);
    const again = makeHarness({ clock, store: h.store, github: reader, assistantWatchReader: new FakeWatchReader(), env: { DUCKY_GITHUB_FEED_ENABLED: 'true' } });
    again.store.nativeTransitions.sweepOrphans();
    clock.advance(16 * MIN);
    await again.app.githubFeed.tick();
    expect(again.store.githubFeed.heldEventCount()).toBe(1);
    expect(JSON.stringify(again.transport.sent)).not.toContain('Changes requested');
    again.close();
  });

  it('SENDS the card when its provider instant provably differs from the target\'s review', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    targetDelivered(h, hashProviderRef('rest-node-id')!, '2026-10-01T00:05:00.000Z');
    withReview(reader);
    await feedTick();
    expect(texts(h)).toContain('Changes requested');
    expect(h.store.githubFeed.heldEventCount()).toBe(0);
    h.close();
  });

  it('skips it only when the ids are equal', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    targetDelivered(h, hashProviderRef('R9')!, '2026-10-01T00:11:00.000Z');
    withReview(reader);
    await feedTick();
    expect(texts(h)).not.toContain('Changes requested');
    expect(h.store.githubFeed.listEvents('skipped').map((e) => e.kind)).toContain('changes_requested');
    expect(h.store.githubFeed.heldEventCount()).toBe(0);
    h.close();
  });

  it('waits while the target\'s send is in flight, then holds the queued card when that send is delivered', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    // The target is mid-send of a review of #2 under a different id: the card is queued, unreserved.
    h.store.nativeTransitions.reserveTarget(OWNER, DEMO, {
      kind: 'review_requested_changes', identity: '2:review:777', occurredAt: '2026-10-01T00:11:00.000Z',
      providerHash: hashProviderRef('rest-node-id'), attempt: null,
    }, 'target_digest', 'tgt', T0);
    withReview(reader);
    await feedTick();
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]).toMatchObject({ attempts: 0, heldReason: null });
    expect(nativeReviewClaims(h)).toEqual([]);
    expect(texts(h)).not.toContain('Changes requested');
    // The send succeeded: the card is now ambiguous, so it is held (not sent, not skipped), still unreserved.
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'tgt', T0);
    await feedTick();
    expect(texts(h)).not.toContain('Changes requested');
    expect(cards(h)[0]).toMatchObject({ attempts: 0, heldReason: 'ambiguous_review' });
    expect(nativeReviewClaims(h)).toEqual([]);
    h.close();
  });

  it('never lets the target deliver a review while a native card for that pull request is still reserved', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    h.transport.failSends = true; // the card is queued and reserved, but not sent
    withReview(reader);
    await feedTick();
    expect(nativeReviewClaims(h).map((c) => c.state)).toEqual(['reserved']);
    // The target's own attempt must WAIT, so it cannot deliver first and leave the card ambiguous.
    const out = h.store.nativeTransitions.reserveTarget(OWNER, DEMO, {
      kind: 'review_requested_changes', identity: '2:review:777', occurredAt: '2026-10-01T00:11:00.000Z',
      providerHash: hashProviderRef('rest-node-id'), attempt: null,
    }, 'target_digest', 'tgt', T0);
    expect(out).toMatchObject({ reserved: false, resolution: { outcome: 'wait' } });
    h.close();
  });

  it('cannot starve the cards behind it: held cards are not pending work', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick);
    const ins = h.store.db.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at, held_reason)
       VALUES (?, ?, 'changes_requested', ?, 'selected', NULL, 'pending', ?, 'ambiguous_review')`,
    );
    for (let i = 0; i < GITHUB_FEED_EVENT_BATCH + 5; i += 1) ins.run(`held${i}`, `changes_requested:${DEMO}#9:H${i}`, DEMO, '2026-09-01T00:00:00.000Z');
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z', title: 'Add the feed' }), pr(1)]);
    await feedTick();
    expect(texts(h)).toContain('Pull request opened');
    expect(h.store.githubFeed.heldEventCount()).toBe(GITHUB_FEED_EVENT_BATCH + 5);
    h.close();
  });
});

describe('a buffered commit waits out an imported send of it, and nothing else', () => {
  it('keeps the commit open and unreserved while the imported send is in flight, then tells it once that send is released', async () => {
    const clock = new TestClock('2026-10-01T00:00:00Z', 'UTC');
    const reader = new FeedReader();
    reader.setView(DEMO);
    const h = makeHarness({
      clock, github: reader, assistantWatchReader: new FakeWatchReader(),
      env: { DUCKY_GITHUB_FEED_ENABLED: 'true', DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL },
    });
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await h.app.githubFeed.tick();
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    h.store.nativeTransitions.reserveTarget(OWNER, DEMO, {
      kind: 'commit', identity: sha(2), occurredAt: T0, providerHash: null, attempt: null,
    }, 'target_digest', 'tgt', T0);
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:10:00Z', 'In flight'), commit(3, '2026-10-01T00:11:00Z', 'Free'), commit(1, '2026-09-30T00:00:00Z')]);
    clock.set('2026-10-01T00:30:00Z');
    await h.app.githubFeed.tick();
    // Only the commit nothing imported is sending is reserved.
    expect(h.store.nativeTransitions.all().filter((c) => c.path === 'native').map((c) => c.transition.item)).toEqual([sha(3)]);
    clock.set('2026-10-01T09:05:00Z');
    await h.app.githubFeed.tick();
    const digest = sentTo(h.transport.sent).filter((m) => m.text.includes('Commit digest')).map((m) => m.text).join('\n');
    expect(digest).toContain('Free');
    expect(digest).not.toContain('In flight');
    expect(h.store.githubFeed.openCommits(DEMO).map((c) => c.sha)).toEqual([sha(2)]);
    // The imported send failed and was released: the next digest tells it.
    h.store.nativeTransitions.releaseTarget('target_digest', 'tgt');
    h.transport.clear();
    clock.set('2026-10-02T09:05:00Z');
    await h.app.githubFeed.tick();
    expect(sentTo(h.transport.sent).map((m) => m.text).join('\n')).toContain('In flight');
    h.close();
  });
});

describe('pausing, native delivery and resuming', () => {
  it('does not repeat what the feed told while monitoring was off, and still tells the rest', async () => {
    const { h, reader, feedTick, clock } = boot();
    await baseline(reader, feedTick);
    h.app.assistantWatch.setMonitoring(h.owner, false);
    clock.advance(MIN);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z', title: 'Add the feed' }), pr(1)]);
    await feedTick();
    expect(texts(h)).toContain('Pull request opened');
    h.app.assistantWatch.setMonitoring(h.owner, true);
    // What the target then reads: the same pull request, and its merge.
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    importedEvent(h, 'e-merge', 'pr_merged', '3:merged');
    expect(row(h, 'e-pr3')).toMatchObject({ settled_by: 'native_receipt' });
    h.transport.clear();
    clock.set('2026-10-01T08:00:00.000Z');
    await h.app.briefingNotifier.tick();
    expect(texts(h)).toContain('PR #3 merged');
    expect(texts(h)).not.toContain('PR #3 opened');
    h.close();
  });

  it('settles nothing from a snapshot, a skipped row or a baseline row', async () => {
    const { h, reader, feedTick } = boot();
    await baseline(reader, feedTick); // PR #1 and issue #1 are baseline history
    expect(h.store.githubFeed.listEvents('baseline').length).toBeGreaterThan(0);
    expect(h.store.nativeTransitions.counts()).toMatchObject({ receiptsNative: 0, reservedNative: 0 });
    importedEvent(h, 'e-pr1', 'pr_opened', '1:opened');
    expect(row(h, 'e-pr1')).toMatchObject({ settled_by: null, digested_at: null });
    h.close();
  });
});

describe('start-up recovery', () => {
  it('returns a target send of unknown outcome to pending and records no receipt, but only under the runtime lock', () => {
    const { h } = boot();
    importedEvent(h, 'e-pr3', 'pr_opened', '3:opened');
    h.store.assistantWatch.reserveSend(
      { id: 'e-pr3', targetRepoKey: DEMO, discordUserId: OWNER, kind: 'pr_opened', identity: '3:opened', occurredAt: T0, providerHash: null, attempt: null },
      'target_alert', T0,
    );
    expect(h.store.nativeTransitions.counts().reservedTarget).toBe(1);
    expect(h.app.assistantWatch.recoverAfterStart({ holdsRuntimeLock: false })).toEqual({ releasedSends: 0 });
    expect(h.store.nativeTransitions.counts().reservedTarget).toBe(1);
    expect(h.app.assistantWatch.recoverAfterStart({ holdsRuntimeLock: true })).toEqual({ releasedSends: 1 });
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 0 });
    expect(row(h, 'e-pr3')['digested_at']).toBeNull();
    h.close();
  });
});
