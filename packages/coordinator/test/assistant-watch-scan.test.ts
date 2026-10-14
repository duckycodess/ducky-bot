import { describe, expect, it } from 'vitest';
import { EMPTY_SCAN, keyOf, parseScan, serializeScan, windowHeldStill } from '../src/domain/assistant-watch.scan.js';
import { deriveIssues, deriveReleases, deriveRuns, windowThresholdMs } from '../src/domain/assistant-watch.engine.js';

describe('windowHeldStill', () => {
  const page = ['a', 'b', 'c', 'd'];
  it('accepts an identical page', () => expect(windowHeldStill(page, [...page])).toBe(true));
  it('accepts the page shifted down by insertions, its tail pushed off', () => {
    expect(windowHeldStill(page, ['x', 'a', 'b', 'c'])).toBe(true);
    expect(windowHeldStill(page, ['x', 'y', 'a', 'b'])).toBe(true);
  });
  it('rejects a deletion above, which slides the next page up', () => {
    expect(windowHeldStill(page, ['b', 'c', 'd', 'e'])).toBe(false);
  });
  it('rejects a change of the first item with the rest intact', () => {
    expect(windowHeldStill(page, ['z', 'b', 'c', 'd'])).toBe(false);
  });
  it('rejects a page of entirely new items, which cannot be told from a replacement', () => {
    expect(windowHeldStill(page, ['w', 'x', 'y', 'z'])).toBe(false);
  });
  it('rejects a deletion paired with an insertion that keeps the length', () => {
    expect(windowHeldStill(page, ['x', 'b', 'c', 'd'])).toBe(false);
  });
  it('treats an empty page on either side as holding still: nothing can have slid past it', () => {
    expect(windowHeldStill([], ['a'])).toBe(true);
    expect(windowHeldStill(page, [])).toBe(true);
  });
});

describe('scan state', () => {
  it('round-trips, and treats anything unreadable as a fresh read', () => {
    const s = { v: 1 as const, last: { page: 2, keys: ['a'] }, verify: true };
    expect(parseScan(serializeScan(s))).toEqual(s);
    expect(parseScan(null)).toBe(EMPTY_SCAN);
    expect(parseScan('not json')).toBe(EMPTY_SCAN);
    expect(parseScan('{"v":2}')).toBe(EMPTY_SCAN);
  });

  it('keys updated-sorted lists by their update time and creation-sorted ones by identity alone', () => {
    expect(keyOf({ kind: 'pull', number: 1, updatedAt: 't' })).not.toBe(keyOf({ kind: 'pull', number: 1, updatedAt: 'u' }));
    expect(keyOf({ kind: 'run', id: '9' })).toBe(keyOf({ kind: 'run', id: '9' }));
  });
});

describe('the window thresholds', () => {
  const t = (iso: string) => Date.parse(iso);
  it('is the cursor, or the oldest unsettled creation time when that is older', () => {
    expect(windowThresholdMs(null, 5)).toBeNull();
    expect(windowThresholdMs(10, null)).toBe(10);
    expect(windowThresholdMs(10, 4)).toBe(4);
    expect(windowThresholdMs(10, 40)).toBe(10);
  });

  it('closes a runs window only on an item created at or before the threshold', () => {
    const run = (id: string, created: string) => ({
      id, name: 'b', branch: 'main', status: 'completed', conclusion: 'success', createdAt: created, updatedAt: created,
    });
    const since = t('2026-10-12T00:00:00Z');
    const items = [run('2', '2026-10-12T05:00:00Z'), run('1', '2026-10-11T00:00:00Z')];
    expect(deriveRuns(items.slice(0, 1), since, false).reachedCursor).toBe(false);
    expect(deriveRuns(items, since, false).reachedCursor).toBe(true);
    // A floor older than the cursor keeps the window open past an item that would close it.
    expect(deriveRuns(items, since, false, false, t('2026-10-10T00:00:00Z')).reachedCursor).toBe(false);
  });

  it('closes a releases window the same way and ignores drafts as events', () => {
    const rel = (id: string, created: string, draft: boolean, published: string | null) => ({
      id, tag: id, name: id, draft, createdAt: created, publishedAt: published,
    });
    const since = t('2026-10-12T00:00:00Z');
    const r = deriveReleases([rel('d', '2026-10-13T00:00:00Z', true, null)], since);
    expect(r.events).toEqual([]);
    expect(r.unsettledFloorMs).toBe(t('2026-10-13T00:00:00Z'));
    expect(r.reachedCursor).toBe(false);
  });

  it('closes an issues window from the shared sort key even with no issue on the page', () => {
    const since = t('2026-10-12T00:00:00Z');
    expect(deriveIssues([], since, false, '2026-10-11T00:00:00Z').reachedCursor).toBe(true);
    expect(deriveIssues([], since, false, '2026-10-13T00:00:00Z').reachedCursor).toBe(false);
    expect(deriveIssues([], null, false, '2026-10-11T00:00:00Z').reachedCursor).toBe(false);
  });
});
