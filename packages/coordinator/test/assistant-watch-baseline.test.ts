import { describe, expect, it } from 'vitest';
import { ASSISTANT_WATCH_CALLS_PER_TICK, type WatchSurface } from '@ducky/contracts';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { parseScan } from '../src/domain/assistant-watch.scan.js';
import { WatchReadError } from '../src/domain/assistant-watch.reader.js';
import { deriveReleases, deriveRuns, secondBoundaryMs } from '../src/domain/assistant-watch.engine.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * The first observation of runs and releases (ADR 0031, "the baseline boundary").
 *
 * A NEW baseline is frozen at a boundary taken before its first request, spans the
 * whole bounded inventory, and commits exactly that boundary, so a transition that
 * happens while later pages are still being read is announced by the next ordinary
 * pass and nothing before the boundary ever is. Driven through the real service,
 * store and transport with a scripted reader. Invented data only; every transition
 * that must be announced is stamped AFTER the baseline began.
 */
const NOW = '2026-10-13T00:00:00.000Z';
/** One millisecond before the second NOW falls in. */
const B = '2026-10-12T23:59:59.999Z';
const MIN = 60_000;
const SINCE = '2026-10-10T00:00:00.000Z';

const boot = (nowIso = NOW) => {
  const clock = new TestClock(nowIso, 'UTC');
  const reader = new FakeWatchReader();
  const h = makeHarness({ clock, assistantWatchReader: reader });
  return { h, clock, reader };
};

let seq = 700;
const target = (h: Harness, defaultBranch: string | null = 'main', key = 'acme/widgets') => {
  seq += 1;
  const id = `b${seq}`;
  h.store.assistantWatch.insertTarget({
    id, publicId: `w${String(seq).padStart(5, '0')}`, discordUserId: OWNER, repoKey: key,
    display: key, defaultBranch, state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
  });
  return id;
};
const checkpoint = (
  h: Harness, id: string, surface: WatchSurface, state: 'unbaselined' | 'imported' | 'ready', cursor: string | null,
) => h.store.assistantWatch.insertCheckpoint({
  targetId: id, surface, state, cursor, nextDueAt: NOW, updatedAt: NOW,
});
const cp = (h: Harness, id: string, surface: WatchSurface) => h.store.assistantWatch.checkpoint(id, surface)!;
const events = (h: Harness, id: string) => h.store.assistantWatch.eventsFor(id);
/** A baseline's identity marker: observed, empty payload, settled at birth. Dedupe state, never news. */
const isMarker = (e: ReturnType<typeof events>[number]) =>
  e.origin === 'observed' && e.payloadJson === '{}' && e.alertedAt === e.createdAt && e.digestedAt === e.createdAt;
const news = (h: Harness, id: string) => events(h, id).filter((e) => !isMarker(e));
const markers = (h: Harness, id: string) => events(h, id).filter(isMarker).map((e) => e.identity).sort();
const ids = (h: Harness, id: string) => news(h, id).map((e) => e.identity).sort();

const run = (id: string, created: string, status: string, conclusion: string | null, updated = created) => ({
  id, name: 'build', branch: 'main', status, conclusion, createdAt: created, updatedAt: updated,
});
const rel = (id: string, created: string | null, published: string | null, draft = false) => ({
  id, tag: `v${id}`, name: `Rel ${id}`, draft, publishedAt: published, createdAt: created,
});
const at = (day: number, hour = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const AFTER = (minutes: number, seconds = 0) =>
  `2026-10-13T00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}Z`;

describe('the boundary is the second before the first request, never the newest time seen', () => {
  it('floors to the second and takes one millisecond off', () => {
    expect(secondBoundaryMs(Date.parse('2026-10-13T00:00:00.000Z'))).toBe(Date.parse(B));
    expect(secondBoundaryMs(Date.parse('2026-10-13T00:00:00.750Z'))).toBe(Date.parse(B));
    expect(secondBoundaryMs(Date.parse('2026-10-13T00:00:01.000Z'))).toBe(Date.parse('2026-10-13T00:00:00.999Z'));
  });

  it('commits the boundary on a one-page baseline, with no events and a strict boundary', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 10), 'in_progress', null, at(12, 12)),
      run('1', at(12, 9), 'completed', 'failure', at(12, 20)),
    ]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B, boundaryKnown: false, pendingState: null });
    expect(news(h, id)).toEqual([]);
    // Run 2 was already underway: its start is recorded as known, silently, with no text.
    expect(markers(h, id)).toEqual(['2:ci_started']);
    expect(events(h, id).every((e) => e.payloadJson === '{}' && !e.held)).toBe(true);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);
    h.close();
  });

  it('keeps a same-second event on the announced side', async () => {
    const { h, clock, reader } = boot('2026-10-13T00:00:00.600Z');
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [run('1', at(12, 9), 'completed', 'success')]);
    await h.app.assistantWatch.tick();
    // The provider stamps whole seconds: 00:00:00 is the second the baseline began in.
    reader.runsBy.set('acme/widgets', [run('2', '2026-10-13T00:00:00Z', 'completed', 'failure')]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['2:ci_failed']);
    h.close();
  });

  it('never delivers history, only what moved after the boundary, exactly once', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 10), 'completed', 'failure', at(12, 11)),
      run('1', at(12, 9), 'completed', 'failure', at(12, 9)),
    ]);
    await h.app.assistantWatch.tick();
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(events(h, id)).toEqual([]);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);
    h.close();
  });
});

describe('a transition while a multi-page baseline is read is announced once, by the next pass', () => {
  it('announces an old-created run that settled before its page was read', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [
      run('3', at(12, 20), 'completed', 'success'),
      run('2', at(12, 12), 'completed', 'success'),
      run('1', at(12, 9), 'in_progress', null),
    ]);
    let settled = false;
    reader.hook = (method, _ref, page) => {
      if (method !== 'runs' || page !== 3 || settled) return;
      settled = true; // run 1 concludes after page 1 was read and before page 3 is
      clock.advance(30_000);
      reader.runsBy.set('acme/widgets', [
        run('3', at(12, 20), 'completed', 'success'),
        run('2', at(12, 12), 'completed', 'success'),
        run('1', at(12, 9), 'completed', 'failure', AFTER(0, 30)),
      ]);
    };
    const first = await h.app.assistantWatch.tick();
    // Three pages and the last page re-read, nothing more.
    expect(reader.log).toEqual([
      'runs:acme/widgets:1', 'runs:acme/widgets:2', 'runs:acme/widgets:3', 'runs:acme/widgets:3',
    ]);
    expect(first.callsUsed).toBe(4);
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B, scanFloor: '2026-10-12T09:00:00.000Z' });
    expect(events(h, id)).toEqual([]);

    reader.hook = null;
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['1:ci_failed']);
    expect(cp(h, id, 'runs').scanFloor).toBeNull();
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['1:ci_failed']); // exactly once across repeated scans
    h.close();
  });

  it('announces an old-created draft that was published before its page was read', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.pageSize = 1;
    reader.releasesBy.set('acme/widgets', [rel('2', at(12, 1), at(12, 1)), rel('1', at(11), null, true)]);
    let published = false;
    reader.hook = (method, _ref, page) => {
      if (method !== 'releases' || page !== 2 || published) return;
      published = true;
      clock.advance(30_000);
      reader.releasesBy.set('acme/widgets', [rel('2', at(12, 1), at(12, 1)), rel('1', at(11), AFTER(0, 30))]);
    };
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'releases')).toMatchObject({ state: 'ready', cursor: B, scanFloor: '2026-10-11T00:00:00.000Z' });
    expect(events(h, id)).toEqual([]);
    reader.hook = null;
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['release:1']);
    expect(cp(h, id, 'releases').scanFloor).toBeNull();
    h.close();
  });

  it('does not announce the start of a run that was already running at the boundary', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [run('2', at(12, 9), 'in_progress', null, at(12, 9))]);
    await h.app.assistantWatch.tick();
    // It progresses (a newer update stamp) and a genuinely new run starts.
    reader.runsBy.set('acme/widgets', [
      run('9', AFTER(12), 'in_progress', null),
      run('2', at(12, 9), 'in_progress', null, AFTER(10)),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['9:ci_started']);
    expect(markers(h, id)).toEqual(['2:ci_started']);
    reader.runsBy.set('acme/widgets', [
      run('9', AFTER(12), 'in_progress', null),
      run('2', at(12, 9), 'completed', 'failure', AFTER(20)),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['2:ci_failed', '9:ci_started']);
    h.close();
  });
});

describe('the boundary survives every retry', () => {
  it('survives a failure on the very first request, before anything was saved', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [run('1', at(12, 9), 'completed', 'success')]);
    reader.failNext.add('runs');
    const first = await h.app.assistantWatch.tick();
    expect(first.failed).toBe(1);
    // The marker was written before the request: nothing about it depends on a success.
    expect(cp(h, id, 'runs')).toMatchObject({ cursor: null, failures: 1, pendingCursor: B });
    expect(parseScan(cp(h, id, 'runs').pendingState).baseline?.boundaryMs).toBe(Date.parse(B));

    // A run starts and fails AFTER the original boundary, before the retry's own time.
    reader.runsBy.set('acme/widgets', [run('2', AFTER(10), 'completed', 'failure'), run('1', at(12, 9), 'completed', 'success')]);
    clock.advance(40 * MIN);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B, failures: 0 });
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['2:ci_failed']);
    h.close();
  });

  it('survives a failure of the repository metadata read that precedes the first list request', async () => {
    const { h, clock, reader } = boot();
    const id = target(h, null); // the default branch is unknown, so the metadata read comes first
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.failNext.add('repository');
    const first = await h.app.assistantWatch.tick();
    expect(first.failed).toBe(1);
    expect(reader.log).toEqual(['repository:acme/widgets']);
    expect(parseScan(cp(h, id, 'runs').pendingState).baseline?.boundaryMs).toBe(Date.parse(B));

    reader.runsBy.set('acme/widgets', [run('2', AFTER(10), 'completed', 'failure')]);
    clock.advance(40 * MIN);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs').cursor).toBe(B);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['2:ci_failed']);
    h.close();
  });

  it('survives a failed later page and resumes at that page with the same boundary', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [run('2', at(12, 12), 'completed', 'success'), run('1', at(12, 9), 'completed', 'success')]);
    reader.failNth.set('runs', 2);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ cursor: null, pendingPage: 1, failures: 1 });
    clock.advance(40 * MIN);
    reader.log.length = 0;
    await h.app.assistantWatch.tick();
    expect(reader.log[0]).toBe('runs:acme/widgets:2');
    expect(cp(h, id, 'runs').cursor).toBe(B);
    h.close();
  });

  it('keeps the ORIGINAL boundary and the floor so far across a drift restart', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    const list = [
      run('3', at(12, 20), 'completed', 'success'),
      run('2', at(12, 12), 'in_progress', null),
      run('1', at(12, 9), 'completed', 'success'),
    ];
    reader.runsBy.set('acme/widgets', list);
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'runs') return;
      n += 1;
      if (n === 4) reader.runsBy.set('acme/widgets', list.slice(1)); // run 3 vanishes before the re-read
    };
    const first = await h.app.assistantWatch.tick();
    expect(first.failed).toBe(1);
    const pending = cp(h, id, 'runs');
    expect(pending).toMatchObject({ cursor: null, lastError: 'window_unstable', pendingPage: 0, pendingCursor: null });
    // Only the boundary and the creation floor so far survive; nothing positional does.
    expect(parseScan(pending.pendingState)).toEqual({
      v: 1, baseline: { boundaryMs: Date.parse(B) }, floorMs: Date.parse('2026-10-12T12:00:00Z'),
    });

    // Run 2 concludes after the ORIGINAL boundary but before the retry starts.
    reader.hook = null;
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 12), 'completed', 'failure', AFTER(5)), run('1', at(12, 9), 'completed', 'success'),
    ]);
    clock.advance(40 * MIN);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B });
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['2:ci_failed']);
    h.close();
  });

  it('restarts a shrunk runs total the same way, keeping the boundary', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [run('2', at(12, 12), 'completed', 'success'), run('1', at(12, 9), 'completed', 'success')]);
    reader.runsTotalOverride = 2;
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'runs') return;
      n += 1;
      if (n === 2) reader.runsTotalOverride = 1;
    };
    await h.app.assistantWatch.tick();
    const c = cp(h, id, 'runs');
    expect(c).toMatchObject({ cursor: null, lastError: 'window_unstable', pendingPage: 0 });
    expect(parseScan(c.pendingState).baseline?.boundaryMs).toBe(Date.parse(B));
    h.close();
  });
});

describe('a failure after the boundary was written persists against the NEW version', () => {
  // The checkpoint's own version is older than the clock here. When both are equal a
  // stale version still matches the row, which is how a wrong version once went unseen.
  const OLD = '2026-10-12T00:00:00.000Z';
  const older = (h: Harness, id: string, surface: WatchSurface) => h.store.assistantWatch.insertCheckpoint({
    targetId: id, surface, state: 'unbaselined', cursor: null, nextDueAt: NOW, updatedAt: OLD,
  });
  const expectRecorded = (h: Harness, id: string, surface: WatchSurface, code: string) => {
    const c = cp(h, id, surface);
    expect(c).toMatchObject({
      state: 'unbaselined', cursor: null, failures: 1, lastError: code, pendingCursor: B, updatedAt: NOW,
      nextDueAt: '2026-10-13T00:15:00.000Z', // one interval of backoff from the failure
    });
    expect(parseScan(c.pendingState).baseline?.boundaryMs).toBe(Date.parse(B));
    expect(h.store.assistantWatch.callsSince('2026-10-13T00:00')).toBe(1); // the failed request was charged
  };

  it('records a failed first runs request: failure count, error, backoff, charge, same boundary', async () => {
    const { h, reader } = boot();
    const id = target(h);
    older(h, id, 'runs');
    reader.failNext.add('runs');
    const out = await h.app.assistantWatch.tick();
    expect(out).toMatchObject({ failed: 1, callsUsed: 1 });
    expectRecorded(h, id, 'runs', 'read_failed');
    h.close();
  });

  it('records a failed repository metadata read that precedes the first list request', async () => {
    const { h, reader } = boot();
    const id = target(h, null);
    older(h, id, 'runs');
    reader.failNext.add('repository');
    const out = await h.app.assistantWatch.tick();
    expect(out).toMatchObject({ failed: 1, callsUsed: 1 });
    expect(reader.log).toEqual(['repository:acme/widgets']);
    expectRecorded(h, id, 'runs', 'read_failed');
    h.close();
  });

  it('records a failed first releases request the same way', async () => {
    const { h, reader } = boot();
    const id = target(h);
    older(h, id, 'releases');
    reader.failNext.add('releases');
    await h.app.assistantWatch.tick();
    expectRecorded(h, id, 'releases', 'read_failed');
    h.close();
  });

  it('records a typed failure (rate limit) and still keeps the boundary for the retry', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    older(h, id, 'runs');
    reader.failWith.set('runs', new WatchReadError('rate_limited'));
    await h.app.assistantWatch.tick();
    expectRecorded(h, id, 'runs', 'rate_limited');
    reader.runsBy.set('acme/widgets', [run('2', AFTER(10), 'completed', 'failure')]);
    clock.advance(40 * MIN);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B, failures: 0, lastError: null });
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['2:ci_failed']);
    h.close();
  });

  it('requests and charges nothing when the pre-write loses a race, and the unit is simply picked again', async () => {
    const { h, reader } = boot();
    const id = target(h);
    older(h, id, 'runs');
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [run('1', at(12, 9), 'completed', 'success')]);
    // Something else moves the checkpoint after it was selected as due: our first write loses.
    const repo = h.store.assistantWatch;
    const real = repo.savePending.bind(repo);
    let lost = false;
    repo.savePending = ((input: Parameters<typeof real>[0]) => {
      if (!lost) {
        lost = true;
        real({ ...input, pendingCursor: SINCE, atIso: '2026-10-12T12:00:00.000Z' }); // the other writer
        return false;
      }
      return real(input);
    }) as typeof real;
    const out = await h.app.assistantWatch.tick();
    expect(out.incomplete).toBeGreaterThanOrEqual(1);
    expect(reader.log).toEqual(['runs:acme/widgets:1']); // exactly one request, for the retried unit
    expect(out.callsUsed).toBe(1);
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B });
    h.close();
  });

  it('ends the tick instead of spinning on a unit it can never write', async () => {
    const { h, reader } = boot();
    const id = target(h);
    older(h, id, 'runs');
    reader.runsBy.set('acme/widgets', [run('1', at(12, 9), 'completed', 'success')]);
    h.store.assistantWatch.savePending = (() => false) as typeof h.store.assistantWatch.savePending;
    const out = await h.app.assistantWatch.tick(); // would never return without the guard
    expect(out.callsUsed).toBe(0);
    expect(reader.log).toEqual([]);
    expect(cp(h, id, 'runs')).toMatchObject({ cursor: null });
    h.close();
  });
});

describe('saved state and adoption', () => {
  it('restarts a null-cursor read that has progress but no marker, and writes the marker first', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [run('1', at(12, 9), 'completed', 'success')]);
    // Progress written by code that had no marker: page 2 next, a last page to compare.
    h.store.assistantWatch.savePending({
      targetId: id, surface: 'runs', expectedUpdatedAt: NOW, pendingCursor: at(12, 20), pendingPage: 2,
      pendingState: JSON.stringify({ v: 1, last: { page: 2, keys: ['r9'] }, verify: true }), nextDueAt: NOW, atIso: NOW,
    });
    await h.app.assistantWatch.tick();
    expect(reader.log[0]).toBe('runs:acme/widgets:1');
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B });
    h.close();
  });

  it('resets positional progress, not only the marker, when a marker meets a real cursor', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'imported', SINCE);
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 12), 'completed', 'failure'), run('1', at(11, 9), 'completed', 'failure'),
    ]);
    h.store.assistantWatch.savePending({
      targetId: id, surface: 'runs', expectedUpdatedAt: NOW, pendingCursor: B, pendingPage: 1,
      pendingState: JSON.stringify({ v: 1, baseline: { boundaryMs: Date.parse(B) }, last: { page: 1, keys: ['r2'] }, verify: true }),
      nextDueAt: NOW, atIso: NOW,
    });
    await h.app.assistantWatch.tick();
    // It starts at page ONE; it neither skips what the dead marker called read nor verifies a phantom page.
    expect(reader.log[0]).toBe('runs:acme/widgets:1');
    expect(ids(h, id)).toEqual(['1:ci_failed', '2:ci_failed']);
    h.close();
  });

  it('adoption of an unbaselined checkpoint drops a half-read baseline, and the source cursor reconciles', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 12), 'completed', 'failure'), run('1', at(12, 9), 'completed', 'success'),
    ]);
    reader.failNth.set('runs', 2);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ pendingPage: 1 });

    const adopted = h.store.assistantWatch.adoptCheckpoint(id, 'runs', SINCE, NOW, NOW);
    expect(adopted).toBe(true);
    expect(cp(h, id, 'runs')).toMatchObject({
      state: 'imported', cursor: SINCE, boundaryKnown: false, pendingPage: 0, pendingCursor: null, pendingState: null,
    });
    // What was on the page already read is reconciled from the source cursor, not skipped.
    clock.advance(40 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toContain('2:ci_failed');
    h.close();
  });

  it('parses state saved before the marker existed, and drops a marker that is not a time', () => {
    expect(parseScan(JSON.stringify({ v: 1, floorMs: 5, last: { page: 1, keys: ['a'] } })).baseline).toBeUndefined();
    expect(parseScan(JSON.stringify({ v: 1, baseline: { boundaryMs: 7 } })).baseline).toEqual({ boundaryMs: 7 });
    expect(parseScan(JSON.stringify({ v: 1, baseline: { boundaryMs: 'x' }, floorMs: 5 }))).toEqual({ v: 1, floorMs: 5 });
    expect(parseScan(JSON.stringify({ v: 1, baseline: 3 })).baseline).toBeUndefined();
  });
});

describe('capacity: a first observation reads the bounded inventory or refuses visibly', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => run(String(n - i), at(12, 1), 'completed', 'success'));

  it('proves an inventory of at most 99 runs: ten pages, then commits the boundary', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.cardinalityHasMore = true; // as the real reader: a full page might have a successor
    reader.runsBy.set('acme/widgets', many(99));
    reader.runsTotalOverride = 50; // an understated total never ends or refuses a window by itself
    const out = await h.app.assistantWatch.tick();
    expect(reader.log.length).toBe(11); // ten pages and the last page re-read
    expect(out.callsUsed).toBe(11);
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B });
    h.close();
  });

  it('refuses a full tenth page, since a page of ten cannot be told from a longer list', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.cardinalityHasMore = true;
    reader.runsBy.set('acme/widgets', many(100));
    reader.runsTotalOverride = 50; // so only the page cap can refuse
    await h.app.assistantWatch.tick();
    expect(reader.log.length).toBe(10);
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'unbaselined', cursor: null, blockedReason: 'window_exceeded' });
    expect(h.store.assistantWatch.checkpoint(id, 'ci_state')).toBeUndefined();
    expect(h.store.assistantWatch.observes(OWNER, 'acme/widgets', 'runs')).toBe(false);
    expect(events(h, id)).toEqual([]);
    h.close();
  });

  it('refuses early, on page one, when the provider total already fills the inventory', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', many(30));
    reader.runsTotalOverride = 100;
    const out = await h.app.assistantWatch.tick();
    expect(reader.log).toEqual(['runs:acme/widgets:1']);
    expect(out.callsUsed).toBe(1);
    expect(cp(h, id, 'runs')).toMatchObject({ cursor: null, blockedReason: 'window_exceeded' });
    expect(h.store.assistantWatch.observes(OWNER, 'acme/widgets', 'runs')).toBe(false);
    h.close();
  });

  it('refuses a release list whose tenth page is full, leaving the cursor null', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.pageSize = 10;
    reader.cardinalityHasMore = true;
    reader.releasesBy.set('acme/widgets', Array.from({ length: 100 }, (_, i) => rel(String(i), at(1), at(1))));
    await h.app.assistantWatch.tick();
    expect(reader.log.length).toBe(10);
    expect(cp(h, id, 'releases')).toMatchObject({ cursor: null, blockedReason: 'window_exceeded' });
    h.close();
  });

  it('blocks a steady-state floor deeper than the page cap, keeping cursor, floor and held events', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'ready', SINCE);
    h.store.assistantWatch.commitObservation({
      targetId: id, surface: 'runs', expectedUpdatedAt: NOW, cursor: SINCE, nextDueAt: NOW, atIso: NOW,
      events: [], scanFloor: '2026-10-01T00:00:00.000Z',
    });
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', Array.from({ length: 150 }, (_, i) =>
      run(String(1000 - i), at(12, 1), 'completed', 'failure')));
    reader.runsTotalOverride = 150;
    await h.app.assistantWatch.tick();
    const c = cp(h, id, 'runs');
    expect(c).toMatchObject({ cursor: SINCE, scanFloor: '2026-10-01T00:00:00.000Z', blockedReason: 'window_exceeded' });
    expect(events(h, id).length).toBeGreaterThan(0);
    expect(events(h, id).every((e) => e.held)).toBe(true);
    h.close();
  });

  it('refuses a draft with no usable creation time, never skipping it', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.pageSize = 10;
    reader.releasesBy.set('acme/widgets', [rel('1', null, null, true)]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'releases')).toMatchObject({ cursor: null, blockedReason: 'release_untrackable' });
    clock.advance(1);
    h.close();
  });

  it('refuses it on a steady-state pass too, leaving the committed cursor alone', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'imported', SINCE);
    reader.pageSize = 10;
    reader.releasesBy.set('acme/widgets', [rel('1', null, null, true)]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'releases')).toMatchObject({ cursor: SINCE, blockedReason: 'release_untrackable' });
    h.close();
  });

  it('keeps every call inside the per-tick bound across a mass first observation', async () => {
    const { h, reader } = boot();
    reader.pageSize = 10;
    for (let i = 0; i < 12; i += 1) {
      const key = `acme/repo${i}`;
      checkpoint(h, target(h, 'main', key), 'runs', 'unbaselined', null);
      reader.runsBy.set(key, many(60));
    }
    const out = await h.app.assistantWatch.tick();
    // Twelve targets of seven requests each would be 84: the tick stops at its ceiling,
    // and every baseline resumes (its boundary is durable) on the ticks after it.
    expect(out.callsUsed).toBe(ASSISTANT_WATCH_CALLS_PER_TICK);
    expect(out.incomplete).toBeGreaterThan(0);
    h.close();
  });
});

describe('the other surfaces keep their one-page first look', () => {
  it('reads one page of pull requests and commits the newest time it saw', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'pulls', 'unbaselined', null);
    reader.pageSize = 1;
    reader.pullsBy.set('acme/widgets', [
      { number: 2, title: 'two', state: 'open', createdAt: at(1), updatedAt: at(12, 3), mergedAt: null, closedAt: null },
      { number: 1, title: 'one', state: 'open', createdAt: at(1), updatedAt: at(11), mergedAt: null, closedAt: null },
    ]);
    await h.app.assistantWatch.tick();
    expect(reader.log).toEqual(['pulls:acme/widgets:1']);
    expect(cp(h, id, 'pulls')).toMatchObject({ state: 'ready', cursor: '2026-10-12T03:00:00.000Z' });
    h.close();
  });
});

describe('the derivations', () => {
  const T = Date.parse('2026-10-12T10:00:00Z');

  it('closes a creation-sorted window only STRICTLY before the threshold', () => {
    const a = run('a', '2026-10-12T10:00:00Z', 'completed', 'success');
    const earlier = run('b', '2026-10-12T09:59:59Z', 'completed', 'success');
    expect(deriveRuns([a], T, false).reachedCursor).toBe(false);
    expect(deriveRuns([a, earlier], T, false).reachedCursor).toBe(true);
    const r = rel('a', '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z');
    expect(deriveReleases([r], T).reachedCursor).toBe(false);
    expect(deriveReleases([rel('b', '2026-10-12T09:59:59Z', '2026-10-12T09:59:59Z')], T).reachedCursor).toBe(true);
  });

  it('finds an unsettled item in the SAME second on the next page, which equality would have skipped', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'ready', '2026-10-12T10:00:00.000Z');
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [
      run('A', '2026-10-12T10:00:00Z', 'completed', 'success'),
      run('R', '2026-10-12T10:00:00Z', 'completed', 'failure', '2026-10-12T11:00:00Z'),
    ]);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toContain('R:ci_failed');
    h.close();
  });

  it('announces a start from an UPDATE after the cursor, whatever the run\'s creation time', () => {
    const lateInserted = run('1', '2026-10-12T09:00:00Z', 'in_progress', null, '2026-10-12T10:30:00Z');
    expect(deriveRuns([lateInserted], T, false).events.map((e) => e.kind)).toEqual(['ci_started']);
    const fresh = run('2', '2026-10-12T10:30:00Z', 'queued', null);
    expect(deriveRuns([fresh], T, false).events.map((e) => e.kind)).toEqual(['ci_started']);
  });

  it('names the runs already underway at a baseline boundary, and nothing outside a baseline', () => {
    const items = [
      run('3', '2026-10-13T00:00:30Z', 'queued', null), // created after the boundary: a real start
      run('2', '2026-10-12T09:00:00Z', 'in_progress', null),
      run('1', '2026-10-12T08:00:00Z', 'completed', 'success'),
    ];
    expect(deriveRuns(items, null, false, false, null, Date.parse(B)).underwayIds).toEqual(['2']);
    expect(deriveRuns(items, T, false).underwayIds).toEqual([]);
  });

  it('announces the start of a run inserted late, once, when an older run carried the cursor past its creation', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'imported', '2026-10-12T12:00:00.000Z');
    reader.pageSize = 10;
    // Pass one sees only the older run, which concluded at 13:00 and carries the cursor there.
    reader.runsBy.set('acme/widgets', [run('O', '2026-10-12T08:00:00Z', 'completed', 'failure', '2026-10-12T13:00:00Z')]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs').cursor).toBe('2026-10-12T13:00:00.000Z');
    // Run Q was created at 12:30 (before that cursor), was not listed yet, and progresses at 13:30.
    reader.runsBy.set('acme/widgets', [
      run('Q', '2026-10-12T12:30:00Z', 'in_progress', null, '2026-10-12T13:30:00Z'),
      run('O', '2026-10-12T08:00:00Z', 'completed', 'failure', '2026-10-12T13:00:00Z'),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['O:ci_failed', 'Q:ci_started']); // each exactly once
    h.close();
  });

  it('caps a draft at the start of the read second so a same-second publication is still news', async () => {
    const { h, clock, reader } = boot('2026-10-13T00:00:00.500Z');
    const id = target(h);
    checkpoint(h, id, 'releases', 'imported', SINCE);
    reader.pageSize = 10;
    reader.releasesBy.set('acme/widgets', [
      rel('2', at(12, 20), '2026-10-13T00:00:00Z'), rel('1', at(11), null, true),
    ]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'releases').cursor).toBe(B);
    // The draft is published in the very second the pass read it in.
    reader.releasesBy.set('acme/widgets', [
      rel('2', at(12, 20), '2026-10-13T00:00:00Z'), rel('1', at(11), '2026-10-13T00:00:00Z'),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['release:1', 'release:2']);
    h.close();
  });
});

describe('a release whose place is unknown cannot be tracked, so it is refused visibly', () => {
  it('refuses a published release with no creation time that was published after the boundary', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.pageSize = 1;
    reader.releasesBy.set('acme/widgets', [
      rel('3', at(12, 3), at(12, 3)), rel('2', at(12, 2), at(12, 2)), rel('1', null, at(11)),
    ]);
    let published = false;
    reader.hook = (method, _ref, page) => {
      if (method !== 'releases' || page !== 3 || published) return;
      published = true; // the page-three release (no creation time) is published after page one was read
      clock.advance(30_000);
      reader.releasesBy.set('acme/widgets', [
        rel('3', at(12, 3), at(12, 3)), rel('2', at(12, 2), at(12, 2)), rel('1', null, AFTER(0, 30)),
      ]);
    };
    const out = await h.app.assistantWatch.tick();
    // Committing here would let the next window close on page one and never reach it.
    expect(cp(h, id, 'releases')).toMatchObject({
      state: 'unbaselined', cursor: null, blockedReason: 'release_untrackable',
    });
    expect(out.blocked).toBe(1);
    expect(news(h, id)).toEqual([]);
    h.close();
  });

  it('does not refuse a published release with no creation time that predates the boundary', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.pageSize = 10;
    reader.releasesBy.set('acme/widgets', [rel('1', null, at(11))]);
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'releases')).toMatchObject({ state: 'ready', cursor: B });
    h.close();
  });

  it('reports the refusal by count, never by repository', async () => {
    const { h, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'releases', 'unbaselined', null);
    reader.pageSize = 10;
    reader.releasesBy.set('acme/widgets', [rel('1', null, null, true)]);
    await h.app.assistantWatch.tick();
    const line = h.app.assistantWatch.statusLine();
    expect(line).toContain('1 releases surface(s) with a release that cannot be placed');
    expect(line).not.toContain('acme');
    expect(h.store.assistantWatch.blockedCounts(OWNER)).toMatchObject({ releaseUntrackable: 1, windowExceeded: 0 });
    h.close();
  });
});

describe('identity markers for runs already underway at the boundary', () => {
  it('are written only in the baseline commit, silently, with no text, and never announced', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 12), 'in_progress', null), run('1', at(12, 9), 'completed', 'success'),
    ]);
    reader.failNth.set('runs', 2); // page two fails: the baseline is half read
    await h.app.assistantWatch.tick();
    expect(cp(h, id, 'runs')).toMatchObject({ cursor: null, pendingPage: 1 });
    // Nothing is visible, held or settled before the commit.
    expect(events(h, id)).toEqual([]);
    expect(parseScan(cp(h, id, 'runs').pendingState).underway).toEqual(['2']);

    clock.advance(40 * MIN);
    const out = await h.app.assistantWatch.tick();
    expect(markers(h, id)).toEqual(['2:ci_started']);
    expect(events(h, id).every((e) => !e.held && e.payloadJson === '{}')).toBe(true);
    expect(out.alertsSent).toBe(0);
    expect(h.store.assistantWatch.undigested(OWNER, 20)).toEqual([]);
    expect(cp(h, id, 'runs')).toMatchObject({ state: 'ready', cursor: B, pendingState: null });
    // An update after the cursor does not announce what the marker already knows.
    reader.runsBy.set('acme/widgets', [
      run('2', at(12, 12), 'in_progress', null, AFTER(50)), run('1', at(12, 9), 'completed', 'success'),
    ]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(news(h, id)).toEqual([]);
    h.close();
  });

  it('are dropped by a drift restart and recomputed by the pass that commits', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 1;
    const list = [
      run('3', at(12, 20), 'completed', 'success'),
      run('2', at(12, 12), 'in_progress', null),
      run('1', at(12, 9), 'completed', 'success'),
    ];
    reader.runsBy.set('acme/widgets', list);
    let n = 0;
    reader.hook = (method) => {
      if (method !== 'runs') return;
      n += 1;
      if (n === 4) reader.runsBy.set('acme/widgets', list.slice(1));
    };
    await h.app.assistantWatch.tick();
    expect(parseScan(cp(h, id, 'runs').pendingState).underway).toBeUndefined();
    expect(events(h, id)).toEqual([]);
    reader.hook = null;
    clock.advance(40 * MIN);
    await h.app.assistantWatch.tick();
    expect(markers(h, id)).toEqual(['2:ci_started']);
    h.close();
  });

  it('are not written for a run created after the boundary, whose start is real news', async () => {
    const { h, clock, reader } = boot();
    const id = target(h);
    checkpoint(h, id, 'runs', 'unbaselined', null);
    reader.pageSize = 10;
    reader.runsBy.set('acme/widgets', [run('9', AFTER(0, 5), 'in_progress', null)]);
    await h.app.assistantWatch.tick();
    expect(markers(h, id)).toEqual([]);
    clock.advance(16 * MIN);
    await h.app.assistantWatch.tick();
    expect(ids(h, id)).toEqual(['9:ci_started']);
    h.close();
  });
});
