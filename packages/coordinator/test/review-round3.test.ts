import { describe, expect, it } from 'vitest';
import { EXECUTOR_OFFLINE_AFTER_MS } from '@ducky/contracts';
import { Reconciler } from '../src/domain/reconciler.js';
import { PendingScheduleStore } from '../src/domain/pending-schedules.js';
import { implementedResult, makeHarness } from './helpers.js';

const claimOne = (h: ReturnType<typeof makeHarness>, key = 'k1') => {
  const c = h.app.jobs.claim(h.executorId, key);
  if (!c) throw new Error('claim failed');
  return c;
};

const reconcilerAt = (h: ReturnType<typeof makeHarness>, when: Date) =>
  new Reconciler({
    store: h.store,
    approvals: h.app.approvals,
    pending: new PendingScheduleStore(),
    now: () => when,
  });

const REGISTRATION = {
  workspaceId: 'wX',
  label: 'ducky-mgd:demo',
  mode: 'direct' as const,
  agentName: 'ducky-pi-demo',
  workspacePath: '/tmp/ducky-demo',
};

describe('a job heartbeat proves the executor is alive', () => {
  it('keeps a long-running job’s executor from being marked offline', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);

    // Age the executor as if the general heartbeat had stopped -- which is
    // exactly what a long turn looks like, since the loop is blocked inside
    // the run and only the supervisor's JOB heartbeats keep arriving.
    const stale = new Date(Date.now() - EXECUTOR_OFFLINE_AFTER_MS * 3).toISOString();
    h.store.db.prepare('UPDATE executors SET last_seen_at = ? WHERE id = ?').run(stale, h.executorId);

    const cutoff = new Date(Date.now() - EXECUTOR_OFFLINE_AFTER_MS).toISOString();
    expect(h.store.executors.offlineExecutors(cutoff).map((e) => e.id)).toContain(h.executorId);

    // One job heartbeat is enough to prove liveness again.
    h.app.jobs.jobHeartbeat(h.executorId, c.jobId, c.leaseId);
    expect(h.store.executors.offlineExecutors(cutoff).map((e) => e.id)).not.toContain(h.executorId);

    // And a fresh submission is not wrongly told to wait for an executor.
    const next = h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 'b', bootstrap: false });
    expect(next.state).toBe('queued');
    h.close();
  });

  it('would have looked offline without the fix', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    const stale = new Date(Date.now() - EXECUTOR_OFFLINE_AFTER_MS * 3).toISOString();
    h.store.db.prepare('UPDATE executors SET last_seen_at = ? WHERE id = ?').run(stale, h.executorId);

    // Renewing only the lease -- the old behaviour -- leaves it stale.
    h.store.jobs.touchLease(c.jobId, new Date(Date.now() + 60_000).toISOString());
    const cutoff = new Date(Date.now() - EXECUTOR_OFFLINE_AFTER_MS).toISOString();
    expect(h.store.executors.offlineExecutors(cutoff).map((e) => e.id)).toContain(h.executorId);
    h.close();
  });

  it('does mark it offline when nothing is heard at all', () => {
    const h = makeHarness();
    const past = new Date(Date.now() - EXECUTOR_OFFLINE_AFTER_MS * 3).toISOString();
    h.store.db.prepare('UPDATE executors SET last_seen_at = ? WHERE id = ?').run(past, h.executorId);

    const cutoff = new Date(Date.now() - EXECUTOR_OFFLINE_AFTER_MS).toISOString();
    expect(h.store.executors.offlineExecutors(cutoff).map((e) => e.id)).toContain(h.executorId);
    expect(reconcilerAt(h, new Date()).markOfflineExecutors()).toBeGreaterThan(0);
    h.close();
  });

  it('refuses a job heartbeat on a stale lease, so liveness cannot be forged', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    expect(() => h.app.jobs.jobHeartbeat(h.executorId, c.jobId, 'stale')).toThrow(
      /no longer current/,
    );
    h.close();
  });
});

describe('workspace close bookkeeping survives the lease being cleared', () => {
  const finished = (h: ReturnType<typeof makeHarness>) => {
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
    // Accepting the result clears the lease, which is why the close route
    // cannot require one.
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    return { job, claim: c };
  };

  it('marks the recorded row closed after a terminal job', () => {
    const h = makeHarness();
    const { job } = finished(h);
    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    expect(h.store.jobs.byId(job.id)?.leaseId).toBeNull();
    expect(h.store.herdrWorkspaces.byWorkspaceId('wX')?.closedAt).toBeNull();

    const out = h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX');
    expect(out).toEqual({ closed: true, workspaceId: 'wX' });
    expect(h.store.herdrWorkspaces.byWorkspaceId('wX')?.closedAt).not.toBeNull();
    // No longer open, so a reaper cannot act on stale metadata.
    expect(h.store.herdrWorkspaces.openForJob(job.id)).toBeUndefined();
    h.close();
  });

  it('is idempotent', () => {
    const h = makeHarness();
    const { job } = finished(h);
    h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX');
    expect(h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX').closed).toBe(true);
    h.close();
  });

  it('refuses a workspace that is not recorded for this job', () => {
    const h = makeHarness();
    const { job } = finished(h);
    // A user's workspace id, or simply an unknown one.
    expect(() => h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wUser')).toThrow(
      /not recorded for this job/,
    );
    h.close();
  });

  it('refuses an executor that does not own the job', () => {
    const h = makeHarness();
    const { job } = finished(h);
    expect(() => h.app.jobs.markWorkspaceClosed('someone-else', job.id, 'wX')).toThrow(
      /another executor/,
    );
    h.close();
  });
});

describe('workspace registration conflicts are decided in the transaction', () => {
  it('reports a conflict rather than a false success', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const first = claimOne(h);
    h.app.jobs.registerWorkspace(h.executorId, first.jobId, first.leaseId, REGISTRATION);

    const other = h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 'b', bootstrap: false });
    const second = h.app.jobs.claim(h.executorId, 'k2')!;
    expect(second.jobId).toBe(other.id);

    expect(() =>
      h.app.jobs.registerWorkspace(h.executorId, second.jobId, second.leaseId, {
        ...REGISTRATION,
        label: 'ducky-mgd:other',
        agentName: 'ducky-pi-other',
        workspacePath: '/tmp/ducky-other',
      }),
    ).toThrow(/already registered to a different job/);

    // The original ownership is intact.
    expect(h.store.herdrWorkspaces.byWorkspaceId('wX')?.jobId).toBe(first.jobId);
    h.close();
  });

  it('reports directly from the repository whether a row was written', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    const row = {
      workspaceId: 'wZ',
      repoSlug: 'demo',
      jobId: c.jobId,
      label: 'ducky-mgd:demo',
      mode: 'direct' as const,
      agentName: 'ducky-pi-demo',
      workspacePath: '/tmp/ducky-demo',
      worktreePath: null,
      state: 'creating' as const,
    };
    expect(h.store.herdrWorkspaces.record(row)).toBe(true);
    expect(h.store.herdrWorkspaces.record({ ...row, state: 'active' })).toBe(true);
    // A different owner is a no-op, and now says so.
    expect(h.store.herdrWorkspaces.record({ ...row, jobId: 'some-other-job' })).toBe(false);
    expect(h.store.herdrWorkspaces.byWorkspaceId('wZ')?.jobId).toBe(c.jobId);
    h.close();
  });
});

describe('orphan cleanup requires an observation, not just a flag', () => {
  const orphaned = (h: ReturnType<typeof makeHarness>) => {
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_agent_still_working', {
      workspaceId: 'wX',
    });
    return job;
  };

  it('refuses to release while the agent is observed working', () => {
    const h = makeHarness();
    const job = orphaned(h);
    const out = h.app.jobs.cleanup(h.owner, job.publicId, false, 'working');
    expect(out.released).toBe(false);
    expect(out.note).toMatch(/still working/);
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');
    h.close();
  });

  it('refuses to release when the agent state is unknown', () => {
    const h = makeHarness();
    const job = orphaned(h);
    expect(h.app.jobs.cleanup(h.owner, job.publicId, false).released).toBe(false);
    expect(h.app.jobs.cleanup(h.owner, job.publicId, false, 'unknown').released).toBe(false);
    expect(h.store.jobs.reservation('demo')).toBeDefined();
    h.close();
  });

  it('releases once the agent is observed gone or idle', () => {
    for (const observed of ['absent', 'idle', 'done'] as const) {
      const h = makeHarness();
      const job = orphaned(h);
      expect(h.app.jobs.cleanup(h.owner, job.publicId, false, observed).released, observed).toBe(
        true,
      );
      expect(h.store.jobs.reservation('demo')).toBeUndefined();
      h.close();
    }
  });

  it('lets force override an unresolved observation, and records that it did', () => {
    const h = makeHarness();
    const job = orphaned(h);
    expect(h.app.jobs.cleanup(h.owner, job.publicId, true, 'working').released).toBe(true);
    const events = h.store.jobs.events(job.id);
    expect(events.some((e) => e.kind === 'forced_cleanup')).toBe(true);
    expect(events.find((e) => e.kind === 'forced_cleanup')?.message).toMatch(/working/);
    h.close();
  });

  it('stays owner-only whatever the observation says', () => {
    const h = makeHarness();
    const job = orphaned(h);
    for (const actor of [h.chat, h.stranger]) {
      expect(() => h.app.jobs.cleanup(actor, job.publicId, true, 'absent')).toThrow(
        /not authorized/i,
      );
    }
    h.close();
  });
});
