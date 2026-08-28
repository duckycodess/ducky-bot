import { describe, expect, it } from 'vitest';
import type { PrChecks, PrList, PrView, RepoView } from '@ducky/contracts';
import type { GitHubReader, RepoRef } from '@ducky/adapters';
import { TestClock, OWNER, STRANGER, makeHarness } from './helpers.js';

const START = '2026-09-01T00:00:00.000Z';

class MutableGitHubReader implements GitHubReader {
  repo: RepoView = { name: 'demo', defaultBranchRef: { name: 'main' } };
  prs: PrList = [];
  checks = new Map<number, PrChecks>();
  calls: string[] = [];

  async repoView(_ref: RepoRef): Promise<RepoView> {
    this.calls.push('repoView');
    return this.repo;
  }

  async prList(_ref: RepoRef): Promise<PrList> {
    this.calls.push('prList');
    return this.prs;
  }

  async prView(_ref: RepoRef, n: number): Promise<PrView> {
    this.calls.push(`prView:${n}`);
    return { number: n, title: 'unused', state: 'OPEN' };
  }

  async prChecks(_ref: RepoRef, n: number): Promise<PrChecks> {
    this.calls.push(`prChecks:${n}`);
    return this.checks.get(n) ?? [];
  }
}

describe('GitHub repository watches', () => {
  it('deduplicates unchanged snapshots and delivers meaningful owner updates', async () => {
    const clock = new TestClock(START);
    const reader = new MutableGitHubReader();
    reader.prs = [{
      number: 7, title: 'Improve the API', state: 'OPEN', isDraft: false,
      headRefName: 'feature/api', updatedAt: START,
    }];
    reader.checks.set(7, [{ name: 'tests', state: 'SUCCESS', bucket: 'pass' }]);
    const h = makeHarness({ clock, github: reader });

    const watch = h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * 60_000);
    const first = await h.app.githubWatches.tick();
    expect(first).toMatchObject({ observed: 1, changed: 1, delivered: 1 });
    expect(h.transport.sent).toHaveLength(1);
    expect(JSON.stringify(h.transport.sent[0])).toContain('Started watching `demo`');
    expect(JSON.stringify(h.transport.sent[0])).not.toContain('acme');

    clock.advance(15 * 60_000);
    const same = await h.app.githubWatches.tick();
    expect(same).toMatchObject({ observed: 1, changed: 0, delivered: 0 });
    expect(h.transport.sent).toHaveLength(1);

    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
    clock.advance(15 * 60_000);
    const changed = await h.app.githubWatches.tick();
    expect(changed).toMatchObject({ observed: 1, changed: 1, delivered: 1 });
    expect(h.transport.sent).toHaveLength(2);
    expect(JSON.stringify(h.transport.sent[1])).toContain('Improve the API safely');
    expect(h.store.githubWatches.byId(watch.id)?.snapshotHash).toBeTruthy();
    h.close();
  });

  it('is owner-only and cancels future observations', async () => {
    const clock = new TestClock(START);
    const reader = new MutableGitHubReader();
    const h = makeHarness({ clock, github: reader });
    expect(() => h.app.githubWatches.add(h.chat, { repoSlug: 'demo' })).toThrow(/not authorized/i);
    expect(() => h.app.githubWatches.list(h.chat)).toThrow(/not authorized/i);
    const watch = h.app.githubWatches.add(h.owner, { repoSlug: 'demo' });
    expect(() => h.app.githubWatches.cancel(h.stranger, watch.publicId)).toThrow(/not authorized/i);
    h.app.githubWatches.cancel(h.owner, watch.publicId);
    clock.advance(15 * 60_000);
    const tick = await h.app.githubWatches.tick();
    expect(tick.observed).toBe(0);
    expect(reader.calls).toEqual([]);
    h.close();
  });

  it('abandons a pending event if its stored owner no longer matches configuration', async () => {
    const clock = new TestClock(START);
    const reader = new MutableGitHubReader();
    const h = makeHarness({ clock, github: reader });
    const watch = h.app.githubWatches.add(h.owner, { repoSlug: 'demo' });
    const at = clock.nowIso();
    h.store.db.prepare(
      `INSERT INTO github_watch_events (id, watch_id, fingerprint, summary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('event-foreign', watch.id, 'fingerprint-foreign', 'private update', at);
    // This simulates a stale row from a profile/owner change. It must not be
    // addressed to the currently configured owner.
    h.store.db.prepare('UPDATE github_watches SET discord_user_id = ? WHERE id = ?').run(STRANGER, watch.id);
    const result = await h.app.githubWatches.tick();
    expect(result.delivered).toBe(0);
    expect(result.abandoned).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
    expect(h.store.githubWatches.pendingEvents(10)).toHaveLength(0);
    expect(OWNER).not.toBe(STRANGER);
    h.close();
  });
});
