import { describe, expect, it } from 'vitest';
import { GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS } from '@ducky/contracts';
import type { PrList, RepoView } from '@ducky/contracts';
import type { RepoRef } from '@ducky/adapters';
import { OWNER, REPOS_JSON, TestClock, makeHarness, type Harness } from './helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';

/**
 * The ordinary repository watch against the exact ledger (ADR 0034): which repository it queried,
 * which items its summary NAMES (and nothing else), what it skips, and when it releases. Invented data.
 */
const START = '2026-09-01T00:00:00.000Z';
const MIN = 60_000;
const at = (h: number) => `2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`;

const prs = (n: number, over: (i: number) => Partial<PrList[number]> = () => ({})): PrList =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1, title: `PR ${i + 1}`, state: 'OPEN', isDraft: false, headRefName: `f${i + 1}`,
    updatedAt: START, headRefOid: `h${i + 1}`, ...over(i),
  }));

class RaceReader extends MutableGitHubReader {
  onView: (() => void) | null = null;
  override async repoView(ref: RepoRef): Promise<RepoView> {
    this.onView?.();
    return super.repoView(ref);
  }
}

const start = async (init: PrList, reader: MutableGitHubReader = new MutableGitHubReader()) => {
  const clock = new TestClock(START);
  reader.prs = init;
  const h = makeHarness({ clock, github: reader, assistantWatchReader: new FakeWatchReader() });
  const w = h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
  clock.advance(15 * MIN);
  await h.app.githubWatches.tick(); // "Started watching"
  h.transport.clear();
  const step = async () => {
    clock.advance(15 * MIN);
    return h.app.githubWatches.tick();
  };
  return { h, clock, reader, w, step };
};
const claims = (h: Harness) => h.store.nativeTransitions.all();
const wid = (h: Harness) => (h.store.db.prepare('SELECT id FROM github_watches').get() as { id: string }).id;
const sent = (h: Harness) => JSON.stringify(h.transport.sent);

describe('the repository an ordinary watch queried is recorded, never inferred', () => {
  it('binds the canonical repository when the watch is created and records it on every outbox row', async () => {
    const { h, reader, step } = await start(prs(2));
    expect(h.store.githubWatches.listForOwner(OWNER, false, 5)[0]).toMatchObject({ repoKey: 'acme/demo', cancelReason: null });
    reader.prs = prs(2, (i) => (i === 0 ? { title: 'Changed', updatedAt: at(1) } : {}));
    await step();
    // The "Started watching" row and the summary both carry the repository the read queried.
    expect(h.store.db.prepare('SELECT repo_key FROM github_watch_events').all()).toEqual([{ repo_key: 'acme/demo' }, { repo_key: 'acme/demo' }]);
    h.close();
  });

  it('binds a legacy watch (no recorded repository) at its first observation, from the mapping used for that read', async () => {
    const { h, step, reader } = await start(prs(2));
    h.store.db.prepare('UPDATE github_watches SET repo_key = NULL').run(); // as every pre-migration row is
    reader.prs = prs(2, (i) => (i === 0 ? { title: 'Changed', updatedAt: at(1) } : {}));
    await step();
    expect(h.store.githubWatches.listForOwner(OWNER, false, 5)[0]!.repoKey).toBe('acme/demo');
    h.close();
  });

  it('stops a watch whose slug now names another repository: snapshot and pending outbox kept, no DM, counted in /status', async () => {
    const { h, clock, reader, step } = await start(prs(2));
    reader.prs = prs(2, (i) => (i === 0 ? { title: 'Changed', updatedAt: at(1) } : {}));
    h.transport.failSends = true; // the summary stays pending
    await step();
    h.transport.failSends = false;
    h.transport.clear();
    const before = h.store.githubWatches.listForOwner(OWNER, false, 5)[0]!;
    const pending = h.store.githubWatches.pendingEvents(10).map((e) => e.id);
    expect(pending).toHaveLength(1);

    // A later boot over the same database: the allowlist now maps `demo` to another repository.
    const remapped = JSON.stringify({
      version: 1,
      repos: [{ ...(JSON.parse(REPOS_JSON) as { repos: object[] }).repos[0], github: { owner: 'zeta', repo: 'moved' } }],
    });
    const second = makeHarness({ clock, store: h.store, allowlistJson: remapped, github: reader, assistantWatchReader: new FakeWatchReader() });
    clock.advance(15 * MIN);
    const out = await second.app.githubWatches.tick();
    expect(out).toMatchObject({ identityStopped: 1, observed: 0 });
    const after = h.store.githubWatches.byId(before.id)!;
    expect(after).toMatchObject({ state: 'cancelled', cancelReason: 'identity_mismatch', repoKey: 'acme/demo', snapshotHash: before.snapshotHash });
    expect(after.snapshotJson).toBe(before.snapshotJson);
    // The pending notification is still true of the repository it was observed on, and is still delivered.
    expect(h.store.githubWatches.pendingEvents(10).map((e) => e.id).length + (sent(second) !== '[]' ? 1 : 0)).toBeGreaterThan(0);
    // The reservation of a still-deliverable outbox row survives the sweep.
    h.store.nativeTransitions.sweepOrphans();
    expect(second.app.assistantWatch.statusLine()).toMatch(/1 ordinary watch\(es\) stopped because their repository mapping changed/);
    expect(JSON.stringify(second.transport.sent)).not.toMatch(/zeta|moved|mapping/);
    second.close();
  });

  it('records the repository fixed before the awaited reads: a change while they run commits nothing', async () => {
    const reader = new RaceReader();
    const { h, step } = await start(prs(2), reader);
    reader.prs = prs(2, (i) => (i === 0 ? { title: 'Changed', updatedAt: at(1) } : {}));
    // While the reads are in flight something else binds the row to a different identity.
    const events = h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get();
    reader.onView = () => h.store.db.prepare("UPDATE github_watches SET repo_key = 'someone/else'").run();
    const out = await step();
    expect(out).toMatchObject({ observed: 1, changed: 0 });
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM github_watch_events').get()).toEqual(events);
    expect(claims(h)).toEqual([]);
    h.close();
  });
});

describe('a summary reserves exactly the items its words name', () => {
  it('names at most three updates and reserves only those; the fourth and fifth are counted, not reserved', async () => {
    const { h, reader, step } = await start(prs(5));
    reader.prs = prs(5, (i) => ({ updatedAt: at(1 + i) }));
    await step();
    expect(sent(h)).toContain('5 pull request update(s)');
    expect(sent(h)).toContain('#1 PR 1; #2 PR 2; #3 PR 3');
    expect(sent(h)).not.toContain('#4 PR 4');
    expect(claims(h).map((c) => `${c.state}:${c.transition.kind}:${c.transition.item}:${c.transition.stamp}`).sort()).toEqual([
      `delivered:pr_updated:1:${at(1)}`, `delivered:pr_updated:2:${at(2)}`, `delivered:pr_updated:3:${at(3)}`,
    ]);
    h.close();
  });

  it('names at most three merges, by their merge instant, and a check flipping on a head is not an update receipt', async () => {
    const { h, reader, step } = await start(prs(5));
    reader.prs = prs(5, (i) => (i < 4 ? { state: 'MERGED', mergedAt: at(2 + i), updatedAt: START } : {}));
    reader.checks.set(5, [{ name: 'tests', state: 'FAILURE', bucket: 'fail' }]);
    await step();
    const merged = claims(h).filter((c) => c.transition.kind === 'pr_merged');
    expect(merged.map((c) => c.transition.item).sort()).toEqual(['1', '2', '3']);
    // PR 5 changed only through its checks: updatedAt did not move, so it names no update.
    expect(claims(h).some((c) => c.transition.kind === 'pr_updated')).toBe(false);
    h.close();
  });

  it('does not treat a pull request new to the snapshot as an opened receipt', async () => {
    const { h, reader, step } = await start(prs(1));
    reader.prs = prs(2);
    await step();
    expect(sent(h)).toContain('#2 PR 2');
    expect(claims(h)).toEqual([]);
    h.close();
  });

  it('keeps counts, aggregates and the follow-up out of the ledger entirely', async () => {
    const { h, reader, step } = await start(prs(1));
    reader.prs = prs(1, () => ({ reviewDecision: 'CHANGES_REQUESTED' }));
    reader.reviews.set(1, {
      number: 1, reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: at(3), id: 'R1' }],
    });
    reader.issues = [{ number: 5, title: 'bug', state: 'OPEN', updatedAt: at(2) }];
    reader.runs = [{ workflowName: 'ci', headBranch: 'main', headSha: 'sha2', status: 'completed', conclusion: 'failure' }];
    await step();
    expect(sent(h)).toContain('/job submit repo:demo');
    expect(sent(h)).toContain('changes requested on #1');
    expect(sent(h)).toContain('1 new issue(s)');
    expect(sent(h)).toContain('workflow failure(s): ci');
    expect(claims(h)).toEqual([]);
    h.close();
  });
});

describe('a summary clipped to its length reserves only the items it shows in full', () => {
  const LONG = (n: number) => `${'long title '.repeat(20)}${n}`.slice(0, 160) + `#${n}`.padEnd(20, '.');
  // Three pull requests updated AND merged in one pass (the snapshot holds at most five).
  const settle = (n: number, title: (i: number) => string) =>
    prs(n, (i) => ({ title: title(i), ...(i < 3 ? { state: 'MERGED', mergedAt: at(2 + i), updatedAt: at(1 + i) } : {}) }));

  it('keeps no claim for a third merge the clamp cut off, so a native receipt can never settle what the owner did not read', async () => {
    const { h, reader, step } = await start(prs(5, (i) => ({ title: LONG(i + 1) })));
    // Two previously listed pull requests are gone and a head has failing checks: lines in front of the
    // merge line that push its third item past the clamp.
    reader.prs = settle(3, (i) => LONG(i + 1));
    reader.checks.set(1, [{ name: 'tests', state: 'FAILURE', bucket: 'fail' }]);
    await step();
    const body = JSON.parse(sent(h))[0].message.embeds[0].description as string;
    expect(body.length).toBeLessThanOrEqual(1200);
    expect(body.endsWith('…')).toBe(true);
    // Merges 1 and 2 are read in full; 3 is cut off and is no receipt. All three updates are in full.
    expect(body).toContain(LONG(2));
    expect(body.split(LONG(3)).length - 1).toBe(1); // read once (the update line), cut off in the merge line
    expect(claims(h).filter((c) => c.transition.kind === 'pr_merged').map((c) => c.transition.item).sort()).toEqual(['1', '2']);
    expect(claims(h).filter((c) => c.transition.kind === 'pr_updated').map((c) => c.transition.item).sort()).toEqual(['1', '2', '3']);
    // The imported event for the merge nobody read is NOT settled by a native receipt: it is told.
    const merged = (n: number) => ({
      kind: 'pr_merged' as const, identity: `${n}:merged`, occurredAt: at(2 + n - 1), providerHash: null, attempt: null,
    });
    expect(h.store.nativeTransitions.resolveTarget(OWNER, 'acme/demo', merged(2))).toEqual({ outcome: 'covered' });
    expect(h.store.nativeTransitions.resolveTarget(OWNER, 'acme/demo', merged(3))).toEqual({ outcome: 'deliver' });
    h.close();
  });

  it('claims every named item when nothing is clipped, and the claims are exactly the items in the text', async () => {
    const { h, reader, step } = await start(prs(5));
    reader.prs = settle(5, (i) => `PR ${i + 1}`);
    await step();
    expect(claims(h).map((c) => `${c.transition.kind}:${c.transition.item}`).sort())
      .toEqual(['pr_merged:1', 'pr_merged:2', 'pr_merged:3', 'pr_updated:1', 'pr_updated:2', 'pr_updated:3']);
    h.close();
  });
});

describe('an item the imported target already delivered is taken out, and only that item', () => {
  const targetDelivered = (h: Harness, n: number, stamp: string) => {
    h.store.nativeTransitions.reserveTarget(OWNER, 'acme/demo', {
      kind: 'pr_updated', identity: `${n}:updated:${stamp}`, occurredAt: stamp, providerHash: null, attempt: null,
    }, 'target_digest', `t${n}`, START);
    h.store.nativeTransitions.markTargetDelivered('target_digest', `t${n}`, START);
  };

  it('rebuilds a mixed summary around what remains: other updates, merges, issues and runs are all kept', async () => {
    const { h, reader, step } = await start(prs(3));
    targetDelivered(h, 1, at(1));
    reader.prs = prs(3, (i) => (i === 0 ? { updatedAt: at(1) } : i === 1 ? { updatedAt: at(2) } : { state: 'MERGED', mergedAt: at(3) }));
    reader.issues = [{ number: 5, title: 'bug', state: 'OPEN', updatedAt: at(2) }];
    await step();
    const body = sent(h);
    expect(body).toContain('2 pull request update(s): #2 PR 2; #3 PR 3');
    expect(body).not.toContain('#1 PR 1');
    expect(body).toContain('merged: #3 PR 3');
    expect(body).toContain('1 new issue(s)');
    // What was told is reserved and delivered; what the target told is not claimed twice.
    expect(claims(h).filter((c) => c.path === 'native').map((c) => `${c.transition.kind}:${c.transition.item}`).sort())
      .toEqual(['pr_merged:3', 'pr_updated:2']);
    h.close();
  });

  it('says nothing when removing the delivered item leaves nothing, and the snapshot still advances', async () => {
    const { h, reader, step } = await start(prs(1));
    targetDelivered(h, 1, at(1));
    reader.prs = prs(1, () => ({ updatedAt: at(1) }));
    expect((await step()).delivered).toBe(0);
    expect(h.transport.sent).toEqual([]);
    expect((await step())).toMatchObject({ changed: 0 });
    h.close();
  });
});

describe('a reservation follows its outbox row to the end, and is released only when that row will not be sent', () => {
  const change = (reader: MutableGitHubReader) => {
    reader.prs = prs(1, () => ({ updatedAt: at(1) }));
  };

  it('stays reserved through failed sends and becomes a receipt on the successful one', async () => {
    const { h, reader, step } = await start(prs(1));
    change(reader);
    h.transport.failSends = true;
    await step();
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedNative: 1, receiptsNative: 0 });
    h.transport.failSends = false;
    await step();
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedNative: 0, receiptsNative: 1 });
    h.close();
  });

  it('is released when the outbox row is abandoned after its attempts', async () => {
    const { h, reader, step } = await start(prs(1));
    change(reader);
    h.transport.failSends = true;
    for (let i = 0; i < GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS + 1; i += 1) await step();
    expect(h.store.githubWatches.pendingEvents(5)).toEqual([]);
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedNative: 0, receiptsNative: 0 });
    h.close();
  });

  it('is released when the owner cancels the watch, which retires what was pending', async () => {
    const { h, reader, step, w } = await start(prs(1));
    change(reader);
    h.transport.failSends = true;
    await step();
    expect(h.store.nativeTransitions.counts().reservedNative).toBe(1);
    h.app.githubWatches.cancel(h.owner, w.publicId);
    h.store.nativeTransitions.sweepOrphans();
    expect(h.store.nativeTransitions.counts()).toMatchObject({ reservedNative: 0, receiptsNative: 0 });
    expect(wid(h)).toBeTruthy();
    h.close();
  });
});
