import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_WATCH_CYCLE_TARGETS, ASSISTANT_WATCH_MAX_TARGETS, WATCH_EVENT_KINDS, type WatchSurface,
} from '@ducky/contracts';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { WatchReadError, type DiscoveredRepository } from '../src/domain/assistant-watch.reader.js';
import type { AssistantWatchConfig } from '../src/domain/assistant-watch.service.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * Repository discovery, the source's recency-limited poll cycle and the global
 * monitoring switch, through the real service, store and transport with a
 * scripted reader. Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL = new Set(['owner', 'organization', 'collaborator'] as const);

const config = (over: Partial<AssistantWatchConfig> = {}): AssistantWatchConfig => ({
  account: 'me', cycle: true, discovery: true, relationships: ALL, includeForks: false, includeArchived: false, ...over,
});

const boot = (cfg: AssistantWatchConfig | null = config(), over: { reader?: FakeWatchReader; store?: Harness['store']; clock?: TestClock } = {}) => {
  const clock = over.clock ?? new TestClock(NOW, 'UTC');
  const reader = over.reader ?? new FakeWatchReader();
  reader.capabilities = { observableKinds: [...WATCH_EVENT_KINDS], discovery: true };
  const h = makeHarness({
    clock, assistantWatchReader: reader, ...(cfg ? { assistantWatchConfig: cfg } : {}),
    ...(over.store ? { store: over.store } : {}),
  });
  return { h, clock, reader };
};

const repo = (full: string, over: Partial<DiscoveredRepository> = {}): DiscoveredRepository => {
  const [owner] = full.split('/') as [string];
  return {
    fullName: full, ownerLogin: owner, ownerType: owner === 'me' || owner === 'other' ? 'User' : 'Organization', fork: false, archived: false,
    pushedAt: '2026-10-12T00:00:00Z', ...over,
  };
};
const targets = (h: Harness) => h.store.assistantWatch.listForOwner(OWNER, true, 2000);

let seq = 500;
const addTarget = (
  h: Harness, key: string,
  over: { pushedAt?: string | null; archived?: boolean; fork?: boolean; relationship?: 'owner' | 'organization' | 'collaborator' | null; state?: 'active' | 'cancelled' } = {},
) => {
  seq += 1;
  const id = `d${seq}`;
  h.store.assistantWatch.insertTarget({
    id, publicId: `w${String(seq).padStart(5, '0')}`, discordUserId: OWNER, repoKey: key.toLowerCase(), display: key,
    defaultBranch: 'main', state: over.state ?? 'active', lastObservedAt: null, createdAt: NOW,
    cancelledAt: over.state === 'cancelled' ? NOW : null, pushedAt: over.pushedAt ?? null,
    relationship: over.relationship ?? null, archived: over.archived ?? false, fork: over.fork ?? false,
  });
  return id;
};
const checkpoint = (h: Harness, id: string, surface: WatchSurface, cursor: string | null = '2026-10-10T00:00:00.000Z') =>
  h.store.assistantWatch.insertCheckpoint({
    targetId: id, surface, state: cursor === null ? 'unbaselined' : 'imported', cursor, nextDueAt: NOW, updatedAt: NOW,
  });

describe('repository discovery', () => {
  it('stores a repository as an active, silent, unbaselined target', async () => {
    const { h, reader } = boot();
    reader.pageSize = 100;
    reader.discoveredBy = [repo('me/mine'), repo('acme/org'), repo('other/shared')];
    await h.app.assistantWatch.tick();
    const rows = targets(h);
    expect(rows.map((r) => r.repoKey).sort()).toEqual(['acme/org', 'me/mine', 'other/shared']);
    expect(rows.find((r) => r.repoKey === 'me/mine')).toMatchObject({ relationship: 'owner', state: 'active' });
    expect(rows.find((r) => r.repoKey === 'acme/org')!.relationship).toBe('organization');
    expect(rows.find((r) => r.repoKey === 'other/shared')!.relationship).toBe('collaborator');
    for (const r of rows) {
      const cps = h.store.assistantWatch.checkpointsFor(r.id);
      expect(cps.map((c) => c.surface).sort()).toEqual(['commits', 'default_branch', 'issues', 'pulls', 'releases', 'runs']);
      // Created silent: never a checkpoint that reads as new, and never imported.
      expect(cps.every((c) => c.state !== 'imported')).toBe(true);
    }
    // First sight is silent: nothing is owed for what already existed.
    expect(h.store.assistantWatch.undigested(OWNER, 50)).toEqual([]);
    h.close();
  });

  it('stores only what the frozen scope allows; the rest never reaches the database', async () => {
    const { h, reader } = boot(config({ relationships: new Set(['owner']) }));
    reader.pageSize = 100;
    reader.discoveredBy = [repo('me/mine'), repo('acme/org'), repo('other/shared')];
    await h.app.assistantWatch.tick();
    expect(targets(h).map((r) => r.repoKey)).toEqual(['me/mine']);
    h.close();
  });

  it('never resets what the owner decided: a cancelled target stays cancelled, only facts refresh', async () => {
    const { h, reader } = boot();
    reader.pageSize = 100;
    const id = addTarget(h, 'acme/muted', { state: 'cancelled' });
    checkpoint(h, id, 'issues');
    reader.discoveredBy = [repo('acme/muted', { pushedAt: '2026-10-12T05:00:00Z', archived: true })];
    await h.app.assistantWatch.tick();
    const row = h.store.assistantWatch.byRepoKey(OWNER, 'acme/muted')!;
    expect(row).toMatchObject({ state: 'cancelled', pushedAt: '2026-10-12T05:00:00Z', archived: true });
    expect(h.store.assistantWatch.checkpoint(id, 'issues')).toMatchObject({ state: 'imported', cursor: '2026-10-10T00:00:00.000Z' });
    h.close();
  });

  it('does not bring back a target the owner deleted', async () => {
    const { h, reader } = boot();
    reader.pageSize = 100;
    const id = addTarget(h, 'acme/forgotten');
    h.store.db.prepare('DELETE FROM assistant_watch_targets WHERE id = ?').run(id);
    reader.discoveredBy = [repo('acme/forgotten'), repo('acme/new')];
    await h.app.assistantWatch.tick();
    expect(targets(h).map((r) => r.repoKey)).toEqual(['acme/new']);
    h.close();
  });

  it('is one request per unit, resumable, and runs again only after six hours', async () => {
    const { h, clock, reader } = boot();
    reader.pageSize = 2;
    reader.discoveredBy = [repo('a/1'), repo('a/2'), repo('a/3'), repo('a/4'), repo('a/5')];
    reader.failNth.set('discover', 2); // page 1 succeeds, page 2 fails
    const first = await h.app.assistantWatch.tick();
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(targets(h)).toHaveLength(2);
    expect(h.store.assistantWatch.discovery(OWNER)).toMatchObject({ pendingPage: 1, failures: 1, lastError: 'read_failed' });

    clock.advance(31 * MIN);
    reader.log.length = 0;
    await h.app.assistantWatch.tick();
    // It resumes at page 2, not at page 1.
    expect(reader.log.filter((l) => l.startsWith('discover'))).toEqual(['discover:-:2', 'discover:-:3']);
    expect(targets(h)).toHaveLength(5);
    expect(h.store.assistantWatch.discovery(OWNER)).toMatchObject({ pendingPage: 0, incomplete: false });

    clock.advance(HOUR);
    reader.log.length = 0;
    await h.app.assistantWatch.tick();
    expect(reader.log.some((l) => l.startsWith('discover'))).toBe(false);
    clock.advance(6 * HOUR);
    await h.app.assistantWatch.tick();
    expect(reader.log.some((l) => l.startsWith('discover'))).toBe(true);
    h.close();
  });

  it('reports a pass INCOMPLETE when more repositories exist than five pages hold', async () => {
    const { h, reader } = boot();
    reader.pageSize = 2;
    reader.discoveredBy = Array.from({ length: 20 }, (_, i) => repo(`a/r${i}`));
    await h.app.assistantWatch.tick();
    expect(reader.log.filter((l) => l.startsWith('discover'))).toHaveLength(5);
    expect(targets(h)).toHaveLength(10);
    expect(h.store.assistantWatch.discovery(OWNER)).toMatchObject({ incomplete: true, pendingPage: 0 });
    expect(h.app.assistantWatch.statusLine()).toContain('EXCEPT repositories beyond the page cap');
    h.close();
  });

  it('counts toward the ceiling and reports overflow without truncating or cancelling anything', async () => {
    const { h, reader } = boot();
    reader.pageSize = 100;
    for (let i = 0; i < ASSISTANT_WATCH_MAX_TARGETS - 1; i += 1) addTarget(h, `bulk/r${i}`);
    reader.discoveredBy = [repo('x/one'), repo('x/two')];
    await h.app.assistantWatch.tick();
    expect(targets(h)).toHaveLength(ASSISTANT_WATCH_MAX_TARGETS);
    expect(targets(h).some((r) => r.state === 'cancelled')).toBe(false);
    expect(h.store.assistantWatch.discovery(OWNER)).toMatchObject({ capacityBlocked: true });
    expect(h.app.assistantWatch.statusLine()).toContain('at the target ceiling');
    h.close();
  });

  it.each(['rate_limited', 'auth'] as const)('a %s answer stores nothing and stops the cycle', async (code) => {
    const { h, reader } = boot();
    reader.discoveredBy = [repo('a/1')];
    reader.failWith.set('discover', new WatchReadError(code));
    await h.app.assistantWatch.tick();
    expect(targets(h)).toEqual([]);
    expect(h.store.assistantWatch.discovery(OWNER)).toMatchObject({ lastError: code, failures: 1 });
    h.close();
  });

  it('does not run when discovery is not configured or the reader cannot', async () => {
    const off = boot(config({ discovery: false }));
    off.reader.discoveredBy = [repo('a/1')];
    await off.h.app.assistantWatch.tick();
    expect(off.reader.log).toEqual([]);
    off.h.close();

    const noCap = boot();
    noCap.reader.capabilities = { observableKinds: [...WATCH_EVENT_KINDS], discovery: false };
    noCap.reader.discoveredBy = [repo('a/1')];
    await noCap.h.app.assistantWatch.tick();
    expect(noCap.reader.log).toEqual([]);
    noCap.h.close();
  });

  it('skips a malformed full name rather than storing it', async () => {
    const { h, reader } = boot();
    reader.pageSize = 100;
    reader.discoveredBy = [repo('a/ok'), { ...repo('a/x'), fullName: 'no-slash' }, { ...repo('a/y'), fullName: '../etc' }];
    await h.app.assistantWatch.tick();
    expect(targets(h).map((r) => r.repoKey)).toEqual(['a/ok']);
    h.close();
  });
});

describe("the source's recency-limited poll cycle", () => {
  const cycle = (over = {}) => ({ ownerId: OWNER, limit: ASSISTANT_WATCH_CYCLE_TARGETS, includeArchived: false, includeForks: false, ...over });
  const dueIssues = (h: Harness, c = cycle()) =>
    h.store.assistantWatch.dueCheckpoints('2099-01-01T00:00:00.000Z', 5000, c).filter((u) => u.surface === 'issues');

  it('covers at most forty eligible targets, most recently pushed first', () => {
    const { h } = boot();
    for (let i = 0; i < 45; i += 1) {
      const id = addTarget(h, `acme/r${String(i).padStart(2, '0')}`, { pushedAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:${String(i).padStart(2, '0')}:00Z` });
      checkpoint(h, id, 'issues');
    }
    const due = dueIssues(h);
    expect(due).toHaveLength(ASSISTANT_WATCH_CYCLE_TARGETS);
    const pushed = (key: string) => h.store.assistantWatch.byRepoKey(OWNER, key)!.pushedAt!;
    const covered = new Set(due.map((u) => u.repoKey));
    const worstCovered = Math.min(...[...covered].map((k) => Date.parse(pushed(k))));
    const bestBeyond = Math.max(...targets(h).filter((t) => !covered.has(t.repoKey)).map((t) => Date.parse(t.pushedAt!)));
    expect(worstCovered).toBeGreaterThanOrEqual(bestBeyond);
    h.close();
  });

  it('does not read the surfaces of a target beyond coverage, but still reads its metadata', () => {
    const { h } = boot();
    const ids: string[] = [];
    for (let i = 0; i < 41; i += 1) {
      const id = addTarget(h, `acme/r${i}`, { pushedAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z` });
      checkpoint(h, id, 'issues');
      checkpoint(h, id, 'default_branch', 'main');
      ids.push(id);
    }
    const all = h.store.assistantWatch.dueCheckpoints('2099-01-01T00:00:00.000Z', 5000, cycle());
    expect(all.filter((u) => u.surface === 'default_branch')).toHaveLength(41);
    expect(all.filter((u) => u.surface === 'issues')).toHaveLength(40);
    h.close();
  });

  it('serves only the metadata surface of a target whose recency is not yet known', () => {
    const { h } = boot();
    const id = addTarget(h, 'acme/unknown');
    checkpoint(h, id, 'issues');
    checkpoint(h, id, 'default_branch', 'main');
    const all = h.store.assistantWatch.dueCheckpoints('2099-01-01T00:00:00.000Z', 50, cycle());
    expect(all.map((u) => u.surface)).toEqual(['default_branch']);
    h.close();
  });

  it('excludes an archived repository and a fork the account owns, unless included', () => {
    const { h } = boot();
    const rows: [string, Parameters<typeof addTarget>[2]][] = [
      ['acme/plain', {}],
      ['acme/archived', { archived: true }],
      ['me/ownedfork', { fork: true, relationship: 'owner' }],
      ['acme/orgfork', { fork: true, relationship: 'organization' }],
    ];
    for (const [key, over] of rows) {
      const id = addTarget(h, key, { pushedAt: '2026-10-12T00:00:00Z', ...over });
      checkpoint(h, id, 'issues');
    }
    expect(dueIssues(h).map((u) => u.repoKey).sort()).toEqual(['acme/orgfork', 'acme/plain']);
    expect(dueIssues(h, cycle({ includeArchived: true })).map((u) => u.repoKey).sort())
      .toEqual(['acme/archived', 'acme/orgfork', 'acme/plain']);
    expect(dueIssues(h, cycle({ includeForks: true })).map((u) => u.repoKey).sort())
      .toEqual(['acme/orgfork', 'acme/plain', 'me/ownedfork']);
    h.close();
  });

  it('is not applied to a scripted reader, which covers every active target', async () => {
    const { h, reader } = boot(null);
    const id = addTarget(h, 'acme/unmeasured');
    checkpoint(h, id, 'issues');
    await h.app.assistantWatch.tick();
    expect(reader.log).toEqual(['issues:acme/unmeasured:1']);
    h.close();
  });

  it('refreshes an uncovered target slowly, so its recency can still move it into coverage', async () => {
    const { h, clock, reader } = boot(config({ discovery: false }));
    for (let i = 0; i < 40; i += 1) addTarget(h, `acme/hot${i}`, { pushedAt: '2026-10-12T12:00:00Z' });
    const cold = addTarget(h, 'acme/cold', { pushedAt: '2026-01-01T00:00:00Z' });
    checkpoint(h, cold, 'default_branch', 'main');
    checkpoint(h, cold, 'issues');
    reader.repoBy.set('acme/cold', { pushedAt: '2026-10-12T23:00:00Z' });
    await h.app.assistantWatch.tick();
    const t = h.store.assistantWatch.byRepoKey(OWNER, 'acme/cold')!;
    expect(t.pushedAt).toBe('2026-10-12T23:00:00Z'); // it woke up and is now the most recent
    // Covered now, so its other surfaces are served right after the metadata read.
    expect(reader.log).toEqual(['repository:acme/cold', 'issues:acme/cold:1']);
    // And a covered target's metadata comes round again at the ordinary interval.
    expect(h.store.assistantWatch.checkpoint(cold, 'default_branch')!.nextDueAt).toBe('2026-10-13T00:15:00.000Z');
    clock.advance(MIN);
    h.close();
  });

  it('refreshes a target that stays beyond coverage only every six hours', async () => {
    const { h, reader } = boot(config({ discovery: false }));
    for (let i = 0; i < 40; i += 1) addTarget(h, `acme/hot${i}`, { pushedAt: '2026-10-12T12:00:00Z' });
    const cold = addTarget(h, 'acme/cold', { pushedAt: '2026-01-01T00:00:00Z' });
    checkpoint(h, cold, 'default_branch', 'main');
    checkpoint(h, cold, 'issues');
    reader.repoBy.set('acme/cold', { pushedAt: '2026-01-02T00:00:00Z' });
    await h.app.assistantWatch.tick();
    expect(reader.log).toEqual(['repository:acme/cold']);
    expect(h.store.assistantWatch.checkpoint(cold, 'default_branch')!.nextDueAt).toBe('2026-10-13T06:00:00.000Z');
    h.close();
  });

  it('puts the coverage in /status as counts only', () => {
    const { h } = boot(config({ discovery: false }));
    for (let i = 0; i < 3; i += 1) addTarget(h, `acme/r${i}`, { pushedAt: '2026-10-12T00:00:00Z' });
    addTarget(h, 'acme/unmeasured');
    const line = h.app.assistantWatch.statusLine();
    expect(line).toContain('3 covered this cycle');
    expect(line).toContain('1 awaiting a first metadata read');
    expect(line).not.toContain('acme/');
    h.close();
  });
});

describe('the global monitoring switch', () => {
  it('reads nothing while paused, keeps every cursor, and resumes where it stood', async () => {
    const { h, clock, reader } = boot(null);
    const id = addTarget(h, 'acme/widgets');
    checkpoint(h, id, 'issues');
    h.store.assistantWatch.setMonitoring(OWNER, false, NOW);
    const out = await h.app.assistantWatch.tick();
    expect(out.callsUsed).toBe(0);
    expect(reader.calls).toBe(0);
    expect(h.store.assistantWatch.checkpoint(id, 'issues')).toMatchObject({ state: 'imported', cursor: '2026-10-10T00:00:00.000Z' });
    expect(h.app.assistantWatch.statusLine()).toContain('PAUSED');

    h.store.assistantWatch.setMonitoring(OWNER, true, NOW);
    clock.advance(MIN);
    expect((await h.app.assistantWatch.tick()).callsUsed).toBeGreaterThan(0);
    h.close();
  });

  it('is on when nothing was ever said', () => {
    const { h } = boot(null);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    h.close();
  });

  it('still delivers an alert that was already owed while paused', async () => {
    const { h } = boot(null);
    const id = addTarget(h, 'acme/widgets');
    checkpoint(h, id, 'pulls', '2026-10-12T00:00:00.000Z');
    h.store.assistantWatch.insertImportedEvent({
      id: 'a1', targetId: id, kind: 'review_requested_changes', identity: '3:review:r9', occurredAt: '2026-10-12T12:00:00.000Z',
      payloadJson: JSON.stringify({ number: 3, title: 'Add a thing' }), alertedAt: null, digestedAt: null, createdAt: NOW,
    });
    h.store.assistantWatch.setMonitoring(OWNER, false, NOW);
    const out = await h.app.assistantWatch.tick();
    expect(out.alertsSent).toBe(1);
    h.close();
  });
});
