import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAUSE_DELIVERY_CAPABILITY, PauseDeliveryResponseSchema, leaseDigest, parseSystemPauseReason,
  type PauseReportRequest,
} from '@ducky/contracts';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { Reconciler } from '../src/domain/reconciler.js';
import { makeHarness, OWNER } from './helpers.js';

/**
 * Durable pause delivery, coordinator side.
 *
 * The property under test: a pause the executor holds durably survives its
 * lease expiring, the coordinator restarting and its response being lost,
 * WITHOUT charging the attempt, exhausting the job, releasing anyone else's
 * holds or touching a newer attempt -- while silence, and every peer that did
 * not negotiate the protocol, keeps the ordinary conservative accounting.
 */

type H = ReturnType<typeof makeHarness>;

const NEGOTIATE = ['herdr-pi', PAUSE_DELIVERY_CAPABILITY];
const REGISTRATION = {
  workspaceId: 'wX',
  label: 'ducky-mgd:demo',
  mode: 'direct' as const,
  agentName: 'ducky-pi-demo',
  workspacePath: '/tmp/ducky-demo',
};
const REPORT_A = '11111111-1111-4111-8111-111111111111';
const REPORT_B = '22222222-2222-4222-8222-222222222222';

const report = (leaseId: string, over: Partial<PauseReportRequest> = {}): PauseReportRequest => ({
  protocol: 1,
  reportId: REPORT_A,
  leaseId,
  cause: 'agent_idle_no_result',
  workspaceId: REGISTRATION.workspaceId,
  agentName: REGISTRATION.agentName,
  agentStatus: 'idle',
  quiescent: true,
  ...over,
});

const submit = (h: H, repoSlug = 'demo') =>
  h.app.jobs.submit(h.owner, { repoSlug, task: `work on ${repoSlug}`, bootstrap: false });

function claimRegistered(h: H, key: string, capabilities: readonly string[] = NEGOTIATE) {
  const c = h.app.jobs.claim(h.executorId, key, capabilities)!;
  h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
  return c;
}

const at = (h: H, ms: number) =>
  new Reconciler({
    store: h.store,
    approvals: h.app.approvals,
    pending: { sweep: () => 0 } as never,
    now: () => new Date(Date.now() + ms),
  });

const EXPIRED = 10 * 60_000;
const count = (h: H, table: string, jobId: string): number =>
  Number((h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`).get(jobId) as { n: number }).n);
const transitionsInto = (h: H, jobId: string, state: string) =>
  h.store.jobs.transitions(jobId).filter((t) => t.to === state);

describe('negotiation', () => {
  it('echoes the protocol only to an executor that advertised it, and records it on the job', () => {
    const h = makeHarness();
    const job = submit(h);
    const plain = h.app.jobs.claim(h.executorId, 'k1', ['herdr-pi'])!;
    expect(plain.pauseProtocol).toBeUndefined();
    expect(h.store.jobs.byId(job.id)?.deliveryProtocol).toBe(0);
    h.close();

    const g = makeHarness();
    const j2 = submit(g);
    const neg = g.app.jobs.claim(g.executorId, 'k1', NEGOTIATE)!;
    expect(neg.pauseProtocol).toBe(1);
    expect(g.store.jobs.byId(j2.id)?.deliveryProtocol).toBe(1);
    g.close();
  });
});

describe('an expired lease whose executor holds a durable pause', () => {
  it('defers the charge, keeps every hold, and a bound report then pauses with the budget intact', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');

    expect(at(h, EXPIRED).expireLeases()).toBe(1);
    // FAILURE-BEFORE (ordinary path): attempts would be 1 here. Deferred: nothing charged.
    expect(h.store.jobs.byId(job.id)).toMatchObject({
      state: 'waiting_for_executor', attempts: 0, recoveryRequired: true, leaseId: null,
    });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);
    expect(h.store.jobs.pendingExpiry(job.id)).toMatchObject({
      leaseDigest: leaseDigest(c.leaseId), executorId: h.executorId, workspaceId: 'wX',
      agentName: 'ducky-pi-demo', attemptsBefore: 0, chargeState: 'deferred', disposition: 'pending',
    });
    // The first route cannot land it: the lease is gone.
    expect(() =>
      h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, {
        cause: 'agent_idle_no_result', workspaceId: 'wX', agentName: 'ducky-pi-demo', agentStatus: 'idle',
      }),
    ).toThrow(/lease/i);

    const res = h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(PauseDeliveryResponseSchema.parse(res)).toMatchObject({
      reportId: REPORT_A, disposition: 'paused', state: 'needs_owner_input', jobId: job.id,
      leaseDigest: leaseDigest(c.leaseId),
    });

    // SUCCESS-AFTER.
    expect(h.store.jobs.byId(job.id)).toMatchObject({
      state: 'needs_owner_input', attempts: 0, ownerInputRounds: 0, recoveryRequired: false,
      leaseId: null, attemptDeadlineAt: null,
    });
    expect(count(h, 'job_owner_inputs', job.id)).toBe(0);
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id, reason: 'active_job' });
    expect(h.store.herdrWorkspaces.openForJob(job.id)).toMatchObject({ workspaceId: 'wX' });
    expect(h.store.jobs.pendingExpiry(job.id)).toBeUndefined();
    expect(h.store.jobs.expiryFor(job.id, leaseDigest(c.leaseId))).toMatchObject({
      chargeState: 'not_charged', disposition: 'paused',
    });
    // Exactly one needs_owner_input transition, parseable, so the Resume button and
    // the supersession check apply.
    const into = transitionsInto(h, job.id, 'needs_owner_input');
    expect(into).toHaveLength(1);
    expect(parseSystemPauseReason(into[0]!.reason)).toMatchObject({
      cause: 'agent_idle_no_result', leaseDigest: leaseDigest(c.leaseId),
    });
    h.close();
  });

  it('keeps the budget across REPEATED expiries and still pauses (the ordinary path exhausts here)', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    expect(at(h, EXPIRED).expireLeases()).toBe(1);

    // The recovery claim is the ordinary recovery it always was: it charges once.
    const again = h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE)!;
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', attempts: 1 });
    expect(h.store.jobs.expiriesFor(job.id).map((e) => [e.disposition, e.chargeState])).toEqual([
      ['charged', 'charged'],
    ]);

    // That lease also lapses with its report undelivered: still nothing more charged.
    expect(at(h, 2 * EXPIRED).expireLeases()).toBe(1);
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 1 });

    const res = h.app.jobs.deliverPause(h.executorId, again.jobId, report(again.leaseId));
    expect(res.disposition).toBe('paused');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 1 });
    expect(h.store.jobs.admission()).toBeUndefined();
    h.close();
  });

  it('exhausts only through an ordinary recovery claim, once, and keeps the holds as an orphan', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE);
    at(h, 2 * EXPIRED).expireLeases();
    // Deferred again: the job is NOT failed by silence alone.
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 1 });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });

    // Nobody reported: the next claim is the second ordinary recovery and exhausts the budget.
    expect(h.app.jobs.claim(h.executorId, 'k3', NEGOTIATE)).toBeUndefined();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'failed', attempts: 2 });
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('lease_expired_exhausted');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id, reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    expect(h.store.jobs.pendingExpiry(job.id)).toBeUndefined();
    h.close();
  });

  it('keeps the slot and repository blocked for everyone else while the report is unknown', () => {
    const h = makeHarness();
    const first = submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    const other = submit(h, 'other');
    // Only the same job's own recovery claim can take the slot it holds; the other
    // job stays queued behind it, on another repository.
    expect(h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE)?.jobId).toBe(first.id);
    expect(h.store.jobs.byId(other.id)?.state).toBe('queued');
    expect(h.app.jobs.claim(h.executorId, 'k3', NEGOTIATE)).toBeUndefined();
    h.close();
  });

  it('is never failed, orphaned or superseded by the reservation timer while its report is unknown', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    expect(at(h, 2 * EXPIRED).expireLeases()).toBe(0);
    // Far past the 24-hour waiting bound, which would otherwise orphan it.
    expect(at(h, 48 * 60 * 60_000).expireReservations()).toBe(0);
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 0 });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id });
    expect(h.store.jobs.pendingExpiry(job.id)).toBeDefined();

    // ...and the executor that was offline all that time still reconciles it.
    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('paused');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 0 });
    h.close();
  });

  it('the owner can still cancel it, which orphans the holds for /job cleanup', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ reason: 'unconfirmed_stop' });
    expect(h.store.jobs.expiriesFor(job.id)[0]).toMatchObject({ disposition: 'cancelled', chargeState: 'not_charged' });
    h.close();
  });

  it('keeps the original attempt deadline through the wait and the recovery claim', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    const deadline = h.store.jobs.byId(job.id)!.attemptDeadlineAt;
    expect(deadline).not.toBeNull();
    at(h, EXPIRED).expireLeases();
    expect(h.store.jobs.byId(job.id)?.attemptDeadlineAt).toBe(deadline);
    const again = h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE)!;
    expect(again.attemptDeadlineAt).toBe(deadline);
    void c;
    h.close();
  });
});

describe('only the original executor, attested, can consume a deferred attempt', () => {
  const OTHER = 'exec-b';

  it('a second executor cannot claim, charge, exhaust or supersede it while the original is offline', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    const snapshot = () => JSON.stringify([
      h.store.jobs.byId(job.id), h.store.jobs.admission(), h.store.jobs.reservation('demo'),
      h.store.jobs.expiriesFor(job.id),
    ]);
    const before = snapshot();

    // Even repeatedly, and even advertising the protocol.
    for (const caps of [NEGOTIATE, ['herdr-pi'], []]) {
      for (let i = 0; i < 3; i += 1) expect(h.app.jobs.claim(OTHER, `other-${caps.length}-${i}`, caps)).toBeUndefined();
    }
    expect(snapshot()).toBe(before);
    expect(h.store.jobs.byId(job.id)?.attempts).toBe(0);

    // The original executor's durable report is still accepted afterwards.
    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('paused');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 0 });
    h.close();
  });

  it('the original executor cannot recover it without the attestation either', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    // An executor with an unresolved intent does not advertise the capability.
    expect(h.app.jobs.claim(h.executorId, 'k2', ['herdr-pi'])).toBeUndefined();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 0 });
    expect(h.store.jobs.pendingExpiry(job.id)).toBeDefined();

    expect(h.app.jobs.claim(h.executorId, 'k3', NEGOTIATE)?.jobId).toBe(job.id);
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', attempts: 1 });
    h.close();
  });

  it('a second executor stays out of a job that an attested claim already exhausted', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE);
    at(h, 2 * EXPIRED).expireLeases();
    expect(h.app.jobs.claim(OTHER, 'o1', NEGOTIATE)).toBeUndefined();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 1 });
    expect(h.app.jobs.claim(h.executorId, 'k3', NEGOTIATE)).toBeUndefined();
    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    h.close();
  });
});

describe('ordinary accounting is unchanged for peers that did not negotiate', () => {
  it('charges at expiry, records the expiry as charged, and a new-route report is superseded', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1', ['herdr-pi']);
    at(h, EXPIRED).expireLeases();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 1 });
    expect(h.store.jobs.expiryFor(job.id, leaseDigest(c.leaseId))).toMatchObject({
      chargeState: 'charged', disposition: 'charged', deliveryProtocol: 0,
    });

    const res = h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(res.disposition).toBe('superseded');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 1 });
    expect(h.store.jobs.admission()).toMatchObject({ reason: 'unconfirmed_stop' });
    h.close();
  });

  it('still exhausts at the second expiry and orphans, exactly as before', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1', ['herdr-pi']);
    at(h, EXPIRED).expireLeases();
    h.app.jobs.claim(h.executorId, 'k2', ['herdr-pi']);
    at(h, 2 * EXPIRED).expireLeases();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'failed', attempts: 2 });
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('lease_expired_exhausted');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ reason: 'orphan_agent' });
    h.close();
  });

  it('a lease with no recorded workspace is never deferred (there is nothing to pause)', () => {
    const h = makeHarness();
    const job = submit(h);
    h.app.jobs.claim(h.executorId, 'k1', NEGOTIATE);
    at(h, EXPIRED).expireLeases();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 1 });
    h.close();
  });
});

describe('a report is idempotent and bound to its full identity', () => {
  /** An expired, deferred job and the lease it expired under. */
  function expired(h: H) {
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    return { job, c };
  }

  it('answers a repeat after the commit identically and mutates nothing (lost response)', () => {
    const h = makeHarness();
    const { job, c } = expired(h);
    const first = h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    const before = {
      transitions: h.store.jobs.transitions(job.id).length,
      events: count(h, 'job_events', job.id),
      receipts: count(h, 'job_pause_receipts', job.id),
    };

    for (let i = 0; i < 3; i += 1) {
      expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId))).toEqual(first);
    }
    expect(h.store.jobs.transitions(job.id)).toHaveLength(before.transitions);
    expect(count(h, 'job_events', job.id)).toBe(before.events);
    expect(count(h, 'job_pause_receipts', job.id)).toBe(before.receipts);
    expect(h.store.jobs.byId(job.id)?.attempts).toBe(0);
    h.close();
  });

  it('an owner resume racing an old report answers the receipt and never pauses the newer attempt', () => {
    const h = makeHarness();
    const { job, c } = expired(h);
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));

    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'resume');
    const next = h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE)!;
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', leaseId: next.leaseId });

    // The same report, replayed late.
    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('paused');
    // A DIFFERENT report id for the same old lease is not a new pause either.
    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId, { reportId: REPORT_B })).disposition)
      .toBe('superseded');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', leaseId: next.leaseId });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'active_attempt' });
    expect(transitionsInto(h, job.id, 'needs_owner_input')).toHaveLength(1);
    h.close();
  });

  it('a report for an attempt a recovery claim already charged is superseded, never applied', () => {
    const h = makeHarness();
    const { job, c } = expired(h);
    const recovery = h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE)!;
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', attempts: 1 });

    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('superseded');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', attempts: 1, leaseId: recovery.leaseId });
    expect(h.store.jobs.admission()).toMatchObject({ reason: 'active_attempt' });
    expect(count(h, 'job_pause_receipts', job.id)).toBe(0);
    h.close();
  });

  it('refuses every mismatched identity without changing anything', () => {
    const h = makeHarness();
    const { job, c } = expired(h);
    const snapshot = () => JSON.stringify([
      h.store.jobs.byId(job.id), h.store.jobs.admission(), h.store.jobs.reservation('demo'),
      h.store.jobs.expiriesFor(job.id), count(h, 'job_pause_receipts', job.id),
    ]);
    const before = snapshot();

    for (const bad of [
      report(c.leaseId, { workspaceId: 'wOther' }),
      report(c.leaseId, { agentName: 'ducky-pi-other' }),
    ]) {
      expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, bad)).toThrow(/recorded/);
    }
    // Another executor, an unknown lease, and an unknown job.
    expect(() => h.app.jobs.deliverPause('exec-b', c.jobId, report(c.leaseId))).toThrow(/match/);
    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report('not-the-lease'))).toThrow(/match/);
    expect(() => h.app.jobs.deliverPause(h.executorId, 'no-such-job', report(c.leaseId))).toThrow(/Unknown job/);
    expect(snapshot()).toBe(before);
    h.close();
  });

  it('refuses to reuse a report id for a different report, job or executor', () => {
    const h = makeHarness();
    const { c } = expired(h);
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));

    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId, { agentName: 'ducky-pi-x' })))
      .toThrow(/already used/);
    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId, { cause: 'memory_headroom_unproven' })))
      .toThrow(/already used/);
    expect(() => h.app.jobs.deliverPause('exec-b', c.jobId, report(c.leaseId))).toThrow(/already used/);
    // Another job entirely.
    const other = submit(h, 'other');
    expect(() => h.app.jobs.deliverPause(h.executorId, other.id, report(c.leaseId))).toThrow(/already used/);
    h.close();
  });

  it('refuses when the job does not own its repository or its slot, releasing nothing', () => {
    const h = makeHarness();
    const { job, c } = expired(h);
    h.store.jobs.markReservationOrphan('demo');
    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId))).toThrow(/reservation/);
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    expect(h.store.jobs.pendingExpiry(job.id)).toBeDefined();
    h.close();

    const g = makeHarness();
    const e = expired(g);
    g.store.db.prepare('DELETE FROM engineering_admission').run();
    expect(() => g.app.jobs.deliverPause(g.executorId, e.c.jobId, report(e.c.leaseId))).toThrow(/slot/);
    expect(g.store.jobs.byId(e.job.id)?.state).toBe('waiting_for_executor');
    g.close();
  });

  it('a live report is refused unless the slot is this job\'s attempt slot, releasing nothing', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    const snap = () => JSON.stringify([h.store.jobs.byId(job.id), h.store.jobs.admission(), h.store.jobs.reservation('demo'), count(h, 'job_pause_receipts', job.id)]);
    const before = snap();

    // Missing.
    const row = h.store.jobs.admission()!;
    h.store.db.prepare('DELETE FROM engineering_admission').run();
    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId))).toThrow(/slot/);
    // An unconfirmed stop from an unrelated attempt.
    h.store.db.prepare(
      "INSERT INTO engineering_admission (slot, job_id, repo_slug, acquired_at, reason) VALUES (1,?,?,?,'unconfirmed_stop')",
    ).run(row.jobId, row.repoSlug, row.acquiredAt);
    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId))).toThrow(/slot/);
    // Another job's.
    h.store.db.prepare('DELETE FROM engineering_admission').run();
    h.store.db
      .prepare(
        `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, state, max_attempts, created_at, updated_at)
         VALUES ('j-foreign','jforeig','x','other','t','queued',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    h.store.jobs.acquireAdmission('j-foreign', 'other');
    expect(() => h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId))).toThrow(/slot/);
    // The older route shares the rule.
    expect(() =>
      h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, {
        cause: 'agent_idle_no_result', workspaceId: 'wX', agentName: 'ducky-pi-demo', agentStatus: 'idle',
      }),
    ).toThrow(/slot/);

    expect(h.store.jobs.admission()).toMatchObject({ jobId: 'j-foreign' });
    h.store.db.prepare('DELETE FROM engineering_admission').run();
    h.store.db.prepare(
      "INSERT INTO engineering_admission (slot, job_id, repo_slug, acquired_at, reason) VALUES (1,?,?,?,'active_attempt')",
    ).run(row.jobId, row.repoSlug, row.acquiredAt);
    expect(snap()).toBe(before);
    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('paused');
    h.close();
  });

  it("never releases another job's holds", () => {
    const h = makeHarness();
    const { job, c } = expired(h);
    // Another job's reservation on another repository must be untouched.
    h.store.db
      .prepare(
        `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, state, max_attempts, created_at, updated_at)
         VALUES ('j-other','jother','x','other','t','queued',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    h.store.jobs.acquireReservation('other', 'j-other', null);
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(h.store.jobs.reservation('other')).toMatchObject({ jobId: 'j-other' });
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id });
    h.close();
  });
});

describe('cancellation and the deadline win inside the transaction, on the coordinator clock', () => {
  function expiredJob(h: H) {
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    return { job, c };
  }

  it('an elapsed persisted deadline ends the job failed and a fresh bound proof clears only its slot', () => {
    const h = makeHarness();
    const { job, c } = expiredJob(h);
    h.store.db.prepare('UPDATE jobs SET attempt_deadline_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', job.id);

    const res = h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(res.disposition).toBe('overtaken_timed_out');
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'failed', attempts: 0 });
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toMatch(/^pause_overtaken:timed_out:/);
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    expect(h.store.jobs.expiryFor(job.id, leaseDigest(c.leaseId))).toMatchObject({
      disposition: 'overtaken_timed_out', chargeState: 'not_charged',
    });
    // A replay answers the receipt.
    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('overtaken_timed_out');
    h.close();
  });

  it('a cancellation flag wins over the report and the quiet proof lets the job release', () => {
    const h = makeHarness();
    const { job, c } = expiredJob(h);
    h.store.jobs.setCancelRequested(job.id);

    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('overtaken_cancelled');
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });

  it('a cancel that landed while waiting became a terminal orphan: a late proof never releases it', () => {
    const h = makeHarness();
    const { job, c } = expiredJob(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.store.jobs.reservation('demo')).toMatchObject({ reason: 'orphan_agent' });
    const before = JSON.stringify([h.store.jobs.byId(job.id), h.store.jobs.admission(), h.store.jobs.reservation('demo')]);

    const res = h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(res.disposition).toBe('superseded');
    expect(JSON.stringify([h.store.jobs.byId(job.id), h.store.jobs.admission(), h.store.jobs.reservation('demo')])).toBe(before);
    expect(h.store.jobs.expiryFor(job.id, leaseDigest(c.leaseId))).toMatchObject({ disposition: 'cancelled' });
    h.close();
  });

  it('a cancellation observed before the silence stays a terminal orphan and the report is superseded', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.requestCancel(h.owner, job.publicId);
    at(h, EXPIRED).expireLeases();
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');

    expect(h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId)).disposition).toBe('superseded');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ reason: 'unconfirmed_stop' });
    h.close();
  });
});

describe('the disposition query', () => {
  it('says pending for a live lease and for an open expiry, and what happened afterwards', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    const q = (over = {}) => ({
      protocol: 1 as const, reportId: REPORT_A, workspaceId: 'wX', agentName: 'ducky-pi-demo',
      cause: 'agent_idle_no_result' as const, leaseDigest: leaseDigest(c.leaseId), ...over,
    });

    expect(h.app.jobs.pauseDisposition(h.executorId, c.jobId, q()).disposition).toBe('pending');
    at(h, EXPIRED).expireLeases();
    expect(h.app.jobs.pauseDisposition(h.executorId, c.jobId, q()).disposition).toBe('pending');
    // Read-only.
    expect(h.store.jobs.pendingExpiry(job.id)).toBeDefined();

    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(h.app.jobs.pauseDisposition(h.executorId, c.jobId, q()).disposition).toBe('paused');

    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'resume');
    h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE);
    expect(h.app.jobs.pauseDisposition(h.executorId, c.jobId, q()).disposition).toBe('paused');
    expect(h.app.jobs.pauseDisposition(h.executorId, c.jobId, q({ reportId: REPORT_B })).disposition).toBe('superseded');
    h.close();
  });

  it('refuses a report id reused for another identity, an unknown lease, another executor and an unknown job', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    const q = {
      protocol: 1 as const, reportId: REPORT_A, workspaceId: 'wX', agentName: 'ducky-pi-demo',
      cause: 'agent_idle_no_result' as const, leaseDigest: leaseDigest(c.leaseId),
    };
    expect(() => h.app.jobs.pauseDisposition(h.executorId, c.jobId, { ...q, workspaceId: 'wY' })).toThrow(/already used/);
    expect(() => h.app.jobs.pauseDisposition('exec-b', c.jobId, q)).toThrow(/already used/);
    expect(() => h.app.jobs.pauseDisposition(h.executorId, c.jobId, { ...q, reportId: REPORT_B, leaseDigest: '0'.repeat(16) }))
      .toThrow(/match/);
    expect(() => h.app.jobs.pauseDisposition(h.executorId, 'nope', q)).toThrow(/Unknown job/);
    void job;
    h.close();
  });
});

describe('notification delivery is independent of the report being accepted', () => {
  it('a lost owner DM is retried after the reconcile, once, and the pause stays accepted', async () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    h.transport.failSends = true;
    await notifier.deliverPending();
    expect(h.transport.sent).toHaveLength(0);

    h.transport.failSends = false;
    await notifier.deliverPending();
    const pauses = h.transport.sent.filter((s) => JSON.stringify(s).includes('Resume'));
    expect(pauses).toHaveLength(1);
    // And not again.
    await notifier.deliverPending();
    expect(h.transport.sent.filter((s) => JSON.stringify(s).includes('Resume'))).toHaveLength(1);
    h.close();
  });
});

describe('coordinator restart over real persisted state', () => {
  it('a report for an attempt that expired before a restart still reconciles, and its replay after another restart answers the receipt', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-pause-delivery-'));
    const file = path.join(dir, 'coordinator.db');
    try {
      const db1 = openDatabase({ location: file });
      runMigrations(db1);
      const store1 = createStore(db1);
      const h1 = makeHarness({ store: store1, registerExecutor: true });
      store1.executors.upsertExecutor(h1.executorId, 'test executor');
      const job = submit(h1);
      const c = claimRegistered(h1, 'k1');
      expect(at(h1, EXPIRED).expireLeases()).toBe(1);
      db1.close();

      // New process: nothing in memory but the rows.
      const db2 = openDatabase({ location: file });
      runMigrations(db2);
      const store2 = createStore(db2);
      const h2 = makeHarness({ store: store2 });
      // A restarted coordinator's first reconcile tick must not charge or exhaust it.
      expect(at(h2, 2 * EXPIRED).expireLeases()).toBe(0);
      expect(store2.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 0 });

      const res = h2.app.jobs.deliverPause(h2.executorId, c.jobId, report(c.leaseId));
      expect(res.disposition).toBe('paused');
      db2.close();

      const db3 = openDatabase({ location: file });
      runMigrations(db3);
      const store3 = createStore(db3);
      const h3 = makeHarness({ store: store3 });
      expect(h3.app.jobs.deliverPause(h3.executorId, c.jobId, report(c.leaseId))).toEqual(res);
      expect(store3.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 0 });
      expect(store3.jobs.admission()).toBeUndefined();
      db3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retention and forget', () => {
  it('removes the ledgers with their finished job, and never while the job is live', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(count(h, 'job_pause_receipts', job.id)).toBe(1);
    expect(count(h, 'job_lease_expiries', job.id)).toBe(1);

    expect(h.store.retention.deleteJobUnitGuarded(job.id)).toMatchObject({ refusal: expect.any(String) });
    expect(count(h, 'job_pause_receipts', job.id)).toBe(1);

    h.app.jobs.requestCancel(h.owner, job.publicId);
    h.store.db.prepare("UPDATE jobs SET finished_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(job.id);
    h.store.db.prepare("DELETE FROM herdr_workspaces WHERE job_id = ?").run(job.id);
    const out = h.store.retention.deleteJobUnitGuarded(job.id);
    expect('deleted' in out).toBe(true);
    expect(count(h, 'job_pause_receipts', job.id)).toBe(0);
    expect(count(h, 'job_lease_expiries', job.id)).toBe(0);
    h.close();
  });
});

describe('job status for pruning an executor\'s durable records', () => {
  it('tells the executor that ran a job where it stands, and whether anything will run it again', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    expect(h.app.jobs.executorJobStatus(h.executorId, c.jobId)).toEqual({ jobId: job.id, state: 'running', executorDone: false });

    at(h, EXPIRED).expireLeases();
    expect(h.app.jobs.executorJobStatus(h.executorId, c.jobId)).toMatchObject({ state: 'waiting_for_executor', executorDone: false });

    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.app.jobs.executorJobStatus(h.executorId, c.jobId)).toMatchObject({ state: 'cancelled', executorDone: true });
    h.close();
  });

  it('marks completed, failed, cancelled and awaiting-approval as done, and a paused or queued job as not', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.deliverPause(h.executorId, c.jobId, report(c.leaseId));
    expect(h.app.jobs.executorJobStatus(h.executorId, c.jobId)).toMatchObject({ state: 'needs_owner_input', executorDone: false });
    for (const [state, done] of [['needs_approval', true], ['completed', true], ['failed', true], ['waiting_on_dependency', false], ['queued', false]] as const) {
      h.store.db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(state, job.id);
      expect(h.app.jobs.executorJobStatus(h.executorId, c.jobId).executorDone, state).toBe(done);
    }
    h.close();
  });

  it('is bound to the executor: another one learns nothing, an unknown job is not_found, an expired lease still counts', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    expect(() => h.app.jobs.executorJobStatus('exec-b', c.jobId)).toThrow(/not run by this executor/);
    expect(() => h.app.jobs.executorJobStatus(h.executorId, 'no-such-job')).toThrow(/Unknown job/);

    // The job moves to another executor; the one with an expired lease on it may still ask.
    at(h, EXPIRED).expireLeases();
    h.store.db.prepare('UPDATE jobs SET executor_id = ? WHERE id = ?').run('exec-b', job.id);
    expect(h.app.jobs.executorJobStatus(h.executorId, c.jobId).state).toBe('waiting_for_executor');
    expect(h.app.jobs.executorJobStatus('exec-b', c.jobId).state).toBe('waiting_for_executor');
    expect(() => h.app.jobs.executorJobStatus('exec-c', c.jobId)).toThrow();
    h.close();
  });
});

describe('an executor-state failure', () => {
  it('ends the job under its own reason, never as no_result, keeping the holds of a started agent', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'executor_state_unavailable', {
      detail: 'The record of what was submitted to the agent could not be written.',
    });
    expect(out).toEqual({ state: 'failed', orphan: true });
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('executor_state_unavailable');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ reason: 'orphan_agent' });
    h.close();
  });
});

describe('the owner is told about a deferred hold', () => {
  const notifierFor = (h: H) =>
    new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
  const dms = (h: H) => h.transport.sent.map((s) => JSON.stringify(s));
  const held = (h: H) => dms(h).filter((m) => m.includes('held for its executor'));

  it('sends one DM naming what is held and the way out, retried after a failed send, never repeated', async () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    const notifier = notifierFor(h);

    h.transport.failSends = true;
    await notifier.deliverPending();
    expect(held(h)).toHaveLength(0);
    h.transport.failSends = false;
    await notifier.deliverPending();
    await notifier.deliverPending();

    const msgs = held(h);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('demo');
    expect(msgs[0]).toContain('engineering slot');
    expect(msgs[0]).toContain(`/job cancel id:${job.publicId}`);
    expect(msgs[0]).toContain(`/job cleanup id:${job.publicId}`);
    expect(msgs[0]).toContain('Nothing expires these holds on a timer');
    // It offers no button that could act on the job.
    expect(msgs[0]).not.toContain('Resume');
    h.close();
  });

  it('is dropped when the wait is already over: reconciled, recovered, or cancelled before the sweep', async () => {
    // Reconciled by the executor's report.
    const a = makeHarness();
    submit(a);
    const ca = claimRegistered(a, 'k1');
    at(a, EXPIRED).expireLeases();
    a.app.jobs.deliverPause(a.executorId, ca.jobId, report(ca.leaseId));
    await notifierFor(a).deliverPending();
    expect(held(a)).toHaveLength(0);
    expect(dms(a).filter((m) => m.includes('Resume'))).toHaveLength(1);
    a.close();

    // Recovered by the attested claim.
    const b = makeHarness();
    submit(b);
    claimRegistered(b, 'k1');
    at(b, EXPIRED).expireLeases();
    b.app.jobs.claim(b.executorId, 'k2', NEGOTIATE);
    await notifierFor(b).deliverPending();
    expect(held(b)).toHaveLength(0);
    b.close();

    // Cancelled by the owner (who already got a synchronous reply).
    const c = makeHarness();
    const job = submit(c);
    claimRegistered(c, 'k1');
    at(c, EXPIRED).expireLeases();
    c.app.jobs.requestCancel(c.owner, job.publicId);
    await notifierFor(c).deliverPending();
    expect(held(c)).toHaveLength(0);
    c.close();
  });

  it('after a repeated deferral only the current hold speaks', async () => {
    const h = makeHarness();
    submit(h);
    claimRegistered(h, 'k1');
    at(h, EXPIRED).expireLeases();
    h.app.jobs.claim(h.executorId, 'k2', NEGOTIATE);
    at(h, 2 * EXPIRED).expireLeases();
    await notifierFor(h).deliverPending();
    expect(held(h)).toHaveLength(1);
    h.close();
  });

  it('says nothing for an ordinary expiry, which was always charged and visible as before', async () => {
    const h = makeHarness();
    submit(h);
    claimRegistered(h, 'k1', ['herdr-pi']);
    at(h, EXPIRED).expireLeases();
    await notifierFor(h).deliverPending();
    expect(held(h)).toHaveLength(0);
    h.close();
  });
});
