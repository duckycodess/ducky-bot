import { describe, expect, it } from 'vitest';
import { TestClock, makeHarness, OWNER, type Harness } from './helpers.js';
import { FeedReader, commit, sentTo } from './github-feed-helpers.js';

const CHANNEL = '900000000000000021';
const DEMO = 'acme/demo';
const SECRET = 'acme/secret';

const REPOS_JSON = JSON.stringify({
  version: 1,
  repos: [DEMO, SECRET].map((full) => ({
    slug: full.split('/')[1], absolutePath: `/tmp/${full.split('/')[1]}`, defaultBranch: 'main',
    github: { owner: full.split('/')[0], repo: full.split('/')[1] }, allowWorktree: true,
    allowBootstrap: false, bootstrapAllowedEntries: ['.git'], enabled: true,
  })),
});

function setup(startIso: string, tz: string, opts: { channel?: boolean; two?: boolean } = {}): {
  h: Harness; clock: TestClock; reader: FeedReader;
  at: (iso: string) => ReturnType<Harness['app']['githubFeed']['tick']>;
  sent: () => ReturnType<typeof sentTo>;
} {
  const clock = new TestClock(startIso, tz);
  const reader = new FeedReader();
  reader.setView(DEMO);
  reader.setView(SECRET);
  const h = makeHarness({
    clock, github: reader, ...(opts.two ? { allowlistJson: REPOS_JSON } : {}),
    env: {
      DUCKY_GITHUB_FEED_ENABLED: 'true',
      ...(opts.channel === false ? {} : { DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL }),
    },
  });
  return {
    h, clock, reader,
    at: async (iso) => {
      clock.set(iso);
      return h.app.githubFeed.tick();
    },
    sent: () => sentTo(h.transport.sent),
  };
}

const digests = (s: ReturnType<typeof sentTo>) => s.filter((m) => m.text.includes('Commit digest'));

describe('the daily digest fires at 09:00 LOCAL time, once', () => {
  it('uses the owner zone, not UTC: Manila 09:00 is 01:00Z', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z'); // baseline, 08:00 local
    reader.commitList.set(DEMO, [commit(3, '2026-10-01T00:30:00Z', 'Add the digest'), commit(2, '2026-10-01T00:20:00Z', 'Fix the poll'), commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:30:00Z');
    expect(digests(sent())).toEqual([]);

    // 00:59Z is 08:59 in Manila: not yet.
    await at('2026-10-01T00:59:00Z');
    expect(h.store.githubFeed.listDigests()).toEqual([]);

    // 01:01Z is 09:01 in Manila: the slot is claimed and, swept, delivered.
    const r = await at('2026-10-01T01:01:00Z');
    expect(r.digestsDelivered).toBe(1);
    const d = digests(sent());
    expect(d).toHaveLength(1);
    expect(d[0]!.where).toBe(`channel:${CHANNEL}`);
    expect(d[0]!.text).toContain('Add the digest');
    expect(d[0]!.text).toContain('Fix the poll');
    expect(d[0]!.text).toContain('2026-10-01');
    // The baseline commit is history and not in it.
    expect(d[0]!.text).not.toContain('Commit 1');
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-10-01', 'github_channel')).toMatchObject({
      status: 'delivered', dueAt: '2026-10-01T01:00:00.000Z',
    });
    h.close();
  });

  it('is exactly one digest per day, however many ticks and restarts follow', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:20:00Z'), commit(1, '2026-09-30T00:00:00Z')]);
    for (const iso of ['2026-10-01T01:01:00Z', '2026-10-01T01:30:00Z', '2026-10-01T05:00:00Z', '2026-10-01T15:59:00Z']) {
      await at(iso);
    }
    expect(digests(sent())).toHaveLength(1);
    // Commits pushed later in the day wait for tomorrow's, which is its own slot.
    reader.commitList.set(DEMO, [commit(3, '2026-10-01T10:00:00Z', 'Afternoon work'), commit(2, '2026-10-01T00:20:00Z'), commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T10:30:00Z');
    expect(digests(sent())).toHaveLength(1);
    await at('2026-10-02T01:01:00Z');
    await at('2026-10-02T01:20:00Z');
    expect(digests(sent())).toHaveLength(2);
    expect(digests(sent())[1]!.text).toContain('Afternoon work');
    expect(h.store.githubFeed.listDigests().map((d) => d.dayKey)).toEqual([
      '2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02',
    ]);
    h.close();
  });

  it('holds for a post-slot sweep so a 08:58 push is not left to tomorrow', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    // Last poll of the morning at 00:50Z (08:50), then a push at 08:58 local.
    await at('2026-10-01T00:50:00Z');
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:58:00Z', 'Pushed just before nine'), commit(1, '2026-09-30T00:00:00Z')]);
    // 01:01Z: the slot is due, but the repository has not been read since it.
    await at('2026-10-01T01:01:00Z');
    // The very next tick makes that read, and the digest includes the push.
    await at('2026-10-01T01:02:00Z');
    const d = digests(sent());
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toContain('Pushed just before nine');
    h.close();
  });

  it('holds while a repository cannot be swept, then goes out after the grace period', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:20:00Z', 'waiting for the sweep'), commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:30:00Z');

    reader.failing.add(`commits:${DEMO}`);
    await at('2026-10-01T01:01:00Z');
    await at('2026-10-01T01:20:00Z');
    expect(digests(sent())).toEqual([]);
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-10-01', 'github_channel')?.status).toBe('pending');

    // Thirty minutes past the slot the digest stops waiting and sends what it has.
    await at('2026-10-01T01:31:00Z');
    const d = digests(sent());
    expect(d.find((m) => m.where === `channel:${CHANNEL}`)!.text).toContain('waiting for the sweep');
    // And the owner is told, in the DM, that this repository was not read.
    expect(d.find((m) => m.where === `dm:${OWNER}`)!.text).toMatch(/could not be read for acme\/demo/);
    h.close();
  });

  it('keeps nine local across a DST change (New York, 2026-03-08)', async () => {
    const { h, reader, at } = setup('2026-03-07T13:00:00Z', 'America/New_York');
    reader.commitList.set(DEMO, [commit(1, '2026-03-06T00:00:00Z')]);
    await at('2026-03-07T13:00:00Z');
    reader.commitList.set(DEMO, [commit(2, '2026-03-07T15:00:00Z'), commit(1, '2026-03-06T00:00:00Z')]);
    // Before the change: 09:00 EST is 14:00Z.
    await at('2026-03-07T13:59:00Z');
    expect(h.store.githubFeed.listDigests()).toEqual([]);
    await at('2026-03-07T14:01:00Z');
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-03-07', 'github_channel')?.dueAt)
      .toBe('2026-03-07T14:00:00.000Z');

    // After it: 09:00 EDT is 13:00Z, an hour earlier on the clock.
    await at('2026-03-08T12:59:00Z');
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-03-08', 'github_channel')).toBeUndefined();
    await at('2026-03-08T13:01:00Z');
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-03-08', 'github_channel')?.dueAt)
      .toBe('2026-03-08T13:00:00.000Z');
    h.close();
  });

  it('groups commits by repository in ONE message, one section each', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila', { two: true });
    for (const repo of [DEMO, SECRET]) reader.commitList.set(repo, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [commit(12, '2026-10-01T00:20:00Z', 'demo two'), commit(11, '2026-10-01T00:10:00Z', 'demo one'), commit(1, '2026-09-30T00:00:00Z')]);
    reader.commitList.set(SECRET, [commit(22, '2026-10-01T00:21:00Z', 'other two'), commit(21, '2026-10-01T00:11:00Z', 'other one'), commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:30:00Z');
    await at('2026-10-01T01:01:00Z');
    const d = digests(sent());
    expect(d).toHaveLength(1);
    expect(d[0]!.message.embeds).toHaveLength(2);
    expect(d[0]!.text).toContain('demo one');
    expect(d[0]!.text).toContain('other two');
    // No per-commit message was ever sent.
    expect(sent().filter((m) => !m.text.includes('Commit digest'))).toEqual([]);
    h.close();
  });
});

describe('what a digest may reveal, and where', () => {
  async function twoRepos(secretIsPrivate: boolean) {
    const s = setup('2026-10-01T00:00:00Z', 'Asia/Manila', { two: true });
    s.reader.setView(SECRET, { isPrivate: secretIsPrivate });
    for (const repo of [DEMO, SECRET]) s.reader.commitList.set(repo, [commit(1, '2026-09-30T00:00:00Z')]);
    await s.at('2026-10-01T00:00:00Z');
    s.reader.commitList.set(DEMO, [commit(12, '2026-10-01T00:20:00Z', 'public work'), commit(1, '2026-09-30T00:00:00Z')]);
    s.reader.commitList.set(SECRET, [commit(22, '2026-10-01T00:21:00Z', 'confidential work'), commit(1, '2026-09-30T00:00:00Z')]);
    await s.at('2026-10-01T00:30:00Z');
    return s;
  }

  it('puts a public repository in the channel and a private one in the DM only', async () => {
    const { h, at, sent } = await twoRepos(true);
    await at('2026-10-01T01:01:00Z');
    const d = digests(sent());
    const channel = d.filter((m) => m.where === `channel:${CHANNEL}`);
    const dm = d.filter((m) => m.where === `dm:${OWNER}`);
    expect(channel).toHaveLength(1);
    expect(dm).toHaveLength(1);
    expect(channel[0]!.text).toContain('public work');
    expect(channel[0]!.text).not.toMatch(/confidential|secret/);
    expect(dm[0]!.text).toContain('confidential work');
    expect(dm[0]!.text).not.toContain('public work');
    h.close();
  });

  it('reroutes a section that is private AT SEND TIME to the DM, never dropping it', async () => {
    const { h, reader, at, sent } = await twoRepos(false);
    // Both public when observed; the second goes private before the digest.
    reader.setView(SECRET, { isPrivate: true });
    await at('2026-10-01T01:01:00Z');
    const d = digests(sent());
    expect(d.filter((m) => m.where === `channel:${CHANNEL}`).map((m) => m.text).join('\n'))
      .not.toContain('confidential');
    expect(d.filter((m) => m.where === `dm:${OWNER}`).map((m) => m.text).join('\n'))
      .toContain('confidential work');
    expect(h.store.githubFeed.reposWithOpenCommits()).toEqual([]);
    h.close();
  });

  it('reroutes when visibility cannot be read, and when a channel retry follows a DM that settled', async () => {
    const { h, reader, at, sent } = await twoRepos(false);
    // The channel send fails once, and meanwhile the DM row settles.
    h.transport.failSends = true;
    await at('2026-10-01T01:01:00Z');
    expect(digests(sent())).toEqual([]);
    h.transport.failSends = false;
    reader.failing.add(`repoView:${SECRET}`); // visibility unknowable now
    await at('2026-10-01T01:30:00Z');
    const d = digests(sent());
    expect(d.map((m) => m.text).join('\n')).toContain('confidential work');
    expect(d.find((m) => m.text.includes('confidential work'))!.where).toBe(`dm:${OWNER}`);
    expect(d.find((m) => m.text.includes('public work'))!.where).toBe(`channel:${CHANNEL}`);
    expect(h.store.githubFeed.reposWithOpenCommits()).toEqual([]);
    h.close();
  });

  it('sends everything to the DM when no channel is configured', async () => {
    const s = setup('2026-10-01T00:00:00Z', 'Asia/Manila', { channel: false });
    s.reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await s.at('2026-10-01T00:00:00Z');
    s.reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:20:00Z', 'quiet work'), commit(1, '2026-09-30T00:00:00Z')]);
    await s.at('2026-10-01T00:30:00Z');
    await s.at('2026-10-01T01:01:00Z');
    expect(digests(s.sent()).map((m) => m.where)).toEqual([`dm:${OWNER}`]);
    s.h.close();
  });

  it('names a repository it could not read, in the DM and never in the channel', async () => {
    const { h, reader, at, sent } = await twoRepos(false);
    reader.failing.add(`repoView:${SECRET}`);
    // Two reads fail across the sweep window; the digest still goes out.
    await at('2026-10-01T01:01:00Z');
    await at('2026-10-01T01:40:00Z');
    const d = digests(sent());
    const channel = d.filter((m) => m.where === `channel:${CHANNEL}`).map((m) => m.text).join('\n');
    expect(channel).not.toMatch(/secret/);
    expect(d.filter((m) => m.where === `dm:${OWNER}`).map((m) => m.text).join('\n'))
      .toMatch(/could not be read for acme\/secret/);
    h.close();
  });
});

describe('a force-push, a rename and an overflow do not flood', () => {
  it('reports a force-pushed head as a gap, recording only the commits since the last read', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(3, '2026-09-30T00:00:00Z'), commit(2, '2026-09-29T00:00:00Z'), commit(1, '2026-09-28T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    // History rewritten: the old head is gone and every sha is new. Only the one
    // commit actually made since the last read is news.
    reader.commitList.set(DEMO, [
      commit(0x100, '2026-10-01T00:20:00Z', 'rewritten tip'),
      commit(0x101, '2026-09-30T00:00:00Z', 'rewritten old'),
      commit(0x102, '2026-09-29T00:00:00Z', 'rewritten older'),
    ]);
    await at('2026-10-01T00:30:00Z');
    await at('2026-10-01T01:01:00Z');
    const d = digests(sent());
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toContain('rewritten tip');
    expect(d[0]!.text).not.toContain('rewritten old');
    expect(d[0]!.text).toMatch(/some commits may be missing/);
    // Disclosed once: the flag clears when the digest has said it.
    expect(h.store.githubFeed.repoByKey(DEMO)?.commitGapAt).toBeNull();
    h.close();
  });

  it('baselines anew when the default branch is renamed', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.setView(DEMO, { defaultBranchRef: { name: 'trunk' } });
    reader.commitList.set(DEMO, [commit(0x200, '2026-10-01T00:20:00Z', 'on trunk'), commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:30:00Z');
    await at('2026-10-01T01:01:00Z');
    // A rename re-baselines, so even a commit made since is not announced.
    expect(digests(sent())).toEqual([]);
    expect(h.store.githubFeed.cursor(DEMO, 'commits')?.meta).toBe('trunk');
    h.close();
  });

  it('bounds an overflow: at most three pages are read and nothing older is invented', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [
      ...Array.from({ length: 120 }, (_, i) => commit(0x1000 + i, '2026-10-01T00:20:00Z', `bulk ${i}`)),
      commit(1, '2026-09-30T00:00:00Z'),
    ]);
    reader.calls.length = 0;
    await at('2026-10-01T00:30:00Z');
    expect(reader.count('commits')).toBe(3);
    await at('2026-10-01T01:01:00Z');
    const d = digests(sent());
    expect(d).toHaveLength(1);
    // Visibly truncated: a line cap with the remainder counted, and a gap note.
    expect(d[0]!.text).toMatch(/and \d+ more commits/);
    expect(d[0]!.text).toMatch(/some commits may be missing/);
    const chars = (d[0]!.message.embeds ?? []).reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0), 0);
    expect(chars).toBeLessThanOrEqual(6000);
    h.close();
  });
});

describe('catch-up after an outage is bounded', () => {
  it('claims only today and describes the commits that are open, not a backlog of days', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [commit(3, '2026-10-02T03:00:00Z', 'during the outage'), commit(2, '2026-10-01T05:00:00Z', 'also during'), commit(1, '2026-09-30T00:00:00Z')]);
    // The host was off for two and a half days.
    await at('2026-10-03T04:00:00Z');
    await at('2026-10-03T04:20:00Z');
    expect(h.store.githubFeed.listDigests().map((d) => d.dayKey)).toEqual(['2026-10-03', '2026-10-03']);
    expect(digests(sent())).toHaveLength(1);
    h.close();
  });

  it('skips a slot that went stale rather than delivering a day that has passed', async () => {
    const { h, reader, at, sent } = setup('2026-10-01T00:00:00Z', 'Asia/Manila');
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:20:00Z', 'the day it describes'), commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:30:00Z');
    h.transport.failSends = true;
    await at('2026-10-01T01:01:00Z');
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-10-01', 'github_channel')?.status).toBe('pending');

    h.transport.failSends = false;
    // 21 hours past the slot: stale.
    await at('2026-10-02T00:00:00Z');
    expect(h.store.githubFeed.digestBySlot(OWNER, '2026-10-01', 'github_channel')).toMatchObject({
      status: 'skipped', note: 'stale',
    });
    expect(digests(sent()).filter((m) => m.text.includes('2026-10-01'))).toEqual([]);
    // Not lost: it is still open, and tomorrow's digest carries it.
    expect(h.store.githubFeed.reposWithOpenCommits()).toEqual([DEMO]);
    await at('2026-10-02T01:05:00Z');
    expect(digests(sent()).map((m) => m.text).join('\n')).toContain('the day it describes');
    h.close();
  });

  it('retires commits that no digest ever picked up, so the buffer is bounded', async () => {
    const { h, reader, at } = setup('2026-10-01T00:00:00Z', 'Asia/Manila', { channel: false });
    reader.commitList.set(DEMO, [commit(1, '2026-09-30T00:00:00Z')]);
    await at('2026-10-01T00:00:00Z');
    reader.commitList.set(DEMO, [commit(2, '2026-10-01T00:20:00Z'), commit(1, '2026-09-30T00:00:00Z')]);
    h.transport.failSends = true;
    await at('2026-10-01T00:30:00Z');
    // Fourteen days on, still nothing delivered: the old commit is retired, not kept forever.
    await at('2026-10-16T00:30:00Z');
    expect(h.store.githubFeed.openCommits(DEMO)).toEqual([]);
    h.close();
  });
});
