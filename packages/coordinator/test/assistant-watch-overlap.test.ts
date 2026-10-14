import { describe, expect, it } from 'vitest';
import type { WatchSurface } from '@ducky/contracts';
import type { ImportedPreferences } from '@ducky/contracts';
import type { AssistantWatchConfig } from '../src/domain/assistant-watch.service.js';
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

const PREFS: ImportedPreferences = {
  timeZone: 'UTC', morningEnabled: true, morningTime: '07:00', eveningEnabled: true, eveningTime: '21:00',
  weekendBriefings: true, lookaheadDays: 3, includeWeather: false, includeGithub: true, includeCaptures: false,
  includeMeal: false, assistantWording: false, defaultReminderOffsetsMinutes: [1440, 60],
};
/** What must hold for the imported side to REALLY tell the owner, each switchable off. */
interface World {
  prefs?: 'github' | 'none' | 'no_github_section';
  briefing?: boolean;
  delivery?: 'dm' | 'channel';
  paused?: boolean;
  cycle?: { pushedAt: string | null };
}
const CYCLE: AssistantWatchConfig = {
  account: null, cycle: true, discovery: false, relationships: new Set(['owner', 'organization', 'collaborator']),
  includeForks: false, includeArchived: false,
};

const start = async (
  surfaces: readonly WatchSurface[] | null,
  over: Parameters<typeof importedTarget>[2] = {},
  world: World = {},
) => {
  const clock = new TestClock(START);
  const reader = new MutableGitHubReader();
  seed(reader);
  const h = makeHarness({
    clock, github: reader,
    ...(world.cycle ? { assistantWatchConfig: CYCLE } : {}),
    env: {
      ...(world.briefing === false ? {} : { DUCKY_BRIEFING_ENABLED: 'true' }),
      ...(world.prefs === 'none' ? {} : { DUCKY_IMPORTED_PREFERENCES: 'true' }),
      ...(world.delivery === 'channel'
        ? { DUCKY_BRIEFING_DELIVERY: 'channel', DUCKY_DEV_BRIEFING_CHANNEL_ID: '900000000000000031' }
        : {}),
    },
  });
  if (world.prefs !== 'none') {
    h.store.ownerPreferences.insert({
      ownerId: OWNER, source: 'import', at: START,
      prefsJson: JSON.stringify({ ...PREFS, includeGithub: world.prefs !== 'no_github_section' }),
    });
  }
  h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
  if (surfaces) importedTarget(h, surfaces, over);
  if (world.cycle) h.store.db.prepare('UPDATE assistant_watch_targets SET pushed_at = ?').run(world.cycle.pushedAt);
  if (world.paused) h.store.assistantWatch.setMonitoring(OWNER, false, START);
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

describe('an imported target only silences the native DM when it will really deliver', () => {
  const change = (reader: MutableGitHubReader) => {
    reader.prs = [{ ...reader.prs[0]!, title: 'Improve the API safely', updatedAt: '2026-09-01T01:00:00.000Z' }];
  };

  it('is silenced when watching is on, a briefing can carry the digest and the target is healthy (positive control)', async () => {
    const { h, reader, step } = await start(['pulls', 'issues']);
    change(reader);
    expect((await step()).delivered).toBe(0);
    h.close();
  });

  it.each([
    ['watching is paused', {}, { paused: true }],
    ['imported preferences are not in force', {}, { prefs: 'none' as const }],
    ['the preferences leave the GitHub section out', {}, { prefs: 'no_github_section' as const }],
    ['briefings are off', {}, { briefing: false }],
    ['briefings go to a channel only, which never carries the digest', {}, { delivery: 'channel' as const }],
    ['the target is outside the poll cycle', {}, { cycle: { pushedAt: null } }],
  ] as const)('keeps the native DM when %s', async (_name, over, world) => {
    const { h, reader, step } = await start(['pulls', 'issues'], over, world);
    change(reader);
    await step();
    expect(sent(h)).toContain('Improve the API safely');
    h.close();
  });

  it('silences it again once the target is inside the poll cycle', async () => {
    const { h, reader, step } = await start(['pulls', 'issues'], {}, { cycle: { pushedAt: '2026-09-01T00:00:00Z' } });
    change(reader);
    expect((await step()).delivered).toBe(0);
    h.close();
  });

  it('silences a requested change on the imported ALERT alone, with no digest anywhere', async () => {
    const { h, reader, step } = await start(['pulls', 'issues'], {}, { prefs: 'none', briefing: false });
    reader.prs = [{ ...reader.prs[0]!, reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-09-01T03:00:00.000Z' }];
    reader.reviews.set(7, {
      number: 7, reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T03:00:00.000Z' }],
    });
    await step();
    const body = sent(h);
    // The pull request's own update, which would ride a digest nobody can receive, is kept...
    expect(body).toContain('pull request update');
    // ...while the requested change is the imported alert's to tell.
    expect(body).not.toContain('changes requested on #7');
    h.close();
  });
});
