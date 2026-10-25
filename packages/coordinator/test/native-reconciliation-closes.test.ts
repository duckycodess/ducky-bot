import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, closedTransition, transitionKey, type PrList, type PrReviews } from '@ducky/contracts';
import type { RepoRef } from '@ducky/adapters';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';

/**
 * The exact pull request close of the ordinary watch (ADR 0034, migration 39): proven from the list's own explicit
 * evidence, told once as a close with its canonical instant, claimed only when shown in full, never inferred from a
 * disappearance, an update time or a missing merge field, and decided against the target both ways round. Invented data.
 */
const START = '2026-09-01T00:00:00.000Z';
const MIN = 60_000;
const REPO = 'acme/demo';
const at = (h: number, m = 0) => `2026-09-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const C1 = at(2);
const C2 = at(3);

const pr = (n: number, over: Partial<PrList[number]> = {}): PrList[number] => ({
  number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, headRefName: `f${n}`, updatedAt: START, headRefOid: `h${n}`,
  createdAt: '2026-08-01T00:00:00Z', mergedAt: null, closedAt: null, ...over,
});
const closed = (n: number, closedAt = C1, over: Partial<PrList[number]> = {}): PrList[number] =>
  pr(n, { state: 'CLOSED', mergedAt: null, closedAt, updatedAt: closedAt, ...over });
const open = (...ns: number[]): PrList => ns.map((n) => pr(n));

class Reader extends MutableGitHubReader {
  failReviews = false;
  override async prReviews(ref: RepoRef, n: number): Promise<PrReviews> {
    if (this.failReviews) throw new Error('reviews unavailable');
    return super.prReviews(ref, n);
  }
}

const start = async (init: PrList, reader = new Reader()) => {
  const clock = new TestClock(START);
  reader.prs = init;
  const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
  h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
  clock.advance(15 * MIN);
  await h.app.githubWatches.tick(); // "Started watching": the first complete read
  h.transport.clear();
  const step = async () => {
    clock.advance(15 * MIN);
    return h.app.githubWatches.tick();
  };
  return { h, clock, reader, step };
};

const wid = (h: Harness): string => (h.store.db.prepare('SELECT id FROM github_watches').get() as { id: string }).id;
const watch = (h: Harness) => h.store.githubWatches.byId(wid(h))!;
const snap = (h: Harness) => JSON.parse(watch(h).snapshotJson!) as {
  v: number; tail?: { n: number; s: string; cp?: string; ma?: string }[];
  prs: { number: number; cp?: string; state: string; mergedAt?: string }[];
};
const texts = (h: Harness): string[] =>
  h.transport.sent.map((m) => (m as unknown as { message: { embeds?: { description?: string }[] } }).message.embeds?.[0]?.description ?? '');
const summaries = (h: Harness): string[] => texts(h).filter((t) => t.startsWith('Update for'));
const closeClaims = (h: Harness) => h.store.nativeTransitions.all().filter((c) => c.transition.kind === 'pr_closed');
const claimKeys = (h: Harness, kind: string): string[] =>
  h.store.nativeTransitions.all().filter((c) => c.transition.kind === kind).map((c) => `${c.transition.item}${c.transition.stamp ? `@${c.transition.stamp}` : ''}`).sort();
/** What THIS watch claimed (the target's own receipts are separate rows). */
const nativeCloseKeys = (h: Harness): string[] =>
  h.store.nativeTransitions.all().filter((c) => c.path === 'native' && c.transition.kind === 'pr_closed')
    .map((c) => `${c.transition.item}@${c.transition.stamp}`).sort();
const closeFacts = (n: number, occurredAt = C1) => ({
  kind: 'pr_closed' as const, identity: `${n}:closed`, occurredAt, providerHash: null, attempt: null,
});
const targetClose = (h: Harness, n: number, occurredAt = C1, ref = `t${n}`): void => {
  h.store.nativeTransitions.reserveTarget(OWNER, REPO, closeFacts(n, occurredAt), 'target_digest', ref, START);
  h.store.nativeTransitions.markTargetDelivered('target_digest', ref, START);
};

/** Rewrites the stored snapshot into what migration 38's build wrote: version 3, no close proof, no fetched tail. */
const downgradeToV3 = (h: Harness): void => {
  const row = watch(h);
  const s = JSON.parse(row.snapshotJson!) as { v: number; tail?: unknown; prs: { cp?: string; rf?: { rv: { h: string; at: string; c: string }[] } }[] };
  s.v = 3;
  delete s.tail;
  for (const p of s.prs) delete p.cp;
  const { v: _v, prs, ...rest } = s;
  const projected = {
    v: 3, ...rest,
    prs: prs.map(({ rf, ...p }) => ({ ...p, rv: (rf?.rv ?? []).filter((f) => f.c !== 'U').map((f) => [f.h, f.at, f.c]) })),
  };
  h.store.db.prepare('UPDATE github_watches SET snapshot_json = ?, snapshot_hash = ? WHERE id = ?')
    .run(canonicalJson(s), createHash('sha256').update(canonicalJson(projected)).digest('hex'), row.id);
};

describe('a proven close is told as the exact close, once, and claimed', () => {
  it('names the pull request with its canonical instant, claims exactly that close, and does not retell it as an update', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2)];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain(`closed: #2 PR 2 at ${C1}`);
    expect(text).not.toMatch(/pull request update\(s\)/);
    expect(text).not.toContain('(newly listed)');
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`]);
    expect(closeClaims(h).map((c) => `${c.via}:${c.state}`)).toEqual(['watch_summary:delivered']);
    // A close is its own fact: nothing was claimed as an update, a merge or an opening.
    expect(h.store.nativeTransitions.all().filter((c) => c.transition.kind !== 'pr_closed')).toEqual([]);
    expect(snap(h).v).toBe(4);
    expect(snap(h).prs.find((p) => p.number === 2)).toMatchObject({ cp: C1, state: 'CLOSED' });
    h.close();
  });

  it('is told once: the next read of the same closed pull request, and a restart, say nothing', async () => {
    const { h, clock, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2)];
    await step();
    h.transport.clear();
    await step();
    expect(summaries(h)).toEqual([]);
    const second = makeHarness({ clock, store: h.store, github: reader, assistantWatchReader: new FakeWatchReader() });
    clock.advance(15 * MIN);
    await second.app.githubWatches.tick();
    expect(second.transport.sent).toEqual([]);
    expect(closeClaims(h)).toHaveLength(1);
    second.close();
    h.close();
  });

  it('writes the instant canonically whatever offset the provider used', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2, '2026-09-01T10:00:00+08:00')];
    await step();
    expect(summaries(h)[0]).toContain('closed: #2 PR 2 at 2026-09-01T02:00:00.000Z');
    expect(claimKeys(h, 'pr_closed')).toEqual(['2@2026-09-01T02:00:00.000Z']);
    h.close();
  });

  it('keeps an independent change to the same pull request as its own update line, without restating the close', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2, C1, { title: 'Renamed' })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('1 pull request update(s): #2 Renamed');
    expect(text).toContain(`closed: #2 Renamed at ${C1}`);
    // The update sentence is the current detail only: it does not say the pull request closed.
    expect(text.split('. ')[0]).not.toMatch(/clos/i);
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`]);
    expect(claimKeys(h, 'pr_updated')).toEqual([`2@${C1}`]);
    h.close();
  });

  it('names at most three closes and counts the rest instead of dropping them silently', async () => {
    const { h, reader, step } = await start(open(1, 2, 3, 4, 5));
    reader.prs = [closed(1), closed(2), closed(3), closed(4), pr(5)];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('#1 PR 1 at');
    expect(text).toContain('#3 PR 3 at');
    expect(text).not.toContain('#4 PR 4 at');
    expect(text).toContain('1 more closed pull request(s) not named here');
    expect(claimKeys(h, 'pr_closed')).toEqual([`1@${C1}`, `2@${C1}`, `3@${C1}`]);
    h.close();
  });

  it('claims only the close segments shown in full when the summary is clipped, never the one the clamp cut off', async () => {
    const LONG = (n: number) => `${'long title '.repeat(20)}${n}`.slice(0, 180);
    const { h, reader, step } = await start(open(1, 2, 3, 4, 5));
    // Five NEW pull requests push the five old ones out of the list (no longer listed); three of them are already
    // closed (a close first seen with the pull request), so the clamp falls inside the close line.
    reader.prs = [closed(6, C1, { title: LONG(6) }), closed(7, C1, { title: LONG(7) }), closed(8, C1, { title: LONG(8) }), pr(9, { title: LONG(9) }), pr(10, { title: LONG(10) })];
    await step();
    const body = texts(h).find((t) => t.startsWith('Update for'))!;
    expect(body.length).toBeLessThanOrEqual(1200);
    const shownInFull = [6, 7, 8].filter((n) => body.includes(`#${n} ${LONG(n)} at ${C1}`)).map((n) => `${n}@${C1}`);
    expect(shownInFull.length).toBeLessThan(3); // the clamp really cut a close segment
    expect(claimKeys(h, 'pr_closed')).toEqual(shownInFull);
    h.close();
  });

  it('claims nothing at all when redaction changes the summary, because no offset can be trusted', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [
      closed(1, C1, { title: 'a -----BEGIN PRIVATE KEY----- b' }), closed(2, C1, { title: 'c -----END PRIVATE KEY----- d' }),
    ];
    await step();
    expect(summaries(h)).toHaveLength(1);
    expect(claimKeys(h, 'pr_closed')).toEqual([]);
    h.close();
  });
});

describe('only explicit evidence proves a close', () => {
  const sendsNoClose = async (row: PrList[number], reviews?: Partial<PrReviews>) => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), row];
    if (reviews) reader.reviews.set(2, { number: 2, reviews: [], latestReviews: [], comments: [], commits: [], ...reviews });
    await step();
    const out = { text: summaries(h).join('\n'), claims: h.store.nativeTransitions.all(), cp: snap(h).prs.find((p) => p.number === 2)!.cp };
    h.close();
    return out;
  };

  it.each([
    ['a missing merge field', { ...closed(2), mergedAt: undefined }],
    ['an empty merge field', { ...closed(2), mergedAt: '' }],
    ['a merge instant (a merged pull request is closed too)', { ...closed(2), mergedAt: C2 }],
    ['the state MERGED', { ...closed(2), state: 'MERGED', mergedAt: C2 }],
    ['a lower-case state', { ...closed(2), state: 'closed' }],
    ['a missing close instant', { ...closed(2), closedAt: undefined }],
    ['a null close instant', { ...closed(2), closedAt: null }],
    ['an empty close instant', { ...closed(2), closedAt: '' }],
    ['an unreadable close instant', { ...closed(2), closedAt: 'garbage' }],
    ['a date without a time', { ...closed(2), closedAt: '2026-09-01' }],
    ['an open pull request that carries a close instant', pr(2, { closedAt: C1 })],
  ])('%s is no close: no close line, no close claim, no proof stored', async (_name, row) => {
    const out = await sendsNoClose(row as PrList[number]);
    expect(out.text).not.toContain('closed: #2');
    expect(out.claims.filter((c) => c.transition.kind === 'pr_closed')).toEqual([]);
    expect(out.cp).toBeUndefined();
  });

  it('is not inferred from a pull request disappearing from the list: it is only no longer listed, with no claim', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1)];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('1 previously listed pull request(s) are no longer among the 1 listed (not necessarily closed)');
    expect(text).not.toContain('closed: ');
    expect(h.store.nativeTransitions.all()).toEqual([]);
    h.close();
  });

  it('is not inferred from an update time alone', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), pr(2, { updatedAt: at(1) })];
    await step();
    expect(summaries(h)[0]).toContain('1 pull request update(s): #2 PR 2');
    expect(claimKeys(h, 'pr_closed')).toEqual([]);
    h.close();
  });

  it('is confirmed, not required, by the per-pull-request read: a failed or silent read leaves the list\'s proof standing', async () => {
    for (const mode of ['failed', 'silent', 'confirming'] as const) {
      const { h, reader, step } = await start(open(1, 2));
      reader.prs = [pr(1), closed(2)];
      if (mode === 'failed') reader.failReviews = true;
      if (mode === 'confirming') reader.reviews.set(2, { number: 2, state: 'CLOSED', mergedAt: null, reviews: [], latestReviews: [] });
      await step();
      expect(claimKeys(h, 'pr_closed'), mode).toEqual([`2@${C1}`]);
      h.close();
    }
  });

  it.each([
    ['a merge instant', { mergedAt: C2 }],
    ['an empty merge instant', { mergedAt: '' }],
    ['the state OPEN', { state: 'OPEN' }],
    ['the state MERGED', { state: 'MERGED' }],
    ['a lower-case state', { state: 'closed' }],
  ])('the per-pull-request read supplying %s contradicts the list: no close and no new merge claim', async (_name, reviews) => {
    const out = await sendsNoClose(closed(2), reviews);
    expect(out.text).not.toContain('closed: #2');
    expect(out.text).not.toContain('merged: ');
    expect(out.claims.filter((c) => ['pr_closed', 'pr_merged'].includes(c.transition.kind))).toEqual([]);
    expect(out.cp).toBeUndefined();
  });

  it('keeps the existing merge behaviour when there is nothing to contradict', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), pr(2, { state: 'MERGED', mergedAt: C1, updatedAt: C1 })];
    await step();
    expect(summaries(h)[0]).toContain('merged: #2 PR 2');
    expect(claimKeys(h, 'pr_merged')).toEqual([`2@${C1}`]);
    expect(claimKeys(h, 'pr_closed')).toEqual([]);
    h.close();
  });
});

describe('a reopened pull request is closed again as a different close', () => {
  it('tells a re-close at a distinct instant, with its own claim, and never lets an old receipt collapse it', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2, C1)];
    await step();
    reader.prs = [pr(1), pr(2, { updatedAt: at(2, 30) })]; // reopened
    await step();
    expect(summaries(h)[1]).toContain('pull request update(s): #2 PR 2');
    expect(summaries(h)[1]).not.toContain('closed: ');
    reader.prs = [pr(1), closed(2, C2)];
    await step();
    expect(summaries(h)[2]).toContain(`closed: #2 PR 2 at ${C2}`);
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`, `2@${C2}`]);
    // The target's close at the FIRST instant never covers the second.
    targetClose(h, 2, C1);
    expect(h.store.nativeTransitions.probeNative(OWNER, REPO, closedTransition(2, C2)!)).toBe('free');
    h.close();
  });

  it('tells a changed close instant seen in one read (reopened and closed again between two reads) as a close, not an update', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2, C1)];
    await step();
    h.transport.clear();
    reader.prs = [pr(1), closed(2, C2)];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain(`closed: #2 PR 2 at ${C2}`);
    expect(text).not.toContain('pull request update(s)');
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`, `2@${C2}`]);
    h.close();
  });

  it('shares one key at an equal instant (the provider\'s identity cannot tell two such closes apart), told once per observed change', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1), closed(2, C1)];
    await step();
    reader.prs = [pr(1), pr(2, { updatedAt: at(2, 30) })];
    await step();
    reader.prs = [pr(1), closed(2, C1, { updatedAt: at(2, 45) })];
    await step();
    // One key, two native holders: each told the observed change, and the target sees one transition.
    expect(closeClaims(h)).toHaveLength(2);
    expect(new Set(closeClaims(h).map((c) => c.transitionKey)).size).toBe(1);
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, closeFacts(2, C1))).toEqual({ outcome: 'covered' });
    h.close();
  });
});

describe('the upgrade from a version 3 snapshot', () => {
  it('establishes the close proof of an already closed pull request silently: no message, and the snapshot becomes version 4', async () => {
    const { h, reader, step } = await start([pr(1), closed(2)]);
    downgradeToV3(h);
    expect(snap(h).v).toBe(3);
    const events = h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get();
    await step();
    expect(h.transport.sent).toEqual([]);
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get()).toEqual(events);
    expect(snap(h)).toMatchObject({ v: 4, prs: [{ number: 1 }, { number: 2, cp: C1 }] });
    expect(closeClaims(h)).toEqual([]);
    // From then on the close is established: the same list says nothing.
    await step();
    expect(h.transport.sent).toEqual([]);
    expect(reader.calls.filter((c) => c === 'prListAll').length).toBeGreaterThan(1);
    h.close();
  });

  it('tells a REAL close that happens in the upgrade read, because the previous snapshot held the pull request open', async () => {
    const { h, reader, step } = await start(open(1, 2));
    downgradeToV3(h);
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(summaries(h)[0]).toContain(`closed: #2 PR 2 at ${C1}`);
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`]);
    h.close();
  });

  it('never swallows a real change to an older field because the same read also gained the close proof', async () => {
    const { h, reader, step } = await start([pr(1), closed(2)]);
    downgradeToV3(h);
    reader.prs = [pr(1), closed(2, C1, { title: 'Renamed later', updatedAt: at(2, 30) })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('1 pull request update(s): #2 Renamed later');
    expect(text).not.toContain('closed: ');
    expect(claimKeys(h, 'pr_closed')).toEqual([]);
    expect(claimKeys(h, 'pr_updated')).toEqual([`2@${at(2, 30)}`]);
    h.close();
  });

  it('establishes the fetched tail silently as well', async () => {
    const list = [pr(1), pr(2), pr(3), pr(4), pr(5), pr(6), closed(7)];
    const { h, step } = await start(list);
    downgradeToV3(h);
    await step();
    expect(h.transport.sent).toEqual([]);
    expect(snap(h).tail).toEqual([{ n: 6, s: 'O' }, { n: 7, s: 'C', cp: C1 }]);
    h.close();
  });
});

describe('a pull request beyond the rich slice of the fetched list keeps its lifecycle evidence, with no extra read', () => {
  const six = (over: Record<number, PrList[number]> = {}): PrList => [1, 2, 3, 4, 5, 6].map((n) => over[n] ?? pr(n));

  it('tells a close of a pull request that dropped out of the five but is still listed, and is not "no longer listed"', async () => {
    const { h, reader, step } = await start(six());
    // A new pull request enters at the front: #5 is pushed to position six, where it is closed.
    reader.prs = [pr(9), pr(1), pr(2), pr(3), pr(4), closed(5)];
    reader.calls.length = 0;
    await step();
    const text = summaries(h).join('\n');
    expect(text).toContain(`closed: #5 PR 5 at ${C1}`);
    expect(text).not.toContain('no longer');
    expect(claimKeys(h, 'pr_closed')).toEqual([`5@${C1}`]);
    // The rich reads are exactly the five rich pull requests: nothing was fetched for #5.
    expect(reader.calls.filter((c) => c.startsWith('prReviews')).sort()).toEqual(['prReviews:1', 'prReviews:2', 'prReviews:3', 'prReviews:4', 'prReviews:9']);
    expect(reader.calls.filter((c) => c.startsWith('prChecks')).length).toBe(5);
    expect(snap(h).tail).toEqual([{ n: 5, s: 'C', cp: C1 }]);
    h.close();
  });

  it('tells a merge of such a pull request from the list\'s own canonical instant', async () => {
    const { h, reader, step } = await start(six());
    reader.prs = [pr(9), pr(1), pr(2), pr(3), pr(4), pr(5, { state: 'MERGED', mergedAt: C1, updatedAt: C1 })];
    await step();
    expect(summaries(h).join('\n')).toContain('merged: #5 PR 5');
    expect(claimKeys(h, 'pr_merged')).toEqual([`5@${C1}`]);
    expect(claimKeys(h, 'pr_closed')).toEqual([]);
    h.close();
  });

  it('is told once across repeated reads and a restart, and the order beyond the slice is never evidence', async () => {
    const { h, clock, reader, step } = await start(six());
    reader.prs = [pr(9), pr(1), pr(2), pr(3), pr(4), closed(5), pr(6)];
    await step();
    h.transport.clear();
    await step();
    // The same fetched set with the pull requests beyond the five in another order: the fingerprint is the same.
    reader.prs = [pr(9), pr(1), pr(2), pr(3), pr(4), pr(6), closed(5)];
    await step();
    expect(summaries(h)).toEqual([]);
    const second = makeHarness({ clock, store: h.store, github: reader, assistantWatchReader: new FakeWatchReader() });
    clock.advance(15 * MIN);
    await second.app.githubWatches.tick();
    expect(second.transport.sent).toEqual([]);
    expect(closeClaims(h)).toHaveLength(1);
    second.close();
    h.close();
  });

  it('establishes a pull request first seen only beyond the slice silently, with no lifecycle claim', async () => {
    const { h, reader, step } = await start(open(1, 2, 3, 4, 5));
    reader.prs = [...open(1, 2, 3, 4, 5), closed(6)];
    await step();
    expect(summaries(h)).toEqual([]);
    expect(snap(h).tail).toEqual([{ n: 6, s: 'C', cp: C1 }]);
    expect(h.store.nativeTransitions.all()).toEqual([]);
    h.close();
  });

  it('establishes a merge of a pull request first seen only beyond the slice silently, with no merge claim', async () => {
    const { h, reader, step } = await start(open(1, 2, 3, 4, 5));
    reader.prs = [...open(1, 2, 3, 4, 5), pr(6, { state: 'MERGED', mergedAt: C1, updatedAt: C1 })];
    await step();
    expect(summaries(h)).toEqual([]);
    expect(snap(h).tail).toEqual([{ n: 6, s: 'M', ma: C1 }]);
    expect(h.store.nativeTransitions.all()).toEqual([]);
    h.close();
  });

  it('says "no longer listed" only for a pull request absent from ALL of the fetched list, and says how many were listed', async () => {
    const { h, reader, step } = await start(six());
    reader.prs = [pr(9), pr(1), pr(2), pr(3), pr(4), pr(6)]; // #5 is gone from the whole list, #6 is still beyond the five
    await step();
    const text = summaries(h).join('\n');
    expect(text).toContain('1 previously listed pull request(s) are no longer among the 6 listed (not necessarily closed)');
    expect(h.store.nativeTransitions.all()).toEqual([]);
    h.close();
  });

  it('applies a close seen beyond the slice when the previous snapshot was version 3 and held the pull request rich', async () => {
    const { h, reader, step } = await start(six());
    downgradeToV3(h);
    reader.prs = [pr(9), pr(1), pr(2), pr(3), pr(4), closed(5)];
    await step();
    expect(claimKeys(h, 'pr_closed')).toEqual([`5@${C1}`]);
    h.close();
  });
});

describe('membership never settles or suppresses a lifecycle fact, in either delivery order', () => {
  it('keeps the no-longer-listed line when the close of another pull request is told or already told by the target', async () => {
    for (const targetFirst of [false, true]) {
      const { h, reader, step } = await start(open(1, 2, 3));
      if (targetFirst) targetClose(h, 2);
      reader.prs = [pr(1), closed(2)]; // #3 is gone, #2 closed
      await step();
      const text = summaries(h).join('\n');
      expect(text, String(targetFirst)).toContain('no longer among the 2 listed');
      expect(text.includes('closed: #2'), String(targetFirst)).toBe(!targetFirst);
      expect(nativeCloseKeys(h), String(targetFirst)).toEqual(targetFirst ? [] : [`2@${C1}`]);
      h.close();
    }
  });

  it('tells an imported close after membership was delivered, and the membership line is not a receipt for it', async () => {
    const { h, reader, step } = await start(open(1, 2));
    reader.prs = [pr(1)]; // #2 is no longer listed
    await step();
    expect(summaries(h)[0]).toContain('no longer among');
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, closeFacts(2))).toEqual({ outcome: 'deliver' });
    h.close();
  });

  it('settles an imported close the ordinary watch already delivered, and does not suppress the unrelated membership line', async () => {
    const { h, reader, step } = await start(open(1, 2, 3));
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(summaries(h)[0]).toContain('closed: #2');
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, closeFacts(2))).toEqual({ outcome: 'covered' });
    expect(summaries(h)[0]).toContain('no longer among');
    h.close();
  });
});

describe('a close the imported target already delivered is told by neither path again', () => {
  it('takes a pure close out entirely, and leaves no generic update sentence that retells it', async () => {
    const { h, reader, step } = await start(open(1, 2));
    targetClose(h, 2);
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(summaries(h)).toEqual([]);
    expect(h.store.nativeTransitions.all().filter((c) => c.path === 'native')).toEqual([]);
    // The observation still advanced: the close is established, never told later.
    expect(snap(h).prs.find((p) => p.number === 2)).toMatchObject({ cp: C1, state: 'CLOSED' });
    h.close();
  });

  it('keeps an independent change as its own update, without the close', async () => {
    const { h, reader, step } = await start(open(1, 2));
    targetClose(h, 2);
    reader.prs = [pr(1), closed(2, C1, { title: 'Renamed' })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('1 pull request update(s): #2 Renamed');
    expect(text).not.toContain('closed: ');
    expect(nativeCloseKeys(h)).toEqual([]);
    h.close();
  });

  it('is not covered by a target close at another instant, another pull request or another repository', async () => {
    const { h, reader, step } = await start(open(1, 2));
    targetClose(h, 2, C2);
    targetClose(h, 1, C1);
    h.store.nativeTransitions.reserveTarget(OWNER, 'acme/other', closeFacts(2, C1), 'target_digest', 'o1', START);
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'o1', START);
    reader.prs = [pr(1), closed(2, C1)];
    await step();
    // Told natively with its own claim: none of the target's receipts is this close.
    expect(h.store.nativeTransitions.all().filter((c) => c.path === 'native' && c.transition.kind === 'pr_closed')
      .map((c) => `${c.transition.item}@${c.transition.stamp}`)).toEqual([`2@${C1}`]);
    expect(summaries(h)[0]).toContain(`closed: #2 PR 2 at ${C1}`);
    h.close();
  });

  it('defers the whole observation while the target is sending that very close, persisting nothing', async () => {
    const { h, reader, step } = await start(open(1, 2));
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, closeFacts(2), 'target_digest', 'e1', START);
    const before = watch(h);
    reader.prs = [pr(1), closed(2)];
    expect((await step()).deferred).toBe(1);
    expect(watch(h).snapshotJson).toBe(before.snapshotJson);
    expect(summaries(h)).toEqual([]);
    h.close();
  });

  it('tells a failed target send\'s close natively, because a failed send is no receipt', async () => {
    const { h, reader, step } = await start(open(1, 2));
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, closeFacts(2), 'target_digest', 'e1', START);
    h.store.nativeTransitions.releaseTarget('target_digest', 'e1');
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`]);
    h.close();
  });

  it('keeps a summary the transport could not send reserved, so the target waits instead of repeating', async () => {
    const { h, reader, step } = await start(open(1, 2));
    h.transport.failSends = true;
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, closeFacts(2))).toEqual({ outcome: 'wait' });
    h.close();
  });
});

describe('a close the target may already have told before exact receipts existed is held, never sent', () => {
  const uncertain = (h: Harness, over: Record<string, unknown> = {}): void => {
    const row = {
      owner_id: OWNER, repo_key: REPO, scope: 'exact', item: '2', transition_key: transitionKey(closedTransition(2, C1)!),
      origin: 'imported', marker: 'digest_marker', multiplicity: 1, representative_ref: 'e1', earliest_marked_at: START,
      recorded_at: START, ...over,
    };
    const cols = Object.keys(row);
    h.store.db.prepare(`INSERT INTO native_close_uncertainty (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...Object.values(row) as never[]);
  };
  const heldClose = (h: Harness) => h.store.db.prepare("SELECT held_key, summary FROM github_watch_events WHERE held_reason IS NOT NULL").all() as { held_key: string; summary: string }[];

  it('holds the exact close durably and counts it, sends nothing for it and reserves nothing', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h);
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(summaries(h)).toEqual([]); // a pure close: nothing else to say
    expect(heldClose(h).map((r) => r.held_key)).toEqual([transitionKey(closedTransition(2, C1)!)]);
    expect(heldClose(h)[0]!.summary).not.toContain('PR 2'); // no title in a held row
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(1);
    expect(h.store.githubWatches.heldCount(OWNER)).toBe(0); // reviews are counted on their own
    expect(h.store.nativeTransitions.all()).toEqual([]);
    expect(h.app.githubWatches.statusNotes()).toMatch(/1 pull request close\(s\) HELD and NOT sent/);
    expect(h.app.githubWatches.statusNotes()).not.toMatch(/acme|PR 2/);
    // Established: the same list never tells it, and never holds it twice.
    await step();
    expect(summaries(h)).toEqual([]);
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(1);
    h.close();
  });

  it('rebuilds only the close out of the summary: an independent update and the membership line are still told', async () => {
    const { h, reader, step } = await start(open(1, 2, 3));
    uncertain(h);
    reader.prs = [pr(1, { title: 'Renamed', updatedAt: at(1) }), closed(2)]; // #3 is gone
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('1 pull request update(s): #1 Renamed');
    expect(text).toContain('no longer among the 2 listed');
    expect(text).not.toContain('closed: ');
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(1);
    h.close();
  });

  it('holds an independent update of the same pull request only as that update, never as a close', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h);
    reader.prs = [pr(1), closed(2, C1, { title: 'Renamed' })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('1 pull request update(s): #2 Renamed');
    expect(text).not.toContain('closed: ');
    h.close();
  });

  it('keeps distinct close instants distinct: a close at another instant is told, with its own claim', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h);
    reader.prs = [pr(1), closed(2, C2)];
    await step();
    expect(summaries(h)[0]).toContain(`closed: #2 PR 2 at ${C2}`);
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C2}`]);
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(0);
    h.close();
  });

  it('holds a close at ANY instant for a pull request whose historical instant could not be read', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h, { scope: 'item', transition_key: '' });
    reader.prs = [pr(1), closed(2, C2)];
    await step();
    expect(summaries(h)).toEqual([]);
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(1);
    h.close();
  });

  it('blocks no other pull request, repository or owner', async () => {
    const { h, reader, step } = await start(open(1, 2, 3));
    uncertain(h, { repo_key: 'acme/other' });
    uncertain(h, { owner_id: '999999999999999999' });
    uncertain(h, { item: '3', transition_key: transitionKey(closedTransition(3, C2)!) });
    reader.prs = [pr(1), closed(2), pr(3)];
    await step();
    expect(claimKeys(h, 'pr_closed')).toEqual([`2@${C1}`]);
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(0);
    h.close();
  });

  it('is covered by a real target receipt, which is checked first: a close that was LATER digested with proof', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h, { marker: 'alert_marker_only' });
    targetClose(h, 2); // a real target receipt written by a send whose output was proven
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(summaries(h)).toEqual([]);
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(0); // covered, not held
    h.close();
  });

  it('waits behind a target send in flight, then returns to the hold when that send fails', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h);
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, closeFacts(2), 'target_digest', 'e1', START);
    reader.prs = [pr(1), closed(2)];
    expect((await step()).deferred).toBe(1);
    h.store.nativeTransitions.releaseTarget('target_digest', 'e1');
    await step();
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(1);
    expect(summaries(h)).toEqual([]);
    h.close();
  });

  it('survives a cancel of the watch, a restart and retention: the hold and the uncertainty stay', async () => {
    const { h, reader, step } = await start(open(1, 2));
    uncertain(h);
    reader.prs = [pr(1), closed(2)];
    await step();
    h.app.githubWatches.cancel(h.owner, watch(h).publicId);
    expect(h.store.githubWatches.heldCloseCount(OWNER)).toBe(1);
    expect(h.store.nativeTransitions.closeUncertaintyCounts(OWNER)).toMatchObject({ rows: 1, events: 1 });
    h.close();
  });
});

describe('a pull request first seen already closed, and an opening beside a close', () => {
  /** The first tick runs at START + 15 minutes: the read boundary the next pass is compared with. */
  const B = Date.parse(START) + 15 * MIN;
  const iso = (ms: number) => new Date(ms).toISOString();

  it('states its known close without claiming an opening, and without claiming it happened since the last read', async () => {
    const { h, reader, step } = await start(open(1));
    reader.prs = [pr(1), closed(7, C1, { createdAt: '2026-08-02T00:00:00Z' })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain(`closed: #7 PR 7 at ${C1}`);
    expect(text).toContain('#7 PR 7 (newly listed)'); // membership is its own fact
    expect(text).not.toContain('opened:');
    expect(claimKeys(h, 'pr_closed')).toEqual([`7@${C1}`]);
    expect(claimKeys(h, 'pr_opened')).toEqual([]);
    h.close();
  });

  it('tells a proven opening and its close as two facts, each claimed once', async () => {
    const { h, reader, step } = await start(open(1));
    const created = iso(B + 5 * MIN);
    reader.prs = [pr(1), closed(7, iso(B + 9 * MIN), { createdAt: created })];
    await step();
    const text = summaries(h)[0]!;
    expect(text).toContain('opened: #7 PR 7');
    expect(text).toContain(`closed: #7 PR 7 at ${iso(B + 9 * MIN)}`);
    expect(claimKeys(h, 'pr_opened')).toEqual(['7']);
    expect(claimKeys(h, 'pr_closed')).toEqual([`7@${iso(B + 9 * MIN)}`]);
    h.close();
  });

  it('keeps every other fact when the target already delivered the opening: the close, a merge and the membership line', async () => {
    const { h, reader, step } = await start(open(1, 2, 3));
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, { kind: 'pr_opened', identity: '7:opened', occurredAt: iso(B + 5 * MIN), providerHash: null, attempt: null }, 'target_digest', 'o7', START);
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'o7', START);
    reader.prs = [
      closed(7, iso(B + 9 * MIN), { createdAt: iso(B + 5 * MIN) }), pr(1), pr(2, { state: 'MERGED', mergedAt: C2, updatedAt: C2 }),
    ]; // #3 is no longer listed
    await step();
    const text = summaries(h)[0]!;
    expect(text).not.toContain('opened:');
    expect(text).toContain(`closed: #7 PR 7 at ${iso(B + 9 * MIN)}`);
    expect(text).toContain('merged: #2 PR 2');
    expect(text).toContain('no longer among the 3 listed');
    // The opening is the TARGET's receipt alone: this watch claimed none.
    expect(h.store.nativeTransitions.all().filter((c) => c.path === 'native' && c.transition.kind === 'pr_opened')).toEqual([]);
    h.close();
  });
});

describe('an imported close is decided against the ledger when it is written, in either order', () => {
  const importTarget = (h: Harness, id = 't1', repo = REPO): string => {
    const publicId = `w${id.padEnd(5, 'a').slice(0, 5).replace(/[^a-z]/g, 'a')}`;
    h.store.assistantWatch.insertTarget({
      id, publicId, discordUserId: OWNER, repoKey: repo, display: repo, defaultBranch: 'main', state: 'active',
      lastObservedAt: null, createdAt: START, cancelledAt: null,
    });
    return publicId;
  };
  const importClose = (h: Harness, id: string, n: number, occurredAt: string): void =>
    h.store.assistantWatch.insertImportedEvent({
      id, targetId: 't1', kind: 'pr_closed', identity: `${n}:closed`, occurredAt, payloadJson: JSON.stringify({ number: n, title: 'T' }),
      alertedAt: null, digestedAt: null, createdAt: START,
    });
  const ev = (h: Harness, id: string) => h.store.db.prepare('SELECT digested_at, settled_by, withheld_reason FROM assistant_watch_events WHERE id = ?').get(id) as
    { digested_at: string | null; settled_by: string | null; withheld_reason: string | null };

  it('settles it by the native receipt when the ordinary watch already told that very close, and not for another pull request\'s', async () => {
    const { h, reader, step } = await start(open(1, 2));
    importTarget(h);
    reader.prs = [pr(1), closed(2)];
    await step(); // the watch tells the close at C1
    importClose(h, 'same', 2, C1);
    importClose(h, 'other', 3, C1); // the source identity is unique per pull request: another close is another pull request here
    expect(ev(h, 'same')).toMatchObject({ settled_by: 'native_receipt' });
    expect(ev(h, 'same').digested_at).not.toBeNull();
    expect(ev(h, 'other')).toEqual({ digested_at: null, settled_by: null, withheld_reason: null });
    h.close();
  });

  it('is told by the target when the native watch has not yet, and the native watch then tells nothing', async () => {
    const { h, reader, step } = await start(open(1, 2));
    importTarget(h);
    importClose(h, 'e1', 2, C1);
    h.store.assistantWatch.reserveSend(
      { id: 'e1', targetRepoKey: REPO, discordUserId: OWNER, kind: 'pr_closed', identity: '2:closed', occurredAt: C1, providerHash: null, attempt: null },
      'target_digest', START,
    );
    h.store.assistantWatch.markDigested(['e1'], START);
    reader.prs = [pr(1), closed(2)];
    await step();
    expect(summaries(h)).toEqual([]);
    h.close();
  });

  it('withholds a close with an unreadable instant, counted, only where this owner has an ordinary watch bound to the repository', async () => {
    for (const time of ['garbage', 'Sep 1 2026 10:00 UTC']) {
      const { h } = await start(open(1, 2));
      importTarget(h);
      importClose(h, 'e1', 2, time);
      expect(ev(h, 'e1').withheld_reason, time).toBe('ambiguous_evidence'); // the owner's watch for this repository exists
      expect(h.store.assistantWatch.withheldCounts(OWNER).ambiguousEvidence).toBe(1);
      h.close();
    }
    // With no ordinary watch bound to the repository nothing native could tell it, so nothing is withheld.
    const h = makeHarness({ clock: new TestClock(START), assistantWatchReader: new FakeWatchReader() });
    importTarget(h);
    importClose(h, 'e1', 2, 'garbage');
    expect(ev(h, 'e1')).toEqual({ digested_at: null, settled_by: null, withheld_reason: null });
    h.close();
  });

  it('leaves the permanent uncertainty alone when the target is cancelled', async () => {
    const { h } = await start(open(1, 2));
    const publicId = importTarget(h);
    h.store.db.prepare(
      `INSERT INTO native_close_uncertainty (owner_id, repo_key, scope, item, transition_key, origin, marker, multiplicity, representative_ref, earliest_marked_at, recorded_at)
       VALUES (?, ?, 'exact', '2', ?, 'imported', 'digest_marker', 1, 'e1', ?, ?)`,
    ).run(OWNER, REPO, transitionKey(closedTransition(2, C1)!), START, START);
    h.app.assistantWatch.cancel(h.owner, publicId);
    expect(h.store.nativeTransitions.closeUncertaintyCounts(OWNER)).toEqual({ events: 1, rows: 1, itemScopeRows: 0 });
    h.close();
  });
});
