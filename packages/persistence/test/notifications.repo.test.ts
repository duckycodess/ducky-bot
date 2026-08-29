import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore } from '../src/index.js';

const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  const store = createStore(db);
  store.repos.upsert({
    slug: 'demo',
    localPath: '/tmp/demo',
    allowJobs: true,
    defaultBranch: 'main',
    githubOwner: null,
    githubRepo: null,
    allowWorktree: true,
    allowBootstrap: false,
    bootstrapAllowedEntries: ['.git'],
    enabled: true,
  });
  return { db, store };
};

const makeJob = (
  store: ReturnType<typeof fresh>['store'],
  id: string,
  publicId: string,
  originSharedChannelId: string | null = null,
) =>
  store.jobs.create({
    id,
    publicId,
    discordUserId: 'owner-1',
    repoSlug: 'demo',
    task: 't',
    context: null,
    bootstrap: false,
    maxAttempts: 3,
    maxOwnerInputRounds: 3,
    state: 'queued',
    originSharedChannelId,
  });

describe('NotificationsRepo', () => {
  it('lists a transition as pending until every target is marked delivered', () => {
    const { store } = fresh();
    // Submitted from a shared channel, so this transition owes BOTH targets.
    const job = makeJob(store, 'j1', 'p1', '900000000000000001');
    store.jobs.transition(job.id, 'failed', 'no_result', 'executor:e1', {
      finishedAt: new Date().toISOString(),
    });

    const pending = store.notifications.pending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      jobId: job.id,
      publicId: 'p1',
      repoSlug: 'demo',
      fromState: 'queued',
      toState: 'failed',
      reason: 'no_result',
      actor: 'executor:e1',
    });

    // Two independent targets. Marking one leaves the transition pending for
    // the other, which is the whole point of the per-target ledger.
    store.notifications.markDelivered(pending[0]!.transitionId, job.id, 'owner_dm');
    const stillPending = store.notifications.pending(10);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]).toMatchObject({ ownerDelivered: true, sharedDelivered: false });

    store.notifications.markDelivered(pending[0]!.transitionId, job.id, 'shared_channel');
    expect(store.notifications.pending(10)).toHaveLength(0);
  });

  it('marking the same transition and target delivered twice is a no-op, not an error', () => {
    const { store } = fresh();
    const job = makeJob(store, 'j1', 'p1', '900000000000000001');
    store.jobs.transition(job.id, 'failed', 'no_result', 'executor:e1', {});

    const [row] = store.notifications.pending(10);
    for (const target of ['owner_dm', 'shared_channel'] as const) {
      store.notifications.markDelivered(row!.transitionId, job.id, target);
      expect(() =>
        store.notifications.markDelivered(row!.transitionId, job.id, target),
      ).not.toThrow();
    }
    expect(store.notifications.pending(10)).toHaveLength(0);
  });

  it('returns pending transitions oldest-first, independent per job', () => {
    const { store } = fresh();
    const a = makeJob(store, 'j1', 'p1');
    const b = makeJob(store, 'j2', 'p2');
    store.jobs.transition(a.id, 'failed', 'no_result', 'executor:e1', {});
    store.jobs.transition(b.id, 'cancelled', 'cancelled_by_owner', 'owner:u1', {});

    const pending = store.notifications.pending(10);
    expect(pending.map((p) => p.jobId)).toEqual([a.id, b.id]);
  });

  it('reports no shared target for a job that was not submitted from a shared channel', () => {
    const { store } = fresh();
    const job = makeJob(store, 'j1', 'p1');
    store.jobs.transition(job.id, 'failed', 'no_result', 'executor:e1', {});

    const [row] = store.notifications.pending(10);
    // Nowhere to share it, so that target is satisfied by construction and
    // never becomes a ledger row.
    expect(row).toMatchObject({ ownerDelivered: false, sharedDelivered: true });
    expect(row!.originSharedChannelId).toBeNull();

    store.notifications.markDelivered(row!.transitionId, job.id, 'owner_dm');
    expect(store.notifications.pending(10)).toHaveLength(0);
  });

  it('respects the limit', () => {
    const { store } = fresh();
    for (let i = 0; i < 5; i += 1) {
      const job = makeJob(store, `j${i}`, `p${i}`);
      store.jobs.transition(job.id, 'failed', 'no_result', 'executor:e1', {});
    }
    expect(store.notifications.pending(2)).toHaveLength(2);
    expect(store.notifications.pending(100)).toHaveLength(5);
  });
});
