import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson, hashProviderRef, hashSourceIdentity, observedReviewTransition, transitionKey, type PrList, type PrReviews,
  type ReviewObservedState,
} from '@ducky/contracts';
import type { RepoRef } from '@ducky/adapters';
import { RetentionService } from '../src/domain/retention.service.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';

/**
 * The observed-state review facts of the ordinary watch (ADR 0034, migration 38): a review in its OWN state
 * (approved, commented, requested changes, dismissed), the lifecycle it refuses to guess, what a version 2
 * snapshot already proves, and the per-author lines that name no review. Invented data only.
 */
const START = '2026-09-01T00:00:00.000Z';
const MIN = 60_000;
const at = (h: number, m = 0) => `2026-09-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const REPO = 'acme/demo';

const pr = (n: number, over: Partial<PrList[number]> = {}): PrList[number] => ({
  number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, headRefName: `f${n}`, updatedAt: START, headRefOid: `h${n}`,
  createdAt: '2026-08-01T00:00:00Z', ...over,
});
type Review = { id?: string; state: string; submittedAt?: string | null };
const rv = (id: string, state: string, submittedAt: string | null = at(1)): Review => ({ id, state, submittedAt });
const hashOf = (id: string): string => hashProviderRef(id)!;

class Reader extends MutableGitHubReader {
  failReviews = false;
  override async prReviews(ref: RepoRef, n: number): Promise<PrReviews> {
    if (this.failReviews) throw new Error('reviews unavailable');
    return super.prReviews(ref, n);
  }
  setReviews(n: number, reviews: Review[] | undefined, extra: Partial<PrReviews> = {}): void {
    this.reviews.set(n, {
      number: n,
      ...(reviews === undefined ? {} : { reviews }),
      latestReviews: (reviews ?? []).filter((r) => r.state !== 'PENDING'),
      ...extra,
    });
  }
}

const start = async (reader = new Reader(), init: { reviews?: Review[]; prs?: PrList } = {}, over: Parameters<typeof makeHarness>[0] = {}) => {
  const clock = new TestClock(START);
  reader.prs = init.prs ?? [pr(1)];
  reader.setReviews(1, init.reviews ?? []);
  const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader(), ...over });
  h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
  clock.advance(15 * MIN);
  await h.app.githubWatches.tick(); // "Started watching": the first complete read establishes the baseline
  h.transport.clear();
  const step = async () => {
    clock.advance(15 * MIN);
    return h.app.githubWatches.tick();
  };
  return { h, clock, reader, step };
};
const texts = (h: Harness): string[] =>
  h.transport.sent.map((m) => (m as unknown as { message: { embeds?: { description?: string }[] } }).message.embeds?.[0]?.description ?? '');
const summaries = (h: Harness): string[] => texts(h).filter((t) => t.startsWith('Update for'));
const said = (h: Harness): string => summaries(h).join(' ');
const wid = (h: Harness): string => (h.store.db.prepare('SELECT id FROM github_watches').get() as { id: string }).id;
const watch = (h: Harness) => h.store.githubWatches.byId(wid(h))!;
interface Rf { s: string; known: boolean; pb: string | null; x?: string; seen?: string[]; rv: { h: string; at: string; f: string | null; c: string }[] }
const rfOf = (h: Harness, n = 0): Rf => (JSON.parse(watch(h).snapshotJson!) as { prs: { rf: Rf }[] }).prs[n]!.rf;
const claimsOf = (h: Harness, kind: string) => h.store.nativeTransitions.all().filter((c) => c.transition.kind === kind);
const KINDS = ['changes_requested', 'review_approved', 'review_commented', 'review_dismissed'];
const reviewClaims = (h: Harness) => h.store.nativeTransitions.all().filter((c) => KINDS.includes(c.transition.kind));
const keyOf = (state: ReviewObservedState, id: string, n = 1): string =>
  transitionKey(observedReviewTransition(n, hashOf(id), 'provider', state)!);

describe('a new review is told in the state it was submitted in, and claimed in that state only', () => {
  it('tells an approved review and claims the approved key, with the provider submission instant', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))]);
    await step();
    expect(said(h)).toContain('approval submitted on #1');
    expect(reviewClaims(h).map((c) => [c.path, c.state, c.transition.kind, c.transition.state, c.transition.domain, c.transition.hash, c.deliveredTo]))
      .toEqual([['native', 'delivered', 'review_approved', 'APPROVED', 'provider', hashOf('PRR_a'), 'owner_dm']]);
    expect(h.store.db.prepare("SELECT provider_at FROM native_transition_claims WHERE kind = 'review_approved'").get()).toEqual({ provider_at: at(1) });
    h.close();
  });

  it('tells a commented review as a commented review, never as an approval or a requested change', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_c', 'COMMENTED', at(1))]);
    await step();
    expect(said(h)).toContain('commented review submitted on #1');
    expect(said(h)).not.toMatch(/approval|requested changes|dismissed/);
    expect(reviewClaims(h).map((c) => c.transition.kind)).toEqual(['review_commented']);
    h.close();
  });

  it('claims a review first seen DISMISSED only in the dismissed state, and never invents an earlier state', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_d', 'DISMISSED', at(1))]);
    await step();
    expect(said(h)).toContain('review submitted and now dismissed on #1');
    expect(reviewClaims(h).map((c) => c.transition.kind)).toEqual(['review_dismissed']);
    expect(rfOf(h).rv).toMatchObject([{ f: 'D', c: 'D' }]);
    h.close();
  });

  it('claims every new review of one pull request in one segment per state, two in the same second included', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_a1', 'APPROVED', at(1)), rv('PRR_a2', 'APPROVED', at(1)), rv('PRR_c', 'COMMENTED', at(1))]);
    await step();
    expect(said(h).match(/approval submitted on #1/g)).toHaveLength(1);
    expect(claimsOf(h, 'review_approved').map((c) => c.transition.hash).sort()).toEqual([hashOf('PRR_a1'), hashOf('PRR_a2')].sort());
    expect(claimsOf(h, 'review_commented')).toHaveLength(1);
    h.close();
  });

  it('keeps requested changes where they were: the same line and the same existing key', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_r', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(said(h)).toContain('requested changes submitted on #1');
    expect(claimsOf(h, 'changes_requested').map((c) => c.transition)).toMatchObject([{ kind: 'changes_requested', hash: hashOf('PRR_r'), domain: 'provider' }]);
    h.close();
  });

  it('never calls a pending review, or a review already seen, new: a pending one is told once it is submitted', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_p', 'PENDING', null)]);
    await step();
    expect(said(h)).not.toMatch(/review|approval|dismissed/);
    expect(reviewClaims(h)).toEqual([]);
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_p', 'APPROVED', at(2, 30))]);
    await step();
    expect(said(h)).toContain('approval submitted on #1');
    // The same list again: nothing is new.
    h.transport.clear();
    reader.prs = [pr(1, { updatedAt: at(4) })];
    await step();
    expect(said(h)).not.toContain('approval submitted');
    h.close();
  });
});

describe('a dismissal is a state OBSERVATION, never a new submission and never given a time', () => {
  const approvedThenDismissed = async () => {
    const ctx = await start();
    ctx.reader.prs = [pr(1, { updatedAt: at(2) })];
    ctx.reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))]);
    await ctx.step();
    ctx.h.transport.clear();
    ctx.reader.prs = [pr(1, { updatedAt: at(5) })];
    ctx.reader.setReviews(1, [rv('PRR_a', 'DISMISSED', at(1))]);
    await ctx.step();
    return ctx;
  };

  it('tells the dismissal of a known approved review as an observation, claiming only the dismissed state', async () => {
    const { h } = await approvedThenDismissed();
    expect(said(h)).toContain('review dismissed (observed) on #1');
    expect(said(h)).not.toContain('submitted');
    // The approved receipt stands, and the dismissal is a separate key: two tellings of one review.
    expect(reviewClaims(h).map((c) => `${c.transition.kind}:${c.transition.state}`).sort())
      .toEqual(['review_approved:APPROVED', 'review_dismissed:DISMISSED']);
    expect(rfOf(h).rv).toMatchObject([{ h: hashOf('PRR_a'), f: 'A', c: 'D' }]);
    h.close();
  });

  it('records the ORIGINAL submission instant as the review identity and puts no dismissal time anywhere', async () => {
    const { h } = await approvedThenDismissed();
    expect(h.store.db.prepare("SELECT provider_at FROM native_transition_claims WHERE kind = 'review_dismissed'").get()).toEqual({ provider_at: at(1) });
    expect(said(h)).not.toMatch(/\d{4}-\d{2}-\d{2}|dismissed at|dismissed by/);
    h.close();
  });

  it('is told once: the same dismissed review on a later pass is nothing new', async () => {
    const { h, reader, step } = await approvedThenDismissed();
    h.transport.clear();
    reader.prs = [pr(1, { updatedAt: at(6) })];
    await step();
    expect(said(h)).not.toContain('dismissed');
    expect(claimsOf(h, 'review_dismissed')).toHaveLength(1);
    h.close();
  });

  it('observes the dismissal of a requested change too, and a moved-back requested-change instant is no new request', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_r', 'CHANGES_REQUESTED', at(1))]);
    await step();
    h.transport.clear();
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_r', 'DISMISSED', at(1))]);
    await step();
    expect(said(h)).toContain('review dismissed (observed) on #1');
    expect(said(h)).not.toContain('changes requested on #1');
    expect(claimsOf(h, 'review_dismissed')).toHaveLength(1);
    h.close();
  });

  it('uses the state-change wording for a review first seen dismissed when ANY path already delivered another state of it', async () => {
    const { h, reader, step } = await start();
    // The target (or any path) told this very review approved.
    h.store.nativeTransitions.reserveNative(
      OWNER, REPO, observedReviewTransition(1, hashOf('PRR_x'), 'provider', 'APPROVED')!, 'feed_event', 'e0', at(1), at(1), at(0, 30),
    );
    h.store.nativeTransitions.markNativeDelivered('feed_event', 'e0', 'owner_dm', at(1));
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_x', 'DISMISSED', at(0, 30))]);
    await step();
    expect(said(h)).toContain('review dismissed (observed) on #1');
    expect(said(h)).not.toContain('submitted and now dismissed');
    h.close();
  });

  it('does not claim the dismissal of a review known only by identity: its prior state is unproven', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))]);
    await step();
    // Rewrite the stored snapshot into a version 2 one that knows the review by its prefix alone.
    h.transport.clear();
    asVersion2(h, { identityOnly: true });
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_a', 'DISMISSED', at(1))]);
    await step();
    expect(said(h)).not.toMatch(/dismissed|review submitted/);
    expect(claimsOf(h, 'review_dismissed')).toEqual([]);
    expect(rfOf(h).rv).toMatchObject([{ h: hashOf('PRR_a'), f: null, c: 'D' }]);
    h.close();
  });
});

/**
 * Rewrites the stored snapshot into what a version 2 build wrote: the requested-changes `cr` and the identity
 * prefixes `seen`, and the version 2 hash. `identityOnly` knows every review by its prefix alone.
 */
function asVersion2(h: Harness, opts: { identityOnly?: boolean } = {}): void {
  const row = watch(h);
  const snap = JSON.parse(row.snapshotJson!) as { v?: number; prs: Record<string, unknown>[] } & Record<string, unknown>;
  const v2prs = snap.prs.map((p) => {
    const rf = p['rf'] as Rf;
    const cr = opts.identityOnly ? [] : rf.rv.filter((f) => f.c === 'R').map(({ h: hh, at: a }) => ({ h: hh, at: a }));
    return { ...p, rf: { s: rf.s, known: rf.known, seen: rf.rv.map((f) => f.h.slice(0, 32)).sort(), cr } };
  });
  const stored = { ...snap, v: 2, prs: v2prs };
  const { v: _v, prs, ...rest } = stored as { v: number; prs: { rf: { cr: unknown }; [k: string]: unknown }[] } & Record<string, unknown>;
  const projected = { v: 2, ...rest, prs: prs.map(({ rf, ...p }) => ({ ...p, cr: rf.cr })) };
  const hash = createHash('sha256').update(canonicalJson(projected)).digest('hex');
  h.store.db.prepare('UPDATE github_watches SET snapshot_json = ?, snapshot_hash = ? WHERE id = ?').run(canonicalJson(stored), hash, row.id);
}

describe('a version 2 snapshot already proves comparable facts, and the upgrade swallows none of them', () => {
  const base = async (reviews: Review[]) => {
    const ctx = await start(new Reader(), { reviews });
    asVersion2(ctx.h);
    return ctx;
  };

  it('sends nothing for an unchanged repository, and the snapshot becomes version 3 with every review recorded', async () => {
    const { h, step } = await base([rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_ok', 'APPROVED', at(0, 40))]);
    const events = h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get();
    await step();
    expect(sent(h)).toBe('[]');
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get()).toEqual(events);
    expect(JSON.parse(watch(h).snapshotJson!).v).toBe(3);
    // The requested change keeps the state version 2 proved; the approval is known by identity alone.
    expect(rfOf(h).rv.map((f) => [f.h === hashOf('PRR_old') ? 'old' : 'ok', f.f, f.c])).toEqual(expect.arrayContaining([['old', 'R', 'R'], ['ok', null, 'A']]));
    h.close();
  });

  it('tells a genuinely NEW approved review while the version 2 projection is unchanged', async () => {
    const { h, reader, step } = await base([rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))]);
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_new', 'APPROVED', at(2))]);
    await step();
    expect(said(h)).toContain('approval submitted on #1');
    expect(claimsOf(h, 'review_approved').map((c) => c.transition.hash)).toEqual([hashOf('PRR_new')]);
    h.close();
  });

  it('tells a genuinely NEW requested change and a new commented review the version 2 snapshot had not seen', async () => {
    const { h, reader, step } = await base([rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))]);
    reader.setReviews(1, [
      rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_new', 'CHANGES_REQUESTED', at(2)), rv('PRR_c', 'COMMENTED', at(2)),
    ]);
    await step();
    expect(said(h)).toContain('requested changes submitted on #1');
    expect(said(h)).toContain('commented review submitted on #1');
    expect(claimsOf(h, 'changes_requested').map((c) => c.transition.hash)).toEqual([hashOf('PRR_new')]);
    h.close();
  });

  it('claims the dismissal of a requested change version 2 recorded, which proves its earlier state', async () => {
    const { h, reader, step } = await base([rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))]);
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_old', 'DISMISSED', at(0, 30))]);
    await step();
    expect(said(h)).toContain('review dismissed (observed) on #1');
    expect(claimsOf(h, 'review_dismissed').map((c) => c.transition.hash)).toEqual([hashOf('PRR_old')]);
    h.close();
  });

  it('keeps a version 2 snapshot that was refused (a review left) refused rather than forgetting it', async () => {
    const { h, reader, step } = await base([rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_ok', 'APPROVED', at(0, 40))]);
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))]);
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'unavailable', x: 'left' });
    h.close();
  });
});
const sent = (h: Harness): string => JSON.stringify(h.transport.sent);

describe('the provider lifecycle is assumed, enforced and counted, never guessed', () => {
  const REFUSED: [string, string][] = [
    ['APPROVED', 'CHANGES_REQUESTED'], ['CHANGES_REQUESTED', 'APPROVED'], ['COMMENTED', 'APPROVED'],
    ['COMMENTED', 'CHANGES_REQUESTED'], ['DISMISSED', 'APPROVED'], ['DISMISSED', 'COMMENTED'], ['DISMISSED', 'CHANGES_REQUESTED'],
    ['APPROVED', 'COMMENTED'],
  ];
  it.each(REFUSED)('refuses %s then %s: carries the proven facts, tells nothing and counts it', async (first, second) => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_x', first, at(1))]);
    await step();
    h.transport.clear();
    const claimsBefore = reviewClaims(h).length;
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_x', second, at(1))]);
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'unavailable', x: 'lifecycle', known: true });
    expect(rfOf(h).rv).toHaveLength(1);
    expect(rfOf(h).rv[0]!.c).not.toBe(second === 'DISMISSED' ? 'X' : second === 'APPROVED' ? 'A' : second === 'COMMENTED' ? 'C' : 'R');
    expect(reviewClaims(h)).toHaveLength(claimsBefore);
    expect(said(h)).not.toMatch(/review submitted|approval submitted|requested changes submitted|dismissed/);
    expect(h.app.githubWatches.statusNotes()).toMatch(/1 pull request\(s\) refused for exact review facts/);
    h.close();
  });

  it.each([['APPROVED'], ['CHANGES_REQUESTED'], ['COMMENTED']])('allows %s then DISMISSED', async (first) => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_x', first, at(1))]);
    await step();
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_x', 'DISMISSED', at(1))]);
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'complete' });
    expect(rfOf(h).x).toBeUndefined();
    expect(claimsOf(h, 'review_dismissed')).toHaveLength(1);
    h.close();
  });

  it('refuses a review that LEFT the list, never reading its return as a new review, and keeps its identity', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1)), rv('PRR_b', 'APPROVED', at(1, 10))]);
    await step();
    h.transport.clear();
    const claims = reviewClaims(h).length;
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))]); // PRR_b is gone
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'unavailable', x: 'left' });
    expect(rfOf(h).rv.map((f) => f.h).sort()).toEqual([hashOf('PRR_a'), hashOf('PRR_b')].sort());
    reader.prs = [pr(1, { updatedAt: at(4) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1)), rv('PRR_b', 'APPROVED', at(1, 10))]); // and it returns
    await step();
    expect(reviewClaims(h)).toHaveLength(claims);
    expect(said(h)).not.toContain('approval submitted');
    expect(rfOf(h)).toMatchObject({ s: 'complete' });
    expect(rfOf(h).x).toBeUndefined();
    h.close();
  });

  it('tells nothing for a state word it does not know, and never calls a known review a conflict into one it cannot read', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_u', 'SOMETHING_NEW', at(1))]);
    await step();
    expect(said(h)).not.toMatch(/submitted|dismissed/);
    expect(reviewClaims(h)).toEqual([]);
    // An unknown state never conflicts: it may become anything.
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_u', 'APPROVED', at(1))]);
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'complete' });
    expect(rfOf(h).x).toBeUndefined();
    h.close();
  });

  it('treats a purported submitted review with no id, or no submission instant, as an unavailable read', async () => {
    for (const bad of [{ state: 'APPROVED', submittedAt: at(1) }, { id: 'PRR_x', state: 'APPROVED', submittedAt: null }]) {
      const { h, reader, step } = await start();
      reader.prs = [pr(1, { updatedAt: at(2) })];
      reader.setReviews(1, [bad]);
      await step();
      expect(rfOf(h).s).toBe('unavailable');
      expect(reviewClaims(h)).toEqual([]);
      h.close();
    }
  });
});

describe('a recovered read compares with the last proven set, so a review that arrived in the gap is told once', () => {
  it('tells an approved review that arrived while the exact list was unavailable, and invents nothing', async () => {
    const { h, reader, step } = await start(new Reader(), { reviews: [rv('PRR_old', 'APPROVED', at(0, 30))] });
    reader.failReviews = true;
    reader.prs = [pr(1, { updatedAt: at(2) })];
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'unavailable', known: true });
    reader.failReviews = false;
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_old', 'APPROVED', at(0, 30)), rv('PRR_gap', 'APPROVED', at(1))]);
    await step();
    expect(claimsOf(h, 'review_approved').map((c) => c.transition.hash)).toEqual([hashOf('PRR_gap')]);
    expect(said(h).match(/approval submitted on #1/g)).toHaveLength(1);
    h.close();
  });

  it('carries the last boundary through a gap and writes a new one only beside a complete set', async () => {
    const { h, reader, step } = await start(new Reader(), { reviews: [] });
    const first = rfOf(h);
    expect(first.pb).not.toBeNull();
    reader.failReviews = true;
    await step();
    expect(rfOf(h)).toMatchObject({ s: 'unavailable', pb: first.pb });
    reader.failReviews = false;
    await step();
    expect(rfOf(h).s).toBe('complete');
    expect(rfOf(h).pb).not.toBe(first.pb);
    h.close();
  });
});

describe('a decision is a value only from a read that carried it, and is never a review', () => {
  const decided = async (value: string | undefined) => {
    const reader = new Reader();
    const ctx = await start(reader, { prs: [pr(1, value === undefined ? {} : { reviewDecision: value })] });
    return { ...ctx, reader };
  };

  it('tells a change between two read values as a decision, claims nothing and is not suppressed by a review beside it', async () => {
    const { h, reader, step } = await decided('REVIEW_REQUIRED');
    reader.prs = [pr(1, { updatedAt: at(2), reviewDecision: 'APPROVED' })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))]);
    await step();
    // BOTH are said: the decision, and the review that was submitted beside it. No cause is asserted.
    expect(said(h)).toContain('review decision now approved: #1');
    expect(said(h)).toContain('approval submitted on #1');
    expect(reviewClaims(h).map((c) => c.transition.kind)).toEqual(['review_approved']);
    h.close();
  });

  it('says nothing for a pull request new to the list, and nothing when the previous decision was never read', async () => {
    const first = await decided(undefined);
    first.reader.prs = [pr(1, { updatedAt: at(2), reviewDecision: 'APPROVED' })];
    await first.step();
    expect(said(first.h)).not.toContain('review decision');
    first.h.close();
    const second = await decided('REVIEW_REQUIRED');
    second.reader.prs = [pr(1, { updatedAt: at(2), reviewDecision: 'REVIEW_REQUIRED' }), pr(2, { updatedAt: at(2), reviewDecision: 'APPROVED' })];
    await second.step();
    expect(said(second.h)).not.toContain('review decision');
    second.h.close();
  });

  it('carries the last proven decision when a read omits it or reports it empty, so recovery is no decision change', async () => {
    const { h, reader, step } = await decided('APPROVED');
    reader.prs = [pr(1, { updatedAt: at(2) })]; // the field is absent
    await step();
    const stored = (JSON.parse(watch(h).snapshotJson!) as { prs: { reviewDecision: string }[] }).prs[0]!;
    expect(stored.reviewDecision).toBe('APPROVED');
    reader.prs = [pr(1, { updatedAt: at(3), reviewDecision: '' })]; // present but empty
    await step();
    reader.prs = [pr(1, { updatedAt: at(4), reviewDecision: 'APPROVED' })];
    await step();
    expect(said(h)).not.toContain('review decision');
    h.close();
  });

  it('words each value as a decision state', async () => {
    const { h, reader, step } = await decided('APPROVED');
    reader.prs = [pr(1, { updatedAt: at(2), reviewDecision: 'CHANGES_REQUESTED' })];
    await step();
    expect(said(h)).toContain('review decision now changes requested: #1');
    h.close();
  });
});

describe('per-author lines name no review, are reconciled only against shown exact facts, and are remembered once delivered', () => {
  const perAuthor = (approvedAt: string, extra: Partial<PrReviews> = {}): Partial<PrReviews> => ({
    latestReviews: [{ state: 'APPROVED', submittedAt: approvedAt }], ...extra,
  });

  it('leaves the approvals line out when a COMPLETE comparable observation names the same-class review exactly', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))]);
    await step();
    expect(said(h)).toContain('approval submitted on #1');
    expect(said(h)).not.toContain('approvals recorded');
    expect(h.store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 0, notProvablyShown: 0 });
    h.close();
  });

  it('tells it, labelled, when the exact list is unavailable, and records it durably only once DELIVERED', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, undefined, perAuthor(at(1)));
    await step();
    expect(said(h)).toContain('approvals recorded on #1 (reviewer summary only)');
    expect(h.store.githubWatches.gapMarkers(OWNER, 10)).toMatchObject([
      { pr: 1, reviewClass: 'approval', reason: 'unavailable', shown: 'shown', repoKey: REPO },
    ]);
    h.close();
  });

  it('labels a truncated list and a pull request with no comparable baseline, each with its own reason', async () => {
    const trunc = await start(new Reader(), { reviews: [rv('PRR_old', 'APPROVED', at(0, 30))] });
    trunc.reader.prs = [pr(1, { updatedAt: at(2) })];
    trunc.reader.setReviews(1, Array.from({ length: 100 }, (_, i) => rv(`PRR_${i}`, 'COMMENTED', at(1))), {
      latestReviews: [{ state: 'APPROVED', submittedAt: at(0, 30) }, { state: 'APPROVED', submittedAt: at(1) }],
    });
    await trunc.step();
    expect(trunc.h.store.githubWatches.gapMarkers(OWNER, 10).map((m) => m.reason)).toEqual(['truncated']);
    trunc.h.close();

    // A pull request that enters the list has no previous exact set: its first complete read has no baseline.
    const fresh = await start(new Reader());
    fresh.reader.prs = [pr(1), pr(2, { updatedAt: at(2) })];
    fresh.reader.setReviews(2, [rv('PRR_n', 'APPROVED', at(1))], perAuthor(at(1)));
    await fresh.step();
    expect(fresh.h.store.githubWatches.gapMarkers(OWNER, 10).map((m) => [m.pr, m.reason])).toEqual([]);
    fresh.h.close();
  });

  it('writes nothing for a send that failed or an outbox row that was abandoned, and keeps it through a cancel and retention', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, undefined, perAuthor(at(1)));
    h.transport.failSends = true;
    await step();
    expect(h.store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 0, notProvablyShown: 0 });
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events WHERE gap_markers IS NOT NULL').get()).toEqual({ n: 1 });
    // The retry succeeds: only now is the evidence durable.
    h.transport.failSends = false;
    await step();
    expect(h.store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 1, notProvablyShown: 0 });
    const before = h.store.db.prepare('SELECT * FROM github_watch_gap_markers').all();
    // Cancel the watch and let retention delete its delivered outbox rows and the watch itself.
    h.app.githubWatches.cancel(h.owner, h.store.githubWatches.byId(wid(h))!.publicId);
    const old = new Date(Date.now() + 400 * 86_400_000).toISOString();
    const policy = {
      enabled: true, jobMetadataDays: 90, jobDetailDays: 30, doneCaptureDays: 365, closedTaskDays: 90,
      closedReminderDays: 90, pastScheduleDays: 180, auditDays: 90, watchEventDays: 0, idempotencyDays: 7,
      cancelledWatchDays: 0, runLogDays: 365, conversationOwnerDays: 30, conversationOtherDays: 7,
      closedThreadDays: 14, batch: 200,
    };
    void old;
    await new RetentionService({ store: h.store, policy }).tick();
    expect(h.store.db.prepare('SELECT * FROM github_watch_gap_markers').all()).toEqual(before);
    expect(h.app.githubWatches.statusNotes()).toMatch(/1 per-author review line\(s\) were delivered without exact review identity/);
    h.close();
  });

  it('writes nothing for an outbox row abandoned after its attempts were spent', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, undefined, perAuthor(at(1)));
    h.transport.failSends = true;
    for (let i = 0; i < 12; i += 1) await step();
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events WHERE abandoned_at IS NOT NULL AND delivered_at IS NULL').get())
      .toMatchObject({ n: expect.any(Number) });
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events WHERE abandoned_at IS NOT NULL AND gap_markers IS NOT NULL').get())
      .toEqual({ n: 1 });
    expect(h.store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 0, notProvablyShown: 0 });
    h.close();
  });

  it('does not clear a marker when the exact list recovers', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, undefined, perAuthor(at(1)));
    await step();
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_a', 'APPROVED', at(1))], perAuthor(at(1)));
    await step();
    expect(h.store.githubWatches.gapMarkerCounts(OWNER)).toEqual({ shown: 1, notProvablyShown: 0 });
    h.close();
  });

  it('tells a requested-changes line only for a STRICTLY later instant, and never for a pull request new to the list', async () => {
    const { h, reader, step } = await start(new Reader(), { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(1))] });
    const crView = (when: string) => ({ latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: when }] });
    // An equal instant, and one that moved back (a dismissal), say nothing.
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(1))], crView(at(1)));
    await step();
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(1))], crView(at(0, 30)));
    await step();
    expect(said(h)).not.toContain('changes requested on');
    // A later one is told, as a reviewer summary naming no review.
    reader.prs = [pr(1, { updatedAt: at(4) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(1))], crView(at(3)));
    await step();
    expect(said(h)).toContain('changes requested on #1');
    expect(reviewClaims(h)).toEqual([]); // a per-author line names no review and claims none
    // A new pull request that already has a change request has no comparable baseline.
    h.transport.clear();
    reader.prs = [pr(1, { updatedAt: at(4) }), pr(2, { updatedAt: at(5) })];
    reader.setReviews(2, [rv('PRR_n', 'CHANGES_REQUESTED', at(4))], crView(at(4)));
    await step();
    expect(said(h)).not.toContain('changes requested on #2');
    h.close();
  });

  it('sends no generic message when only review counts moved, and still advances the snapshot', async () => {
    const { h, reader, step } = await start(new Reader(), { reviews: [] });
    reader.prs = [pr(1)];
    reader.setReviews(1, [], { commits: [{ oid: 'c1' }, { oid: 'c2' }] });
    const before = watch(h).snapshotHash;
    await step();
    expect(summaries(h)).toEqual([]);
    expect(watch(h).snapshotHash).not.toBe(before);
    h.close();
  });
});

describe('what the imported target delivered, holds or is sending, per observed state', () => {
  const targetFacts = (kind: 'review_approved' | 'review_commented', over: Record<string, unknown> = {}) => ({
    kind, identity: '1:review:77', occurredAt: at(1), providerHash: null as string | null, attempt: null,
    providerState: kind === 'review_approved' ? 'APPROVED' : 'COMMENTED', providerAt: at(1), createdAt: at(1), ...over,
  });
  const targetTold = (h: Harness, f: ReturnType<typeof targetFacts>, ref = 'e1', deliver = true) => {
    const out = h.store.nativeTransitions.reserveTarget(OWNER, REPO, f, 'target_alert', ref, at(9));
    if (deliver) h.store.nativeTransitions.markTargetDelivered('target_alert', ref, at(9));
    return out;
  };
  const newApproved = async (ctx: Awaited<ReturnType<typeof start>>, id = 'PRR_new', when = at(1)) => {
    ctx.reader.prs = [pr(1, { updatedAt: at(2) })];
    ctx.reader.setReviews(1, [rv(id, 'APPROVED', when)]);
    return ctx.step();
  };

  it('does not tell, and does not claim, a review the target delivered under the same provider hash', async () => {
    const ctx = await start();
    targetTold(ctx.h, targetFacts('review_approved', { providerHash: hashOf('PRR_new') }));
    await newApproved(ctx);
    expect(said(ctx.h)).not.toMatch(/approval|review submitted/);
    expect(reviewClaims(ctx.h).map((c) => c.path)).toEqual(['target']);
    expect(rfOf(ctx.h).rv).toHaveLength(1); // the snapshot advanced: the review is known
    ctx.h.close();
  });

  it('defers the WHOLE observation while the target is sending that review, then tells it after a failed send releases', async () => {
    const ctx = await start();
    targetTold(ctx.h, targetFacts('review_approved', { providerHash: hashOf('PRR_new') }), 'e1', false);
    const before = watch(ctx.h);
    const out = await newApproved(ctx);
    expect(out.deferred).toBe(1);
    expect(watch(ctx.h).snapshotJson).toBe(before.snapshotJson);
    ctx.h.store.nativeTransitions.releaseTarget('target_alert', 'e1');
    await ctx.step();
    expect(said(ctx.h)).toContain('approval submitted on #1');
    ctx.h.close();
  });

  it('HOLDS a review it cannot tell from one the target delivered without a comparable id, and tells the rest', async () => {
    const ctx = await start();
    // The target's row carried no provider hash: its identity is its own source identity, never equal to ours.
    targetTold(ctx.h, targetFacts('review_approved', { createdAt: at(1, 30) }));
    ctx.reader.prs = [pr(1, { updatedAt: at(2), title: 'Renamed' })];
    ctx.reader.setReviews(1, [rv('PRR_new', 'APPROVED', at(1))]);
    await ctx.step();
    expect(said(ctx.h)).toContain('pull request update(s)');
    expect(said(ctx.h)).not.toContain('approval submitted');
    expect(ctx.h.store.githubWatches.heldCount(OWNER)).toBe(1);
    expect(ctx.h.store.githubWatches.heldReviews(10)).toMatchObject([{ heldKey: keyOf('APPROVED', 'PRR_new'), providerAt: at(1) }]);
    expect(reviewClaims(ctx.h).filter((c) => c.path === 'native')).toEqual([]);
    expect(ctx.h.app.githubWatches.statusNotes()).toMatch(/1 review fact\(s\) HELD and NOT sent/);
    ctx.h.close();
  });

  it('tells a review the target provably delivered BEFORE the previous complete read began (the boundary proof)', async () => {
    const ctx = await start();
    // Committed long before the baseline read began (START + 15 min): that review is in the baseline set.
    targetTold(ctx.h, targetFacts('review_approved', { createdAt: '2026-08-31T23:00:00.000Z' }));
    await newApproved(ctx);
    expect(said(ctx.h)).toContain('approval submitted on #1');
    expect(ctx.h.store.githubWatches.heldCount(OWNER)).toBe(0);
    ctx.h.close();
  });

  it('never applies the boundary proof to a known review changing state', async () => {
    const ctx = await start();
    ctx.reader.prs = [pr(1, { updatedAt: at(2) })];
    ctx.reader.setReviews(1, [rv('PRR_x', 'APPROVED', at(1))]);
    await ctx.step();
    ctx.h.transport.clear();
    targetTold(ctx.h, targetFacts('review_commented', { providerState: 'DISMISSED', createdAt: '2026-08-31T23:00:00.000Z', providerAt: at(1) }), 'e2');
    ctx.reader.prs = [pr(1, { updatedAt: at(3) })];
    ctx.reader.setReviews(1, [rv('PRR_x', 'DISMISSED', at(1))]);
    await ctx.step();
    expect(said(ctx.h)).not.toContain('dismissed');
    expect(ctx.h.store.githubWatches.heldReviews(10)).toMatchObject([{ heldKey: keyOf('DISMISSED', 'PRR_x') }]);
    ctx.h.close();
  });

  it('tells an approved review even when the target delivered the same review DISMISSED: another state, another telling', async () => {
    const ctx = await start();
    targetTold(ctx.h, targetFacts('review_commented', { providerHash: hashOf('PRR_new'), providerState: 'DISMISSED' }));
    await newApproved(ctx);
    expect(said(ctx.h)).toContain('approval submitted on #1');
    expect(ctx.h.store.githubWatches.heldCount(OWNER)).toBe(0);
    ctx.h.close();
  });

  it('is isolated by repository: a delivery for another repository never holds or hides a review here', async () => {
    const ctx = await start();
    ctx.h.store.nativeTransitions.reserveTarget(OWNER, 'acme/other', targetFacts('review_approved', { providerHash: hashOf('PRR_new') }), 'target_alert', 'e1', at(9));
    ctx.h.store.nativeTransitions.markTargetDelivered('target_alert', 'e1', at(9));
    await newApproved(ctx);
    expect(said(ctx.h)).toContain('approval submitted on #1');
    ctx.h.close();
  });
});

describe('a per-author line is shown after all when the exact fact that stood for it was not conveyed', () => {
  const longTitle = (n: number, len: number) => `${'long title '.repeat(30)}${n}`.slice(0, len);
  const scenario = async (len: number, pad: number) => {
    const reader = new Reader();
    const clock = new TestClock(START);
    const list = (f: (n: number) => Partial<PrList[number]>): PrList => [1, 2, 3, 4, 5].map((n) => pr(n, { title: longTitle(n, len), ...f(n) }));
    reader.prs = list(() => ({ reviewDecision: 'REVIEW_REQUIRED' }));
    for (let n = 1; n <= 5; n += 1) reader.setReviews(n, []);
    const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    h.transport.clear();
    reader.prs = list((n) => ({ updatedAt: at(1 + n), mergedAt: at(1 + n), state: 'MERGED' }));
    for (let n = 1; n <= 5; n += 1) {
      reader.setReviews(n, [rv(`PRR_${n}`, 'APPROVED', at(1))]);
    }
    // A decision word of `pad` characters sits BEFORE the exact lines and moves the clamp across a segment by exactly that much.
    reader.prs = reader.prs.map((p) => (p.number === 1 ? { ...p, reviewDecision: 'X'.repeat(pad + 1) } : p));
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    const text = summaries(h)[0]!;
    const shownExact = [1, 2, 3, 4, 5].filter((n) => new RegExp(`approval submitted on [^.]*#${n}(?![0-9])`).test(text));
    const claimed = claimsOf(h, 'review_approved').filter((c) => c.path === 'native').map((c) => Number(c.transition.item)).sort();
    const perAuthorShown = [1, 2, 3, 4, 5].filter((n) => new RegExp(`approvals recorded on [^.]*#${n}(?![0-9])`).test(text));
    const markers = h.store.githubWatches.gapMarkers(OWNER, 20);
    h.close();
    return { text, shownExact, claimed, perAuthorShown, markers };
  };

  it('claims exactly the exact segments shown, and shows the per-author line for every pull request whose exact segment was cut off', async () => {
    let exercised = 0;
    for (const [len, pad] of Array.from({ length: 20 }, (_, i) => [171, 14 + i] as const)) {
      const { text, shownExact, claimed, perAuthorShown } = await scenario(len, pad);
      expect(text.length, `len ${len} pad ${pad}`).toBeLessThanOrEqual(1200);
      // A receipt exists for exactly the segments the owner can read.
      expect(claimed, `len ${len} pad ${pad}`).toEqual(shownExact);
      // A pull request whose exact segment was cut off is never left with neither it nor its per-author line.
      const cut = [1, 2, 3, 4, 5].filter((n) => !shownExact.includes(n));
      // ... unless the clamp ate the per-author line too (the text then ends in the cut): that is clipping loss, named
      // as a required blocker, and it can only happen at the very end of a full summary.
      for (const n of cut) {
        if (!perAuthorShown.includes(n)) expect(text.endsWith('…'), `len ${len} pad ${pad} #${n}`).toBe(true);
      }
      // And one whose exact segment IS shown has no per-author line repeating it.
      for (const n of shownExact) expect(perAuthorShown, `len ${len} pad ${pad} #${n}`).not.toContain(n);
      if (cut.length > 0) exercised += 1;
    }
    // The clamp really cut an exact segment off in at least one of those cases, so the rule was exercised.
    expect(exercised).toBeGreaterThan(0);
  });
});

describe('redaction that changes the summary claims nothing and brings the per-author lines back', () => {
  it('claims no exact review when a private-key block swallows segments, and still says the per-author line', async () => {
    const reader = new Reader();
    const clock = new TestClock(START);
    const begin = '-----BEGIN PRIVATE KEY-----';
    const end = '-----END PRIVATE KEY-----';
    reader.prs = [pr(1, { title: `a ${begin}` }), pr(2, { title: `b ${end}` })];
    reader.setReviews(1, []);
    reader.setReviews(2, []);
    const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    h.transport.clear();
    reader.prs = [pr(1, { title: `a ${begin}`, updatedAt: at(2) }), pr(2, { title: `b ${end}`, updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_1', 'APPROVED', at(1))]);
    reader.setReviews(2, [rv('PRR_2', 'APPROVED', at(1))]);
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    expect(claimsOf(h, 'review_approved').filter((c) => c.path === 'native')).toEqual([]);
    expect(said(h)).toMatch(/approvals recorded on #1, #2|approvals recorded on #1/);
    h.close();
  });
});

describe('the ordinary summary names a COMMENTED review, and no conversation comment is one', () => {
  /** The watch must have READ a comment count before a rise in it is a change. */
  const withCommentBaseline = async (h: Harness, reader: Reader, step: () => Promise<unknown>) => {
    reader.prs = [pr(1, { updatedAt: at(0, 30) })];
    reader.setReviews(1, [], { comments: [] });
    await step();
    h.transport.clear();
  };

  it('does not move on a conversation comment, and a conversation comment claims nothing', async () => {
    const { h, reader, step } = await start();
    await withCommentBaseline(h, reader, step);
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [], { comments: [{ author: { login: 'someone' } }] });
    await step();
    expect(said(h)).toContain('new conversation comment(s) on #1');
    expect(said(h)).not.toContain('commented review');
    expect(reviewClaims(h)).toEqual([]);
    h.close();
  });

  it('keeps a submitted commented review apart from the conversation-comment count in the same pass', async () => {
    const { h, reader, step } = await start();
    await withCommentBaseline(h, reader, step);
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_c', 'COMMENTED', at(1))], { comments: [{ author: { login: 'someone' } }] });
    await step();
    expect(said(h)).toContain('commented review submitted on #1');
    expect(said(h)).toContain('new conversation comment(s) on #1');
    expect(reviewClaims(h).map((c) => c.transition.kind)).toEqual(['review_commented']);
    h.close();
  });
});

describe('a target source-identity claim is told apart from a native provider claim by domain', () => {
  it('never equates the two hashes, even for one review', () => {
    const provider = observedReviewTransition(1, hashOf('PRR_x'), 'provider', 'APPROVED')!;
    const source = observedReviewTransition(1, hashSourceIdentity('1:review:77', 'APPROVED'), 'source_identity', 'APPROVED')!;
    expect(transitionKey(provider)).not.toBe(transitionKey(source));
    expect(provider.hash).not.toBe(source.hash);
  });
});
