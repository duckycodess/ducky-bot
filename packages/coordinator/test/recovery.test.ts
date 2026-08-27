import { describe, expect, it } from 'vitest';
import { Reconciler } from '../src/domain/reconciler.js';
import { commitAction, implementedResult, makeHarness } from './helpers.js';

const claimOne = (h: ReturnType<typeof makeHarness>, key = 'k1') => {
  const c = h.app.jobs.claim(h.executorId, key);
  if (!c) throw new Error('claim failed');
  return c;
};

const at = (h: ReturnType<typeof makeHarness>, when: Date) =>
  new Reconciler({
    store: h.store,
    approvals: h.app.approvals,
    pending: (h.app as unknown as { reconciler: Reconciler }).reconciler
      ? ({ sweep: () => 0 } as never)
      : ({ sweep: () => 0 } as never),
    now: () => when,
  });

const future = (ms: number) => new Date(Date.now() + ms);

describe('lease expiry keeps the repository and asks for recovery', () => {
  it('moves the job back to waiting_for_executor without releasing the reservation', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    claimOne(h);
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });

    const r = at(h, future(10 * 60_000));
    expect(r.expireLeases()).toBe(1);

    const after = h.store.jobs.byId(job.id)!;
    expect(after.state).toBe('waiting_for_executor');
    expect(after.recoveryRequired).toBe(true);
    expect(after.attempts).toBe(1);
    // still holding the repo, so no second writer can start beside the workspace
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);
    expect(h.app.jobs.claim(h.executorId, 'k2')?.jobId).toBe(job.id);
    h.close();
  });

  it('fails and releases once attempts are exhausted', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    claimOne(h);
    at(h, future(10 * 60_000)).expireLeases();
    claimOne(h, 'k2');
    at(h, future(20 * 60_000)).expireLeases();

    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('lease_expired_exhausted');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });
});

describe('orphaned agents block the repository until the owner clears them', () => {
  const orphan = (h: ReturnType<typeof makeHarness>) => {
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_agent_still_working', {
      workspaceId: 'wX',
      agentName: 'ducky-pi-demo',
      detail: 'agent still working',
    });
    return { job, out };
  };

  it('converts the reservation instead of releasing it', () => {
    const h = makeHarness();
    const { job, out } = orphan(h);
    expect(out).toEqual({ state: 'failed', orphan: true });
    const reservation = h.store.jobs.reservation('demo')!;
    expect(reservation.reason).toBe('orphan_agent');
    expect(reservation.expiresAt).toBeNull();
    expect(h.store.jobs.byId(job.id)?.retainedWorkspaceId).toBe('wX');

    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    h.close();
  });

  it('never expires an orphan reservation automatically', () => {
    const h = makeHarness();
    orphan(h);
    expect(at(h, future(365 * 24 * 3600_000)).expireReservations()).toBe(0);
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');
    h.close();
  });

  it('is released only by an explicit owner cleanup', () => {
    const h = makeHarness();
    const { job } = orphan(h);
    expect(() => h.app.jobs.cleanup(h.chat, job.publicId, false)).toThrow(/not authorized/i);

    // Unforced cleanup needs an observation showing the agent has stopped.
    expect(h.app.jobs.cleanup(h.owner, job.publicId, false).released).toBe(false);
    const released = h.app.jobs.cleanup(h.owner, job.publicId, false, 'absent');
    expect(released.released).toBe(true);
    expect(h.store.jobs.reservation('demo')).toBeUndefined();

    const next = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });
    expect(h.app.jobs.claim(h.executorId, 'k3')?.jobId).toBe(next.id);
    h.close();
  });

  it('does not treat a normal active reservation as cleanup-able', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    claimOne(h);
    expect(h.app.jobs.cleanup(h.owner, job.publicId, false).released).toBe(false);
    expect(h.store.jobs.reservation('demo')).toBeDefined();
    h.close();
  });

  it('releases the repository for a non-orphan failure', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'workspace_rejected', {
      detail: 'directory not empty',
    });
    expect(out).toEqual({ state: 'failed', orphan: false });
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });
});

describe('reservation expiry has an explicit outcome per state', () => {
  it('fails an unanswered job safely and retains its workspace', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'q?', proposedActions: [] }),
      400,
    );
    expect(at(h, future(25 * 3600_000)).expireReservations()).toBe(1);

    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('owner_input_expired');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    // A later answer cannot restart it unsafely.
    expect(() => h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'late')).toThrow(/not waiting/);
    h.close();
  });

  it('resolves pending approvals safely and keeps the recorded result', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ proposedActions: [commitAction()] }),
      800,
    );
    const before = h.store.results.byJobId(job.id)!;

    // approvals outlive the reservation TTL for running work, so force the
    // reservation to look expired
    h.store.db.prepare(`UPDATE repo_reservations SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect(at(h, new Date()).expireReservations()).toBe(1);

    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('approvals_expired_reservation');
    expect(h.store.approvals.forJob(job.id).every((a) => a.state === 'expired')).toBe(true);
    expect(h.store.results.byJobId(job.id)?.snapshot).toEqual(before.snapshot);
    h.close();
  });

  it('gives a needs_approval job a reservation that outlives its approvals', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ proposedActions: [commitAction()] }),
      800,
    );
    const reservation = h.store.jobs.reservation('demo')!;
    const approval = h.store.approvals.forJob(job.id)[0]!;
    expect(Date.parse(reservation.expiresAt!)).toBeGreaterThan(Date.parse(approval.expiresAt));
    h.close();
  });
});
