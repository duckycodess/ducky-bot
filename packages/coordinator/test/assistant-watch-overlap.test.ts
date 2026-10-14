import { describe, expect, it } from 'vitest';
import type { WatchSurface } from '@ducky/contracts';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';

/**
 * An imported notification target and an ordinary watch on the SAME repository
 * must not tell one event twice, and must not lose one the imported side cannot
 * see. Invented data only.
 */
const START = '2026-09-01T00:00:00.000Z';
const MIN = 60_000;

const seed = (reader: MutableGitHubReader): void => {
  reader.prs = [{
    number: 7, title: 'Improve the API', state: 'OPEN', isDraft: false, headRefName: 'feature/api',
    updatedAt: START, headRefOid: 'aaa1',
  }];
  reader.checks.set(7, [{ name: 'tests', state: 'SUCCESS', bucket: 'pass' }]);
  reader.issues = [{ number: 3, title: 'a bug', state: 'OPEN', updatedAt: START }];
  reader.runs = [{ workflowName: 'ci', headBranch: 'main', headSha: 'sha1', status: 'completed', conclusion: 'success' }];
};

const importedTarget = (h: Harness, surfaces: readonly WatchSurface[], over: { failures?: number; state?: 'active' | 'cancelled' } = {}) => {
  h.store.assistantWatch.insertTarget({
    id: 'imp1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/demo', display: 'acme/demo',
    defaultBranch: 'main', state: over.state ?? 'active', lastObservedAt: null, createdAt: START,
    cancelledAt: over.state === 'cancelled' ? START : null,
  });
  for (const surface of surfaces) {
    h.store.assistantWatch.insertCheckpoint({
      targetId: 'imp1', surface, state: 'ready', cursor: START, nextDueAt: '2099-01-01T00:00:00.000Z', updatedAt: START,
    });
  }
  if (over.failures) {
    h.store.db.prepare('UPDATE assistant_watch_checkpoints SET failures = ?').run(over.failures);
  }
};

const start = async (surfaces: readonly WatchSurface[] | null, over: Parameters<typeof importedTarget>[2] = {}) => {
  const clock = new TestClock(START);
  const reader = new MutableGitHubReader();
  seed(reader);
  const h = makeHarness({ clock, github: reader });
  h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
  if (surfaces) importedTarget(h, surfaces, over);
  clock.advance(15 * MIN);
  await h.app.githubWatches.tick(); // "Started watching" is never suppressed
  h.transport.clear();
  const step = async () => {
    clock.advance(15 * MIN);
    return h.app.githubWatches.tick();
  };
  return { h, reader, step };
};
const sent = (h: Harness): string => JSON.stringify(h.transport.sent);

describe('the ordinary watch does not repeat what an imported target tells', () => {
  it('says nothing when every change is one the imported pulls and issues surfaces report', async () => {
    const { h, reader, step } = await start(['pulls', 'issues']);
    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
    reader.issues = [{ number: 3, title: 'a bug', state: 'OPEN', updatedAt: '2026-09-01T01:00:00.000Z' }];
    const out = await step();
    expect(out).toMatchObject({ observed: 1, changed: 1, delivered: 0 });
    expect(h.transport.sent).toEqual([]);
    // The snapshot still advanced, so the same change is not re-examined next pass.
    expect((await step())).toMatchObject({ changed: 0 });
    h.close();
  });

  it('still says it when nothing observes the repository', async () => {
    const { h, reader, step } = await start(null);
    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
    await step();
    expect(sent(h)).toContain('Improve the API safely');
    h.close();
  });

  it('keeps what the imported side cannot see: a check flipping on a pull request head', async () => {
    const { h, reader, step } = await start(['pulls', 'issues']);
    reader.checks.set(7, [{ name: 'tests', state: 'FAILURE', bucket: 'fail' }]);
    await step();
    const body = sent(h);
    expect(body).toContain('failing checks');
    expect(body).not.toContain('The repository snapshot changed');
    h.close();
  });

  it('keeps a workflow failure on any branch, which the imported runs surface does not see', async () => {
    const { h, reader, step } = await start(['pulls', 'issues', 'runs']);
    reader.runs = [{ workflowName: 'ci', headBranch: 'feature/x', headSha: 'sha2', status: 'completed', conclusion: 'failure' }];
    await step();
    expect(sent(h)).toContain('workflow failure(s): ci');
    h.close();
  });

  it('drops only the covered part of a mixed change', async () => {
    const { h, reader, step } = await start(['pulls', 'issues']);
    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
    reader.runs = [{ workflowName: 'ci', headBranch: 'feature/x', headSha: 'sha2', status: 'completed', conclusion: 'failure' }];
    await step();
    const body = sent(h);
    expect(body).toContain('workflow failure(s): ci');
    expect(body).not.toContain('pull request update');
    h.close();
  });

  it('keeps the follow-up proposal for a requested change, which is not a notification', async () => {
    const { h, reader, step } = await start(['pulls', 'issues']);
    reader.prs = [{
      ...reader.prs[0]!, reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-09-01T03:00:00.000Z',
    }];
    reader.reviews.set(7, {
      number: 7, reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T03:00:00.000Z' }],
    });
    await step();
    const body = sent(h);
    expect(body).toContain('/job submit repo:demo');
    // The snapshot line about the same change is the imported alert's to tell.
    expect(body).not.toContain('changes requested on #7');
    h.close();
  });

  it.each([
    ['a surface the imported target does not watch', ['issues'] as WatchSurface[], { }],
    ['a target that is cancelled', ['pulls', 'issues'] as WatchSurface[], { state: 'cancelled' as const }],
    ['a surface whose last read failed', ['pulls', 'issues'] as WatchSurface[], { failures: 1 }],
  ])('does not suppress on behalf of %s: that would lose the notification', async (_name, surfaces, over) => {
    const { h, reader, step } = await start(surfaces, over);
    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
    await step();
    expect(sent(h)).toContain('Improve the API safely');
    h.close();
  });

  it('suppresses nothing for a different repository', async () => {
    const clock = new TestClock(START);
    const reader = new MutableGitHubReader();
    seed(reader);
    const h = makeHarness({ clock, github: reader });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    importedTarget(h, ['pulls', 'issues']);
    h.store.db.prepare("UPDATE assistant_watch_targets SET repo_key = 'other/thing', display = 'other/thing'").run();
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    h.transport.clear();
    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    expect(sent(h)).toContain('Improve the API safely');
    h.close();
  });
});
