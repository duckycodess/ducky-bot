import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_WATCH_CALLS_PER_HOUR, ASSISTANT_WATCH_CALLS_PER_TICK, ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS,
  type WatchEventKind, type WatchSurface,
} from '@ducky/contracts';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { OWNER, STRANGER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * Notification-only targets, observed through the real service, store and
 * transport with a scripted typed reader. Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;

const boot = (
  over: { reader?: FakeWatchReader; env?: Record<string, string | undefined>; store?: Harness['store']; clock?: TestClock } = {},
) => {
  const clock = over.clock ?? new TestClock(NOW, 'UTC');
  const reader = over.reader ?? new FakeWatchReader();
  const h = makeHarness({ clock, assistantWatchReader: reader, ...(over.env ? { env: over.env } : {}), ...(over.store ? { store: over.store } : {}) });
  return { h, clock, reader };
};

let seq = 0;
const target = (h: Harness, key = 'acme/widgets', over: { state?: 'active' | 'cancelled'; owner?: string } = {}) => {
  seq += 1;
  const id = `t${seq}`;
  h.store.assistantWatch.insertTarget({
    id, publicId: `w${String(seq).padStart(5, '0')}`, discordUserId: over.owner ?? OWNER, repoKey: key.toLowerCase(),
    display: key, defaultBranch: 'main', state: over.state ?? 'active', lastObservedAt: null,
    createdAt: NOW, cancelledAt: over.state === 'cancelled' ? NOW : null,
  });
  return id;
};
const checkpoint = (
  h: Harness, id: string, surface: WatchSurface,
  state: 'unbaselined' | 'imported' | 'ready', cursor: string | null, due = NOW,
) => h.store.assistantWatch.insertCheckpoint({ targetId: id, surface, state, cursor, nextDueAt: due, updatedAt: NOW });
const cp = (h: Harness, id: string, surface: WatchSurface) => h.store.assistantWatch.checkpoint(id, surface)!;
const events = (h: Harness, id: string) => h.store.assistantWatch.eventsFor(id);
const commit = (sha: string, at: string) => ({ sha, committedAt: at, subject: `${sha} change` });
const pull = (n: number, over: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, state: 'open' as const, createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z', mergedAt: null, closedAt: null, ...over,
});
const importedEvent = (
  h: Harness, id: string, kind: WatchEventKind, identity: string,
  over: { alertedAt?: string | null; digestedAt?: string | null } = {},
) => h.store.assistantWatch.insertImportedEvent({
  id: `ev-${identity}-${kind}`, targetId: id, kind, identity, occurredAt: '2026-10-11T00:00:00.000Z',
  payloadJson: JSON.stringify({ number: Number(identity.split(':')[0]), title: 'Known' }),
  alertedAt: over.alertedAt ?? null, digestedAt: over.digestedAt === undefined ? NOW : over.digestedAt, createdAt: NOW,
});

describe('a target that was never baselined', () => {
  it('is baselined silently on first sight, then announces only what is new', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'commits', 'unbaselined', null);
    reader.commitsBy.set('acme/widgets', [commit('c3', '2026-10-12T10:00:00Z'), commit('c2', '2026-10-11T10:00:00Z')]);

    const first = await h.app.assistantWatch.tick();
    expect(first.completed).toBe(1);
    expect(events(h, id)).toEqual([]);
    expect(cp(h, id, 'commits')).toMatchObject({ state: 'ready', cursor: '2026-10-12T10:00:00.000Z' });
    // History is not news: nothing is owed, however much already existed.
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toEqual([]);

    reader.commitsBy.get('acme/widgets')!.unshift(commit('c4', '2026-10-13T00:05:00Z'));
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(events(h, id).map((e) => e.identity)).toEqual(['c4']);
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.close();
  });

  it('baselines to now when the repository has nothing to read, never to a null', async () => {
    const { h } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'unbaselined', null);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'issues')).toMatchObject({ state: 'ready', cursor: NOW });
    h.close();
  });
});

describe('the transition window after an import', () => {
  it('suppresses a settled identity and announces the unseen one, advancing once', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', '2026-10-10T00:00:00.000Z');
    importedEvent(h, id, 'pr_opened', '1:opened'); // already announced by the source
    reader.pullsBy.set('acme/widgets', [
      pull(2, { createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T06:00:00Z' }),
      pull(1, { createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T06:00:00Z' }),
    ]);
    reader.pageSize = 10;

    await h.app.assistantWatch.tick();

    const all = events(h, id);
    expect(all.map((e) => e.identity).sort()).toEqual(['1:opened', '2:opened']);
    // The settled one stays settled and is the same single row.
    expect(all.find((e) => e.identity === '1:opened')).toMatchObject({ origin: 'imported', digestedAt: NOW });
    expect(all.find((e) => e.identity === '2:opened')).toMatchObject({ origin: 'observed', digestedAt: null });
    expect(h.store.assistantWatch.undigested(OWNER, 10).map((e) => e.identity)).toEqual(['2:opened']);
    expect(cp(h, id, 'pulls')).toMatchObject({ state: 'ready', cursor: '2026-10-12T06:00:00.000Z' });
    h.close();
  });

  it('does not announce a pull request exactly at the cursor, and does announce a late update', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', '2026-10-12T00:00:00.000Z');
    reader.pageSize = 10;
    reader.pullsBy.set('acme/widgets', [
      pull(9, { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-12T00:00:01Z' }), // late update
      pull(8, { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' }), // exactly at the cursor
    ]);
    await h.app.assistantWatch.tick();
    expect(events(h, id).map((e) => e.identity)).toEqual(['9:updated:2026-10-12T00:00:01Z']);
    h.close();
  });

  it('does not announce again when the same window is read twice', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    reader.pageSize = 10;
    reader.issuesBy.set('acme/widgets', [{ number: 4, title: 'Bug', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', closedAt: null }]);
    await h.app.assistantWatch.tick();
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(events(h, id)).toHaveLength(1);
    h.close();
  });

  it('keeps the CI state with the runs cursor, so a recovery after a failure is announced once', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'imported', '2026-10-10T00:00:00.000Z');
    checkpoint(h, id, 'ci_state', 'ready', 'failing', '9999-12-31T00:00:00.000Z');
    reader.runsBy.set('acme/widgets', [{
      id: '77', name: 'build', branch: 'main', status: 'completed', conclusion: 'success',
      createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
    }]);
    await h.app.assistantWatch.tick();
    expect(events(h, id).map((e) => e.kind)).toEqual(['ci_recovered']);
    expect(cp(h, id, 'ci_state').cursor).toBe('passing');
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(events(h, id)).toHaveLength(1);
    h.close();
  });
});

describe('a read that is not finished', () => {
  const seedCommits = (h: Harness, reader: FakeWatchReader) => {
    const id = target(h);
    checkpoint(h, id, 'commits', 'imported', '2026-10-10T00:00:00.000Z');
    reader.commitsBy.set('acme/widgets', [
      commit('n5', '2026-10-12T05:00:00Z'), commit('n4', '2026-10-12T04:00:00Z'),
      commit('n3', '2026-10-12T03:00:00Z'), commit('n2', '2026-10-12T02:00:00Z'),
      commit('n1', '2026-10-12T01:00:00Z'), commit('old', '2026-10-09T00:00:00Z'),
    ]);
    return id;
  };

  it('holds what it found, delivers nothing and keeps the cursor until the window closes', async () => {
    const { h, clock, reader } = boot();
    const id = seedCommits(h, reader);
    reader.failNth.set('commits', 3); // pages 1 and 2 succeed; the third read fails

    const first = await h.app.assistantWatch.tick();
    expect(first.incomplete).toBe(2);
    expect(first.failed).toBe(1);
    const mid = cp(h, id, 'commits');
    expect(mid).toMatchObject({ state: 'imported', cursor: '2026-10-10T00:00:00.000Z', pendingPage: 2, failures: 1 });
    // Four commits are recorded, and every one of them is HELD.
    expect(events(h, id)).toHaveLength(4);
    expect(events(h, id).every((e) => e.held)).toBe(true);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);

    // After the backoff the read RESUMES at the next page, not at page 1.
    clock.advance(16 * MIN);
    reader.log.length = 0;
    await h.app.assistantWatch.tick();
    // Page 3 closes a window that spanned pages, so the same page is read once
    // more to prove the window held still, and only then does it commit.
    expect(reader.log).toEqual(['commits:acme/widgets:3', 'commits:acme/widgets:3']);
    expect(events(h, id)).toHaveLength(5);
    expect(events(h, id).every((e) => !e.held)).toBe(true);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toHaveLength(5);
    expect(cp(h, id, 'commits')).toMatchObject({
      state: 'ready', cursor: '2026-10-12T05:00:00.000Z', pendingPage: 0, failures: 0,
    });
    h.close();
  });

  it('survives a restart: a new process resumes the same read', async () => {
    const first = boot();
    const id = seedCommits(first.h, first.reader);
    first.reader.failNth.set('commits', 2);
    await first.h.app.assistantWatch.tick();
    expect(cp(first.h, id, 'commits').pendingPage).toBe(1);

    const second = boot({ store: first.h.store, clock: first.clock, reader: first.reader });
    first.clock.advance(16 * MIN);
    first.reader.log.length = 0;
    await second.h.app.assistantWatch.tick();
    expect(first.reader.log[0]).toBe('commits:acme/widgets:2');
    expect(cp(second.h, id, 'commits').state).toBe('ready');
    second.h.close();
  });

  it('records a failure with a short code, backs off, and leaves the cursor alone', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    reader.failNext.add('issues');
    const out = await h.app.assistantWatch.tick();
    expect(out.failed).toBe(1);
    expect(cp(h, id, 'issues')).toMatchObject({
      cursor: '2026-10-10T00:00:00.000Z', failures: 1, lastError: 'read_failed',
      nextDueAt: new Date(Date.parse(NOW) + 15 * MIN).toISOString(),
    });
    // Nothing is retried before the backoff has run out.
    const calls = reader.calls;
    await h.app.assistantWatch.tick();
    expect(reader.calls).toBe(calls);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'issues')).toMatchObject({ failures: 0, lastError: null });
    h.close();
  });

  it('refuses an unreadable timestamp instead of advancing past it', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    reader.issuesBy.set('acme/widgets', [{ number: 1, title: 't', createdAt: 'garbage', updatedAt: 'garbage', closedAt: null }]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'issues')).toMatchObject({ cursor: '2026-10-10T00:00:00.000Z', lastError: 'unreadable_timestamp' });
    expect(events(h, id)).toEqual([]);
    h.close();
  });

  it('blocks a read that never reaches the cursor rather than chasing it forever', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'commits', 'imported', '2000-01-01T00:00:00.000Z');
    reader.pageSize = 1;
    reader.commitsBy.set('acme/widgets', Array.from({ length: 80 }, (_v, i) => commit(`c${i}`, new Date(Date.parse('2026-10-12T00:00:00Z') - i * 1000).toISOString())));
    // Budget would allow it; the page ceiling is what stops it.
    for (let i = 0; i < 4; i += 1) await h.app.assistantWatch.tick();
    const c = cp(h, id, 'commits');
    expect(c.blockedReason).toBe('window_exceeded');
    expect(c.cursor).toBe('2000-01-01T00:00:00.000Z');
    expect(h.store.assistantWatch.undigested(OWNER, 100)).toEqual([]);
    h.close();
  });
});

describe('what the reader cannot see', () => {
  it('blocks a surface it cannot observe, advances nothing there, and carries on elsewhere', async () => {
    const { h, reader } = boot();
    reader.capabilities = { observableKinds: ['commit', 'issue_opened', 'issue_updated', 'issue_closed'], discovery: false };
    const id = target(h);
    checkpoint(h, id, 'releases', 'imported', '2026-10-10T00:00:00.000Z');
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    const out = await h.app.assistantWatch.tick();
    expect(out.blocked).toBe(1);
    expect(cp(h, id, 'releases')).toMatchObject({ blockedReason: 'unobservable', cursor: '2026-10-10T00:00:00.000Z', state: 'imported' });
    expect(cp(h, id, 'issues').state).toBe('ready');
    expect(reader.log.some((l) => l.startsWith('releases'))).toBe(false);
    h.close();
  });

  it('observes nothing with the shipped reader and says so', async () => {
    const h = makeHarness({ clock: new TestClock(NOW, 'UTC') });
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', '2026-10-10T00:00:00.000Z');
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(0);
    expect(cp(h, id, 'pulls')).toMatchObject({ blockedReason: 'unobservable', state: 'imported' });
    expect(h.app.assistantWatch.statusLine()).toContain('NOT observing');
    h.close();
  });
});

describe('the call budget and fair scheduling', () => {
  it('spends at most the per-tick ceiling and serves the longest-waiting first', async () => {
    const { h, reader } = boot();
    reader.pageSize = 10;
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = target(h, `acme/r${String(i).padStart(2, '0')}`);
      ids.push(id);
      // r00 has waited longest.
      checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z', new Date(Date.parse(NOW) - (60 - i) * MIN).toISOString());
    }
    const first = await h.app.assistantWatch.tick();
    expect(first.callsUsed).toBe(ASSISTANT_WATCH_CALLS_PER_TICK);
    expect(reader.log.map((l) => l.split(':')[1])).toEqual(
      Array.from({ length: ASSISTANT_WATCH_CALLS_PER_TICK }, (_v, i) => `acme/r${String(i).padStart(2, '0')}`),
    );
    // The rest wait for the next tick, and nobody is read twice before they are.
    reader.log.length = 0;
    const second = await h.app.assistantWatch.tick();
    expect(second.callsUsed).toBe(10);
    expect(reader.log.map((l) => l.split(':')[1])).toEqual(
      Array.from({ length: 10 }, (_v, i) => `acme/r${String(ASSISTANT_WATCH_CALLS_PER_TICK + i).padStart(2, '0')}`),
    );
    h.close();
  });

  it('honours the rolling-hour ceiling even when the tick ceiling would allow more', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    h.store.assistantWatch.chargeCalls('2026-10-12T23:30', ASSISTANT_WATCH_CALLS_PER_HOUR);
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(0);
    expect(reader.calls).toBe(0);
    // Once that bucket leaves the hour, work resumes.
    const later = boot({ store: h.store, clock: new TestClock('2026-10-13T01:00:00.000Z', 'UTC'), reader });
    expect((await later.h.app.assistantWatch.tick()).callsUsed).toBeGreaterThan(0);
    later.h.close();
  });

  it('starts a unit only when its worst case fits, and never overspends', async () => {
    const { h, reader } = boot();
    seq += 1;
    const id = `t${seq}`;
    // No default branch known: a commits unit may need a second request to learn it.
    h.store.assistantWatch.insertTarget({
      id, publicId: `w${String(seq).padStart(5, '0')}`, discordUserId: OWNER, repoKey: 'acme/widgets',
      display: 'acme/widgets', defaultBranch: null, state: 'active', lastObservedAt: null,
      createdAt: NOW, cancelledAt: null,
    });
    checkpoint(h, id, 'commits', 'imported', '2026-10-10T00:00:00.000Z');
    h.store.assistantWatch.chargeCalls('2026-10-12T23:59', ASSISTANT_WATCH_CALLS_PER_HOUR - 1);
    const out = await h.app.assistantWatch.tick();
    expect(out.budgetStopped).toBe(true);
    expect(reader.calls).toBe(0);
    h.close();
  });

  it('runs a one-request unit when exactly one call is left', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    h.store.assistantWatch.chargeCalls('2026-10-12T23:59', ASSISTANT_WATCH_CALLS_PER_HOUR - 1);
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(1);
    expect(reader.calls).toBe(1);
    h.close();
  });

  it('charges every call a pull-request page makes, reviews included', async () => {
    const { h, reader } = boot();
    reader.pageSize = 10;
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', '2026-10-10T00:00:00.000Z');
    reader.pullsBy.set('acme/widgets', [pull(1, { updatedAt: '2026-10-12T00:00:00Z' }), pull(2, { updatedAt: '2026-10-12T01:00:00Z' })]);
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(3); // one page and two review reads
    expect(h.store.assistantWatch.callsSince('2026-10-12T00:00')).toBe(3);
    h.close();
  });

  it('skips a cancelled target entirely', async () => {
    const { h, reader } = boot();
    const id = target(h, 'acme/gone', { state: 'cancelled' });
    checkpoint(h, id, 'issues', 'imported', '2026-10-10T00:00:00.000Z');
    expect((await h.app.assistantWatch.tick()).callsUsed).toBe(0);
    expect(reader.calls).toBe(0);
    h.close();
  });
});

describe('alerts interrupt for requested changes, and only the owner is told', () => {
  const seedAlert = (h: Harness, identity = '3:review:r9') => {
    const id = target(h);
    checkpoint(h, id, 'pulls', 'ready', '2026-10-12T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    h.store.assistantWatch.insertImportedEvent({
      id: `a-${identity}`, targetId: id, kind: 'review_requested_changes', identity, occurredAt: '2026-10-12T12:00:00.000Z',
      payloadJson: JSON.stringify({ number: 3, title: 'Add a thing', summary: 'Please add tests' }), alertedAt: null, digestedAt: null, createdAt: NOW,
    });
    return id;
  };

  it('sends one alert to the owner’s DM, never twice, and never a channel', async () => {
    const { h } = boot({ env: { DUCKY_DEV_GITHUB_CHANNEL_ID: '900000000000000042' } });
    seedAlert(h);
    const out = await h.app.assistantWatch.tick();
    expect(out.alertsSent).toBe(1);
    const sent = h.transport.sent.at(-1)!;
    expect(sent.target).toEqual({ kind: 'user', userId: OWNER });
    const text = JSON.stringify(sent.message);
    expect(text).toContain('widgets');
    expect(text).not.toContain('acme'); // the owner segment is a name
    expect(text).toContain('Please add tests');
    await h.app.assistantWatch.tick();
    expect(h.transport.sent).toHaveLength(1);
    // Once alerted, the digest still carries it as a record.
    expect(h.store.assistantWatch.undigested(OWNER, 10).map((e) => e.kind)).toEqual(['review_requested_changes']);
    h.close();
  });

  it('retries a failed alert and then hands it to the digest instead of looping or losing it', async () => {
    const { h } = boot();
    seedAlert(h);
    h.transport.failSends = true;
    for (let i = 0; i < ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS; i += 1) {
      expect((await h.app.assistantWatch.tick()).alertsFailed).toBe(1);
    }
    expect((await h.app.assistantWatch.tick()).alertsFailed).toBe(0);
    h.transport.failSends = false;
    expect(h.store.assistantWatch.pendingAlerts(OWNER, 10)).toEqual([]);
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.close();
  });

  it('abandons an unsent alert when the target is cancelled', async () => {
    const { h } = boot();
    const id = seedAlert(h);
    h.store.assistantWatch.cancel(OWNER, id, NOW);
    expect((await h.app.assistantWatch.tick()).alertsSent).toBe(0);
    h.close();
  });

  it('keeps an alert held by an unfinished read from interrupting', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', '2026-10-10T00:00:00.000Z');
    reader.pageSize = 1;
    reader.pullsBy.set('acme/widgets', [
      pull(1, { updatedAt: '2026-10-12T05:00:00Z' }),
      pull(2, { updatedAt: '2026-10-12T04:00:00Z' }),
    ]);
    reader.reviewsBy.set('acme/widgets#1', [{ id: 'q1', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-12T05:00:00Z', body: 'redo' }]);
    reader.failNth.set('pulls', 2);
    await h.app.assistantWatch.tick();
    expect(events(h, id).some((e) => e.kind === 'review_requested_changes' && e.held)).toBe(true);
    expect(h.transport.sent).toEqual([]);
    h.close();
  });
});

describe('the owner’s controls', () => {
  it('lists and cancels notification targets, owner only', async () => {
    const { h } = boot();
    const id = target(h, 'acme/one');
    target(h, 'acme/two');
    const handle = h.store.assistantWatch.listForOwner(OWNER, true, 5)[0]!.publicId;
    expect(h.app.assistantWatch.list(h.owner, true, 10)).toHaveLength(2);
    expect(() => h.app.assistantWatch.list(h.stranger, true, 10)).toThrow();
    expect(() => h.app.assistantWatch.cancel(h.stranger, handle)).toThrow();
    expect(h.app.assistantWatch.owns(h.owner, handle)).toBe(true);
    const row = h.app.assistantWatch.cancel(h.owner, handle);
    expect(row.state).toBe('cancelled');
    expect(() => h.app.assistantWatch.cancel(h.owner, handle)).toThrow(/already cancelled/);
    expect(() => h.app.assistantWatch.cancel(h.owner, 'wzzzzz')).toThrow(/No repository watch/);
    expect(id).toBeDefined();
    h.close();
  });

  it('pages the target list through the existing /watch list command and cancels by handle', async () => {
    const { h } = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    for (let i = 0; i < 20; i += 1) target(h, `acme/r${String(i).padStart(2, '0')}`);
    const page1 = await h.transport.dispatch({ kind: 'command', name: 'watch', subcommand: 'list', userId: OWNER, options: { filter: 'targets' } });
    const text1 = JSON.stringify(page1);
    expect(text1).toContain('20 active');
    expect(text1).toContain('Page 1 of 2');
    expect(text1).not.toContain('r19');
    const page2 = await h.transport.dispatch({ kind: 'command', name: 'watch', subcommand: 'list', userId: OWNER, options: { filter: 'targets', page: 2 } });
    expect(JSON.stringify(page2)).toContain('r19');
    const handle = h.store.assistantWatch.listForOwner(OWNER, true, 1)[0]!.publicId;
    const cancelled = await h.transport.dispatch({ kind: 'command', name: 'watch', subcommand: 'remove', userId: OWNER, options: { id: handle } });
    expect(JSON.stringify(cancelled)).toContain('cancelled');
    expect(h.store.assistantWatch.countActive(OWNER)).toBe(19);
    h.close();
  });

  it('does not let anyone else cancel, whatever the handle', async () => {
    const { h } = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    target(h, 'acme/one');
    const handle = h.store.assistantWatch.listForOwner(OWNER, true, 1)[0]!.publicId;
    const reply = await h.transport.dispatch({ kind: 'command', name: 'watch', subcommand: 'remove', userId: STRANGER, options: { id: handle } });
    expect(JSON.stringify(reply)).not.toContain('cancelled');
    expect(h.store.assistantWatch.countActive(OWNER)).toBe(1);
    h.close();
  });
});

describe('a target is not an engineering watch', () => {
  it('grants no job and touches no allowlist', async () => {
    const { h } = boot();
    target(h, 'acme/not-allowlisted');
    const before = h.store.db.prepare('SELECT COUNT(*) n FROM repos').get() as { n: number };
    const jobs = h.store.db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number };
    await h.app.assistantWatch.tick();
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM repos').get()).toEqual(before);
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual(jobs);
    expect(h.app.allowlist.list().map((r) => r.slug)).not.toContain('not-allowlisted');
    h.close();
  });

  it('is not cancelled by the ordinary watch tick for lacking an allowlist entry', async () => {
    const { h, clock } = boot();
    const id = target(h, 'acme/not-allowlisted');
    clock.advance(24 * 60 * MIN);
    await h.app.githubWatches.tick();
    expect(h.store.assistantWatch.byPublicId(OWNER, h.store.assistantWatch.listForOwner(OWNER, true, 1)[0]!.publicId)?.state).toBe('active');
    expect(id).toBeDefined();
    h.close();
  });

  it('leaves the ordinary add refusing a repository that is not allowlisted', async () => {
    const { h } = boot();
    target(h, 'acme/not-allowlisted');
    expect(() => h.app.githubWatches.add(h.owner, { repoSlug: 'not-allowlisted' })).toThrow();
    h.close();
  });

  it('never lets a handle name two watches', () => {
    const { h } = boot();
    target(h, 'acme/one');
    const taken = h.store.assistantWatch.listForOwner(OWNER, true, 1)[0]!.publicId;
    const w = h.app.githubWatches.add(h.owner, { repoSlug: 'demo' });
    expect(w.publicId).not.toBe(taken);
    h.close();
  });
});
