import { describe, expect, it } from 'vitest';
import {
  UnreadableTimestamp, deriveCommits, deriveDefaultBranch, deriveIssues, derivePulls, deriveReleases,
  deriveRuns, pullNeedsReviews, scrubText,
} from '../src/domain/assistant-watch.engine.js';
import type { PullRecord, ReviewRecord } from '../src/domain/assistant-watch.reader.js';

/** The audited boundary rules, one at a time. Invented data only. */
const since = Date.parse('2026-09-10T12:00:00Z');
const T = {
  before: '2026-09-10T11:00:00Z',
  at: '2026-09-10T12:00:00Z',
  after1: '2026-09-10T12:00:01Z',
  after2: '2026-09-11T00:00:00Z',
};
const kinds = (r: { events: readonly { kind: string }[] }) => r.events.map((e) => e.kind);
const ids = (r: { events: readonly { identity: string }[] }) => r.events.map((e) => e.identity);

describe('text that leaves the system', () => {
  it('removes links, addresses and @mentions, and cuts to a length', () => {
    const out = scrubText('Fix by @someone see https://example.com/x and github.com/a/b mail a@b.co  now', 200);
    expect(out).toBe('Fix by see and mail now');
    expect(scrubText('x'.repeat(300), 20)).toHaveLength(20);
    expect(scrubText('ctrl\u0007chars\u0000 here', 50)).toBe('ctrl chars here');
    expect(scrubText(null, 5)).toBe('');
  });
});

describe('commits', () => {
  const c = (sha: string, at: string) => ({ sha, committedAt: at, subject: `${sha} change\nbody` });

  it('treats a commit AT the cursor as already seen', () => {
    const r = deriveCommits([c('n2', T.after2), c('n1', T.after1), c('eq', T.at), c('old', T.before)], since, 'main');
    expect(ids(r)).toEqual(['n2', 'n1']);
    expect(r.reachedCursor).toBe(true);
    expect(r.newestMs).toBe(Date.parse(T.after2));
  });

  it('has not closed its window while every commit is newer than the cursor', () => {
    const r = deriveCommits([c('a', T.after2), c('b', T.after1)], since, 'main');
    expect(r.reachedCursor).toBe(false);
    expect(ids(r)).toEqual(['a', 'b']);
  });

  it('records nothing on a first sight, and still reports how new the newest is', () => {
    const r = deriveCommits([c('a', T.after2), c('b', T.before)], null, 'main');
    expect(r.events).toEqual([]);
    expect(r.newestMs).toBe(Date.parse(T.after2));
  });

  it('keeps only the first line of a message, scrubbed', () => {
    const r = deriveCommits([c('a', T.after1)], since, null);
    expect(r.events[0]!.payload).toEqual({ subject: 'a change' });
  });

  it('refuses a timestamp it cannot read rather than guessing', () => {
    expect(() => deriveCommits([c('a', 'not a time')], since, null)).toThrow(UnreadableTimestamp);
  });
});

describe('pull requests', () => {
  const pr = (over: Partial<PullRecord> & { number: number }): PullRecord => ({
    title: 'Add a thing', state: 'open', createdAt: T.before, updatedAt: T.after1, mergedAt: null, closedAt: null, ...over,
  });
  const no = new Map<number, readonly ReviewRecord[]>();

  it('announces an opened pull request exactly once by identity, not an update of it', () => {
    const r = derivePulls([pr({ number: 7, createdAt: T.after1, updatedAt: T.after1 })], since, no);
    expect(kinds(r)).toEqual(['pr_opened']);
    expect(ids(r)).toEqual(['7:opened']);
  });

  it('calls a pull request that existed before the cursor "updated", with the update time in its identity', () => {
    const r = derivePulls([pr({ number: 8 })], since, no);
    expect(kinds(r)).toEqual(['pr_updated']);
    expect(ids(r)).toEqual([`8:updated:${T.after1}`]);
  });

  it('does not call a closed pull request merely "updated"', () => {
    const r = derivePulls([pr({ number: 9, state: 'closed', closedAt: T.after1 })], since, no);
    expect(kinds(r)).toEqual(['pr_closed']);
  });

  it('separates merged from closed-unmerged', () => {
    const merged = derivePulls([pr({ number: 1, state: 'merged', mergedAt: T.after1, closedAt: T.after1 })], since, no);
    expect(kinds(merged)).toEqual(['pr_merged']);
    const closed = derivePulls([pr({ number: 2, state: 'closed', closedAt: T.after1 })], since, no);
    expect(kinds(closed)).toEqual(['pr_closed']);
  });

  it('skips a pull request last updated at or before the cursor, and says the window is closed', () => {
    const r = derivePulls([pr({ number: 3, updatedAt: T.at })], since, no);
    expect(r.events).toEqual([]);
    expect(r.reachedCursor).toBe(true);
  });

  it('maps review verdicts, ignores a word it does not know, and skips a review at the cursor', () => {
    const reviews = new Map<number, readonly ReviewRecord[]>([[
      4, [
        { id: 'r1', state: 'approved', submittedAt: T.after1, body: '' },
        { id: 'r2', state: 'COMMENTED', submittedAt: T.after1, body: '' },
        { id: 'r3', state: 'DISMISSED', submittedAt: T.after1, body: '' },
        { id: 'r4', state: 'PENDING', submittedAt: T.after1, body: '' },
        { id: 'r5', state: 'APPROVED', submittedAt: T.at, body: '' },
      ],
    ]]);
    const r = derivePulls([pr({ number: 4 })], since, reviews);
    expect(r.events.filter((e) => e.identity.includes(':review:')).map((e) => `${e.identity} ${e.kind}`)).toEqual([
      '4:review:r1 review_approved', '4:review:r2 review_commented', '4:review:r3 review_commented',
    ]);
  });

  it('marks a pending change request from ANY review, even one before the cursor', () => {
    const reviews = new Map<number, readonly ReviewRecord[]>([[
      5, [{ id: 'old', state: 'CHANGES_REQUESTED', submittedAt: T.before, body: 'please fix' }],
    ]]);
    const r = derivePulls([pr({ number: 5 })], since, reviews);
    expect(kinds(r)).toEqual(['pr_updated', 'review_pending']);
    expect(ids(r)).toContain('5:pending');
    // The old review itself is not re-announced.
    expect(ids(r).some((i) => i.includes(':review:'))).toBe(false);
  });

  it('raises the interrupting kind for a new request for changes, with a scrubbed summary', () => {
    const reviews = new Map<number, readonly ReviewRecord[]>([[
      6, [{ id: 'x1', state: 'CHANGES_REQUESTED', submittedAt: T.after1, body: 'Please see https://x.test and ask @bob' }],
    ]]);
    const r = derivePulls([pr({ number: 6 })], since, reviews);
    const e = r.events.find((v) => v.kind === 'review_requested_changes')!;
    expect(e.identity).toBe('6:review:x1');
    expect(e.payload.summary).toBe('Please see and ask');
  });

  it('records nothing on a first sight', () => {
    const r = derivePulls([pr({ number: 7 })], null, no);
    expect(r.events).toEqual([]);
    expect(r.newestMs).toBe(Date.parse(T.after1));
  });

  it('asks for reviews only of an open pull request touched after the cursor', () => {
    expect(pullNeedsReviews(pr({ number: 1 }), since)).toBe(true);
    expect(pullNeedsReviews(pr({ number: 1, state: 'merged' }), since)).toBe(false);
    expect(pullNeedsReviews(pr({ number: 1, updatedAt: T.at }), since)).toBe(false);
    expect(pullNeedsReviews(pr({ number: 1 }), null)).toBe(false);
  });
});

describe('issues', () => {
  const issue = (n: number, created: string, updated: string, closed: string | null = null) => ({
    number: n, title: `Issue ${n}`, createdAt: created, updatedAt: updated, closedAt: closed,
  });

  it('gives each issue ONE classification per pass', () => {
    const r = deriveIssues([
      issue(1, T.after1, T.after2),                 // created after the cursor: opened
      issue(2, T.before, T.after2, T.after1),       // closed after the cursor: closed
      issue(3, T.before, T.after2),                 // otherwise: updated
    ], since);
    expect(ids(r)).toEqual([
      `1:issue_opened:${T.after1}`, `2:issue_closed:${T.after1}`, `3:issue_updated:${T.after2}`,
    ]);
  });

  it('skips an issue updated at the cursor and reports the window closed', () => {
    const r = deriveIssues([issue(1, T.before, T.at)], since);
    expect(r.events).toEqual([]);
    expect(r.reachedCursor).toBe(true);
  });

  it('records nothing on a first sight', () => {
    expect(deriveIssues([issue(1, T.after1, T.after2)], null).events).toEqual([]);
  });
});

describe('workflow runs', () => {
  const run = (id: string, status: string, conclusion: string | null, at = T.after1) => ({
    id, name: 'build', branch: 'main', status, conclusion, createdAt: at, updatedAt: at,
  });

  it('starts, fails and recovers by run id and kind', () => {
    const r = deriveRuns([
      run('3', 'completed', 'success', T.after2),
      run('2', 'completed', 'timed_out', T.after1),
      run('1', 'in_progress', null, T.after1),
    ], since, true);
    expect(ids(r)).toEqual(['3:ci_recovered', '2:ci_failed', '1:ci_started']);
  });

  it('does not call a pass a recovery unless it was failing', () => {
    expect(deriveRuns([run('3', 'completed', 'success')], since, false).events).toEqual([]);
  });

  it('takes the CI state from the newest NEW conclusion only', () => {
    expect(deriveRuns([run('2', 'completed', 'failure'), run('1', 'completed', 'success')], since, false).ciState).toBe('failing');
    expect(deriveRuns([run('2', 'completed', 'success'), run('1', 'completed', 'failure')], since, false).ciState).toBe('passing');
    // A run at or before the cursor does not move it.
    expect(deriveRuns([run('9', 'completed', 'failure', T.at)], since, false).ciState).toBeNull();
  });

  it('records nothing and sets no state on a first sight', () => {
    const r = deriveRuns([run('1', 'completed', 'failure')], null, false);
    expect(r.events).toEqual([]);
    expect(r.ciState).toBeNull();
  });
});

describe('releases and the default branch', () => {
  it('announces a release published after the cursor, by id', () => {
    const r = deriveReleases([
      { id: '5', tag: 'v2', name: 'Two', publishedAt: T.after1, createdAt: null },
      { id: '4', tag: 'v1', name: 'One', publishedAt: T.at, createdAt: null },
      { id: '3', tag: 'v0', name: 'Zero', publishedAt: null, createdAt: null },
    ], since);
    expect(ids(r)).toEqual(['release:5']);
  });

  it('falls back to the creation time of an unpublished release', () => {
    const r = deriveReleases([{ id: '6', tag: 'rc', name: 'rc', publishedAt: null, createdAt: T.after2 }], since);
    expect(ids(r)).toEqual(['release:6']);
  });

  it('records a default branch silently the first time and announces a change after', () => {
    expect(deriveDefaultBranch('main', null, T.after1)).toEqual({ events: [], cursor: 'main' });
    expect(deriveDefaultBranch('main', 'main', T.after1).events).toEqual([]);
    const changed = deriveDefaultBranch('trunk', 'main', T.after1);
    expect(changed.cursor).toBe('trunk');
    expect(ids(changed)).toEqual(['default:main->trunk']);
  });
});
