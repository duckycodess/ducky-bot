import { describe, expect, it } from 'vitest';
import type {
  IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, WorkflowRuns,
} from '@ducky/contracts';
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

  // The wider surface the final milestone added. Defaults are EMPTY, never
  // helpful: a stub that answers more than the real thing is how five live
  // Herdr defects survived a full unit suite.
  reviews = new Map<number, PrReviews>();
  runs: WorkflowRuns = [];
  issues: IssueList = [];

  async prListAll(_ref: RepoRef): Promise<PrList> {
    this.calls.push('prListAll');
    return this.prs;
  }

  async prReviews(_ref: RepoRef, n: number): Promise<PrReviews> {
    this.calls.push(`prReviews:${n}`);
    return this.reviews.get(n) ?? { number: n };
  }

  async runList(_ref: RepoRef): Promise<WorkflowRuns> {
    this.calls.push('runList');
    return this.runs;
  }

  async issueList(_ref: RepoRef): Promise<IssueList> {
    this.calls.push('issueList');
    return this.issues;
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

/**
 * The wider read-only surface the final milestone added.
 *
 * Everything here is still an OBSERVATION: no write verb exists in the argv
 * table, and the follow-up path proposes a command rather than running one.
 */
describe('a watch sees more than open pull request titles', () => {
  const seed = (reader: MutableGitHubReader): void => {
    reader.prs = [{
      number: 7, title: 'Improve the API', state: 'OPEN', isDraft: false,
      headRefName: 'feature/api', updatedAt: START, headRefOid: 'aaa1',
    }];
    reader.checks.set(7, [{ name: 'tests', state: 'SUCCESS', bucket: 'pass' }]);
  };

  /** Runs the first observation, which is always "started watching". */
  const start = async (reader: MutableGitHubReader) => {
    const clock = new TestClock(START);
    const h = makeHarness({ clock, github: reader });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();
    h.transport.clear();
    return { h, clock };
  };

  const advance = async (h: Awaited<ReturnType<typeof start>>['h'], clock: TestClock) => {
    clock.advance(15 * 60_000);
    return h.app.githubWatches.tick();
  };

  it('reports a merge rather than a pull request that simply vanished', async () => {
    const reader = new MutableGitHubReader();
    seed(reader);
    const { h, clock } = await start(reader);

    reader.prs = [{
      ...reader.prs[0]!, state: 'MERGED', mergedAt: '2026-09-01T02:00:00.000Z',
      updatedAt: '2026-09-01T02:00:00.000Z',
    }];
    await advance(h, clock);

    expect(JSON.stringify(h.transport.sent)).toContain('merged: #7');
    h.close();
  });

  it('reports an approval and a requested change from the review surface', async () => {
    const reader = new MutableGitHubReader();
    seed(reader);
    const { h, clock } = await start(reader);

    reader.prs = [{ ...reader.prs[0]!, reviewDecision: 'APPROVED', updatedAt: '2026-09-01T02:00:00.000Z' }];
    reader.reviews.set(7, {
      number: 7,
      latestReviews: [{ state: 'APPROVED', submittedAt: '2026-09-01T02:00:00.000Z' }],
    });
    await advance(h, clock);
    expect(JSON.stringify(h.transport.sent)).toContain('approved: #7');

    h.transport.clear();
    reader.prs = [{
      ...reader.prs[0]!, reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-09-01T03:00:00.000Z',
    }];
    reader.reviews.set(7, {
      number: 7,
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T03:00:00.000Z' }],
    });
    await advance(h, clock);
    expect(JSON.stringify(h.transport.sent)).toContain('changes requested on #7');
    h.close();
  });

  it('reports new review comments', async () => {
    const reader = new MutableGitHubReader();
    seed(reader);
    const { h, clock } = await start(reader);

    reader.reviews.set(7, { number: 7, comments: [{ author: { login: 'someone' } }] });
    reader.prs = [{ ...reader.prs[0]!, updatedAt: '2026-09-01T02:00:00.000Z' }];
    await advance(h, clock);

    expect(JSON.stringify(h.transport.sent)).toContain('new review comment(s) on #7');
    h.close();
  });

  it('reports a workflow failure AND the recovery after it', async () => {
    const reader = new MutableGitHubReader();
    seed(reader);
    reader.runs = [{ workflowName: 'ci', headBranch: 'main', headSha: 'sha1', status: 'completed', conclusion: 'success' }];
    const { h, clock } = await start(reader);

    reader.runs = [{ workflowName: 'ci', headBranch: 'main', headSha: 'sha2', status: 'completed', conclusion: 'failure' }];
    await advance(h, clock);
    expect(JSON.stringify(h.transport.sent)).toContain('workflow failure(s): ci');

    h.transport.clear();
    reader.runs = [{ workflowName: 'ci', headBranch: 'main', headSha: 'sha3', status: 'completed', conclusion: 'success' }];
    await advance(h, clock);
    // Recovery matters as much as failure: "CI is broken" with no "CI is fixed"
    // teaches the owner to ignore the channel.
    expect(JSON.stringify(h.transport.sent)).toContain('workflow recovered: ci');
    h.close();
  });

  it('reports issue activity, counted rather than listed in full', async () => {
    const reader = new MutableGitHubReader();
    seed(reader);
    reader.issues = [{ number: 3, title: 'a bug', state: 'OPEN', updatedAt: START }];
    const { h, clock } = await start(reader);

    reader.issues = [
      { number: 3, title: 'a bug', state: 'OPEN', updatedAt: '2026-09-01T02:00:00.000Z' },
      { number: 4, title: 'another', state: 'OPEN', updatedAt: '2026-09-01T02:00:00.000Z' },
    ];
    await advance(h, clock);

    const body = JSON.stringify(h.transport.sent);
    expect(body).toContain('1 new issue(s)');
    expect(body).toContain('1 issue update(s)');
    h.close();
  });

  it('never constructs a write: every call it makes is a read', async () => {
    const reader = new MutableGitHubReader();
    seed(reader);
    const { h, clock } = await start(reader);
    await advance(h, clock);

    for (const call of reader.calls) {
      expect(call, call).toMatch(/^(repoView|prList|prListAll|prView|prChecks|prReviews|runList|issueList)/);
    }
    h.close();
  });
});

describe('a requested change proposes a job, and never submits one', () => {
  const withChangesRequested = (submittedAt: string, headRefOid = 'aaa1') => {
    const reader = new MutableGitHubReader();
    reader.prs = [{
      number: 7, title: 'Improve the API', state: 'OPEN', isDraft: false,
      headRefName: 'feature/api', updatedAt: START, headRefOid,
      reviewDecision: 'CHANGES_REQUESTED',
    }];
    reader.reviews.set(7, {
      number: 7,
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt }],
    });
    return reader;
  };

  it('names the exact command and creates no job', async () => {
    const clock = new TestClock(START);
    const reader = withChangesRequested('2026-09-01T01:00:00.000Z');
    const h = makeHarness({ clock, github: reader });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });

    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();

    const body = JSON.stringify(h.transport.sent);
    expect(body).toContain('Changes requested on');
    expect(body).toContain('Nothing has been submitted');
    expect(body).toContain('/job submit repo:demo');
    // The load-bearing assertion: no job exists. Every approval and execution
    // gate is untouched because nothing reached them.
    const jobs = h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number };
    expect(jobs.c).toBe(0);
    h.close();
  });

  it('proposes once for the same review, however many passes run', async () => {
    const clock = new TestClock(START);
    const reader = withChangesRequested('2026-09-01T01:00:00.000Z');
    const h = makeHarness({ clock, github: reader });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });

    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();
    const after = countProposals(h);

    for (let i = 0; i < 3; i += 1) {
      clock.advance(15 * 60_000);
      await h.app.githubWatches.tick();
    }

    expect(countProposals(h)).toBe(after);
    expect(after).toBe(1);
    h.close();
  });

  it('proposes again when the review or the code genuinely moves', async () => {
    const clock = new TestClock(START);
    const reader = withChangesRequested('2026-09-01T01:00:00.000Z');
    const h = makeHarness({ clock, github: reader });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();
    expect(countProposals(h)).toBe(1);

    // A new review on the same commit.
    reader.reviews.set(7, {
      number: 7,
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-02T01:00:00.000Z' }],
    });
    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();
    expect(countProposals(h)).toBe(2);

    // New code under the same review.
    reader.prs = [{ ...reader.prs[0]!, headRefOid: 'bbb2' }];
    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();
    expect(countProposals(h)).toBe(3);
    h.close();
  });

  it('stops proposing once the pull request is merged', async () => {
    const clock = new TestClock(START);
    const reader = withChangesRequested('2026-09-01T01:00:00.000Z');
    const h = makeHarness({ clock, github: reader });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();

    reader.prs = [{
      ...reader.prs[0]!, state: 'MERGED', mergedAt: '2026-09-01T02:00:00.000Z', headRefOid: 'ccc3',
    }];
    clock.advance(15 * 60_000);
    await h.app.githubWatches.tick();

    expect(countProposals(h)).toBe(1);
    h.close();
  });
});

function countProposals(h: ReturnType<typeof makeHarness>): number {
  const row = h.store.db
    .prepare("SELECT count(*) c FROM github_watch_events WHERE fingerprint LIKE 'followup:%'")
    .get() as { c: number };
  return Number(row.c);
}
