import { describe, expect, it } from 'vitest';
import { ASSISTANT_WATCH_CALLS_PER_TICK, type WatchSurface } from '@ducky/contracts';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { WatchReadError } from '../src/domain/assistant-watch.reader.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * One request per unit, and a window that must prove it held still before it
 * commits. Driven through the real service, store and transport with a scripted
 * typed reader. Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;
const SINCE = '2026-10-10T00:00:00.000Z';

const boot = (over: { reader?: FakeWatchReader; store?: Harness['store']; clock?: TestClock } = {}) => {
  const clock = over.clock ?? new TestClock(NOW, 'UTC');
  const reader = over.reader ?? new FakeWatchReader();
  const h = makeHarness({ clock, assistantWatchReader: reader, ...(over.store ? { store: over.store } : {}) });
  return { h, clock, reader };
};

let seq = 100;
const target = (h: Harness, key = 'acme/widgets', defaultBranch: string | null = 'main') => {
  seq += 1;
  const id = `u${seq}`;
  h.store.assistantWatch.insertTarget({
    id, publicId: `w${String(seq).padStart(5, '0')}`, discordUserId: OWNER, repoKey: key.toLowerCase(),
    display: key, defaultBranch, state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
  });
  return id;
};
const checkpoint = (
  h: Harness, id: string, surface: WatchSurface, state: 'unbaselined' | 'imported' | 'ready',
  cursor: string | null, over: { due?: string } = {},
) => h.store.assistantWatch.insertCheckpoint({
  targetId: id, surface, state, cursor, nextDueAt: over.due ?? NOW, updatedAt: NOW,
});
const cp = (h: Harness, id: string, surface: WatchSurface) => h.store.assistantWatch.checkpoint(id, surface)!;
const events = (h: Harness, id: string) => h.store.assistantWatch.eventsFor(id);
const ids = (h: Harness, id: string) => events(h, id).map((e) => e.identity).sort();

const issue = (n: number, updated: string, over: Record<string, unknown> = {}) => ({
  number: n, title: `Issue ${n}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: updated, closedAt: null, ...over,
});
const at = (day: number, hour = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

describe('pull request reviews are their own units', () => {
  const pr = (n: number) => ({
    number: n, title: `PR ${n}`, state: 'open' as const, createdAt: at(1), updatedAt: at(12), mergedAt: null, closedAt: null,
  });
  const review = (id: string, state: string, when = at(12)) => ({ id, state, submittedAt: when, body: '' });

  it('reads the list page, then each page of reviews, one request at a time', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', SINCE);
    reader.pullsBy.set('acme/widgets', [pr(7)]);
    reader.reviewsBy.set('acme/widgets#7', [
      review('a', 'COMMENTED'), review('b', 'APPROVED'), review('c', 'CHANGES_REQUESTED'),
      review('d', 'COMMENTED'), review('e', 'APPROVED'),
    ]);
    const out = await h.app.assistantWatch.tick();
    expect(reader.log).toEqual([
      'pulls:acme/widgets:1', 'pullReviews:acme/widgets:1', 'pullReviews:acme/widgets:2', 'pullReviews:acme/widgets:3',
    ]);
    expect(out.callsUsed).toBe(4);
    expect(out.completed).toBe(1);
    expect(ids(h, id)).toEqual([
      '7:pending', '7:review:a', '7:review:b', '7:review:c', '7:review:d', '7:review:e', '7:updated:2026-10-12T00:00:00Z',
    ].sort());
    // The marker is judged over EVERY page, so it exists although no single page held it all.
    expect(events(h, id).every((e) => !e.held)).toBe(true);
    expect(cp(h, id, 'pulls')).toMatchObject({ state: 'ready', pendingPage: 0, pendingState: null });
    h.close();
  });

  it('holds everything until the last review page, and resumes where it stopped', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', SINCE);
    reader.pullsBy.set('acme/widgets', [pr(7)]);
    reader.reviewsBy.set('acme/widgets#7', [
      review('a', 'COMMENTED'), review('b', 'APPROVED'), review('c', 'APPROVED'),
    ]);
    reader.failNth.set('pullReviews', 2); // list and review page 1 succeed; review page 2 fails
    const first = await h.app.assistantWatch.tick();
    expect(first.failed).toBe(1);
    expect(cp(h, id, 'pulls')).toMatchObject({ cursor: SINCE, pendingPage: 1, failures: 1 });
    expect(events(h, id).length).toBeGreaterThan(0);
    expect(events(h, id).every((e) => e.held)).toBe(true);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);

    clock.advance(16 * MIN);
    reader.log.length = 0;
    await h.app.assistantWatch.tick();
    // It resumes at review page 2 of the same pull request, not at the list.
    expect(reader.log).toEqual(['pullReviews:acme/widgets:2']);
    expect(cp(h, id, 'pulls')).toMatchObject({ state: 'ready', pendingState: null, failures: 0 });
    expect(events(h, id).every((e) => !e.held)).toBe(true);
    expect(ids(h, id)).toContain('7:review:c');
    h.close();
  });

  it('blocks a pull request with more reviews than the page cap instead of reading a prefix', async () => {
    const { h, reader } = boot();
    reader.pageSize = 10;
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', SINCE);
    reader.pullsBy.set('acme/widgets', [pr(7)]);
    reader.reviewsBy.set('acme/widgets#7', Array.from({ length: 150 }, (_, i) => review(`r${i}`, 'COMMENTED')));
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'pulls')).toMatchObject({ blockedReason: 'window_exceeded', cursor: SINCE });
    expect(events(h, id).every((e) => e.held)).toBe(true);
    h.close();
  });

  it('announces a late review stamped at the cursor exactly once, by its id', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    // `ready` with a known boundary: Ducky itself processed what sits at the cursor.
    checkpoint(h, id, 'pulls', 'imported', at(12));
    h.store.assistantWatch.commitObservation({
      targetId: id, surface: 'pulls', expectedUpdatedAt: NOW, cursor: at(12), nextDueAt: NOW, atIso: NOW,
      events: [], boundaryKnown: true,
    });
    // The pass that moved the cursor here already announced the update at that instant.
    h.store.assistantWatch.insertImportedEvent({
      id: 'known', targetId: id, kind: 'pr_updated', identity: `7:updated:${at(12)}`, occurredAt: at(12),
      payloadJson: '{}', alertedAt: NOW, digestedAt: NOW, createdAt: NOW,
    });
    reader.pullsBy.set('acme/widgets', [pr(7)]); // updated exactly AT the cursor
    reader.reviewsBy.set('acme/widgets#7', [review('late', 'APPROVED', at(12))]);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['7:review:late', `7:updated:${at(12)}`]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['7:review:late', `7:updated:${at(12)}`]); // not announced a second time
    h.close();
  });

  it('does not re-read the boundary when the cursor came from the source', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', at(12)); // boundary unknown: strict
    reader.pullsBy.set('acme/widgets', [pr(7)]);
    reader.reviewsBy.set('acme/widgets#7', [review('late', 'APPROVED', at(12))]);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual([]);
    expect(reader.log).toEqual(['pulls:acme/widgets:1']);
    h.close();
  });
});

describe('a window that spanned pages must prove it held still', () => {
  // Newest first. Page size 2: [5,4] [3,2] [1,old]; the third page reaches the cursor.
  const seed = (reader: FakeWatchReader) => {
    reader.issuesBy.set('acme/widgets', [
      issue(5, at(12, 5)), issue(4, at(12, 4)), issue(3, at(12, 3)), issue(2, at(12, 2)), issue(1, at(12, 1)),
      issue(9, '2026-10-01T00:00:00Z'),
    ]);
  };

  it('commits after a re-read of the last page that shows nothing changed', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    seed(reader);
    await h.app.assistantWatch.tick();
    expect(reader.log).toEqual([
      'issues:acme/widgets:1', 'issues:acme/widgets:2', 'issues:acme/widgets:3', 'issues:acme/widgets:3',
    ]);
    expect(events(h, id)).toHaveLength(5);
    expect(cp(h, id, 'issues')).toMatchObject({ state: 'ready', pendingState: null });
    h.close();
  });

  it('commits when only an insertion above shifted the page down, and finds the newcomer next time', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    seed(reader);
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'issues') return;
      n += 1;
      if (n === 4) reader.issuesBy.get('acme/widgets')!.unshift(issue(6, at(12, 6)));
    };
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'issues').state).toBe('ready');
    expect(ids(h, id).some((i) => i.startsWith('6:'))).toBe(false);
    clock.advance(16 * MIN);
    reader.hook = null;
    await h.app.assistantWatch.tick();
    expect(ids(h, id).some((i) => i.startsWith('6:'))).toBe(true);
    h.close();
  });

  it('throws the pass away when a row was DELETED above, and never marks it settled', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    seed(reader);
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'issues') return;
      n += 1;
      if (n === 4) reader.issuesBy.set('acme/widgets', reader.issuesBy.get('acme/widgets')!.filter((i) => i.number !== 4));
    };
    const out = await h.app.assistantWatch.tick();
    expect(out.failed).toBe(1);
    expect(cp(h, id, 'issues')).toMatchObject({
      cursor: SINCE, pendingPage: 0, pendingState: null, lastError: 'window_unstable', failures: 1,
    });
    // What was found stays held and undelivered.
    expect(events(h, id)).toHaveLength(5);
    expect(events(h, id).every((e) => e.held)).toBe(true);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);

    // After the backoff the window is read again from the first page and, held still, commits.
    reader.hook = null;
    clock.advance(31 * MIN);
    reader.log.length = 0;
    await h.app.assistantWatch.tick();
    expect(reader.log[0]).toBe('issues:acme/widgets:1');
    expect(cp(h, id, 'issues')).toMatchObject({ state: 'ready', failures: 0 });
    expect(events(h, id).every((e) => !e.held)).toBe(true);
    h.close();
  });

  it('treats an item that moved (was updated) between reads as drift', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    seed(reader);
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'issues') return;
      n += 1;
      if (n === 4) {
        // The last page's first item is updated: it leaves its place and takes the top.
        const all = reader.issuesBy.get('acme/widgets')!;
        const moved = all.splice(4, 1)[0]!;
        all.unshift({ ...moved, updatedAt: at(13) });
      }
    };
    const out = await h.app.assistantWatch.tick();
    expect(out.failed).toBe(1);
    expect(cp(h, id, 'issues')).toMatchObject({ cursor: SINCE, lastError: 'window_unstable' });
    h.close();
  });

  it('does not lose an item that moved to the top between two page reads', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    seed(reader);
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'issues') return;
      n += 1;
      if (n === 2) {
        // Issue 3 sits on page 2 and is not yet read; it is updated and takes the top.
        const all = reader.issuesBy.get('acme/widgets')!;
        const moved = all.splice(2, 1)[0]!;
        all.unshift({ ...moved, updatedAt: at(12, 9) });
      }
    };
    await h.app.assistantWatch.tick();
    reader.hook = null;
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    // The new update of issue 3 is newer than everything the first pass saw, so the second finds it.
    expect(ids(h, id)).toContain(`3:issue_updated:${at(12, 9)}`);
    h.close();
  });

  it('is a close-then-update that the next pass classifies as an update', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    reader.pageSize = 10;
    reader.issuesBy.set('acme/widgets', [issue(3, at(12, 1), { closedAt: at(11) })]);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual([`3:issue_closed:${at(11)}`]);
    reader.issuesBy.set('acme/widgets', [issue(3, at(12, 9), { closedAt: at(11) })]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual([`3:issue_closed:${at(11)}`, `3:issue_updated:${at(12, 9)}`].sort());
    h.close();
  });

  it('does not re-read a window that fitted one page, which was one consistent answer', async () => {
    const { h, reader } = boot();
    reader.pageSize = 10;
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    seed(reader);
    await h.app.assistantWatch.tick();
    expect(reader.log).toEqual(['issues:acme/widgets:1']);
    h.close();
  });

  it('closes on a page of nothing but pull requests, from the shared sort key', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    // The raw page was full of pull requests, none of them issues, and its last row is old.
    reader.issuesBy.set('acme/widgets', []);
    reader.issuesStampBy.set('acme/widgets', '2026-10-01T00:00:00Z');
    reader.pageSize = 2;
    const original = reader.issues.bind(reader);
    reader.issues = async (ref, page) => ({ ...(await original(ref, page)), hasMore: true });
    await h.app.assistantWatch.tick();
    expect(reader.log).toEqual(['issues:acme/widgets:1']);
    expect(cp(h, id, 'issues').state).toBe('ready');
    h.close();
  });
});

describe('workflow runs sort by creation, so the window reaches back to what was unsettled', () => {
  const run = (id: string, created: string, status: string, conclusion: string | null, updated = created) => ({
    id, name: 'build', branch: 'main', status, conclusion, createdAt: created, updatedAt: updated,
  });

  it('finds a run that was running at the last pass and concluded after it', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 2;
    // First sight: run 3 is in flight, created at 09:00 on the 12th.
    reader.runsBy.set('acme/widgets', [run('3', at(12, 9), 'in_progress', null, at(12, 9))]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', scanFloor: '2026-10-12T09:00:00.000Z' });
    expect(events(h, id)).toEqual([]);

    // Later: run 3 failed, and two NEWER completed runs sit above it. A window closed at the
    // cursor alone would stop on page 1 (run 4 was created after the cursor but run 2 before),
    // never reaching run 3 on page 2.
    reader.runsBy.set('acme/widgets', [
      run('5', at(12, 20), 'completed', 'success'),
      run('4', at(12, 12), 'completed', 'success'),
      run('3', at(12, 9), 'completed', 'failure', at(12, 15)),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toContain('3:ci_failed');
    expect(cp(h, id, 'runs').scanFloor).toBeNull();
    expect(cp(h, id, 'ci_state').cursor).toBe('passing');
    h.close();
  });

  it('stops tracking a run that never settled after a day', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.runsBy.set('acme/widgets', [run('3', '2026-10-11T00:00:00Z', 'queued', null)]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs').scanFloor).toBeNull(); // created more than a day before NOW
    clock.advance(1);
    h.close();
  });

  it('restarts the pass when the provider total shrank while it was read', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'imported', SINCE);
    reader.runsBy.set('acme/widgets', [
      run('5', at(12, 5), 'completed', 'success'), run('4', at(12, 4), 'completed', 'success'),
      run('3', at(12, 3), 'completed', 'success'),
    ]);
    reader.runsTotalOverride = 3;
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'runs') return;
      n += 1;
      if (n === 2) reader.runsTotalOverride = 2; // a run was deleted between the two pages
    };
    const out = await h.app.assistantWatch.tick();
    expect(out.failed).toBe(1);
    expect(cp(h, id, 'runs')).toMatchObject({ cursor: SINCE, lastError: 'window_unstable', pendingPage: 0 });
    h.close();
  });
});

describe('releases are listed by creation but announced by publication', () => {
  const rel = (id: string, created: string, published: string | null, draft = false) => ({
    id, tag: `v${id}`, name: `Rel ${id}`, draft, publishedAt: published, createdAt: created,
  });

  it('tracks a draft, and announces it when it is published although it sits deep in the list', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.releasesBy.set('acme/widgets', [rel('2', at(12, 1), at(12, 1)), rel('1', at(11), null, true)]);
    // The first sight reads one page: a draft that sat beyond it would not be tracked.
    reader.pageSize = 10;
    await h.app.assistantWatch.tick();
    reader.pageSize = 1;
    expect(cp(h, id, 'releases').state).toBe('ready');
    expect(events(h, id)).toEqual([]); // a draft announces nothing
    expect(cp(h, id, 'releases').scanFloor).toBe('2026-10-11T00:00:00.000Z');

    // The draft is published; a newer release exists too. The window must reach the draft.
    reader.releasesBy.set('acme/widgets', [
      rel('3', at(12, 20), at(12, 20)), rel('2', at(12, 1), at(12, 1)), rel('1', at(11), at(12, 22)),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['release:1', 'release:3']);
    expect(cp(h, id, 'releases').scanFloor).toBeNull();
    h.close();
  });
});

describe('a window that is too deep to prove is a blocker, not a scan', () => {
  it('blocks commits at the page cap with the cursor and found events left alone', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'commits', 'imported', SINCE);
    reader.commitsBy.set('acme/widgets', Array.from({ length: 12 }, (_, i) => ({
      sha: `c${i}`, committedAt: at(12, 23 - i), subject: 's',
    })));
    const out = await h.app.assistantWatch.tick();
    expect(out.blocked).toBe(1);
    expect(reader.log).toEqual(['commits:acme/widgets:1', 'commits:acme/widgets:2', 'commits:acme/widgets:3']);
    expect(cp(h, id, 'commits')).toMatchObject({ blockedReason: 'window_exceeded', cursor: SINCE });
    expect(events(h, id).every((e) => e.held)).toBe(true);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);
    h.close();
  });

  it('blocks on an exceeded window the reader itself reports', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', SINCE);
    reader.failWith.set('pulls', new WatchReadError('window_exceeded'));
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'pulls')).toMatchObject({ blockedReason: 'window_exceeded' });
    h.close();
  });
});

describe('failures stop what they should and advance nothing', () => {
  it.each(['rate_limited', 'auth'] as const)('%s stops the whole cycle for ten minutes', async (code) => {
    const { h, clock, reader } = boot();
    const a = target(h, 'acme/one');
    const b = target(h, 'acme/two');
    checkpoint(h, a, 'issues', 'imported', SINCE);
    checkpoint(h, b, 'issues', 'imported', SINCE);
    reader.failWith.set('issues', new WatchReadError(code));
    const first = await h.app.assistantWatch.tick();
    expect(first).toMatchObject({ failed: 1, callsUsed: 1 }); // the second target was not tried
    expect(cp(h, a, 'issues')).toMatchObject({ cursor: SINCE, lastError: code, failures: 1 });
    expect(cp(h, b, 'issues').failures).toBe(0);

    clock.advance(5 * MIN);
    expect((await h.app.assistantWatch.tick()).callsUsed).toBe(0);
    clock.advance(6 * MIN);
    expect((await h.app.assistantWatch.tick()).callsUsed).toBeGreaterThan(0);
    h.close();
  });

  it('charges a failed request like any other', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    reader.failWith.set('issues', new WatchReadError('unavailable'));
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(1);
    expect(h.store.assistantWatch.callsSince('2026-10-13T00:00')).toBe(1);
    h.close();
  });

  it('blocks every surface of a repository that was renamed or transferred', async () => {
    const { h, reader } = boot();
    const id = target(h);
    for (const s of ['default_branch', 'issues', 'pulls'] as const) checkpoint(h, id, s, 'imported', s === 'default_branch' ? 'main' : SINCE);
    reader.failWith.set('repository', new WatchReadError('identity_changed'));
    await h.app.assistantWatch.tick();
    for (const s of ['default_branch', 'issues', 'pulls'] as const) {
      expect(cp(h, id, s).blockedReason).toBe('identity_changed');
    }
    h.close();
  });

  it('unmonitors a repository the provider no longer shows, and keeps its row', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'default_branch', 'imported', 'main');
    reader.failWith.set('repository', new WatchReadError('not_found'));
    await h.app.assistantWatch.tick();
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')).toMatchObject({
      state: 'cancelled', cancelReason: 'not_found',
    });
    h.close();
  });

  it('does NOT unmonitor on a not-found from any other surface', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'issues', 'imported', SINCE);
    reader.failWith.set('issues', new WatchReadError('not_found'));
    await h.app.assistantWatch.tick();
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!.state).toBe('active');
    expect(cp(h, id, 'issues')).toMatchObject({ lastError: 'not_found', cursor: SINCE });
    h.close();
  });

  it('refuses an oversized pull request page as malformed and advances nothing', async () => {
    const { h, reader } = boot();
    reader.pageSize = 11;
    const id = target(h);
    checkpoint(h, id, 'pulls', 'imported', SINCE);
    reader.pullsBy.set('acme/widgets', Array.from({ length: 11 }, (_, i) => ({
      number: i + 1, title: 't', state: 'open' as const, createdAt: at(1), updatedAt: at(12), mergedAt: null, closedAt: null,
    })));
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'pulls')).toMatchObject({ lastError: 'malformed', cursor: SINCE });
    h.close();
  });
});

describe('the default branch', () => {
  it('is learned once, for the whole pass, and remembered on the target', async () => {
    const { h, reader } = boot();
    const id = target(h, 'acme/widgets', null);
    checkpoint(h, id, 'commits', 'imported', SINCE);
    reader.repoBy.set('acme/widgets', { defaultBranch: 'trunk' });
    reader.commitsBy.set('acme/widgets', [{ sha: 'c1', committedAt: at(12), subject: 's' }]);
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(2);
    expect(reader.log).toEqual(['repository:acme/widgets', 'commits:acme/widgets:1']);
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!.defaultBranch).toBe('trunk');
    h.close();
  });

  it('records the facts a poll cycle filters by when the metadata surface is read', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'default_branch', 'imported', 'main');
    reader.repoBy.set('acme/widgets', { defaultBranch: 'main', archived: true, fork: true, pushedAt: at(12) });
    await h.app.assistantWatch.tick();
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')).toMatchObject({
      archived: true, fork: true, pushedAt: at(12), defaultBranch: 'main',
    });
    h.close();
  });

  it('announces a changed default branch once', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'default_branch', 'imported', 'main');
    reader.repoBy.set('acme/widgets', { defaultBranch: 'trunk' });
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['default:main->trunk']);
    h.close();
  });
});

describe('every unit stays far inside the tick budget', () => {
  it('never spends more than the per-tick ceiling, whatever is due', async () => {
    const { h, reader } = boot();
    for (let i = 0; i < 30; i += 1) {
      const id = target(h, `acme/r${i}`);
      checkpoint(h, id, 'issues', 'imported', SINCE);
    }
    reader.pageSize = 10;
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(ASSISTANT_WATCH_CALLS_PER_TICK);
    expect(reader.calls).toBe(ASSISTANT_WATCH_CALLS_PER_TICK);
    h.close();
  });
});
