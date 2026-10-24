import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashProviderRef, transitionKey, type PrList, type PrReviews } from '@ducky/contracts';
import type { RepoRef } from '@ducky/adapters';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { githubWatchDm } from '../src/discord/assistant-presenters.js';

/**
 * The exact requested-changes protocol of the ordinary watch (ADR 0034): which submitted reviews are new,
 * when a review can be told or must be held, and what a failed read can and cannot prove. Invented data.
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
  /** The exact list, and the per-author view the older fields read, from one set of reviews. */
  setReviews(n: number, reviews: Review[] | undefined, extra: Partial<PrReviews> = {}): void {
    const latest = reviews === undefined ? [] : reviews;
    this.reviews.set(n, {
      number: n,
      ...(reviews === undefined ? {} : { reviews }),
      latestReviews: latest.filter((r) => r.state !== 'PENDING'),
      ...extra,
    });
  }
}

const start = async (reader = new Reader(), init: { reviews?: Review[] } = {}) => {
  const clock = new TestClock(START);
  reader.prs = [pr(1)];
  reader.setReviews(1, init.reviews ?? []);
  const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
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
const sent = (h: Harness): string => JSON.stringify(h.transport.sent);
/** The owner-facing text of every message sent, and just the repository-update summaries among them. */
const texts = (h: Harness): string[] =>
  h.transport.sent.map((m) => (m as unknown as { message: { embeds?: { description?: string }[] } }).message.embeds?.[0]?.description ?? '');
const summaries = (h: Harness): string[] => texts(h).filter((t) => t.startsWith('Update for'));
const crClaims = (h: Harness) => h.store.nativeTransitions.all().filter((c) => c.transition.kind === 'changes_requested');
const wid = (h: Harness): string => (h.store.db.prepare('SELECT id FROM github_watches').get() as { id: string }).id;
const watch = (h: Harness) => h.store.githubWatches.byId(wid(h))!;
const facts = (id: string, at_: string, n = 1) => ({
  kind: 'review_requested_changes' as const, identity: `${n}:review:99`, occurredAt: at_, providerHash: hashOf(id), attempt: null,
});
const targetDelivered = (h: Harness, id: string, at_: string, ref = 'e1', n = 1): void => {
  h.store.nativeTransitions.reserveTarget(OWNER, REPO, facts(id, at_, n), 'target_alert', ref, at(9));
  h.store.nativeTransitions.markTargetDelivered('target_alert', ref, at(9));
};

describe('a new requested-changes review is told exactly, and only that review', () => {
  it('names the pull request, claims the new review and none of the old ones', async () => {
    const { h, reader, step } = await start(undefined, { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))] });
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(sent(h)).toContain('requested changes submitted on #1');
    // Not also the aggregate line for the same event.
    expect(sent(h)).not.toContain('changes requested on #1');
    const claims = crClaims(h);
    expect(claims.map((c) => `${c.path}:${c.via}:${c.state}:${c.transition.hash}`)).toEqual([
      `native:watch_summary:delivered:${hashOf('PRR_new')}`,
    ]);
    // The raw id never reaches a table: only its hash.
    expect(JSON.stringify(h.store.nativeTransitions.all())).not.toContain('PRR_new');
    expect(watch(h).snapshotJson).not.toContain('PRR_new');
    h.close();
  });

  it('claims every new review of one pull request, including two in the same second, in one segment', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_a', 'CHANGES_REQUESTED', at(1)), rv('PRR_b', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(sent(h).match(/requested changes submitted on #1/g)).toHaveLength(1);
    expect(crClaims(h).map((c) => c.transition.hash).sort()).toEqual([hashOf('PRR_a'), hashOf('PRR_b')].sort());
    h.close();
  });

  it('keeps a PR-level decision with no new review as a distinct line with NO review claim', async () => {
    const { h, reader, step } = await start(undefined, { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))] });
    // The per-author view moves (a later timestamp) but the exact list holds no new review.
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))], {
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(1) }],
    });
    await step();
    expect(sent(h)).toContain('changes requested on #1');
    expect(sent(h)).not.toContain('requested changes submitted');
    expect(crClaims(h)).toEqual([]);
    h.close();
  });

  it('is told through the sanitized message: the claimed segment is in what the owner reads', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    await step();
    const row = h.store.githubWatches.byId(wid(h))!;
    const event = {
      id: 'x', watchId: row.id, publicWatchId: row.publicId, discordUserId: OWNER, repoSlug: 'demo', fingerprint: 'f',
      summary: summaries(h)[0]!,
      createdAt: at(2), deliveredAt: null, attempts: 0, lastAttemptAt: null, abandonedAt: null, repoKey: REPO,
    };
    const out = sanitizeOutbound(githubWatchDm(event));
    expect(out.embeds![0]!.description).toContain('requested changes submitted on #1');
    h.close();
  });
});

describe('a review is never inferred without a proven baseline', () => {
  it('establishes silently the first complete set of a pull request that enters the list: no exact claim', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1), pr(2, { updatedAt: at(2), createdAt: '2026-08-02T00:00:00Z' })];
    reader.setReviews(2, [rv('PRR_x', 'CHANGES_REQUESTED', at(1))], {
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(1) }],
    });
    await step();
    expect(crClaims(h)).toEqual([]);
    expect(sent(h)).not.toContain('requested changes submitted');
    h.close();
  });

  it('never calls an already-seen review new when its STATE changes', async () => {
    const { h, reader, step } = await start(undefined, { reviews: [rv('PRR_s', 'COMMENTED', at(0, 30))] });
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_s', 'CHANGES_REQUESTED', at(0, 30))]);
    await step();
    expect(crClaims(h)).toEqual([]);
    expect(sent(h)).not.toContain('requested changes submitted');
    h.close();
  });

  it('ignores a pending review and one with no submission instant, and tells it once it is submitted', async () => {
    const { h, reader, step } = await start();
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_p', 'PENDING', null), rv('PRR_q', 'CHANGES_REQUESTED', null)]);
    await step();
    expect(crClaims(h)).toEqual([]);
    expect(watch(h).snapshotJson).not.toContain(hashOf('PRR_p').slice(0, 32));
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_p', 'CHANGES_REQUESTED', at(2, 30))]);
    await step();
    expect(sent(h)).toContain('requested changes submitted on #1');
    expect(crClaims(h).map((c) => c.transition.hash)).toEqual([hashOf('PRR_p')]);
    h.close();
  });
});

describe('an unavailable or truncated read proves nothing and absorbs nothing', () => {
  it('carries the older fields forward: recovery repeats no "changes requested" and invents no comments', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader);
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(1))], {
      comments: [{ author: { login: 'a' } }, { author: { login: 'b' } }],
      commits: [{ oid: 'c1' }],
    });
    await step();
    h.transport.clear();
    const stored = watch(h).snapshotJson;
    reader.failReviews = true;
    reader.prs = [pr(1, { updatedAt: at(3) })];
    await step();
    h.transport.clear();
    const gap = JSON.parse(watch(h).snapshotJson!) as { prs: Record<string, unknown>[] };
    const before = JSON.parse(stored!) as { prs: Record<string, unknown>[] };
    for (const k of ['approvals', 'changesRequested', 'reviewComments', 'commits', 'latestChangeRequestAt']) {
      expect(gap.prs[0]![k], k).toEqual(before.prs[0]![k]);
    }
    expect(gap.prs[0]!['rf']).toMatchObject({ s: 'unavailable', known: true, cr: [{ h: hashOf('PRR_old') }] });
    // Recovery with the very same reviews: nothing is told as new.
    reader.failReviews = false;
    reader.prs = [pr(1, { updatedAt: at(3) })];
    await step();
    expect(sent(h)).not.toMatch(/conversation comment|changes requested|requested changes submitted/);
    h.close();
  });

  it('an unavailable read and its recovery alone create no generic snapshot message', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader, { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))] });
    const events = h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get();
    reader.failReviews = true;
    await step();
    reader.failReviews = false;
    await step();
    expect(sent(h)).toBe('[]');
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get()).toEqual(events);
    h.close();
  });

  it('tells a review that arrived DURING the gap when a complete read returns, once', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader, { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))] });
    reader.failReviews = true;
    await step();
    reader.failReviews = false;
    reader.prs = [pr(1, { updatedAt: at(4) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_gap', 'CHANGES_REQUESTED', at(2))]);
    await step();
    expect(sent(h)).toContain('requested changes submitted on #1');
    expect(crClaims(h).map((c) => c.transition.hash)).toEqual([hashOf('PRR_gap')]);
    h.transport.clear();
    await step();
    expect(sent(h)).toBe('[]');
    h.close();
  });

  it('establishes silently when no complete set ever existed, then tells the next new review', async () => {
    const reader = new Reader();
    reader.failReviews = true; // the very first observation cannot read reviews
    const { h, step } = await start(reader);
    expect((JSON.parse(watch(h).snapshotJson!) as { prs: { rf: { known: boolean } }[] }).prs[0]!.rf.known).toBe(false);
    reader.failReviews = false;
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))], {
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(0, 30) }],
    });
    await step();
    // No baseline, so nothing exact and nothing falsely "new".
    expect(crClaims(h)).toEqual([]);
    expect(sent(h)).not.toMatch(/conversation comment|requested changes submitted|changes requested/);
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_next', 'CHANGES_REQUESTED', at(2))]);
    await step();
    expect(crClaims(h).map((c) => c.transition.hash)).toEqual([hashOf('PRR_next')]);
    h.close();
  });

  it('a truncated list (100 reviews or more) infers nothing, carries the last facts and is counted in /status', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader, { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))] });
    reader.prs = [pr(1, { updatedAt: at(2) })];
    const many = Array.from({ length: 100 }, (_, i) => rv(`PRR_${i}`, 'COMMENTED', at(1)));
    reader.setReviews(1, [...many, rv('PRR_brand_new', 'CHANGES_REQUESTED', at(1, 30))].slice(0, 100));
    await step();
    expect(crClaims(h)).toEqual([]);
    const rf = (JSON.parse(watch(h).snapshotJson!) as { prs: { rf: { s: string; cr: { h: string }[] } }[] }).prs[0]!.rf;
    expect(rf).toMatchObject({ s: 'truncated', cr: [{ h: hashOf('PRR_old') }] });
    expect(h.app.githubWatches.statusNotes()).toMatch(/1 pull request\(s\) have 100 or more reviews/);
    expect(h.app.githubWatches.statusNotes()).not.toMatch(/PRR|acme|PR 1/);
    h.close();
  });

  it('a review with no id that asked for changes makes the read unusable for exact facts', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader);
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [{ state: 'CHANGES_REQUESTED', submittedAt: at(1) }]);
    await step();
    expect((JSON.parse(watch(h).snapshotJson!) as { prs: { rf: { s: string } }[] }).prs[0]!.rf.s).toBe('unavailable');
    expect(crClaims(h)).toEqual([]);
    h.close();
  });
});

describe('the upgrade from a legacy snapshot', () => {
  /** Rewrites the stored snapshot into what the previous version wrote: no version, no review facts. */
  const legacy = (h: Harness): void => {
    const row = watch(h);
    const snap = JSON.parse(row.snapshotJson!) as { v?: number; prs: { rf?: unknown }[] };
    delete snap.v;
    for (const p of snap.prs) delete p.rf;
    h.store.db.prepare('UPDATE github_watches SET snapshot_json = ?, snapshot_hash = ?, read_boundary_at = NULL WHERE id = ?')
      .run(canonicalJson(snap), createHash('sha256').update(canonicalJson(snap)).digest('hex'), row.id);
  };

  it('an unchanged repository sends nothing, then establishes the new facts silently', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader, { reviews: [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))] });
    legacy(h);
    const events = h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get();
    await step();
    expect(sent(h)).toBe('[]');
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get()).toEqual(events);
    const upgraded = JSON.parse(watch(h).snapshotJson!) as { v: number; prs: { rf: { known: boolean } }[] };
    expect(upgraded.v).toBe(2);
    expect(upgraded.prs[0]!.rf.known).toBe(true);
    h.close();
  });

  it('a real legacy change renders legacy lines only, with no exact claim', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader);
    legacy(h);
    reader.prs = [pr(1, { title: 'Renamed', updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_x', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(sent(h)).toContain('pull request update(s)');
    expect(sent(h)).not.toContain('requested changes submitted');
    expect(crClaims(h)).toEqual([]);
    h.close();
  });

  it('a review-only change after the upgrade produces a real fact: the fingerprint covers it', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader);
    legacy(h);
    await step(); // the upgrade pass: establishes silently
    h.transport.clear();
    reader.setReviews(1, [rv('PRR_late', 'CHANGES_REQUESTED', at(3))]);
    // Nothing else about the repository moved: only the review list.
    await step();
    expect(sent(h)).toContain('requested changes submitted on #1');
    expect(crClaims(h).map((c) => c.transition.hash)).toEqual([hashOf('PRR_late')]);
    h.close();
  });

  it('a comment-only review (no requested change) is comparison metadata: no message', async () => {
    const reader = new Reader();
    const { h, step } = await start(reader);
    reader.setReviews(1, [rv('PRR_c', 'COMMENTED', at(1))]);
    await step();
    expect(sent(h)).toBe('[]');
    // ... but it joined the seen set, so a later state change of it is not a new review.
    reader.prs = [pr(1, { updatedAt: at(3) })];
    reader.setReviews(1, [rv('PRR_c', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(crClaims(h)).toEqual([]);
    h.close();
  });
});

describe('what the imported target delivered, holds or is sending', () => {
  const newReview = async (reader: Reader, step: () => Promise<unknown>, id = 'PRR_new', when = at(1)) => {
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv(id, 'CHANGES_REQUESTED', when)]);
    await step();
  };

  const reviewOnly = async (reader: Reader, step: () => Promise<unknown>, id = 'PRR_new', when = at(1)) => {
    reader.setReviews(1, [rv(id, 'CHANGES_REQUESTED', when)]);
    await step();
  };

  it('removes a review the target delivered (same id): not told, not claimed, snapshot advanced', async () => {
    const { h, reader, step } = await start();
    targetDelivered(h, 'PRR_new', at(1));
    await reviewOnly(reader, step);
    // No summary at all: the only change was an item the target delivered. (The follow-up proposal is a
    // separate, still-unreconciled message and is not a summary.)
    expect(summaries(h)).toEqual([]);
    expect(crClaims(h).map((c) => c.path)).toEqual(['target']);
    expect((JSON.parse(watch(h).snapshotJson!) as { prs: { rf: { cr: unknown[] } }[] }).prs[0]!.rf.cr).toHaveLength(1);
    h.close();
  });

  it('keeps the rest of a mixed summary when only the review was delivered by the target', async () => {
    const { h, reader, step } = await start();
    targetDelivered(h, 'PRR_new', at(1));
    reader.prs = [pr(1, { updatedAt: at(2), title: 'Renamed' })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(sent(h)).toContain('pull request update(s)');
    expect(sent(h)).not.toMatch(/requested changes submitted|changes requested on/);
    h.close();
  });

  it('defers the WHOLE observation while a target send of that review is in flight, and persists nothing', async () => {
    const { h, reader, step } = await start();
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, facts('PRR_new', at(1)), 'target_alert', 'e1', at(9));
    const before = watch(h);
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    const out = await step();
    expect(out.deferred).toBe(1);
    const after = watch(h);
    expect(after.snapshotJson).toBe(before.snapshotJson);
    expect(after.nextCheckAt).toBe(before.nextCheckAt);
    expect(after.readBoundaryAt).toBe(before.readBoundaryAt);
    expect(h.store.githubWatches.heldCount()).toBe(0);
    // Once the target settles it, the next pass proceeds.
    h.store.nativeTransitions.markTargetDelivered('target_alert', 'e1', at(9));
    await step();
    expect(summaries(h)).toEqual([]);
    expect(h.store.githubWatches.heldCount()).toBe(0);
    h.close();
  });

  it('a released target send (failed) lets the summary tell the review afterwards', async () => {
    const { h, reader, step } = await start();
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, facts('PRR_new', at(1)), 'target_alert', 'e1', at(9));
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    expect((await step()).deferred).toBe(1);
    h.store.nativeTransitions.releaseTarget('target_alert', 'e1');
    await step();
    expect(sent(h)).toContain('requested changes submitted on #1');
    h.close();
  });

  describe('a different id at an equal or unknown instant is held, never told anyway and never dropped', () => {
    it('holds it as its own durable row, sends the rest, and the snapshot advances', async () => {
      const { h, reader, step } = await start();
      targetDelivered(h, 'REST_other_id', at(1)); // same instant, an id this side cannot compare
      reader.prs = [pr(1, { updatedAt: at(2), title: 'Renamed' })];
      reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
      await step();
      expect(sent(h)).toContain('pull request update(s)'); // unrelated output proceeds
      expect(sent(h)).not.toMatch(/requested changes submitted|changes requested on/);
      expect(h.store.githubWatches.heldCount()).toBe(1);
      expect(h.store.githubWatches.heldReviews(10)).toMatchObject([
        { heldKey: transitionKey({ kind: 'changes_requested', item: '1', stamp: null, hash: hashOf('PRR_new'), attempt: null }), providerAt: at(1) },
      ]);
      // No reservation, no receipt of its own, and nothing sendable.
      expect(crClaims(h).filter((c) => c.path === 'native')).toEqual([]);
      expect(h.store.githubWatches.pendingEvents(10).filter((e) => e.summary.startsWith('Held'))).toEqual([]);
      expect(watch(h).snapshotJson).toContain('"cr"');
      expect(h.app.githubWatches.statusNotes()).toMatch(/1 requested-changes fact\(s\) HELD and NOT sent/);
      h.close();
    });

    it('holds one fact once across replays and restarts, and a cancel does not free it', async () => {
      const { h, clock, reader, step } = await start();
      targetDelivered(h, 'REST_other_id', at(1));
      reader.prs = [pr(1, { updatedAt: at(2) })];
      reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
      await step();
      await step();
      expect(h.store.githubWatches.heldCount()).toBe(1);
      // A restart over the same database.
      const second = makeHarness({ clock, store: h.store, github: reader, assistantWatchReader: new FakeWatchReader() });
      clock.advance(15 * MIN);
      await second.app.githubWatches.tick();
      expect(h.store.githubWatches.heldCount()).toBe(1);
      second.app.githubWatches.cancel(second.owner, h.store.githubWatches.byId(wid(h))!.publicId);
      expect(h.store.githubWatches.heldCount()).toBe(1);
      expect(h.store.githubWatches.heldReviews(10)[0]!.watchState).toBe('cancelled');
      second.close();
    });

    it('holds when the target review instant is unknown, and tells a review that provably differs', async () => {
      const { h, reader, step } = await start();
      h.store.nativeTransitions.reserveTarget(OWNER, REPO, facts('REST_x', at(0, 10)), 'target_alert', 'e1', at(9));
      h.store.nativeTransitions.markTargetDelivered('target_alert', 'e1', at(9));
      // A review at a DIFFERENT, known instant is a different review: told.
      reader.prs = [pr(1, { updatedAt: at(2) })];
      reader.setReviews(1, [rv('PRR_later', 'CHANGES_REQUESTED', at(1))]);
      await step();
      expect(sent(h)).toContain('requested changes submitted on #1');
      expect(h.store.githubWatches.heldCount()).toBe(0);
      // Unknown target instant: indistinguishable, held.
      h.store.db.prepare("UPDATE native_transition_claims SET provider_at = NULL WHERE path = 'target'").run();
      reader.prs = [pr(1, { updatedAt: at(3) })];
      reader.setReviews(1, [rv('PRR_later', 'CHANGES_REQUESTED', at(1)), rv('PRR_unk', 'CHANGES_REQUESTED', at(2))]);
      await step();
      expect(h.store.githubWatches.heldCount()).toBe(1);
      h.close();
    });

    it('holds only the ambiguous review of two new ones and tells the other', async () => {
      const { h, reader, step } = await start();
      targetDelivered(h, 'REST_other_id', at(1));
      reader.prs = [pr(1, { updatedAt: at(2) })];
      reader.setReviews(1, [rv('PRR_same_second', 'CHANGES_REQUESTED', at(1)), rv('PRR_other', 'CHANGES_REQUESTED', at(1, 30))]);
      await step();
      expect(h.store.githubWatches.heldCount()).toBe(1);
      expect(sent(h)).toContain('requested changes submitted on #1');
      expect(crClaims(h).filter((c) => c.path === 'native').map((c) => c.transition.hash)).toEqual([hashOf('PRR_other')]);
      h.close();
    });
  });
});

describe('several native holders and a failing send', () => {
  const feedHolder = (h: Harness, id: string, ref = 'card', atIso = at(0, 45)) => {
    h.store.db.prepare(
      `INSERT OR IGNORE INTO github_feed_repos (repo_key, display, source, state, created_at, updated_at) VALUES (?,?, 'explicit','active',?,?)`,
    ).run(REPO, REPO, atIso, atIso);
    h.store.db.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at)
       VALUES (?,?, 'changes_requested', ?, 'selected', NULL, 'pending', ?)`,
    ).run(ref, `changes_requested:${REPO}#1:${id}`, REPO, atIso);
    const t = { kind: 'changes_requested' as const, item: '1', stamp: null, hash: hashOf(id), attempt: null };
    h.store.nativeTransitions.reserveNative(OWNER, REPO, t, 'feed_event', ref, atIso, atIso, at(1));
    return t;
  };

  it('keeps the summary receipt when the feed card that reserved first is abandoned', async () => {
    const { h, reader, step } = await start();
    feedHolder(h, 'PRR_new');
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(crClaims(h).map((c) => `${c.via}:${c.state}`).sort()).toEqual(['feed_event:reserved', 'watch_summary:delivered']);
    h.store.nativeTransitions.releaseNative('feed_event', 'card'); // the card will never be sent
    const target = h.store.nativeTransitions.resolveTarget(OWNER, REPO, facts('PRR_new', at(1)));
    expect(target).toEqual({ outcome: 'covered' });
    h.close();
  });

  it('keeps the card receipt when the summary reserved first and is abandoned', async () => {
    const { h, reader, step } = await start();
    h.transport.failSends = true;
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    await step();
    h.transport.failSends = false;
    expect(crClaims(h).map((c) => `${c.via}:${c.state}`)).toEqual(['watch_summary:reserved']);
    const t = feedHolder(h, 'PRR_new');
    h.store.nativeTransitions.markNativeDelivered('feed_event', 'card', 'owner_dm', at(3));
    // The summary is abandoned after its attempts; the card's receipt stands.
    h.store.db.prepare('UPDATE github_watch_events SET abandoned_at = ? WHERE delivered_at IS NULL').run(at(5));
    h.store.nativeTransitions.sweepOrphans();
    expect(crClaims(h).map((c) => `${c.via}:${c.state}`)).toEqual(['feed_event:delivered']);
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, facts('PRR_new', at(1)))).toEqual({ outcome: 'covered' });
    expect(t.kind).toBe('changes_requested');
    h.close();
  });

  it('a failed send keeps the reservation (the target waits) and a later success makes it a receipt', async () => {
    const { h, reader, step } = await start();
    h.transport.failSends = true;
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    await step();
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, facts('PRR_new', at(1)))).toEqual({ outcome: 'wait' });
    h.transport.failSends = false;
    await step();
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, facts('PRR_new', at(1)))).toEqual({ outcome: 'covered' });
    h.close();
  });

  it('exhausted delivery attempts release the reservation, so the target is free to deliver', async () => {
    const { h, reader, step } = await start();
    h.transport.failSends = true;
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_new', 'CHANGES_REQUESTED', at(1))]);
    for (let i = 0; i < 9; i += 1) await step();
    expect(h.store.nativeTransitions.resolveTarget(OWNER, REPO, facts('PRR_new', at(1)))).toEqual({ outcome: 'deliver' });
    h.close();
  });
});

describe('a claim exists only for a segment the owner can read', () => {
  /** Five pull requests, each with a new review, behind updates and merges whose titles fill the budget. */
  const scenario = async (titleLength: number) => {
    const reader = new Reader();
    const clock = new TestClock(START);
    const list = (over: (n: number) => Partial<PrList[number]>): PrList =>
      [1, 2, 3, 4, 5].map((n) => pr(n, { title: `${'x'.repeat(titleLength)}${n}`, ...over(n) }));
    reader.prs = list(() => ({}));
    for (let n = 1; n <= 5; n += 1) reader.setReviews(n, []);
    const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    h.transport.clear();
    reader.prs = list((n) => ({ updatedAt: at(1 + n), mergedAt: at(1 + n), state: 'MERGED' }));
    for (let n = 1; n <= 5; n += 1) reader.setReviews(n, [rv(`PRR_${n}`, 'CHANGES_REQUESTED', at(1))]);
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    const text = summaries(h)[0]!;
    const shown = [1, 2, 3, 4, 5].filter((n) => new RegExp(`requested changes submitted on [^.]*#${n}(?![0-9])`).test(text));
    const claimed = crClaims(h).filter((c) => c.path === 'native').map((c) => Number(c.transition.item)).sort();
    h.close();
    return { text, shown, claimed };
  };

  it('keeps a claim for every segment in the text and none for one the clamp cut off, at every length', async () => {
    const partial: number[] = [];
    for (let len = 100; len <= 180; len += 2) {
      const { text, shown, claimed } = await scenario(len);
      expect(text.length, `title ${len}`).toBeLessThanOrEqual(1200);
      // Every claim is for a pull request whose segment is in the text, and the other way round.
      expect(claimed, `title ${len}`).toEqual(shown);
      if (shown.length > 0 && shown.length < 5) partial.push(len);
    }
    // The clamp really did cut a segment off in at least one of those cases, so the rule was exercised.
    expect(partial.length).toBeGreaterThan(0);
  });
});

describe('a partial or cut-off successful answer is not an empty one', () => {
  const baseline = async () => {
    const reader = new Reader();
    const ctx = await start(reader);
    reader.prs = [pr(1, { updatedAt: at(2) })];
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))], {
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(0, 30) }, { state: 'APPROVED', submittedAt: at(0, 40) }],
      comments: [{ author: { login: 'a' } }, { author: { login: 'b' } }],
      commits: [{ oid: 'c1' }, { oid: 'c2' }],
    });
    await ctx.step();
    ctx.h.transport.clear();
    return { ...ctx, reader };
  };
  const older = (h: Harness) =>
    (JSON.parse(watch(h).snapshotJson!) as { prs: Record<string, unknown>[] }).prs[0]!;
  const KEYS = ['approvals', 'changesRequested', 'reviewComments', 'commits', 'latestChangeRequestAt'];

  it('a successful answer with NO optional fields keeps every proven older field and says nothing', async () => {
    const { h, reader, step } = await baseline();
    const proven = KEYS.map((k) => older(h)[k]);
    expect(proven).toEqual([1, 1, 2, 2, at(0, 30)]);
    reader.reviews.set(1, { number: 1 }); // `{}`: the call worked and carried nothing
    await step();
    expect(KEYS.map((k) => older(h)[k])).toEqual(proven);
    expect(older(h)['rf']).toMatchObject({ s: 'unavailable', known: true });
    expect(sent(h)).toBe('[]');
    // Recovery with the same real data: nothing is new.
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30))], {
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(0, 30) }, { state: 'APPROVED', submittedAt: at(0, 40) }],
      comments: [{ author: { login: 'a' } }, { author: { login: 'b' } }],
      commits: [{ oid: 'c1' }, { oid: 'c2' }],
    });
    await step();
    expect(sent(h)).toBe('[]');
    h.close();
  });

  it('each missing field is carried on its own: an answer with only comments keeps the rest', async () => {
    const { h, reader, step } = await baseline();
    reader.reviews.set(1, { number: 1, comments: [{ author: { login: 'a' } }, { author: { login: 'b' } }, { author: { login: 'c' } }] });
    await step();
    expect(KEYS.map((k) => older(h)[k])).toEqual([1, 1, 3, 2, at(0, 30)]);
    expect(summaries(h).join(' ')).toContain('new conversation comment(s) on #1'); // a real third comment
    h.close();
  });

  it('a payload at the review bound is partial: it rebuilds no older field and infers no new review', async () => {
    const { h, reader, step } = await baseline();
    const proven = KEYS.map((k) => older(h)[k]);
    const many = Array.from({ length: 100 }, (_, i) => rv(`PRR_${i}`, 'COMMENTED', at(1)));
    reader.setReviews(1, many, { latestReviews: [], comments: [], commits: [] });
    await step();
    expect(KEYS.map((k) => older(h)[k])).toEqual(proven);
    expect(older(h)['rf']).toMatchObject({ s: 'truncated', known: true, cr: [{ h: hashOf('PRR_old') }] });
    expect(sent(h)).toBe('[]');
    // Recovery: a genuinely new requested-changes review that arrived during the cut-off stretch is told, once,
    // and the old facts are neither repeated nor erased.
    reader.setReviews(1, [rv('PRR_old', 'CHANGES_REQUESTED', at(0, 30)), rv('PRR_gap', 'CHANGES_REQUESTED', at(2))], {
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(2) }, { state: 'APPROVED', submittedAt: at(0, 40) }],
      comments: [{ author: { login: 'a' } }, { author: { login: 'b' } }],
      commits: [{ oid: 'c1' }, { oid: 'c2' }],
    });
    await step();
    expect(summaries(h).join(' ')).toContain('requested changes submitted on #1');
    expect(summaries(h).join(' ')).not.toMatch(/conversation comment/);
    // PRR_old was told by the baseline step; PRR_gap is the only NEW claim, and nothing is claimed twice.
    expect(crClaims(h).map((c) => c.transition.hash).sort()).toEqual([hashOf('PRR_old'), hashOf('PRR_gap')].sort());
    h.close();
  });
});

describe('the reconciliation loop is bounded by every candidate, not by the first render', () => {
  it('works through more waves of target-delivered items than the first render named, and defers nothing', async () => {
    const reader = new Reader();
    const clock = new TestClock(START);
    const list = (over: (n: number) => Partial<PrList[number]>): PrList => [1, 2, 3, 4, 5].map((n) => pr(n, over(n)));
    reader.prs = list(() => ({}));
    for (let n = 1; n <= 5; n += 1) reader.setReviews(n, []);
    const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    h.transport.clear();
    // Five updates: the text names three; the target delivered #1-#3, so removing them REVEALS #4 and #5,
    // which the first render did not name. Their claims must be checked too (the target delivered #4).
    const stamps = (n: number) => at(1 + n);
    reader.prs = list((n) => ({ updatedAt: stamps(n) }));
    const upd = (n: number) => ({
      kind: 'pr_updated' as const, identity: `${n}:updated:${stamps(n)}`, occurredAt: stamps(n), providerHash: null, attempt: null,
    });
    for (const n of [1, 2, 3, 4]) {
      h.store.nativeTransitions.reserveTarget(OWNER, REPO, upd(n), 'target_digest', `d${n}`, at(9));
      h.store.nativeTransitions.markTargetDelivered('target_digest', `d${n}`, at(9));
    }
    clock.advance(15 * MIN);
    const out = await h.app.githubWatches.tick();
    expect(out.deferred).toBe(0);
    const text = summaries(h)[0]!;
    // #4 was delivered by the target and so is absent; #5 is what is left to say.
    expect(text).toContain('#5 PR 5');
    expect(text).not.toMatch(/#[1-4] PR/);
    expect(h.store.nativeTransitions.all().filter((c) => c.via === 'watch_summary').map((c) => c.transition.item)).toEqual(['5']);
    h.close();
  });
});
