import { describe, expect, it } from 'vitest';
import { makeHarness, implementedResult, commitAction } from './helpers.js';

const claim = (h: ReturnType<typeof makeHarness>, key = 'idem-1') => {
  const c = h.app.jobs.claim(h.executorId, key);
  if (!c) throw new Error('expected a claim');
  return c;
};

describe('durable queue and claiming', () => {
  it('queues while no executor is online and delivers on the first claim', () => {
    const h = makeHarness({ registerExecutor: false });
    h.store.executors.upsertExecutor(h.executorId, 'e');
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    expect(job.state).toBe('waiting_for_executor');

    const c = claim(h);
    expect(c.publicId).toBe(job.publicId);
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');
    h.close();
  });

  it('returns the same lease for a repeated idempotency key', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const first = claim(h, 'same-key');
    const second = claim(h, 'same-key');
    expect(second.leaseId).toBe(first.leaseId);
    expect(second.jobId).toBe(first.jobId);
    h.close();
  });

  it('holds the repository across every nonterminal state', () => {
    const h = makeHarness();
    const a = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });

    const c = claim(h);
    expect(c.jobId).toBe(a.id);
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(a.id);

    // running: the second job cannot be claimed
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();

    // needs_owner_input: still reserved
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which db?', proposedActions: [] }),
      500,
    );
    expect(h.store.jobs.byId(a.id)?.state).toBe('needs_owner_input');
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(a.id);
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();

    // answered: the SAME job re-claims under its own reservation
    h.app.jobs.submitOwnerInput(h.owner, a.publicId, 'postgres');
    expect(h.store.jobs.byId(a.id)?.state).toBe('queued');
    const again = claim(h, 'k4');
    expect(again.jobId).toBe(a.id);
    expect(again.ownerInputs).toHaveLength(1);
    expect(again.ownerInputs[0]?.answer).toBe('postgres');

    // needs_approval: still reserved
    h.app.jobs.submitResult(
      h.executorId, again.jobId, again.leaseId,
      implementedResult({ proposedActions: [commitAction()] }),
      800,
    );
    expect(h.store.jobs.byId(a.id)?.state).toBe('needs_approval');
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(a.id);
    expect(h.app.jobs.claim(h.executorId, 'k5')).toBeUndefined();
    h.close();
  });

  it('releases the repository when the job reaches a terminal state', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('completed');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();

    const b = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });
    expect(claim(h, 'k9').jobId).toBe(b.id);
    h.close();
  });

  it('rejects heartbeats and results on a stale lease', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    expect(() => h.app.jobs.jobHeartbeat(h.executorId, c.jobId, 'stale-lease')).toThrow(/no longer current/);
    expect(() =>
      h.app.jobs.submitResult(h.executorId, c.jobId, 'stale-lease', implementedResult(), 500),
    ).toThrow(/no longer current/);
    h.close();
  });
});

describe('owner input rounds', () => {
  const toNeedsInput = (h: ReturnType<typeof makeHarness>, key: string) => {
    const c = claim(h, key);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'q?', proposedActions: [] }),
      500,
    );
    return c;
  };

  it('records the answer, requeues, and refreshes the reservation', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    toNeedsInput(h, 'k1');
    const out = h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'use postgres');
    expect(out.state).toBe('queued');
    expect(h.store.jobs.ownerInputs(job.id)).toHaveLength(1);
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);
    h.close();
  });

  it('rejects an answer in the wrong state and an over-long answer', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    expect(() => h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'x')).toThrow(/not waiting/);
    toNeedsInput(h, 'k1');
    expect(() => h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'y'.repeat(3000))).not.toThrow();
    h.close();
  });

  it('fails safely once the rounds are exhausted', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    for (let i = 0; i < 3; i += 1) {
      toNeedsInput(h, `k${i}`);
      h.app.jobs.submitOwnerInput(h.owner, job.publicId, `answer ${i}`);
    }
    toNeedsInput(h, 'k-final');
    const out = h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'one more');
    expect(out.state).toBe('failed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('owner_input_rounds_exhausted');
    h.close();
  });
});

describe('cancellation', () => {
  it('cancels a queued job immediately and is idempotent', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    expect(h.app.jobs.requestCancel(h.owner, job.publicId).state).toBe('cancelled');
    expect(h.app.jobs.requestCancel(h.owner, job.publicId).state).toBe('cancelled');
    h.close();
  });

  it('only flags a running job, and never marks it cancelled optimistically', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    const out = h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(out.state).toBe('running');
    expect(h.store.jobs.byId(job.id)?.cancelRequested).toBe(true);
    expect(h.app.jobs.jobHeartbeat(h.executorId, c.jobId, c.leaseId).cancelRequested).toBe(true);
    h.close();
  });

  it('cancel-ack{terminated:false} leaves the job running', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);
    const out = h.app.jobs.cancelAck(h.executorId, c.jobId, c.leaseId, false, 'still working');
    expect(out.state).toBe('running');
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');
    expect(h.store.jobs.byId(job.id)?.cancelRequested).toBe(true);
    expect(h.store.jobs.events(job.id).some((e) => e.kind === 'cancel_ack_not_terminated')).toBe(true);
    h.close();
  });

  it('cancel-ack{terminated:true} cancels and releases the repository', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.app.jobs.cancelAck(h.executorId, c.jobId, c.leaseId, true).state).toBe('cancelled');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });

  it('cancels from needs_owner_input immediately', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'q?', proposedActions: [] }),
      400,
    );
    expect(h.app.jobs.requestCancel(h.owner, job.publicId).state).toBe('cancelled');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('cancelled_awaiting_owner_input');
    h.close();
  });

  it('cancels from needs_approval, rejecting pending actions and keeping the snapshot', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claim(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ proposedActions: [commitAction(), commitAction('feat: b')] }),
      900,
    );
    const before = h.store.results.byJobId(job.id)!;
    expect(h.app.jobs.requestCancel(h.owner, job.publicId).state).toBe('cancelled');

    const approvals = h.store.approvals.forJob(job.id);
    expect(approvals.every((a) => a.state === 'rejected')).toBe(true);
    expect(approvals.every((a) => a.decisionReason === 'job_cancelled')).toBe(true);
    const after = h.store.results.byJobId(job.id)!;
    expect(after.resultSha256).toBe(before.resultSha256);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });
});
