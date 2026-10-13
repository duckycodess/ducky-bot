import { describe, expect, it } from 'vitest';
import { MockConversationProvider } from '@ducky/adapters';
import { GitHubFeedService } from '../src/domain/github-feed.service.js';
import { TestClock, makeHarness, OWNER, type Harness } from './helpers.js';
import {
  FeedReader, commit, issue, pr, review, run, sentTo, sha,
} from './github-feed-helpers.js';

const CHANNEL = '900000000000000021';
const START = '2026-10-01T00:00:00.000Z';
const DEMO = 'acme/demo';

interface Opts {
  readonly tz?: string;
  readonly start?: string;
  readonly channel?: boolean;
  readonly env?: Record<string, string>;
  readonly conversation?: MockConversationProvider;
}

function setup(opts: Opts = {}): {
  h: Harness; clock: TestClock; reader: FeedReader;
  tick: (advanceMinutes?: number) => ReturnType<GitHubFeedService['tick']>;
  sent: () => ReturnType<typeof sentTo>;
} {
  const clock = new TestClock(opts.start ?? START, opts.tz ?? 'UTC');
  const reader = new FeedReader();
  reader.setView(DEMO);
  const h = makeHarness({
    clock, github: reader,
    ...(opts.conversation ? { conversation: opts.conversation } : {}),
    env: {
      DUCKY_GITHUB_FEED_ENABLED: 'true',
      ...(opts.channel === false ? {} : { DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL }),
      ...opts.env,
    },
  });
  return {
    h, clock, reader,
    tick: async (advanceMinutes = 16) => {
      clock.advance(advanceMinutes * 60_000);
      return h.app.githubFeed.tick();
    },
    sent: () => sentTo(h.transport.sent),
  };
}

/** A baseline read of every kind for the demo repository, with some history in it. */
function withHistory(reader: FeedReader): void {
  reader.prs.set(DEMO, [
    pr(1),
    pr(2, { latestReviews: [review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z')] }),
  ]);
  reader.issues.set(DEMO, [issue(1)]);
  reader.runs.set(DEMO, [run(10, { conclusion: 'failure' })]);
  reader.commitList.set(DEMO, [commit(3, '2026-09-30T00:00:00Z'), commit(2, '2026-09-29T00:00:00Z')]);
}

describe('the first watch records history and announces none of it', () => {
  it('delivers nothing for what already exists, then stays silent on repeats', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);

    const first = await tick(0);
    expect(first).toMatchObject({ observed: 5, failed: 0, recorded: 0, delivered: 0 });
    expect(sent()).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      expect(await tick()).toMatchObject({ recorded: 0, delivered: 0, failed: 0 });
    }
    expect(sent()).toEqual([]);
    // It WAS recorded, as already-seen, which is what keeps it from being news.
    const baseline = h.store.githubFeed.listEvents('baseline').map((e) => e.eventKey).sort();
    expect(baseline).toEqual([
      'changes_requested:acme/demo#2:R0', 'check_failed:acme/demo:10:1', 'issue_opened:acme/demo#1',
      'pr_opened:acme/demo#1', 'pr_opened:acme/demo#2',
    ]);
    h.close();
  });

  it('announces exactly the new things, once each, however often it polls', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);
    await tick(0);

    reader.prs.set(DEMO, [
      pr(3, { createdAt: '2026-10-01T00:10:00Z', title: 'Add the feed' }),
      pr(1),
      pr(2, {
        latestReviews: [
          review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z'),
          review('R1', 'CHANGES_REQUESTED', '2026-10-01T00:11:00Z', 'dave'),
        ],
      }),
    ]);
    reader.issues.set(DEMO, [issue(2, { createdAt: '2026-10-01T00:12:00Z' }), issue(1)]);
    reader.runs.set(DEMO, [
      run(11, { conclusion: 'failure', updatedAt: '2026-10-01T00:13:00Z' }),
      run(10, { conclusion: 'failure' }),
    ]);

    const second = await tick();
    expect(second).toMatchObject({ recorded: 4, delivered: 4 });
    const texts = sent().map((s) => s.text);
    expect(texts.some((t) => t.includes('Pull request opened') && t.includes('Add the feed'))).toBe(true);
    expect(texts.some((t) => t.includes('Issue opened') && t.includes('Problem 2'))).toBe(true);
    expect(texts.some((t) => t.includes('Changes requested') && t.includes('Requested by dave'))).toBe(true);
    expect(texts.some((t) => t.includes('Checks failed') && t.includes('Branch main'))).toBe(true);
    // The history that was already there stayed silent.
    expect(texts.join('\n')).not.toContain('Problem 1');

    for (let i = 0; i < 4; i += 1) await tick();
    expect(h.transport.sent).toHaveLength(4);
    h.close();
  });

  it('does not announce an old pull request that merely rolls into the window', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);
    await tick(0);
    // A pull request from before the baseline, newly visible (an unrelated one closed).
    reader.prs.set(DEMO, [pr(1), pr(2, { latestReviews: [review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z')] }),
      pr(7, { createdAt: '2026-09-01T00:00:00Z' })]);
    expect(await tick()).toMatchObject({ recorded: 0 });
    expect(sent()).toEqual([]);
    h.close();
  });
});

describe('durable identity across a restart', () => {
  it('a second service instance on the same store announces nothing twice', async () => {
    const { h, clock, reader, tick, sent } = setup();
    withHistory(reader);
    await tick(0);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' }), pr(1), pr(2, {
      latestReviews: [review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z')],
    })]);
    await tick();
    expect(sent()).toHaveLength(1);

    // "Restart": a brand-new service over the same database, with no memory.
    const restarted = new GitHubFeedService({
      store: h.store, reader, transport: h.transport, ownerId: OWNER, clock, allowlist: h.app.allowlist,
      config: {
        enabled: true, intervalMinutes: 15, explicitRepos: [], excludedRepos: [],
        reviewRequests: false, digestAt: '09:00', channelId: CHANNEL,
      },
    });
    restarted.reconcileSelection();
    clock.advance(16 * 60_000);
    expect(await restarted.tick()).toMatchObject({ recorded: 0, delivered: 0 });
    expect(sent()).toHaveLength(1);
    h.close();
  });
});

describe('a failed read never becomes an empty baseline', () => {
  it('records nothing when the first read fails, and treats the next success as the baseline', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);
    reader.failing.add(`feedRunList:${DEMO}`);

    const first = await tick(0);
    expect(first).toMatchObject({ observed: 4, failed: 1 });
    const cursor = h.store.githubFeed.cursor(DEMO, 'runs')!;
    expect(cursor.baselinedAt).toBeNull();
    expect(cursor.failures).toBe(1);

    reader.failing.clear();
    // Backed off: not read again until its retry time.
    await tick(1);
    expect(reader.count('feedRunList')).toBe(1);
    await tick(31);
    expect(reader.count('feedRunList')).toBe(2);
    // The old failure (run 10) is HISTORY now that the read succeeded: it is the
    // baseline, so it is not announced as though it were new.
    expect(sent()).toEqual([]);
    expect(h.store.githubFeed.cursor(DEMO, 'runs')!.baselinedAt).not.toBeNull();
    h.close();
  });

  it('one failing kind does not replay, delay or silence the others', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);
    await tick(0);

    reader.failing.add(`feedIssueList:${DEMO}`);
    reader.prs.set(DEMO, [pr(4, { createdAt: '2026-10-01T00:10:00Z' }), pr(1), pr(2, {
      latestReviews: [review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z')],
    })]);
    reader.issues.set(DEMO, [issue(5, { createdAt: '2026-10-01T00:11:00Z' }), issue(1)]);

    expect(await tick()).toMatchObject({ failed: 1, recorded: 1, delivered: 1 });
    expect(sent().map((s) => s.text).join('\n')).toContain('Change 4');

    reader.failing.clear();
    // Past the backoff the issue read recovers and announces ONLY the issue.
    const recovered = await tick(40);
    expect(recovered).toMatchObject({ recorded: 1, delivered: 1, failed: 0 });
    const all = sent().map((s) => s.text);
    expect(all).toHaveLength(2);
    expect(all.filter((t) => t.includes('Change 4'))).toHaveLength(1);
    expect(all.filter((t) => t.includes('Problem 5'))).toHaveLength(1);
    h.close();
  });

  it('degrades honestly, with a generic message and no credential or path', async () => {
    const { h, reader, tick } = setup();
    withHistory(reader);
    reader.failing.add(`feedPrList:${DEMO}`);
    await tick(0);
    const status = h.app.status().githubFeed;
    // The open-PR list feeds two units (new PRs and PR checks); both degrade.
    expect(status).toMatch(/Degraded: 2 reads failing/);
    const row = h.store.githubFeed.cursor(DEMO, 'prs')!;
    expect(row.lastError).toBe('The GitHub read failed.');
    expect(JSON.stringify(row)).not.toMatch(/scripted|ghp_|\/home\//);
    h.close();
  });
});

describe('workflow runs: pending to failed, and reruns', () => {
  it('announces a run only when it FINISHES badly, and a failing rerun again', async () => {
    const { h, reader, tick, sent } = setup();
    reader.runs.set(DEMO, [run(20, { status: 'in_progress', conclusion: null })]);
    await tick(0);
    expect(sent()).toEqual([]);

    // Still going: nothing to say.
    await tick();
    expect(sent()).toEqual([]);

    reader.runs.set(DEMO, [run(20, { conclusion: 'failure', updatedAt: '2026-10-01T00:40:00Z' })]);
    await tick();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain('Checks failed');

    // Seen again: nothing.
    await tick();
    expect(sent()).toHaveLength(1);

    // The SAME run id rerun and failing again is a second, distinct failure.
    reader.runs.set(DEMO, [run(20, { attempt: 2, conclusion: 'failure', updatedAt: '2026-10-01T01:10:00Z' })]);
    await tick();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.text).toContain('Attempt 2');

    // Cancelled and successful runs are not failures.
    reader.runs.set(DEMO, [
      run(21, { conclusion: 'cancelled', updatedAt: '2026-10-01T02:00:00Z' }),
      run(22, { conclusion: 'success', updatedAt: '2026-10-01T02:01:00Z' }),
    ]);
    await tick();
    expect(sent()).toHaveLength(2);
    h.close();
  });
});

describe('review requests assigned to the owner, across repositories', () => {
  const REQUESTS = (n: number, repo: string) => [{
    number: n, title: `Please review ${n}`, state: 'open', isDraft: false, author: { login: 'erin' },
    createdAt: '2026-10-01T00:05:00Z', updatedAt: '2026-10-01T00:05:00Z',
    repository: { name: repo.split('/')[1]!, nameWithOwner: repo },
  }];

  it('is off until the operator says the signed-in account is the owner', async () => {
    const { h, reader, tick } = setup();
    reader.requests = REQUESTS(4, 'acme/elsewhere');
    await tick(0);
    await tick();
    expect(reader.count('reviewRequests')).toBe(0);
    h.close();
  });

  it('baselines existing requests, then announces a new one once, to the DM', async () => {
    const { h, reader, tick, sent } = setup({ env: { DUCKY_GITHUB_FEED_REVIEW_REQUESTS: 'true' } });
    reader.requests = REQUESTS(4, 'acme/elsewhere');
    await tick(0);
    expect(sent()).toEqual([]);

    reader.requests = [...REQUESTS(4, 'acme/elsewhere'), ...REQUESTS(9, 'Acme/Elsewhere')];
    await tick();
    const got = sent();
    expect(got).toHaveLength(1);
    // A repository nobody selected is NEVER posted to the channel, public or not.
    expect(got[0]!.where).toBe(`dm:${OWNER}`);
    expect(got[0]!.text).toContain('Review requested');
    expect(got[0]!.text).toContain('Please review 9');

    await tick();
    await tick();
    expect(sent()).toHaveLength(1);
    // Discovery added nothing to the selected list.
    expect(h.app.githubFeed.selected().map((r) => r.repoKey)).toEqual([DEMO]);
    h.close();
  });

  it('a request in a SELECTED public repository goes to the channel', async () => {
    const { h, reader, tick, sent } = setup({ env: { DUCKY_GITHUB_FEED_REVIEW_REQUESTS: 'true' } });
    await tick(0);
    reader.requests = REQUESTS(12, 'acme/demo');
    await tick();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.where).toBe(`channel:${CHANNEL}`);
    h.close();
  });

  it('a failing search degrades only itself', async () => {
    const { h, reader, tick, sent } = setup({ env: { DUCKY_GITHUB_FEED_REVIEW_REQUESTS: 'true' } });
    withHistory(reader);
    reader.failing.add('reviewRequests');
    const first = await tick(0);
    expect(first).toMatchObject({ observed: 5, failed: 1 });
    expect(h.store.githubFeed.cursor('@me', 'review_requests')!.baselinedAt).toBeNull();
    reader.failing.clear();
    reader.requests = REQUESTS(4, 'acme/elsewhere');
    // Recovery is a baseline, not a flood.
    await tick(40);
    expect(sent()).toEqual([]);
    h.close();
  });
});

describe('the selected list', () => {
  it('seeds from enabled mapped repositories and widens no allowlist or write permission', () => {
    const { h } = setup({ env: { DUCKY_GITHUB_FEED_REPOS: 'acme/outside-the-allowlist' } });
    const before = h.store.db.prepare('SELECT * FROM repos ORDER BY slug').all();
    const reposBefore = JSON.stringify(h.app.allowlist.list());
    h.app.githubFeed.reconcileSelection();
    h.app.githubFeed.reconcileSelection();

    expect(h.app.githubFeed.selected().map((r) => [r.repoKey, r.source])).toEqual([
      ['acme/demo', 'seed'], ['acme/outside-the-allowlist', 'explicit'],
    ]);
    // Neither the table nor the in-memory allowlist moved, and the named
    // repository did not become a job target.
    expect(h.store.db.prepare('SELECT * FROM repos ORDER BY slug').all()).toEqual(before);
    expect(JSON.stringify(h.app.allowlist.list())).toBe(reposBefore);
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM repos WHERE slug LIKE '%outside%'").get())
      .toEqual({ n: 0 });
    h.close();
  });

  it('honours an exclusion, and never selects a disabled or unmapped repository', () => {
    const { h } = setup({ env: { DUCKY_GITHUB_FEED_EXCLUDE: 'ACME/Demo' } });
    expect(h.app.githubFeed.selected()).toEqual([]);
    h.close();
  });

  it('keeps a cancelled seed cancelled, and brings it back only when named, re-baselined', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);
    await tick(0);

    h.store.githubFeed.cancelRepo(DEMO, h.app.clock.nowIso());
    const quiet = reader.calls.length;
    h.app.githubFeed.reconcileSelection();
    expect(h.app.githubFeed.selected()).toEqual([]);
    await tick();
    expect(reader.calls.length).toBe(quiet);

    // Named outright, it returns -- and what happened meanwhile is history.
    const explicit = new GitHubFeedService({
      store: h.store, reader, transport: h.transport, ownerId: OWNER, clock: h.app.clock,
      allowlist: h.app.allowlist,
      config: {
        enabled: true, intervalMinutes: 15, explicitRepos: [DEMO], excludedRepos: [],
        reviewRequests: false, digestAt: '09:00', channelId: CHANNEL,
      },
    });
    expect(explicit.reconcileSelection()).toMatchObject({ reactivated: 1 });
    reader.prs.set(DEMO, [pr(8, { createdAt: '2026-10-01T00:05:00Z' }), pr(1), pr(2, {
      latestReviews: [review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z')],
    })]);
    await explicit.tick();
    expect(sent()).toEqual([]);
    h.close();
  });

  it('retires undelivered alerts of a repository taken off the list', async () => {
    const { h, reader, tick, sent } = setup();
    withHistory(reader);
    await tick(0);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' }), pr(1), pr(2, {
      latestReviews: [review('R0', 'CHANGES_REQUESTED', '2026-09-30T01:00:00Z')],
    })]);
    h.transport.failSends = true;
    await tick();
    expect(h.store.githubFeed.pendingEvents(10)).toHaveLength(1);
    h.store.githubFeed.cancelRepo(DEMO, h.app.clock.nowIso());
    h.transport.failSends = false;
    await tick();
    expect(sent()).toEqual([]);
    expect(h.store.githubFeed.listEvents('skipped')).toHaveLength(1);
    h.close();
  });

  it('does nothing at all when disabled', async () => {
    const { h, reader, tick } = setup({ env: { DUCKY_GITHUB_FEED_ENABLED: 'false' } });
    withHistory(reader);
    expect(await tick(0)).toMatchObject({ observed: 0, delivered: 0 });
    expect(reader.calls).toEqual([]);
    expect(h.app.githubFeed.selected()).toEqual([]);
    expect(h.app.status().githubFeed).toBe('off');
    h.close();
  });
});

describe('where an alert goes, decided at send time', () => {
  const newPr = (reader: FeedReader, repo = DEMO): void => {
    reader.prs.set(repo, [pr(3, { createdAt: '2026-10-01T00:10:00Z' })]);
  };

  it('a public selected repository posts to the channel as a card with link buttons only', async () => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    newPr(reader);
    await tick();
    const [card] = sent();
    expect(card!.where).toBe(`channel:${CHANNEL}`);
    const buttons = card!.message.rows!.flatMap((r) => r.buttons);
    expect(buttons.map((b) => ('url' in b ? b.label : 'control'))).toEqual(['Open PR', 'View changes']);
    expect(buttons.map((b) => ('url' in b ? b.url : ''))).toEqual([
      'https://github.com/acme/demo/pull/3', 'https://github.com/acme/demo/pull/3/files',
    ]);
    // A card is never a control.
    for (const b of buttons) expect(b).not.toHaveProperty('customId');
    h.close();
  });

  it('a private repository goes to the DM, and so does one with no channel configured', async () => {
    const priv = setup();
    priv.reader.setView(DEMO, { isPrivate: true });
    await priv.tick(0);
    newPr(priv.reader);
    await priv.tick();
    expect(priv.sent().map((s) => s.where)).toEqual([`dm:${OWNER}`]);
    priv.h.close();

    const noChannel = setup({ channel: false });
    await noChannel.tick(0);
    newPr(noChannel.reader);
    await noChannel.tick();
    expect(noChannel.sent().map((s) => s.where)).toEqual([`dm:${OWNER}`]);
    noChannel.h.close();
  });

  it('a visibility read that fails or says nothing resolves to the DM', async () => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    newPr(reader);
    // The commit sweep also reads visibility; the interval is longer than the
    // freshness limit, so by the next tick that cached answer has expired.
    reader.failing.add(`repoView:${DEMO}`);
    await tick(16);
    expect(sent().map((s) => s.where)).toEqual([`dm:${OWNER}`]);

    reader.failing.clear();
    reader.views.set(DEMO, { name: 'demo', defaultBranchRef: { name: 'main' } });
    reader.prs.set(DEMO, [pr(4, { createdAt: '2026-10-01T01:00:00Z' }), pr(3, { createdAt: '2026-10-01T00:10:00Z' })]);
    await tick(16);
    // isPrivate absent: "probably public" is not public.
    expect(sent().map((s) => s.where)).toEqual([`dm:${OWNER}`, `dm:${OWNER}`]);
    h.close();
  });

  it('re-reads visibility on retry: a repository that went private is never sent to the channel', async () => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    newPr(reader);
    h.transport.failSends = true;
    await tick(); // observed while PUBLIC; the send fails, so it stays pending
    expect(h.store.githubFeed.pendingEvents(5)).toHaveLength(1);

    reader.setView(DEMO, { isPrivate: true });
    h.transport.failSends = false;
    await tick(6); // past the freshness limit, so visibility is read again
    expect(sent().map((s) => s.where)).toEqual([`dm:${OWNER}`]);
    h.close();
  });

  it.each([
    // Inside the freshness limit the read made moments ago may be reused; past
    // it, the answer is read again and the new one wins.
    [4, 'channel'],
    [6, 'dm'],
  ] as const)('visibility %i minutes old is %s-routed', async (minutes, expected) => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    newPr(reader);
    h.transport.failSends = true;
    await tick();
    expect(h.store.githubFeed.pendingEvents(5)).toHaveLength(1);
    reader.setView(DEMO, { isPrivate: true });
    h.transport.failSends = false;
    await tick(minutes);
    expect(sent().map((s) => s.where.split(':')[0])).toEqual([expected]);
    h.close();
  });

  it('retries a failed delivery from the record, without reading GitHub again', async () => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    newPr(reader);
    h.transport.failSends = true;
    const failed = await tick();
    expect(failed).toMatchObject({ recorded: 1, delivered: 0, deliveryFailed: 1 });
    const reads = reader.count('feedPrList');
    h.transport.failSends = false;
    const ok = await tick(0);
    expect(ok).toMatchObject({ delivered: 1 });
    expect(reader.count('feedPrList')).toBe(reads);
    expect(sent()).toHaveLength(1);
    h.close();
  });
});

describe('the cards read plainly', () => {
  it('has no decoration, bold, middle dot, em dash, timezone or reminder line', async () => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z', title: 'Fix: the thing **now**' })]);
    reader.issues.set(DEMO, [issue(4, { createdAt: '2026-10-01T00:11:00Z' })]);
    reader.runs.set(DEMO, [run(30, { conclusion: 'failure', updatedAt: '2026-10-01T00:12:00Z' })]);
    await tick();
    expect(sent().length).toBeGreaterThanOrEqual(3);
    for (const s of sent()) {
      expect(s.text, s.text).not.toMatch(/·|—|–|UTC|Manila|Reminder|\*\*\*|━|─|•/);
    }
    h.close();
  });

  it('redacts a secret in a title before it is stored or sent', async () => {
    const { h, reader, tick, sent } = setup();
    await tick(0);
    reader.prs.set(DEMO, [pr(3, {
      createdAt: '2026-10-01T00:10:00Z',
      title: 'rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789 now',
    })]);
    await tick();
    expect(JSON.stringify(sent())).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(JSON.stringify(h.store.githubFeed.listEvents())).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    h.close();
  });
});

describe('GitHub keeps being polled when model work is paused', () => {
  it('needs no conversation provider at all', async () => {
    class Paused extends MockConversationProvider {
      override async reply(): Promise<never> {
        throw new Error('subscription quota exhausted');
      }
    }
    const { h, reader, tick, sent } = setup({ conversation: new Paused() });
    await tick(0);
    reader.prs.set(DEMO, [pr(3, { createdAt: '2026-10-01T00:10:00Z' })]);
    expect(await tick()).toMatchObject({ delivered: 1 });
    expect(sent()).toHaveLength(1);
    h.close();
  });

  it('keeps the feed free of every model import', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'github-feed.service.ts'), 'utf8',
    );
    const imports = src.split('\n').filter((l) => /^\s*(import|\} from)\b/.test(l)).join('\n');
    expect(imports).not.toMatch(/conversation|openclaw|provider|channel-roles|ChannelRolePolicy/i);
  });
});

describe('the feed reads only what it should', () => {
  it('never reaches the older watch surface, and a watch never reaches the feed', async () => {
    const { h, reader, tick } = setup();
    withHistory(reader);
    await tick(0);
    await tick();
    for (const op of ['prList', 'prView', 'prChecks', 'prListAll', 'prReviews', 'runList', 'issueList']) {
      expect(reader.count(op), op).toBe(0);
    }
    h.close();
  });

  it('bounds its reads: four units per repository per interval, one commit page when quiet', async () => {
    const { h, reader, tick } = setup();
    withHistory(reader);
    await tick(0);
    reader.calls.length = 0;
    await tick();
    expect(reader.count('feedPrList')).toBe(1);
    expect(reader.count('feedIssueList')).toBe(1);
    expect(reader.count('feedRunList')).toBe(1);
    expect(reader.count('commits')).toBe(1);
    expect(sha(1)).toHaveLength(40);
    h.close();
  });
});
