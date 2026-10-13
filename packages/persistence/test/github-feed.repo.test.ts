import { describe, expect, it } from 'vitest';
import { GITHUB_FEED_KINDS, GITHUB_FEED_TARGETS } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations, type NewFeedEvent } from '../src/index.js';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T00:15:00.000Z';
const T2 = '2026-10-01T00:30:00.000Z';

const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return { db, store: createStore(db) };
};

const event = (key: string, over: Partial<NewFeedEvent> = {}): NewFeedEvent => ({
  id: `id-${key}`, eventKey: key, kind: 'pr_opened', repoKey: 'acme/demo', origin: 'selected',
  cardJson: '{}', status: 'pending', ...over,
});

describe('the feed schema', () => {
  it('agrees with the contract on the closed sets', () => {
    const { db } = fresh();
    const sql = (name: string): string =>
      (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;
    const events = sql('github_feed_events');
    for (const k of GITHUB_FEED_KINDS) expect(events, k).toContain(`'${k}'`);
    for (const t of GITHUB_FEED_TARGETS) expect(sql('github_feed_digests'), t).toContain(`'${t}'`);
  });

  it('references nothing: a selected repository is not an allowlist entry', () => {
    const { db } = fresh();
    for (const table of ['github_feed_repos', 'github_feed_cursors', 'github_feed_events',
      'github_feed_commits', 'github_feed_digests']) {
      expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all(), table).toEqual([]);
    }
  });
});

describe('the selected list', () => {
  it('inserts once and keeps a cancelled repository as a tombstone', () => {
    const { store } = fresh();
    const repo = store.githubFeed;
    expect(repo.insertRepo({ repoKey: 'acme/demo', display: 'Acme/Demo', source: 'seed', atIso: T0 })).toBe(true);
    expect(repo.insertRepo({ repoKey: 'acme/demo', display: 'Acme/Demo', source: 'seed', atIso: T1 })).toBe(false);
    expect(repo.cancelRepo('acme/demo', T1)).toBe(true);
    expect(repo.cancelRepo('acme/demo', T2)).toBe(false);
    // Still there, so a later insert of the same seed does NOT bring it back.
    expect(repo.repoByKey('acme/demo')?.state).toBe('cancelled');
    expect(repo.insertRepo({ repoKey: 'acme/demo', display: 'Acme/Demo', source: 'seed', atIso: T2 })).toBe(false);
    expect(repo.repoByKey('acme/demo')?.state).toBe('cancelled');
  });

  it('retires undelivered alerts on cancel and re-baselines on reactivation', () => {
    const { store } = fresh();
    const r = store.githubFeed;
    r.insertRepo({ repoKey: 'acme/demo', display: 'acme/demo', source: 'seed', atIso: T0 });
    r.ensureCursor('acme/demo', 'prs', T0);
    r.recordSuccess({
      scope: 'acme/demo', kind: 'prs', expectedNextCheckAt: T0, nextCheckAt: T1, atIso: T0,
      baseline: true, cursor: 'w', events: [event('pr_opened:acme/demo#1')],
    });
    expect(r.cancelRepo('acme/demo', T1)).toBe(true);
    expect(r.eventByKey('pr_opened:acme/demo#1')?.status).toBe('skipped');
    expect(r.reactivateRepo('acme/demo', 'explicit', T2)).toBe(true);
    const cursor = r.cursor('acme/demo', 'prs')!;
    expect(cursor.baselinedAt).toBeNull();
    expect(cursor.cursor).toBeNull();
    // The dedup memory survives: what was seen is not news again.
    expect(r.eventByKey('pr_opened:acme/demo#1')).toBeDefined();
  });
});

describe('recording an observation', () => {
  it('writes events and the cursor together, once, and dedups on the event key', () => {
    const { store } = fresh();
    const r = store.githubFeed;
    r.ensureCursor('acme/demo', 'prs', T0);
    const first = r.recordSuccess({
      scope: 'acme/demo', kind: 'prs', expectedNextCheckAt: T0, nextCheckAt: T1, atIso: T0,
      baseline: true, cursor: 'a', events: [event('pr_opened:acme/demo#1', { status: 'baseline', cardJson: null })],
    });
    expect(first).toBe(true);
    expect(r.cursor('acme/demo', 'prs')).toMatchObject({ baselinedAt: T0, cursor: 'a', failures: 0 });

    // The compare-and-swap: a second pass holding the OLD due time loses, and
    // writes nothing at all.
    const lost = r.recordSuccess({
      scope: 'acme/demo', kind: 'prs', expectedNextCheckAt: T0, nextCheckAt: T2, atIso: T1,
      baseline: false, cursor: 'b', events: [event('pr_opened:acme/demo#2')],
    });
    expect(lost).toBe(false);
    expect(r.eventByKey('pr_opened:acme/demo#2')).toBeUndefined();
    expect(r.cursor('acme/demo', 'prs')?.cursor).toBe('a');

    // The same key from a later, winning pass is ignored, not duplicated.
    r.recordSuccess({
      scope: 'acme/demo', kind: 'prs', expectedNextCheckAt: T1, nextCheckAt: T2, atIso: T1,
      baseline: false, cursor: 'b',
      events: [event('pr_opened:acme/demo#1', { id: 'other-id' }), event('pr_opened:acme/demo#2')],
    });
    expect(r.listEvents().map((e) => e.eventKey).sort())
      .toEqual(['pr_opened:acme/demo#1', 'pr_opened:acme/demo#2']);
    // And the baseline stayed the baseline: it never became deliverable.
    expect(r.eventByKey('pr_opened:acme/demo#1')?.status).toBe('baseline');
    expect(r.cursor('acme/demo', 'prs')?.baselinedAt).toBe(T0);
  });

  it('a failure moves only the backoff: no baseline, no cursor, no events', () => {
    const { store } = fresh();
    const r = store.githubFeed;
    r.ensureCursor('acme/demo', 'issues', T0);
    expect(r.recordFailure({
      scope: 'acme/demo', kind: 'issues', expectedNextCheckAt: T0, nextCheckAt: T2,
      error: 'The GitHub read failed.', atIso: T1,
    })).toBe(true);
    const c = r.cursor('acme/demo', 'issues')!;
    expect(c).toMatchObject({ baselinedAt: null, cursor: null, failures: 1, nextCheckAt: T2 });
    expect(r.listEvents()).toEqual([]);
  });

  it('only lists units of ACTIVE repositories, plus discovery when asked', () => {
    const { store } = fresh();
    const r = store.githubFeed;
    r.insertRepo({ repoKey: 'acme/a', display: 'acme/a', source: 'seed', atIso: T0 });
    r.insertRepo({ repoKey: 'acme/b', display: 'acme/b', source: 'seed', atIso: T0 });
    for (const scope of ['acme/a', 'acme/b']) r.ensureCursor(scope, 'prs', T0);
    r.ensureCursor('@me', 'review_requests', T0);
    r.cancelRepo('acme/b', T0);
    expect(r.dueUnits(T1, 10, false).map((u) => u.scope)).toEqual(['acme/a']);
    expect(r.dueUnits(T1, 10, true).map((u) => u.scope).sort()).toEqual(['@me', 'acme/a']);
  });
});

describe('the commit buffer and digest slots', () => {
  it('records a commit once per (repo, sha) and consumes it once', () => {
    const { store } = fresh();
    const r = store.githubFeed;
    r.ensureCursor('acme/demo', 'commits', T0);
    const rows = [{ sha: 'a'.repeat(40), headline: 'one', author: 'x', committedAt: T0 }];
    r.recordSuccess({
      scope: 'acme/demo', kind: 'commits', expectedNextCheckAt: T0, nextCheckAt: T1, atIso: T0,
      baseline: false, cursor: 'a'.repeat(40), meta: 'main',
      commits: { repoKey: 'acme/demo', branch: 'main', rows },
    });
    r.recordSuccess({
      scope: 'acme/demo', kind: 'commits', expectedNextCheckAt: T1, nextCheckAt: T2, atIso: T1,
      baseline: false, cursor: 'a'.repeat(40),
      commits: { repoKey: 'acme/demo', branch: 'main', rows },
    });
    expect(r.openCommits('acme/demo')).toHaveLength(1);
    expect(r.consumeCommits('acme/demo', ['a'.repeat(40)], T2, 'owner_dm')).toBe(1);
    expect(r.consumeCommits('acme/demo', ['a'.repeat(40)], T2, 'github_channel')).toBe(0);
    expect(r.openCommits('acme/demo')).toHaveLength(0);
  });

  it('claims one slot per (owner, day, target), however many times it is asked', () => {
    const { store } = fresh();
    const r = store.githubFeed;
    const claim = (id: string, target: 'github_channel' | 'owner_dm') =>
      r.claimDigest({ id, discordUserId: 'u', dayKey: '2026-10-01', target, dueAt: T0 });
    expect(claim('1', 'github_channel')).toBe(true);
    expect(claim('2', 'github_channel')).toBe(false);
    expect(claim('3', 'owner_dm')).toBe(true);
    expect(r.pendingDigests(10)).toHaveLength(2);
  });
});
