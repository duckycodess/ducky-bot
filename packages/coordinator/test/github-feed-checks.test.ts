import { describe, expect, it } from 'vitest';
import type { FeedPrChecks } from '@ducky/contracts';
import { TestClock, makeHarness, OWNER } from './helpers.js';
import { FeedReader, pr, run, sentTo } from './github-feed-helpers.js';

const CHANNEL = '900000000000000021';
const DEMO = 'acme/demo';
const HEAD = 'a'.repeat(40);

function setup(env: Record<string, string> = {}) {
  const clock = new TestClock('2026-10-01T00:00:00.000Z');
  const reader = new FeedReader();
  reader.setView(DEMO);
  const h = makeHarness({
    clock, github: reader,
    env: { DUCKY_GITHUB_FEED_ENABLED: 'true', DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL, ...env },
  });
  return {
    h, reader,
    tick: async (m = 16) => {
      clock.advance(m * 60_000);
      return h.app.githubFeed.tick();
    },
    sent: () => sentTo(h.transport.sent),
  };
}

const external = (name: string, over: Partial<FeedPrChecks[number]> = {}): FeedPrChecks[number] => ({
  name, state: 'FAILURE', bucket: 'fail', link: 'https://ci.example/build/1', workflow: '',
  startedAt: '2026-10-01T00:10:00Z', completedAt: '2026-10-01T00:12:00Z', ...over,
});

const withPr = (reader: FeedReader, n = 7): void => {
  reader.prs.set(DEMO, [pr(n, { headRefOid: HEAD, createdAt: '2026-09-30T00:00:00Z' })]);
};

describe('failed checks that are not Actions workflow runs', () => {
  it('announces an external CI failure, with the PR and checks buttons built from validated parts', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    await tick(0);
    reader.checks.set(DEMO, { 7: [external('buildkite/unit')] });
    expect(await tick()).toMatchObject({ recorded: 1, delivered: 1 });
    const [card] = sent();
    expect(card!.text).toContain('Checks failed');
    expect(card!.text).toContain('buildkite/unit');
    expect(card!.text).toContain('Commit aaaaaaa');
    const urls = card!.message.rows!.flatMap((r) => r.buttons).map((b) => ('url' in b ? b.url : ''));
    expect(urls).toEqual([
      'https://github.com/acme/demo/pull/7', 'https://github.com/acme/demo/pull/7/checks',
    ]);
    // The CI system's own link is a URL it chose; it is never offered as a button.
    expect(JSON.stringify(card!.message)).not.toContain('ci.example');
    h.close();
  });

  it('treats a check as a failure only once it FINISHES, and announces it once', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    await tick(0);
    reader.checks.set(DEMO, { 7: [external('ci/lint', { state: 'PENDING', bucket: 'pending', completedAt: null })] });
    await tick();
    expect(sent()).toEqual([]);

    reader.checks.set(DEMO, { 7: [external('ci/lint')] });
    await tick();
    expect(sent()).toHaveLength(1);
    await tick();
    await tick();
    expect(sent()).toHaveLength(1);
    h.close();
  });

  it('announces a rerun of the same check on the same commit that fails again', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    await tick(0);
    reader.checks.set(DEMO, { 7: [external('ci/lint')] });
    await tick();
    reader.checks.set(DEMO, { 7: [external('ci/lint', { startedAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-01T01:02:00Z' })] });
    await tick();
    expect(sent()).toHaveLength(2);
    // A different check on the same commit is its own fact.
    reader.checks.set(DEMO, { 7: [external('ci/lint', { startedAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-01T01:02:00Z' }), external('ci/types', { completedAt: '2026-10-01T01:05:00Z' })] });
    await tick();
    expect(sent()).toHaveLength(3);
    h.close();
  });

  it('records failures that already exist at the first watch as history', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    reader.checks.set(DEMO, { 7: [external('ci/old', { completedAt: '2026-09-30T05:00:00Z' })] });
    await tick(0);
    await tick();
    expect(sent()).toEqual([]);
    expect(h.store.githubFeed.listEvents('baseline').some((e) => e.kind === 'check_failed')).toBe(true);
    h.close();
  });

  it('does not announce an old failure on a pull request that only now enters the window', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    reader.checks.set(DEMO, { 7: [external('ci/new-ish', { completedAt: '2026-09-30T05:00:00Z' })] });
    await tick(0);
    // Another pull request appears with a failure that finished BEFORE the watch began.
    reader.prs.set(DEMO, [pr(8, { headRefOid: 'b'.repeat(40), createdAt: '2026-08-01T00:00:00Z' }), pr(7, { headRefOid: HEAD })]);
    reader.checks.set(DEMO, {
      7: [external('ci/new-ish', { completedAt: '2026-09-30T05:00:00Z' })],
      8: [external('ci/ancient', { completedAt: '2026-08-01T00:00:00Z' })],
    });
    await tick();
    expect(sent()).toEqual([]);
    h.close();
  });

  it('leaves Actions-backed checks to the workflow-run path, so nothing is announced twice', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    reader.runs.set(DEMO, [run(50, { status: 'in_progress', conclusion: null })]);
    await tick(0);
    reader.runs.set(DEMO, [run(50, { conclusion: 'failure', updatedAt: '2026-10-01T00:20:00Z' })]);
    reader.checks.set(DEMO, { 7: [
      external('build', { workflow: 'ci', link: 'https://github.com/acme/demo/actions/runs/50/job/9', completedAt: '2026-10-01T00:20:00Z' }),
      // Even with the workflow name absent, an Actions run link is recognised.
      external('test', { workflow: '', link: 'https://github.com/acme/demo/actions/runs/50/job/10', completedAt: '2026-10-01T00:20:00Z' }),
    ] });
    await tick();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain('Branch main');
    h.close();
  });

  it('ignores passing, skipped and cancelled checks', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    await tick(0);
    reader.checks.set(DEMO, { 7: [
      external('a', { bucket: 'pass', state: 'SUCCESS' }), external('b', { bucket: 'skipping' }),
      external('c', { bucket: 'cancel' }),
    ] });
    await tick();
    expect(sent()).toEqual([]);
    h.close();
  });

  it('bounds the extra reads: five pull requests per pass, and says so', async () => {
    const { h, reader, tick } = setup();
    reader.prs.set(DEMO, Array.from({ length: 9 }, (_, i) => pr(i + 1, { headRefOid: HEAD })));
    await tick(0);
    reader.calls.length = 0;
    await tick();
    expect(reader.count('feedPrChecks')).toBe(5);
    // Only one open-PR read serves both the PR unit and the checks unit.
    expect(reader.count('feedPrList')).toBe(1);
    h.close();
  });

  it('skips a pull request whose checks cannot be read, without silencing the others', async () => {
    const { h, reader, tick, sent } = setup();
    reader.prs.set(DEMO, [pr(8, { headRefOid: HEAD }), pr(7, { headRefOid: HEAD })]);
    await tick(0);
    reader.checks.set(DEMO, { 7: [external('ci/x')] });
    reader.failing.add(`feedPrChecks:${DEMO}`);
    // Every read fails: the unit fails and backs off, and says so.
    expect(await tick()).toMatchObject({ failed: 1 });
    expect(h.app.status().githubFeed).toMatch(/Degraded: 1 read failing/);
    reader.failing.clear();
    await tick(40);
    expect(sent()).toHaveLength(1);
    h.close();
  });
});

describe('review requests are not announced for old history, and a renewed one is', () => {
  const req = (n: number, updatedAt: string, repo = 'acme/elsewhere') => ({
    number: n, title: `Please review ${n}`, state: 'open', isDraft: false, author: { login: 'erin' },
    createdAt: '2026-09-01T00:00:00Z', updatedAt,
    repository: { name: repo.split('/')[1]!, nameWithOwner: repo },
  });
  const env = { DUCKY_GITHUB_FEED_REVIEW_REQUESTS: 'true' };

  it('an old request rolling into a full window after the baseline stays silent', async () => {
    const { h, reader, tick, sent } = setup(env);
    // Baseline: a FULL window of 25 requests, all recent.
    reader.requests = Array.from({ length: 25 }, (_, i) => req(100 + i, `2026-09-30T00:${String(i).padStart(2, '0')}:00Z`));
    await tick(0);
    // Some are reviewed; older requests (not in the baseline window) roll in.
    reader.requests = [
      ...Array.from({ length: 20 }, (_, i) => req(100 + i, `2026-09-30T00:${String(i).padStart(2, '0')}:00Z`)),
      ...Array.from({ length: 5 }, (_, i) => req(200 + i, `2026-07-0${i + 1}T00:00:00Z`)),
    ];
    await tick();
    expect(sent()).toEqual([]);
    h.close();
  });

  it('a genuinely new request on an old pull request is announced (it was touched, so it is fresh)', async () => {
    const { h, reader, tick, sent } = setup(env);
    reader.requests = [req(1, '2026-09-30T00:00:00Z')];
    await tick(0);
    reader.requests = [req(1, '2026-09-30T00:00:00Z'), req(2, '2026-10-01T00:20:00Z')];
    await tick();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain('Please review 2');
    h.close();
  });

  it('a request that ended and was RENEWED is announced again, once', async () => {
    const { h, reader, tick, sent } = setup(env);
    reader.requests = [req(1, '2026-09-30T00:00:00Z')];
    await tick(0);
    // The owner reviews: it leaves the results, and the window was not full.
    reader.requests = [];
    await tick();
    expect(sent()).toEqual([]);
    // Re-requested: back, and touched.
    reader.requests = [req(1, '2026-10-01T01:00:00Z')];
    await tick();
    expect(sent()).toHaveLength(1);
    expect(h.store.githubFeed.eventByKey('review_requested:acme/elsewhere#1:e2')).toBeDefined();
    // And only once.
    await tick();
    await tick();
    expect(sent()).toHaveLength(1);
    h.close();
  });

  it('a stale reappearance (no new activity) after an end is not a renewal', async () => {
    const { h, reader, tick, sent } = setup(env);
    reader.requests = [req(1, '2026-09-30T00:00:00Z'), req(2, '2026-09-30T05:00:00Z')];
    await tick(0);
    reader.requests = [req(2, '2026-09-30T05:00:00Z')];
    await tick();
    reader.requests = [req(1, '2026-09-30T00:00:00Z'), req(2, '2026-09-30T05:00:00Z')];
    await tick();
    expect(sent()).toEqual([]);
    h.close();
  });

  it('a full window cannot prove a request ended, so it never announces a roll-back-in', async () => {
    const { h, reader, tick, sent } = setup(env);
    // Always exactly 25: the same 24 recent requests, plus one slot that varies.
    const recent = Array.from({ length: 24 }, (_, i) => req(300 + i, `2026-09-30T02:${String(i).padStart(2, '0')}:00Z`));
    const full = (slot: ReturnType<typeof req>) => [slot, ...recent];
    reader.requests = full(req(1, '2026-09-30T00:00:00Z'));
    await tick(0);
    // #1 is pushed out (the window is full, so that proves nothing), and comes back unchanged.
    reader.requests = full(req(900, '2026-06-01T00:00:00Z'));
    await tick();
    reader.requests = full(req(1, '2026-09-30T00:00:00Z'));
    await tick();
    expect(sent()).toEqual([]);
    expect(h.app.status().githubFeed).toMatch(/review request window full/);
    h.close();
  });

  it('keeps the DM-only rule for requests in repositories nobody selected', async () => {
    const { h, reader, tick, sent } = setup(env);
    await tick(0);
    reader.requests = [req(5, '2026-10-01T00:30:00Z')];
    await tick();
    expect(sent().map((s) => s.where)).toEqual([`dm:${OWNER}`]);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Review fixes: placeholder timestamps, and a partial read that must not move
// the watermark past a failure nobody has seen yet.
// ---------------------------------------------------------------------------

const ZERO = '0001-01-01T00:00:00Z';
/** What `gh` reports for a commit STATUS: the Go zero time in both fields. */
const status = (name: string, bucket: 'fail' | 'pending' | 'pass', over: Partial<FeedPrChecks[number]> = {}): FeedPrChecks[number] => ({
  name, state: bucket === 'fail' ? 'FAILURE' : bucket === 'pass' ? 'SUCCESS' : 'PENDING', bucket,
  link: 'https://ci.example/s/1', workflow: '', startedAt: ZERO, completedAt: ZERO, ...over,
});
const failures = (sent: ReturnType<typeof sentTo>) => sent.filter((s) => s.text.includes('Checks failed'));
const setChecks = (reader: FeedReader, byPr: Record<number, FeedPrChecks>): void => {
  reader.checks.set(DEMO, byPr);
};

describe('placeholder timestamps are missing, not real', () => {
  it('treats the year-0001 zero time, empty and unparseable values as no time at all', async () => {
    const { realStamp } = await import('../src/domain/github-feed.service.js');
    for (const v of [ZERO, '0001-01-01T00:00:00.000Z', '', null, undefined, 'not a time', '1970-01-01T00:00:00Z']) {
      expect(realStamp(v as string | null | undefined), String(v)).toBe('');
    }
    expect(realStamp('2026-10-01T00:12:00Z')).toBe('2026-10-01T00:12:00Z');
  });

  it('a status that fails after pending is announced, even beside a dated check', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [
      external('unit', { bucket: 'pass', state: 'SUCCESS', completedAt: '2026-10-01T00:30:00Z' }),
      status('ci/status', 'pending'),
    ] });
    await tick(0);
    // The dated check's time is the newest real one. A zero-time status must be
    // judged on what was seen, not on that number.
    setChecks(reader, { 7: [
      external('unit', { bucket: 'pass', state: 'SUCCESS', completedAt: '2026-10-01T00:30:00Z' }),
      status('ci/status', 'fail'),
    ] });
    await tick();
    expect(failures(sent())).toHaveLength(1);
    expect(failures(sent())[0]!.text).toContain('ci/status');
    // And it is one alert however often it is seen.
    await tick();
    await tick();
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });

  it('a zero-time status never advances the watermark, so a later dated failure still announces', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    setChecks(reader, { 7: [status('ci/status', 'pass'), external('unit', { completedAt: '2026-10-01T00:20:00Z' })] });
    await tick();
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });

  it('failing statuses that already exist at the baseline are history', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/old', 'fail')] });
    await tick(0);
    await tick();
    await tick();
    expect(failures(sent())).toEqual([]);
    expect(h.store.githubFeed.listEvents('baseline').some((e) => e.eventKey.includes(':undated:e1'))).toBe(true);
    h.close();
  });

  it('a status-only old pull request rolling into the window is recorded silently', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    // PR 5 is OLD (created long before the watch), only now inside the window.
    reader.prs.set(DEMO, [
      pr(7, { headRefOid: HEAD }),
      pr(5, { headRefOid: 'c'.repeat(40), createdAt: '2026-06-01T00:00:00Z' }),
    ]);
    setChecks(reader, { 7: [status('ci/status', 'pass')], 5: [status('ci/legacy', 'fail')] });
    await tick();
    await tick();
    expect(failures(sent())).toEqual([]);
    h.close();
  });

  it('a pull request opened AFTER the baseline, failing on a status, is announced', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    reader.prs.set(DEMO, [
      pr(9, { headRefOid: 'd'.repeat(40), createdAt: '2026-10-01T00:10:00Z' }),
      pr(7, { headRefOid: HEAD }),
    ]);
    setChecks(reader, { 7: [status('ci/status', 'pass')], 9: [status('ci/status', 'fail')] });
    await tick();
    expect(failures(sent())).toHaveLength(1);
    expect(failures(sent())[0]!.text).toContain('#9');
    h.close();
  });

  it('a NEW head on a known pull request that fails is announced; the old head does not repeat', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    reader.prs.set(DEMO, [pr(7, { headRefOid: 'e'.repeat(40) })]);
    setChecks(reader, { 7: [status('ci/status', 'fail')] });
    await tick();
    expect(failures(sent())).toHaveLength(1);
    expect(failures(sent())[0]!.text).toContain('Commit eeeeeee');
    await tick();
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });

  it('a status that fails, passes and fails again on the SAME head is two announcements', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pending')] });
    await tick(0);
    setChecks(reader, { 7: [status('ci/status', 'fail')] });
    await tick();
    expect(failures(sent())).toHaveLength(1);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick();
    setChecks(reader, { 7: [status('ci/status', 'fail')] });
    await tick();
    expect(failures(sent())).toHaveLength(2);
    // Still failing, unchanged: nothing more.
    await tick();
    expect(failures(sent())).toHaveLength(2);
    h.close();
  });
});

describe('a partial read does not move the watermark past an unseen failure', () => {
  it('announces a failure on a pull request whose read failed earlier, once it is readable', async () => {
    const { h, reader, tick, sent } = setup();
    reader.prs.set(DEMO, [pr(8, { headRefOid: 'b'.repeat(40) }), pr(7, { headRefOid: HEAD })]);
    setChecks(reader, { 7: [], 8: [external('unit', { bucket: 'pass', state: 'SUCCESS', completedAt: '2026-09-30T00:00:00Z' })] });
    await tick(0);

    // PR 7's read fails while PR 8 completes LATER than PR 7's coming failure.
    const real = reader.feedPrChecks.bind(reader);
    reader.feedPrChecks = async (ref, n) => {
      if (n === 7) throw new Error('scripted: unreadable');
      return real(ref, n);
    };
    setChecks(reader, { 7: [external('unit', { completedAt: '2026-10-01T00:12:00Z' })],
      8: [external('unit', { bucket: 'pass', state: 'SUCCESS', completedAt: '2026-10-01T00:20:00Z' })] });
    const partial = await tick();
    expect(partial).toMatchObject({ failed: 0 });
    expect(failures(sent())).toEqual([]);
    expect(h.app.status().githubFeed).toMatch(/1 pull request check read skipped/);

    // PR 7 is readable again: its 00:12 failure is NEW, not history.
    reader.feedPrChecks = real;
    await tick();
    expect(failures(sent())).toHaveLength(1);
    expect(failures(sent())[0]!.text).toContain('#7');
    await tick();
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });

  it('is not a baseline while any pull request is unreadable, and records nothing', async () => {
    const { h, reader, tick, sent } = setup();
    reader.prs.set(DEMO, [pr(8, { headRefOid: 'b'.repeat(40) }), pr(7, { headRefOid: HEAD })]);
    setChecks(reader, { 7: [external('unit', { completedAt: '2026-09-30T00:12:00Z' })], 8: [] });
    const real = reader.feedPrChecks.bind(reader);
    reader.feedPrChecks = async (ref, n) => {
      if (n === 7) throw new Error('scripted: unreadable');
      return real(ref, n);
    };
    const first = await tick(0);
    expect(first).toMatchObject({ failed: 1 });
    expect(h.store.githubFeed.cursor(DEMO, 'checks')!.baselinedAt).toBeNull();

    // Once everything is readable THAT is the baseline: the old failure is history.
    reader.feedPrChecks = real;
    await tick(40);
    expect(h.store.githubFeed.cursor(DEMO, 'checks')!.baselinedAt).not.toBeNull();
    expect(failures(sent())).toEqual([]);
    h.close();
  });
});

describe('a new pull request is new by its own creation time, not by another unit having run', () => {
  /** Pushes the pull-request unit's next read far away, as a backoff would. */
  const holdPrUnit = (h: ReturnType<typeof setup>['h']): void => {
    h.store.db.prepare(
      "UPDATE github_feed_cursors SET next_check_at = '2099-01-01T00:00:00.000Z' WHERE scope = ? AND kind = 'prs'",
    ).run(DEMO);
  };

  it('announces a failing status on a PR created after the baseline even when the PR unit has not recorded it', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    holdPrUnit(h);

    reader.prs.set(DEMO, [
      pr(9, { headRefOid: 'd'.repeat(40), createdAt: '2026-10-01T00:10:00Z' }),
      pr(7, { headRefOid: HEAD }),
    ]);
    setChecks(reader, { 7: [status('ci/status', 'pass')], 9: [status('ci/status', 'fail')] });
    await tick();
    // The PR unit never ran, so no pr_opened event exists; the check is judged anyway.
    expect(h.store.githubFeed.eventByKey('pr_opened:acme/demo#9')).toBeUndefined();
    expect(failures(sent())).toHaveLength(1);
    expect(failures(sent())[0]!.text).toContain('#9');

    // Once only, however often it is seen, and when the PR unit finally runs.
    await tick();
    await tick();
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });

  it('stays silent for that failure after a restart', async () => {
    const { h, reader, tick, sent } = setup();
    const clock = h.app.clock as unknown as { advance(ms: number): void };
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    holdPrUnit(h);
    reader.prs.set(DEMO, [pr(9, { headRefOid: 'd'.repeat(40), createdAt: '2026-10-01T00:10:00Z' }), pr(7, { headRefOid: HEAD })]);
    setChecks(reader, { 7: [status('ci/status', 'pass')], 9: [status('ci/status', 'fail')] });
    await tick();
    expect(failures(sent())).toHaveLength(1);

    const { GitHubFeedService } = await import('../src/domain/github-feed.service.js');
    const restarted = new GitHubFeedService({
      store: h.store, reader, transport: h.transport, ownerId: OWNER, clock: h.app.clock,
      allowlist: h.app.allowlist,
      config: {
        enabled: true, intervalMinutes: 15, explicitRepos: [], excludedRepos: [],
        reviewRequests: false, digestAt: '09:00', channelId: CHANNEL,
      },
    });
    restarted.reconcileSelection();
    for (let i = 0; i < 3; i += 1) {
      clock.advance(16 * 60_000);
      await restarted.tick();
    }
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });

  it('keeps an OLD pull request rolling in silent when the PR unit is held too', async () => {
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pass')] });
    await tick(0);
    holdPrUnit(h);
    reader.prs.set(DEMO, [
      pr(7, { headRefOid: HEAD }),
      pr(5, { headRefOid: 'c'.repeat(40), createdAt: '2026-06-01T00:00:00Z' }),
    ]);
    setChecks(reader, { 7: [status('ci/status', 'pass')], 5: [status('ci/legacy', 'fail')] });
    await tick();
    await tick();
    expect(failures(sent())).toEqual([]);
    h.close();
  });

  it('announces it when the PR read itself is failing, so the PR unit cannot have recorded it', async () => {
    // The checks unit reads the same open-PR list, so this models the PR unit
    // backing off for its own reasons rather than the list being unreadable.
    const { h, reader, tick, sent } = setup();
    withPr(reader);
    setChecks(reader, { 7: [status('ci/status', 'pending')] });
    await tick(0);
    holdPrUnit(h);
    setChecks(reader, { 7: [status('ci/status', 'fail')] });
    await tick();
    expect(failures(sent())).toHaveLength(1);
    h.close();
  });
});
