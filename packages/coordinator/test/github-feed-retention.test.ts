import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_FORBIDDEN_TABLES } from '@ducky/contracts';
import { makeHarness } from './helpers.js';

const OLD = '2025-01-01T00:00:00.000Z';
const sha = (n: number): string => n.toString(16).padStart(40, '0');

function seed() {
  const h = makeHarness({
    env: { DUCKY_RETENTION_ENABLED: 'true', DUCKY_RETENTION_WATCH_EVENTS_DAYS: '30' },
  });
  const f = h.store.githubFeed;
  f.insertRepo({ repoKey: 'acme/demo', display: 'acme/demo', source: 'seed', atIso: OLD });
  f.ensureCursor('acme/demo', 'prs', OLD);
  const event = (k: string, kind: 'pr_opened' | 'review_requested', status: 'baseline' | 'pending') => ({
    id: `id-${k}`, eventKey: k, kind, repoKey: 'acme/demo', origin: 'selected' as const,
    cardJson: status === 'pending' ? '{}' : null, status,
  });
  f.recordSuccess({
    scope: 'acme/demo', kind: 'prs', expectedNextCheckAt: OLD, nextCheckAt: OLD, atIso: OLD,
    baseline: true, cursor: 'w',
    events: [
      event('pr_opened:acme/demo#1', 'pr_opened', 'baseline'),
      event('pr_opened:acme/demo#2', 'pr_opened', 'pending'),
      event('pr_opened:acme/demo#3', 'pr_opened', 'pending'),
      event('review_requested:acme/demo#9', 'review_requested', 'pending'),
    ],
  });
  // #2 delivered, #9 (a review request) delivered, #3 still pending, #1 baseline.
  f.markEventDelivered('id-pr_opened:acme/demo#2', OLD, 'owner_dm');
  f.markEventDelivered('id-review_requested:acme/demo#9', OLD, 'owner_dm');
  return h;
}

describe('retention and the GitHub feed', () => {
  it('removes only finished alerts, and never a baseline, a pending alert or a review request', async () => {
    const h = seed();
    const out = await h.app.retention.run('manual');
    expect(out.counts.feedEventsDeleted).toBe(1);
    const left = h.store.githubFeed.listEvents().map((e) => e.eventKey).sort();
    expect(left).toEqual([
      'pr_opened:acme/demo#1', 'pr_opened:acme/demo#3', 'review_requested:acme/demo#9',
    ]);
    h.close();
  });

  it('never touches the selected list or a cursor, however old', async () => {
    const h = seed();
    await h.app.retention.run('manual');
    expect(h.store.githubFeed.repoByKey('acme/demo')).toBeDefined();
    expect(h.store.githubFeed.cursor('acme/demo', 'prs')?.baselinedAt).toBe(OLD);
    h.close();
  });

  it('keeps the newest consumed commits of a repository, so old ones do not look new', async () => {
    const h = seed();
    const f = h.store.githubFeed;
    f.ensureCursor('acme/demo', 'commits', OLD);
    const rows = Array.from({ length: 130 }, (_, i) => ({
      sha: sha(i + 1), headline: `c${i}`, author: 'a',
      committedAt: new Date(Date.parse(OLD) + i * 60_000).toISOString(), baseline: true,
    }));
    f.recordSuccess({
      scope: 'acme/demo', kind: 'commits', expectedNextCheckAt: OLD, nextCheckAt: OLD, atIso: OLD,
      baseline: true, cursor: sha(130), meta: 'main', commits: { repoKey: 'acme/demo', branch: 'main', rows },
    });
    const out = await h.app.retention.run('manual');
    expect(out.counts.feedCommitsDeleted).toBe(30);
    const kept = h.store.db.prepare('SELECT COUNT(*) AS n FROM github_feed_commits').get() as { n: number };
    expect(kept.n).toBe(100);
    // The 100 that stay are the NEWEST.
    expect(f.knownShas('acme/demo', [sha(130), sha(31)]).size).toBe(2);
    expect(f.knownShas('acme/demo', [sha(30)]).size).toBe(0);
    h.close();
  });

  it('never deletes an unconsumed commit or a pending digest slot', async () => {
    const h = seed();
    const f = h.store.githubFeed;
    f.ensureCursor('acme/demo', 'commits', OLD);
    f.recordSuccess({
      scope: 'acme/demo', kind: 'commits', expectedNextCheckAt: OLD, nextCheckAt: OLD, atIso: OLD,
      baseline: false, cursor: sha(1), meta: 'main',
      commits: { repoKey: 'acme/demo', branch: 'main', rows: [{ sha: sha(1), headline: 'x', author: 'a', committedAt: OLD }] },
    });
    f.claimDigest({ id: 'd1', discordUserId: 'u', dayKey: '2025-01-01', target: 'owner_dm', dueAt: OLD });
    await h.app.retention.run('manual');
    expect(f.openCommits('acme/demo')).toHaveLength(1);
    expect(f.pendingDigests(5)).toHaveLength(1);
    h.close();
  });

  it('records counts only in the audit trail, never what was deleted', async () => {
    const h = seed();
    await h.app.retention.run('manual');
    const rows = h.store.db.prepare("SELECT detail FROM audit_log WHERE event = 'retention.pruned'").all() as { detail: string }[];
    expect(rows[0]!.detail).toMatch(/feed events 1/);
    expect(rows[0]!.detail).not.toMatch(/acme|demo|pr_opened/);
    h.close();
  });

  it('names the selection and cursor tables as forbidden, and the retention source never mentions them', () => {
    expect(RETENTION_FORBIDDEN_TABLES).toContain('github_feed_repos');
    expect(RETENTION_FORBIDDEN_TABLES).toContain('github_feed_cursors');
    for (const file of [
      ['persistence', 'src', 'repositories', 'retention.repo.ts'],
      ['coordinator', 'src', 'domain', 'retention.service.ts'],
    ]) {
      const text = readFileSync(path.resolve(import.meta.dirname, '..', '..', ...file), 'utf8');
      for (const table of ['github_feed_repos', 'github_feed_cursors']) {
        expect(text, `${file.at(-1)} mentions ${table}`).not.toContain(table);
      }
    }
  });
});
