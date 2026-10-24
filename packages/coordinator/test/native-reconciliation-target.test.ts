import { describe, expect, it } from 'vitest';
import { hashProviderRef, WATCH_EVENT_KINDS, type ImportedPreferences, type WatchSurface } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MANILA, importDoc, importEnv, takeLock } from './assistant-import-fixture.js';

/**
 * The imported target against the exact ledger (ADR 0034), driven by the real typed engine: the
 * review id and the rerun attempt a read carries, what is alerted, what the briefing carries and
 * carries forward, and what an import withholds. Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const SINCE = '2026-10-10T00:00:00.000Z';
const MIN = 60_000;
const at = (day: number, hour = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const PREFS: ImportedPreferences = {
  timeZone: 'UTC', morningEnabled: true, morningTime: '07:00', eveningEnabled: true, eveningTime: '21:00',
  weekendBriefings: true, lookaheadDays: 3, includeWeather: false, includeGithub: true, includeCaptures: false,
  includeMeal: false, assistantWording: false, defaultReminderOffsetsMinutes: [1440, 60],
};

const boot = (env: Record<string, string> = {}) => {
  const clock = new TestClock(NOW, 'UTC');
  const reader = new FakeWatchReader();
  reader.capabilities = { observableKinds: [...WATCH_EVENT_KINDS], discovery: false };
  reader.pageSize = 10;
  const h = makeHarness({ clock, assistantWatchReader: reader, env: { DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true', ...env } });
  h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify(PREFS), source: 'import', at: NOW });
  h.store.assistantWatch.insertTarget({
    id: 't1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/demo', display: 'acme/demo', defaultBranch: 'main',
    state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
  });
  return { h, clock, reader };
};
const checkpoint = (h: Harness, surface: WatchSurface, cursor = SINCE) =>
  h.store.assistantWatch.insertCheckpoint({ targetId: 't1', surface, state: 'imported', cursor, nextDueAt: NOW, updatedAt: NOW });
const events = (h: Harness) => h.store.db.prepare('SELECT * FROM assistant_watch_events ORDER BY identity').all() as Record<string, unknown>[];
const sentJson = (h: Harness) => JSON.stringify(h.transport.sent);
const nativeCard = (h: Harness, item: string, hash: string, observedAt: string) => {
  h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'changes_requested', item, stamp: null, hash, attempt: null }, 'feed_event', `n${item}`, observedAt, observedAt);
  h.store.nativeTransitions.markNativeDelivered('feed_event', `n${item}`, 'owner_dm', observedAt);
};
const pr = (n: number) => ({ number: n, title: `PR ${n}`, state: 'open' as const, createdAt: at(1), updatedAt: at(12), mergedAt: null, closedAt: null });
const crReview = (id: string, nodeId: string | null | undefined, when = at(12)) =>
  ({ id, state: 'CHANGES_REQUESTED', submittedAt: when, body: 'Please add tests', ...(nodeId === undefined ? {} : { nodeId }) });

describe('a requested change is compared by the exact id the read carries, never by time alone', () => {
  const run = async (review: ReturnType<typeof crReview>, prep?: (h: Harness) => void) => {
    const { h, reader } = boot();
    checkpoint(h, 'pulls');
    prep?.(h);
    reader.pullsBy.set('acme/demo', [pr(2)]);
    reader.reviewsBy.set('acme/demo#2', [review]);
    const out = await h.app.assistantWatch.tick();
    return { h, out };
  };
  const review = (h: Harness) => events(h).find((e) => e['kind'] === 'review_requested_changes')!;

  it('records the hash of the review node id with the event, and never the id itself', async () => {
    const { h } = await run(crReview('55', 'PRR_exact'));
    expect(review(h)['provider_hash']).toBe(hashProviderRef('PRR_exact'));
    expect(JSON.stringify(events(h))).not.toContain('PRR_exact');
    // Nothing native told it: the imported alert goes out.
    expect(sentJson(h)).toContain('Please add tests');
    expect(h.store.nativeTransitions.counts().receiptsTarget).toBe(1);
    h.close();
  });

  it('settles it silently, sending no alert, when the feed already delivered a card for that very review', async () => {
    const { h, out } = await run(crReview('55', 'PRR_exact'), (x) => nativeCard(x, '2', hashProviderRef('PRR_exact')!, at(12, 1)));
    expect(out.alertsSent).toBe(0);
    expect(review(h)).toMatchObject({ settled_by: 'native_receipt', withheld_reason: null });
    expect(sentJson(h)).not.toContain('Please add tests');
    h.close();
  });

  it('tells a DIFFERENT review of the same pull request when it was submitted after the native observation', async () => {
    const { h, out } = await run(crReview('56', 'PRR_other', at(12, 5)), (x) => nativeCard(x, '2', hashProviderRef('PRR_exact')!, at(12, 1)));
    expect(out.alertsSent).toBe(1);
    expect(review(h)).toMatchObject({ settled_by: null, withheld_reason: null });
    h.close();
  });

  it('withholds, never sends, a review it cannot name exactly while a native card for that pull request could be the same', async () => {
    const { h, out } = await run(crReview('55', undefined, at(12)), (x) => nativeCard(x, '2', hashProviderRef('PRR_exact')!, at(12, 1)));
    expect(out.alertsSent).toBe(0);
    expect(review(h)).toMatchObject({ withheld_reason: 'ambiguous_evidence', settled_by: null, digested_at: null, alerted_at: null });
    expect(h.app.assistantWatch.statusLine()).toMatch(/WITHHELD and never sent: 0 predating the native ledger, 1 without the exact id/);
    // A briefing never carries it either.
    expect(h.app.assistantWatch.digest().repos.flatMap((r) => r.lines).join(' ')).not.toContain('requested');
    h.close();
  });

  it('withholds a review it cannot name when the repository has a feed row, because a later native card would repeat it', async () => {
    const { h } = await run(crReview('55', undefined), (x) => {
      x.store.githubFeed.insertRepo({ repoKey: 'acme/demo', display: 'acme/demo', source: 'explicit', atIso: NOW });
    });
    expect(review(h)).toMatchObject({ withheld_reason: 'ambiguous_evidence' });
    h.close();
  });

  it('delivers a review it cannot name when no native path could ever tell it', async () => {
    const { h, out } = await run(crReview('55', undefined));
    expect(out.alertsSent).toBe(1);
    expect(review(h)['withheld_reason']).toBeNull();
    h.close();
  });
});

describe('a failed workflow run is compared by its id AND its rerun attempt', () => {
  const runRec = (attempt: number | null) => ({
    id: '55', name: 'ci', branch: 'main', status: 'completed', conclusion: 'failure', createdAt: at(12), updatedAt: at(12, 1), attempt,
  });
  const go = async (attempt: number | null, prep?: (h: Harness) => void) => {
    const { h, reader } = boot();
    checkpoint(h, 'runs');
    checkpoint(h, 'ci_state', 'passing');
    prep?.(h);
    reader.runsBy.set('acme/demo', [runRec(attempt)]);
    await h.app.assistantWatch.tick();
    return h;
  };
  const failed = (h: Harness) => events(h).find((e) => e['kind'] === 'ci_failed')!;

  it('keeps the attempt with the event and settles it when the feed delivered that exact attempt', async () => {
    const h = await go(2, (x) => {
      x.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'ci_failed', item: '55', stamp: null, hash: null, attempt: '2' }, 'feed_event', 'n1', NOW, NOW);
      x.store.nativeTransitions.markNativeDelivered('feed_event', 'n1', 'github_channel', NOW);
    });
    expect(failed(h)).toMatchObject({ attempt: '2', settled_by: 'native_receipt' });
    h.close();
  });

  it('never suppresses across attempts: attempt 2 is a different fact from the told attempt 1', async () => {
    const h = await go(2, (x) => {
      x.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'ci_failed', item: '55', stamp: null, hash: null, attempt: '1' }, 'feed_event', 'n1', NOW, NOW);
      x.store.nativeTransitions.markNativeDelivered('feed_event', 'n1', 'owner_dm', NOW);
    });
    expect(failed(h)).toMatchObject({ attempt: '2', settled_by: null, withheld_reason: null });
    h.close();
  });

  it('withholds an attempt it cannot read when a native card exists for that run', async () => {
    const h = await go(null, (x) => {
      x.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'ci_failed', item: '55', stamp: null, hash: null, attempt: '1' }, 'feed_event', 'n1', NOW, NOW);
      x.store.nativeTransitions.markNativeDelivered('feed_event', 'n1', 'owner_dm', NOW);
    });
    expect(failed(h)).toMatchObject({ attempt: null, withheld_reason: 'ambiguous_evidence' });
    h.close();
  });
});

describe('what is sent and what is carried forward', () => {
  it('releases a failed alert\'s reservation and sends it on the next tick, recording a receipt only then', async () => {
    const { h, clock, reader } = boot();
    checkpoint(h, 'pulls');
    reader.pullsBy.set('acme/demo', [pr(2)]);
    reader.reviewsBy.set('acme/demo#2', [crReview('55', 'PRR_exact')]);
    h.transport.failSends = true;
    expect((await h.app.assistantWatch.tick()).alertsFailed).toBe(1);
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 0 });
    h.transport.failSends = false;
    clock.advance(16 * MIN);
    expect((await h.app.assistantWatch.tick()).alertsSent).toBe(1);
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedTarget: 0, receiptsTarget: 1 });
    h.close();
  });

  it('puts only the deliverable items in a briefing, and carries the waiting one forward until its native send settles', async () => {
    const { h, clock } = boot();
    const add = (id: string, kind: 'pr_opened' | 'pr_merged', identity: string) =>
      h.store.assistantWatch.insertImportedEvent({
        id, targetId: 't1', kind, identity, occurredAt: '2026-10-12T10:00:00.000Z',
        payloadJson: JSON.stringify({ number: 5, title: 'Add a thing' }), alertedAt: null, digestedAt: null, createdAt: NOW,
      });
    add('wait', 'pr_opened', '5:opened');
    add('free', 'pr_merged', '6:merged');
    // The feed holds a card for #5 that has not been sent.
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'pr_opened', item: '5', stamp: null, hash: null, attempt: null }, 'feed_event', 'n5', NOW, NOW);
    clock.set('2026-10-13T08:00:00.000Z');
    expect((await h.app.briefingNotifier.tick()).delivered).toBe(1);
    expect(sentJson(h)).toContain('PR #5 merged'); // the deliverable item
    expect(sentJson(h)).not.toContain('PR #5 opened'); // the waiting one
    expect(events(h).find((e) => e['id'] === 'wait')).toMatchObject({ digested_at: null, settled_by: null });
    expect(h.store.nativeTransitions.counts().reservedTarget).toBe(0);
    expect(h.app.assistantWatch.statusLine()).toMatch(/1 event\(s\) waiting on a native notification still to be sent/);

    // The feed's send succeeds: the waiting event is settled by that receipt and never carried.
    h.store.nativeTransitions.markNativeDelivered('feed_event', 'n5', 'owner_dm', NOW);
    h.transport.clear();
    clock.set('2026-10-13T21:00:00.000Z');
    await h.app.briefingNotifier.tick();
    expect(sentJson(h)).not.toContain('PR #5 opened');
    h.app.assistantWatch.reconcile();
    expect(events(h).find((e) => e['id'] === 'wait')).toMatchObject({ settled_by: 'native_receipt' });
    h.close();
  });

  it('carries the waiting item as soon as the native send is abandoned', async () => {
    const { h, clock } = boot();
    h.store.assistantWatch.insertImportedEvent({
      id: 'wait', targetId: 't1', kind: 'pr_opened', identity: '5:opened', occurredAt: '2026-10-12T10:00:00.000Z',
      payloadJson: JSON.stringify({ number: 5, title: 'Add a thing' }), alertedAt: null, digestedAt: null, createdAt: NOW,
    });
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'pr_opened', item: '5', stamp: null, hash: null, attempt: null }, 'feed_event', 'n5', NOW, NOW);
    clock.set('2026-10-13T08:00:00.000Z');
    await h.app.briefingNotifier.tick();
    expect(sentJson(h)).not.toContain('PR #5 opened');
    h.store.nativeTransitions.releaseNative('feed_event', 'n5'); // the native card was abandoned
    h.transport.clear();
    clock.set('2026-10-13T21:00:00.000Z');
    await h.app.briefingNotifier.tick();
    expect(sentJson(h)).toContain('PR #5 opened');
    h.close();
  });
});

describe('a long run of waiting events cannot hide a deliverable one', () => {
  it('finds a fresh deliverable event behind more than a thousand that a native path holds, and counts them all', async () => {
    const { h, clock } = boot();
    const WAITING = 1_150;
    const ins = h.store.db.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at)
       VALUES (?, 't1', ?, 'pulls', ?, ?, ?, 'observed', ?)`,
    );
    const reserve = h.store.nativeTransitions;
    for (let n = 1; n <= WAITING; n += 1) {
      ins.run(`w${n}`, 'pr_opened', `${n}:opened`, '2026-10-12T00:00:00.000Z', JSON.stringify({ number: n, title: `Waiting ${n}` }), NOW);
      reserve.reserveNative(OWNER, 'acme/demo', { kind: 'pr_opened', item: String(n), stamp: null, hash: null, attempt: null }, 'feed_event', `f${n}`, NOW, NOW);
    }
    // Fresh, later in the digest's order, and nothing native holds it.
    ins.run('fresh', 'pr_merged', '9999:merged', '2026-10-12T10:00:00.000Z', JSON.stringify({ number: 9999, title: 'Fresh work' }), NOW);

    const digest = h.app.assistantWatch.digest();
    expect(digest.repos.flatMap((r) => r.lines)).toEqual(['PR #9999 merged: Fresh work']);
    expect(h.app.assistantWatch.statusLine()).toMatch(new RegExp(`${WAITING} event\\(s\\) waiting on a native notification`));
    // And a pushed briefing carries it, while every waiting event stays unread and unreserved.
    clock.set('2026-10-13T08:00:00.000Z');
    expect((await h.app.briefingNotifier.tick()).delivered).toBe(1);
    expect(sentJson(h)).toContain('Fresh work');
    expect(h.store.db.prepare("SELECT COUNT(*) n FROM assistant_watch_events WHERE digested_at IS NULL").get()).toEqual({ n: WAITING });
    expect(h.store.nativeTransitions.counts().reservedTarget).toBe(0);
    h.close();
  });
});

describe('an import decides what it writes against the same ledger', () => {
  const apply = (h: Harness, clock: TestClock, doc: unknown = importDoc()) => {
    const lock = takeLock(h.store);
    try {
      return new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).run(doc, { apply: true, lock });
    } finally {
      lock.release();
    }
  };
  const bootImport = () => {
    const clock = new TestClock(NOW, MANILA);
    const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA } });
    return { h, clock };
  };
  const unsettled = (h: Harness) =>
    h.store.db.prepare("SELECT withheld_reason, settled_by FROM assistant_watch_events WHERE identity = '12:review:9'").get() as
      { withheld_reason: string | null; settled_by: string | null };

  it('writes the source\'s unsettled review as it always did when nothing native could have told it', () => {
    const { h, clock } = bootImport();
    expect(apply(h, clock).ok).toBe(true);
    expect(unsettled(h)).toEqual({ withheld_reason: null, settled_by: null });
    const report = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).verify(importDoc());
    expect(report.nativeLedger).toEqual({
      readable: true, fresh: true, withheldLegacy: 0, withheldAmbiguous: 0, cursorsAtOrBeforeCutoff: 0, heldNativeCards: 0, heldOrdinaryReviews: 0, clear: true,
    });
    expect(report.parity).toBe(true);
    h.close();
  });

  it('withholds the source review when an ordinary watch is bound to that repository, in ANY state: the ordinary summary tells exact reviews', () => {
    for (const state of ['active', 'cancelled', 'identity']) {
      const { h, clock } = bootImport();
      h.store.db.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('widgets','/w','acme','widgets',?)`).run(NOW);
      h.store.db.prepare(
        `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key, cancelled_at, cancel_reason)
         VALUES ('w1','wabcde',?, 'widgets', 15, ?, ?, ?, ?, 'acme/widgets', ?, ?)`,
      ).run(
        OWNER, state === 'active' ? NOW : null, state === 'active' ? 'active' : 'cancelled', NOW, NOW,
        state === 'active' ? null : NOW, state === 'identity' ? 'identity_mismatch' : null,
      );
      expect(apply(h, clock).ok, state).toBe(true);
      // The document's review carries no provider hash (no source document ever does): never delivered here.
      expect(unsettled(h), state).toEqual({ withheld_reason: 'ambiguous_evidence', settled_by: null });
      const report = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).verify(importDoc());
      expect(report.nativeLedger, state).toMatchObject({ withheldAmbiguous: 1, clear: false });
      h.close();
    }
  });

  it('withholds it, atomically with the import, when the feed covers that repository and the source has no exact id', () => {
    const { h, clock } = bootImport();
    h.store.githubFeed.insertRepo({ repoKey: 'acme/widgets', display: 'acme/widgets', source: 'explicit', atIso: NOW });
    expect(apply(h, clock).ok).toBe(true);
    expect(unsettled(h)).toEqual({ withheld_reason: 'ambiguous_evidence', settled_by: null });
    const report = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).verify(importDoc());
    expect(report.nativeLedger).toMatchObject({ withheldAmbiguous: 1, clear: false });
    expect(report.ok).toBe(true);
    expect(report.parity).toBe(false); // a notification that was never sent is not parity
    h.close();
  });

  it('records an imported pause as having no real start, and a repeat import changes nothing', () => {
    const { h, clock } = bootImport();
    const doc = importDoc() as { watch: { monitoringEnabled: boolean } };
    doc.watch.monitoringEnabled = false;
    expect(apply(h, clock, doc).ok).toBe(true);
    const before = h.store.assistantWatch.pausePeriods(OWNER);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ startedAt: null, startedOrigin: 'import', endedAt: null });
    clock.advance(MIN);
    expect(apply(h, clock, doc).ok).toBe(true);
    expect(h.store.assistantWatch.pausePeriods(OWNER)).toEqual(before);
    h.close();
  });

  it('counts, on a database that predates the ledger, every event and cursor at or before its cutoff', () => {
    const clock = new TestClock(NOW, MANILA);
    const db = h0(clock);
    expect(db.verify.nativeLedger).toMatchObject({ fresh: false, withheldLegacy: 1, clear: false });
    expect(db.verify.nativeLedger!.cursorsAtOrBeforeCutoff).toBeGreaterThan(0);
    expect(db.verify.parity).toBe(false);
    db.h.close();
  });

  it('turns the feed rows the migration staged into receipts before it decides, so a told pull request is settled, not withheld', () => {
    const clock = new TestClock(NOW, MANILA);
    const raw = openDatabase({ location: ':memory:' });
    runMigrations(raw, { upTo: 35 });
    raw.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, delivered_at, delivered_to, created_at)
       VALUES ('f1','pr_opened:acme/widgets#13','pr_opened','acme/widgets','selected',NULL,'delivered','2026-10-11T00:00:00.000Z','owner_dm','2026-10-11T00:00:00.000Z')`,
    ).run();
    runMigrations(raw, { now: () => '2026-10-12T12:00:00.000Z' });
    const h = makeHarness({ clock, store: createStore(raw), env: { DUCKY_OWNER_TIMEZONE: MANILA } });
    const doc = importDoc() as { watch: { targets: { events: object[] }[] } };
    doc.watch.targets[0]!.events.push(
      { kind: 'pr_opened', identity: '13:opened', occurredAt: '2026-10-11T08:00:00Z', payload: { number: 13, title: 'Told' }, alertedAt: null, digestedAt: null },
      { kind: 'pr_opened', identity: '14:opened', occurredAt: '2026-10-11T09:00:00Z', payload: { number: 14, title: 'Not told' }, alertedAt: null, digestedAt: null },
    );
    // The importer builds no application: its own transaction reads the staged rows back.
    expect(apply(h, clock, doc).ok).toBe(true);
    const by = (id: string) =>
      h.store.db.prepare('SELECT withheld_reason, settled_by FROM assistant_watch_events WHERE identity = ?').get(id);
    expect(by('13:opened')).toEqual({ withheld_reason: null, settled_by: 'native_receipt' });
    // Nothing proves #14 was NOT told before the cutoff on a database that is not new: withheld, not sent.
    expect(by('14:opened')).toEqual({ withheld_reason: 'legacy_unproven', settled_by: null });
    h.close();
  });

  // A database migrated from v35, not built fresh: the cutoff is 2026-10-12, after the source's own times.
  function h0(clock: TestClock) {
    const raw = openDatabase({ location: ':memory:' });
    runMigrations(raw, { upTo: 35 });
    runMigrations(raw, { now: () => '2026-10-12T12:00:00.000Z' });
    const h = makeHarness({ clock, store: createStore(raw), env: { DUCKY_OWNER_TIMEZONE: MANILA } });
    expect(apply(h, clock).ok).toBe(true);
    const verify = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).verify(importDoc());
    return { h, verify };
  }
});
