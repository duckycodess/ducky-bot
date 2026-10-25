import { describe, expect, it } from 'vitest';
import { Reconciler } from '../src/domain/reconciler.js';
import { implementedResult, makeHarness } from './helpers.js';

/**
 * A reservation, and the engineering slot that goes with it, belong to ONE job.
 * Releasing by repository alone let a job that never held either one remove the
 * running job's, so a job on another repository could claim beside a live writer.
 */
type H = ReturnType<typeof makeHarness>;

const submit = (h: H, repoSlug: string) =>
  h.app.jobs.submit(h.owner, { repoSlug, task: `work on ${repoSlug}`, bootstrap: false });

const REGISTRATION = {
  workspaceId: 'wX', label: 'ducky-mgd:demo', mode: 'direct' as const,
  agentName: 'ducky-pi-demo', workspacePath: '/tmp/ducky-demo',
};

const at = (h: H, ms: number) =>
  new Reconciler({
    store: h.store,
    approvals: h.app.approvals,
    pending: { sweep: () => 0 } as never,
    now: () => new Date(Date.now() + ms),
  });

describe('cancelling a queued job on a repository another job is running on', () => {
  function runningAWithQueuedB(h: H) {
    const a = submit(h, 'demo');
    const claimA = h.app.jobs.claim(h.executorId, 'kA')!;
    expect(claimA.jobId).toBe(a.id);
    const b = submit(h, 'demo');
    expect(h.store.jobs.byId(b.id)?.state).toBe('queued');
    return { a, b, claimA };
  }

  it('leaves the running job its reservation AND its slot, so another repository cannot claim', () => {
    const h = makeHarness();
    const { a, b } = runningAWithQueuedB(h);
    const c = submit(h, 'other');

    expect(h.app.jobs.requestCancel(h.owner, b.publicId).state).toBe('cancelled');

    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: a.id, reason: 'active_job' });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: a.id, reason: 'active_attempt' });
    // The job on the other repository is still held back by A's slot.
    expect(h.app.jobs.claim(h.executorId, 'kC')).toBeUndefined();
    expect(h.store.jobs.byId(c.id)?.state).toBe('queued');
    h.close();
  });

  it('keeps that protection through lease expiry, which retains the slot as an unconfirmed stop', () => {
    const h = makeHarness();
    const { a, b } = runningAWithQueuedB(h);
    submit(h, 'other');
    h.app.jobs.requestCancel(h.owner, b.publicId);

    expect(at(h, 10 * 60_000).expireLeases()).toBe(1);
    expect(h.store.jobs.byId(a.id)?.state).toBe('waiting_for_executor');
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(a.id);
    expect(h.store.jobs.admission()).toMatchObject({ jobId: a.id, reason: 'unconfirmed_stop' });
    expect(h.app.jobs.claim(h.executorId, 'kC')?.jobId).toBe(a.id); // only A may re-take it
    h.close();
  });

  it('does not disturb an ORPHANED reservation of the running job either', () => {
    const h = makeHarness();
    const { a, b, claimA } = runningAWithQueuedB(h);
    h.app.jobs.registerWorkspace(h.executorId, claimA.jobId, claimA.leaseId, REGISTRATION);
    h.app.jobs.reportFailure(h.executorId, claimA.jobId, claimA.leaseId, 'no_result');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: a.id, reason: 'orphan_agent' });

    h.app.jobs.requestCancel(h.owner, b.publicId);
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: a.id, reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: a.id, reason: 'unconfirmed_stop' });
    h.close();
  });

  it('still releases a cancelled job its OWN reservation and slot', () => {
    const h = makeHarness();
    const a = submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'kA');
    const claimed = h.store.jobs.byId(a.id)!;
    // A paused job holds a reservation but no slot; cancelling it releases at once.
    h.app.jobs.submitResult(
      h.executorId, a.id, claimed.leaseId!,
      implementedResult({ verdict: 'needs_owner_input', question: 'which?', proposedActions: [] }), 200,
    );
    h.app.jobs.requestCancel(h.owner, a.publicId);
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    expect(h.store.jobs.admission()).toBeUndefined();
    h.close();
  });
});

describe('no other release path may take another job’s reservation', () => {
  it('a terminal result for a job that does not hold the repository releases nothing', () => {
    const h = makeHarness();
    const a = submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'kA');
    const b = submit(h, 'demo');
    // Even a forced terminal state on the queued job must not reach A's hold.
    h.store.jobs.transition(b.id, 'failed', 'test', 'system:test', { finishedAt: new Date().toISOString() });
    expect(h.store.jobs.releaseReservation('demo', b.id)).toBe(false);
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(a.id);
    expect(h.store.jobs.admission()?.jobId).toBe(a.id);
    h.close();
  });

  it('an expiring reservation releases only its own job, and the owner cleanup its own', () => {
    const h = makeHarness();
    const a = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'kA')!;
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result');
    const b = submit(h, 'demo');

    // Cleanup of B (which holds nothing) is refused and changes nothing.
    expect(h.app.jobs.cleanup(h.owner, b.publicId, true).released).toBe(false);
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(a.id);
    // Cleanup of A releases A's own reservation and its slot.
    expect(h.app.jobs.cleanup(h.owner, a.publicId, true).released).toBe(true);
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    expect(h.store.jobs.admission()).toBeUndefined();
    h.close();
  });
});
