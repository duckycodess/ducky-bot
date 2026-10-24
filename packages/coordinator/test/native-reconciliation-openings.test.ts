import { describe, expect, it } from 'vitest';
import type { PrList, RepoView } from '@ducky/contracts';
import type { RepoRef } from '@ducky/adapters';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';

/**
 * An opening is told only when it is PROVEN: the pull request is absent from the previous snapshot and was
 * created after the instant the previous read started (plus the skew margin). Never from the capped list, its
 * order, a maximum or an equal second. Invented data only.
 */
const START = '2026-09-01T00:00:00.000Z';
const MIN = 60_000;
const REPO = 'acme/demo';
/** The first tick runs at START + 15 minutes, so that is the boundary the second pass is compared with. */
const B = Date.parse(START) + 15 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const pr = (n: number, over: Partial<PrList[number]> = {}): PrList[number] => ({
  number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, headRefName: `f${n}`, updatedAt: START, headRefOid: `h${n}`,
  createdAt: '2026-08-01T00:00:00Z', ...over,
});

class Reader extends MutableGitHubReader {
  failView = false;
  override async repoView(ref: RepoRef): Promise<RepoView> {
    if (this.failView) throw new Error('read failed');
    return super.repoView(ref);
  }
}

const start = async (init: PrList = [pr(1)], reader = new Reader()) => {
  const clock = new TestClock(START);
  reader.prs = init;
  const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
  h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
  clock.advance(15 * MIN);
  await h.app.githubWatches.tick(); // "Started watching": the first complete read, started at B
  h.transport.clear();
  const step = async () => {
    clock.advance(15 * MIN);
    return h.app.githubWatches.tick();
  };
  return { h, clock, reader, step };
};
const wid = (h: Harness): string => (h.store.db.prepare('SELECT id FROM github_watches').get() as { id: string }).id;
const watch = (h: Harness) => h.store.githubWatches.byId(wid(h))!;
const summaries = (h: Harness): string[] =>
  h.transport.sent
    .map((m) => (m as unknown as { message: { embeds?: { description?: string }[] } }).message.embeds?.[0]?.description ?? '')
    .filter((t) => t.startsWith('Update for'));
const openedClaims = (h: Harness) => h.store.nativeTransitions.all().filter((c) => c.transition.kind === 'pr_opened');
const openedFacts = (n: number, at_ = iso(B + 5 * MIN)) => ({
  kind: 'pr_opened' as const, identity: `${n}:opened`, occurredAt: at_, providerHash: null, attempt: null,
});

describe('a proven opening is told as an opening, once, and claimed', () => {
  it('names the pull request as opened, claims it, and does not repeat it in the update line', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) }), pr(1)];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('opened: #2 PR 2');
    expect(text).not.toMatch(/pull request update\(s\)/);
    expect(text).not.toContain('(newly listed)');
    expect(openedClaims(h).map((c) => `${c.via}:${c.state}:${c.transition.item}`)).toEqual(['watch_summary:delivered:2']);
    h.close();
  });

  it('is independent of the list order', async () => {
    for (const order of ['newest-first', 'oldest-first']) {
      const { h, reader, step } = await start([pr(1), pr(3)]);
      const fresh = pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) });
      reader.prs = order === 'newest-first' ? [fresh, pr(1), pr(3)] : [pr(1), pr(3), fresh];
      await step();
      expect(summaries(h)[0], order).toContain('opened: #2 PR 2');
      expect(openedClaims(h).map((c) => c.transition.item), order).toEqual(['2']);
      h.close();
    }
  });

  it('survives a restart: the boundary is durable, beside the snapshot', async () => {
    const { h, clock, reader } = await start();
    expect(watch(h).readBoundaryAt).toBe(iso(B));
    const second = makeHarness({ clock, store: h.store, github: reader, assistantWatchReader: new FakeWatchReader() });
    reader.prs = [pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) }), pr(1)];
    clock.advance(15 * MIN);
    await second.app.githubWatches.tick();
    expect(second.transport.sent.length).toBeGreaterThan(0);
    expect(openedClaims(h).map((c) => c.transition.item)).toEqual(['2']);
    second.close();
  });
});

describe('anything not proven is only "newly listed", with no opening claim', () => {
  it('a pull request created before the boundary that rotates into the window', async () => {
    const { h, reader, step } = await start([pr(1)]);
    reader.prs = [pr(1), pr(9, { createdAt: iso(B - 24 * 60 * MIN), updatedAt: iso(B + 5 * MIN) })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('#9 PR 9 (newly listed)');
    expect(text).not.toContain('opened:');
    expect(openedClaims(h)).toEqual([]);
    h.close();
  });

  it('the skew boundary: B, B + 1s and B + 1s + 1ms are NOT proven only until strictly past the margin', async () => {
    const cases: [number, boolean][] = [[0, false], [1000, false], [1001, true]];
    for (const [offset, proven] of cases) {
      const { h, reader, step } = await start();
      reader.prs = [pr(1), pr(2, { createdAt: iso(B + offset), updatedAt: iso(B + 5 * MIN) })];
      await step();
      expect(openedClaims(h).length, `offset ${offset}`).toBe(proven ? 1 : 0);
      expect(summaries(h)[0], `offset ${offset}`).toContain(proven ? 'opened: #2' : '#2 PR 2 (newly listed)');
      h.close();
    }
  });

  it('an equal second, a missing or malformed creation time, and a reopened pull request prove nothing', async () => {
    for (const createdAt of [iso(B), undefined, 'not a date']) {
      const { h, reader, step } = await start();
      reader.prs = [pr(1), pr(2, { ...(createdAt === undefined ? {} : { createdAt }), updatedAt: iso(B + 5 * MIN) })];
      if (createdAt === undefined) delete reader.prs[1]!.createdAt;
      await step();
      expect(openedClaims(h), String(createdAt)).toEqual([]);
      expect(summaries(h)[0], String(createdAt)).toContain('(newly listed)');
      h.close();
    }
    // Present, absent, present again: its creation time is old, so coming back is not an opening.
    const { h, reader, step } = await start([pr(1), pr(2)]);
    reader.prs = [pr(1)];
    await step();
    reader.prs = [pr(1), pr(2, { updatedAt: iso(B + 40 * MIN) })];
    await step();
    expect(openedClaims(h)).toEqual([]);
    h.close();
  });

  it('a legacy or first observation has no boundary, so nothing is proven', async () => {
    const { h, reader, step } = await start();
    h.store.db.prepare('UPDATE github_watches SET read_boundary_at = NULL').run(); // as every pre-migration row is
    reader.prs = [pr(1), pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) })];
    await step();
    expect(openedClaims(h)).toEqual([]);
    expect(summaries(h)[0]).toContain('(newly listed)');
    // That pass recorded its own boundary, so the NEXT new pull request is provable.
    expect(watch(h).readBoundaryAt).not.toBeNull();
    h.close();
  });

  it('an unbound repository identity disables the boundary', async () => {
    const { h, reader, step } = await start();
    h.store.db.prepare('UPDATE github_watches SET repo_key = NULL').run();
    reader.prs = [pr(1), pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) })];
    await step();
    expect(openedClaims(h)).toEqual([]);
    h.close();
  });

  it('a failed read invalidates the boundary: coverage across the gap is never assumed', async () => {
    const { h, reader, step } = await start();
    reader.failView = true;
    const out = await step();
    expect(out.failed).toBe(1);
    expect(watch(h).readBoundaryAt).toBeNull();
    reader.failView = false;
    // Created DURING the gap, after the last good read began, yet not provable: its absence from the
    // snapshot might be the gap's, not a proof of opening.
    reader.prs = [pr(1), pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) })];
    await step();
    expect(openedClaims(h)).toEqual([]);
    expect(summaries(h)[0]).toContain('(newly listed)');
    // After a good read the boundary is back and the next opening is proven.
    reader.prs = [pr(1), pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) }), pr(3, { createdAt: iso(B + 70 * MIN), updatedAt: iso(B + 70 * MIN) })];
    h.transport.clear();
    await step();
    expect(openedClaims(h).map((c) => c.transition.item)).toEqual(['3']);
    h.close();
  });

  it('a capped window: more pull requests than the snapshot holds cannot make an old one look opened', async () => {
    const old = (n: number) => pr(n, { createdAt: iso(B - (n + 1) * 24 * 60 * MIN) });
    const { h, reader, step } = await start([old(1), old(2), old(3), old(4), old(5), old(6), old(7)]);
    // Four newer ones close; older ones rotate into the five normalized.
    reader.prs = [old(6), old(7), old(8), old(9), old(10), old(11)].map((p) => ({ ...p, updatedAt: iso(B + 5 * MIN) }));
    await step();
    expect(openedClaims(h)).toEqual([]);
    expect(summaries(h)[0]).not.toContain('opened:');
    h.close();
  });
});

describe('what the target and the feed did about the same opening', () => {
  const fresh = (): PrList => [pr(1), pr(2, { createdAt: iso(B + 5 * MIN), updatedAt: iso(B + 5 * MIN) })];

  it('does not tell, and does not repeat in the update line, an opening the target delivered', async () => {
    const { h, reader, step } = await start();
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, openedFacts(2), 'target_alert', 'e1', iso(B));
    h.store.nativeTransitions.markTargetDelivered('target_alert', 'e1', iso(B));
    reader.prs = fresh();
    await step();
    expect(summaries(h)).toEqual([]);
    expect(h.store.nativeTransitions.all().filter((c) => c.path === 'native')).toEqual([]);
    h.close();
  });

  it('defers the whole observation while the target is sending it, persisting nothing', async () => {
    const { h, reader, step } = await start();
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, openedFacts(2), 'target_alert', 'e1', iso(B));
    const before = watch(h);
    reader.prs = fresh();
    expect((await step()).deferred).toBe(1);
    expect(watch(h).snapshotJson).toBe(before.snapshotJson);
    expect(watch(h).readBoundaryAt).toBe(before.readBoundaryAt);
    expect(summaries(h)).toEqual([]);
    h.close();
  });

  it('keeps the summary receipt when a feed card for the same opening was reserved first and then abandoned', async () => {
    const { h, reader, step } = await start();
    h.store.db.prepare(`INSERT INTO github_feed_repos (repo_key, display, source, state, created_at, updated_at) VALUES (?,?, 'explicit','active',?,?)`)
      .run(REPO, REPO, START, START);
    h.store.db.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at)
       VALUES ('card', ?, 'pr_opened', ?, 'selected', NULL, 'pending', ?)`,
    ).run(`pr_opened:${REPO}#2`, REPO, START);
    h.store.nativeTransitions.reserveNative(OWNER, REPO, { kind: 'pr_opened', item: '2', stamp: null, hash: null, attempt: null }, 'feed_event', 'card', START, START);
    reader.prs = fresh();
    await step();
    expect(openedClaims(h).map((c) => `${c.via}:${c.state}`).sort()).toEqual(['feed_event:reserved', 'watch_summary:delivered']);
    // The card is abandoned; the owner WAS told by the summary, and the target must see that.
    h.store.db.prepare("UPDATE github_feed_events SET status = 'abandoned'").run();
    h.store.nativeTransitions.sweepOrphans();
    expect(openedClaims(h).map((c) => `${c.via}:${c.state}`)).toEqual(['watch_summary:delivered']);
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, openedFacts(2))).toEqual({ outcome: 'covered' });
    h.close();
  });

  it('a summary the transport could not send keeps its reservation, so the target waits instead of repeating', async () => {
    const { h, reader, step } = await start();
    h.transport.failSends = true;
    reader.prs = fresh();
    await step();
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, openedFacts(2))).toEqual({ outcome: 'wait' });
    h.close();
  });
});
