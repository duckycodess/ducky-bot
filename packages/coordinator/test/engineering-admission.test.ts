import { describe, expect, it } from 'vitest';
import { ENGINEERING_ATTEMPT_GRACE_MS } from '@ducky/contracts';
import { Reconciler } from '../src/domain/reconciler.js';
import { EnvSchema, resolveEngineering } from '../src/config.js';
import { implementedResult, makeHarness, OWNER } from './helpers.js';

/**
 * The engineering slot is Ducky-wide WITHIN ONE COORDINATOR DATABASE. These
 * tests prove exactly that scope: one slot across repositories and executors
 * here. They say nothing about another profile or about agent-flow, which have
 * their own state, and nothing here should be read as cross-program admission.
 */

type H = ReturnType<typeof makeHarness>;

const submit = (h: H, repoSlug: string) =>
  h.app.jobs.submit(h.owner, { repoSlug, task: `work on ${repoSlug}`, bootstrap: false });

const at = (h: H, when: Date) =>
  new Reconciler({
    store: h.store,
    approvals: h.app.approvals,
    pending: { sweep: () => 0 } as never,
    now: () => when,
  });

const future = (ms: number) => new Date(Date.now() + ms);

const REGISTRATION = {
  workspaceId: 'wX',
  label: 'ducky-mgd:demo',
  mode: 'direct' as const,
  agentName: 'ducky-pi-demo',
  workspacePath: '/tmp/ducky-demo',
};

describe('one engineering slot across repositories', () => {
  it('leaves a second repository queued while the first attempt holds the slot', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const second = submit(h, 'other');

    const a = h.app.jobs.claim(h.executorId, 'k1');
    expect(a?.jobId).toBe(first.id);
    expect(h.store.jobs.admission()).toMatchObject({ jobId: first.id, reason: 'active_attempt' });

    // A second claim, from the same or another executor, gets nothing. The job
    // is not failed and not backed off; it simply has not been admitted.
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(h.store.jobs.byId(second.id)?.state).toBe('queued');
    expect(h.store.jobs.byId(second.id)?.attempts).toBe(0);
    h.close();
  });

  it('cannot hold two slots even if a caller tries to', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const second = submit(h, 'other');
    expect(h.store.jobs.acquireAdmission(first.id, 'demo')).toBe(true);
    expect(h.store.jobs.acquireAdmission(second.id, 'other')).toBe(false);
    expect(() =>
      h.store.db
        .prepare(
          `INSERT INTO engineering_admission (slot, job_id, repo_slug, acquired_at, reason)
           VALUES (2, ?, 'other', 'now', 'active_attempt')`,
        )
        .run(second.id),
    ).toThrow();
    h.close();
  });

  it('frees the slot when the attempt completes, then admits the queued job', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const second = submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);

    expect(h.store.jobs.byId(first.id)?.state).toBe('completed');
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.app.jobs.claim(h.executorId, 'k2')?.jobId).toBe(second.id);
    h.close();
  });

  it('releases the slot on a pause but keeps the repository, and the answered job reacquires', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which one?', proposedActions: [] }),
      200,
    );
    expect(h.store.jobs.byId(first.id)?.state).toBe('needs_owner_input');
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(first.id);

    // Another repository may use the freed slot meanwhile...
    const other = submit(h, 'other');
    const b = h.app.jobs.claim(h.executorId, 'k2')!;
    expect(b.jobId).toBe(other.id);

    // ...and the answered job waits behind it instead of running beside it.
    h.app.jobs.submitOwnerInput(h.owner, first.publicId, 'the first one');
    expect(h.store.jobs.byId(first.id)?.state).toBe('queued');
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();

    h.app.jobs.submitResult(h.executorId, b.jobId, b.leaseId, implementedResult(), 500);
    expect(h.app.jobs.claim(h.executorId, 'k4')?.jobId).toBe(first.id);
    h.close();
  });
});

describe('an uncertain stop keeps the slot', () => {
  it('retains it through lease expiry and re-takes it only for the same job', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const second = submit(h, 'other');
    h.app.jobs.claim(h.executorId, 'k1');

    expect(at(h, future(10 * 60_000)).expireLeases()).toBe(1);
    expect(h.store.jobs.byId(first.id)?.state).toBe('waiting_for_executor');
    expect(h.store.jobs.admission()).toMatchObject({ jobId: first.id, reason: 'unconfirmed_stop' });

    // The other repository is still blocked: a silent executor is not proof its
    // agent stopped.
    const again = h.app.jobs.claim(h.executorId, 'k2');
    expect(again?.jobId).toBe(first.id);
    expect(h.store.jobs.byId(second.id)?.state).toBe('queued');
    expect(h.store.jobs.admission()).toMatchObject({ jobId: first.id, reason: 'active_attempt' });
    h.close();
  });

  it('keeps blocking everything when a lost executor leaves a workspace behind', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);

    // First expiry requeues for recovery, the second exhausts the attempt.
    at(h, future(10 * 60_000)).expireLeases();
    h.app.jobs.claim(h.executorId, 'k2');
    at(h, future(20 * 60_000)).expireLeases();

    expect(h.store.jobs.byId(first.id)?.state).toBe('failed');
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');
    expect(h.store.jobs.admission()).toMatchObject({ jobId: first.id, reason: 'unconfirmed_stop' });
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();
    h.close();
  });

  it('does not let a reservation timer release a slot whose agent may still be live', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
    at(h, future(10 * 60_000)).expireLeases();

    h.store.db.prepare(`UPDATE repo_reservations SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect(at(h, new Date()).expireReservations()).toBe(1);

    expect(h.store.jobs.byId(first.id)?.state).toBe('failed');
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');
    expect(h.store.jobs.admission()?.jobId).toBe(first.id);
    h.close();
  });

  it('holds the slot for an orphaned agent until the owner clears it', () => {
    const h = makeHarness();
    const first = submit(h, 'demo');
    const other = submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_agent_still_working', {
      workspaceId: 'wX', agentName: 'ducky-pi-demo',
    });

    expect(h.store.jobs.admission()).toMatchObject({ jobId: first.id, reason: 'unconfirmed_stop' });
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();

    expect(h.app.jobs.cleanup(h.owner, first.publicId, false, 'absent').released).toBe(true);
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.app.jobs.claim(h.executorId, 'k3')?.jobId).toBe(other.id);
    h.close();
  });

  it('releases on a timeout only when the executor proved the agent quiet', () => {
    const quiet = makeHarness();
    const job = submit(quiet, 'demo');
    const c = quiet.app.jobs.claim(quiet.executorId, 'k1')!;
    quiet.app.jobs.registerWorkspace(quiet.executorId, c.jobId, c.leaseId, REGISTRATION);
    const out = quiet.app.jobs.reportFailure(
      quiet.executorId, c.jobId, c.leaseId, 'wall_clock_exceeded',
      { detail: 'budget reached', quiescent: true },
    );
    expect(out).toEqual({ state: 'failed', orphan: false });
    expect(quiet.store.jobs.admission()).toBeUndefined();
    expect(quiet.store.jobs.reservation('demo')).toBeUndefined();
    expect(quiet.store.jobs.byId(job.id)?.state).toBe('failed');
    quiet.close();

    // Without the proof, a registered workspace is an orphan and keeps the slot.
    const unproven = makeHarness();
    submit(unproven, 'demo');
    const u = unproven.app.jobs.claim(unproven.executorId, 'k1')!;
    unproven.app.jobs.registerWorkspace(unproven.executorId, u.jobId, u.leaseId, REGISTRATION);
    expect(
      unproven.app.jobs.reportFailure(unproven.executorId, u.jobId, u.leaseId, 'wall_clock_exceeded', {}),
    ).toEqual({ state: 'failed', orphan: true });
    expect(unproven.store.jobs.admission()?.reason).toBe('unconfirmed_stop');
    unproven.close();
  });

  it('ignores a quiescence claim on any other failure reason', () => {
    const h = makeHarness();
    submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {
      quiescent: true,
    });
    expect(out.orphan).toBe(true);
    expect(h.store.jobs.admission()?.reason).toBe('unconfirmed_stop');
    h.close();
  });
});

describe('the claimed-attempt deadline', () => {
  it('is persisted at claim and returned to the executor', () => {
    const h = makeHarness();
    const job = submit(h, 'demo');
    const before = Date.now();
    const c = h.app.jobs.claim(h.executorId, 'k1')!;

    const stored = h.store.jobs.byId(job.id)!.attemptDeadlineAt!;
    expect(c.attemptDeadlineAt).toBe(stored);
    const budget = Date.parse(stored) - before;
    expect(budget).toBeGreaterThan(59 * 60_000);
    expect(budget).toBeLessThanOrEqual(60 * 60_000 + 5_000);
    h.close();
  });

  it('survives a reclaim after lease expiry, so a restart cannot reset the budget', () => {
    const h = makeHarness();
    const job = submit(h, 'demo');
    const first = h.app.jobs.claim(h.executorId, 'k1')!;
    at(h, future(10 * 60_000)).expireLeases();
    const second = h.app.jobs.claim(h.executorId, 'k2')!;

    expect(second.jobId).toBe(job.id);
    expect(second.attemptDeadlineAt).toBe(first.attemptDeadlineAt);
    h.close();
  });

  it('ends with the attempt: a pause clears it and the next claim gets a fresh one', () => {
    const h = makeHarness();
    const job = submit(h, 'demo');
    const first = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(
      h.executorId, first.jobId, first.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which one?', proposedActions: [] }),
      200,
    );
    expect(h.store.jobs.byId(job.id)?.attemptDeadlineAt).toBeNull();

    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'that one');
    const second = h.app.jobs.claim(h.executorId, 'k2')!;
    expect(second.attemptDeadlineAt).toBeDefined();
    expect(Date.parse(second.attemptDeadlineAt!)).toBeGreaterThanOrEqual(
      Date.parse(first.attemptDeadlineAt!),
    );
    h.close();
  });

  it('is configurable in minutes and bounded', () => {
    const h = makeHarness({ env: { DUCKY_ENGINEERING_ATTEMPT_MINUTES: '5' } });
    submit(h, 'demo');
    const before = Date.now();
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    expect(Date.parse(c.attemptDeadlineAt!) - before).toBeLessThanOrEqual(5 * 60_000 + 5_000);
    h.close();

    const base = { OWNER_DISCORD_USER_ID: OWNER };
    expect(resolveEngineering(EnvSchema.parse(base)).attemptBudgetMs).toBe(60 * 60_000);
    expect(() => EnvSchema.parse({ ...base, DUCKY_ENGINEERING_ATTEMPT_MINUTES: '0' })).toThrow();
    expect(() => EnvSchema.parse({ ...base, DUCKY_ENGINEERING_ATTEMPT_MINUTES: '9999' })).toThrow();
  });

  it('makes the coordinator request cancellation for an attempt that ignored its deadline', () => {
    const h = makeHarness();
    const job = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    const deadline = Date.parse(c.attemptDeadlineAt!);

    // Inside the grace window nothing happens: the executor times itself out.
    expect(at(h, new Date(deadline + 1_000)).stopOverdueAttempts()).toBe(0);
    expect(h.store.jobs.byId(job.id)?.cancelRequested).toBe(false);

    expect(at(h, new Date(deadline + ENGINEERING_ATTEMPT_GRACE_MS + 1_000)).stopOverdueAttempts()).toBe(1);
    expect(h.store.jobs.byId(job.id)?.cancelRequested).toBe(true);
    expect(h.app.jobs.jobHeartbeat(h.executorId, c.jobId, c.leaseId).cancelRequested).toBe(true);
    // The job is NOT optimistically ended, and once flagged it is not flagged again.
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');
    expect(at(h, new Date(deadline + 10 * 60_000)).stopOverdueAttempts()).toBe(0);
    h.close();
  });
});

describe('engineering is off unless the operator turns it on', () => {
  it('defaults to disabled in configuration', () => {
    expect(resolveEngineering(EnvSchema.parse({ OWNER_DISCORD_USER_ID: OWNER })).enabled).toBe(false);
  });

  it('refuses a submission and answers no claim while disabled', () => {
    const h = makeHarness({ env: { DUCKY_ENGINEERING_ENABLED: '0' } });
    expect(() => submit(h, 'demo')).toThrow(/switched off/);
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    h.close();
  });

  it('stops answering claims at once when switched off, even for work already queued', () => {
    const on = makeHarness();
    submit(on, 'demo');
    // Same rows, a restarted coordinator with the switch off.
    const off = makeHarness({
      store: on.store,
      env: { DUCKY_ENGINEERING_ENABLED: '0' },
    });
    expect(off.app.jobs.claim(off.executorId, 'k1')).toBeUndefined();
    expect(on.store.jobs.admission()).toBeUndefined();
    on.close();
  });
});
