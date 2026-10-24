import { describe, expect, it } from 'vitest';
import {
  JobPauseRequestSchema, SYSTEM_PAUSE_OWNER_TEXT, SYSTEM_RESUME_REASON, parsePauseOvertakenReason,
  parseSystemPauseReason, systemPauseReason,
} from '@ducky/contracts';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { Reconciler } from '../src/domain/reconciler.js';
import { implementedResult, makeHarness, OWNER } from './helpers.js';

/**
 * A SYSTEM pause: a quiet, result-less agent handed to the owner without
 * spending an attempt, a question round or a fabricated result.
 */

type H = ReturnType<typeof makeHarness>;

const REGISTRATION = {
  workspaceId: 'wX',
  label: 'ducky-mgd:demo',
  mode: 'direct' as const,
  agentName: 'ducky-pi-demo',
  workspacePath: '/tmp/ducky-demo',
};
const PROOF = { workspaceId: 'wX', agentName: 'ducky-pi-demo', agentStatus: 'idle' as const };
const PAUSE = { cause: 'agent_idle_no_result' as const, ...PROOF };

const submit = (h: H, repoSlug = 'demo') =>
  h.app.jobs.submit(h.owner, { repoSlug, task: `work on ${repoSlug}`, bootstrap: false });

/** Claims the next job and registers the workspace a real executor would have. */
function claimRegistered(h: H, key: string) {
  const c = h.app.jobs.claim(h.executorId, key)!;
  h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
  return c;
}

const rowCount = (h: H, table: string, jobId: string): number =>
  Number(
    (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`).get(jobId) as { n: number }).n,
  );

describe('pausing a quiet agent', () => {
  it('pauses without spending an attempt, a question round or a result', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');

    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({
      state: 'needs_owner_input',
      paused: true,
    });

    const row = h.store.jobs.byId(job.id)!;
    expect(row).toMatchObject({
      state: 'needs_owner_input', attempts: 0, ownerInputRounds: 0,
      leaseId: null, leaseExpiresAt: null, workPhase: null, attemptDeadlineAt: null,
      recoveryRequired: false,
    });
    expect(h.store.results.byJobId(job.id)).toBeUndefined();
    expect(rowCount(h, 'job_owner_inputs', job.id)).toBe(0);
    // The workspace and repository are retained; only the slot is released.
    expect(h.store.herdrWorkspaces.openForJob(job.id)).toMatchObject({ workspaceId: 'wX' });
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id, reason: 'active_job' });
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(parseSystemPauseReason(h.store.jobs.latestTransitionReasonInto(job.id, 'needs_owner_input')!)).toMatchObject({
      cause: 'agent_idle_no_result',
    });
    h.close();
  });

  it('clears recoveryRequired, so the resumed attempt is a fresh turn and not another recovery', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    h.store.db.prepare('UPDATE jobs SET recovery_required = 1 WHERE id = ?').run(job.id);
    const c = h.store.jobs.byId(job.id)!;
    h.app.jobs.pauseJob(h.executorId, job.id, c.leaseId!, PAUSE);
    expect(h.store.jobs.byId(job.id)?.recoveryRequired).toBe(false);
    h.close();
  });

  it('answers a retried report the same way, and refuses a different lease', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    const transitions = h.store.jobs.transitions(job.id).length;

    // The response was lost; the executor sends the same request again.
    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({
      state: 'needs_owner_input', paused: true,
    });
    expect(h.store.jobs.transitions(job.id)).toHaveLength(transitions);

    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, 'some-other-lease', PAUSE)).toThrow(/lease/i);
    // A repeat that names a different workspace is not the same report.
    expect(() =>
      h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, { ...PAUSE, workspaceId: 'wOther' }),
    ).toThrow();
    h.close();
  });

  it('refuses a proof that is not the recorded workspace and agent, changing nothing', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');

    for (const bad of [
      { ...PAUSE, workspaceId: 'wOther' },
      { ...PAUSE, agentName: 'ducky-pi-other' },
    ]) {
      expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, bad)).toThrow(/recorded/);
    }
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'running', leaseId: c.leaseId });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'active_attempt' });
    h.close();
  });

  it('refuses when no workspace was ever recorded', () => {
    const h = makeHarness();
    submit(h);
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toThrow(/recorded/);
    expect(h.store.jobs.admission()).toBeDefined();
    h.close();
  });

  it('refuses unless the job provably holds its own repository reservation', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');

    h.store.jobs.markReservationOrphan('demo');
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toThrow(/reservation/);
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');

    h.store.db.prepare('DELETE FROM repo_reservations WHERE repo_slug = ?').run('demo');
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toThrow(/reservation/);
    h.close();
  });

  it('is refused for a stale lease and for another executor', () => {
    const h = makeHarness();
    submit(h);
    const c = claimRegistered(h, 'k1');
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, 'stale', PAUSE)).toThrow(/lease/i);
    expect(() => h.app.jobs.pauseJob('other-executor', c.jobId, c.leaseId, PAUSE)).toThrow(/lease/i);
    h.close();
  });

  it('lets an owner cancellation win inside the same transaction', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');

    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({
      state: 'cancelled', paused: false,
    });
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    // Quiet was proven, so the repository and the slot are released.
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    expect(h.store.jobs.admission()).toBeUndefined();
    h.close();
  });

  it('lets an elapsed attempt deadline win, ending the job as a timeout', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.store.db
      .prepare('UPDATE jobs SET attempt_deadline_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), job.id);

    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({
      state: 'failed', paused: false,
    });
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'failed', attempts: 0 });
    expect(parsePauseOvertakenReason(h.store.jobs.transitions(job.id).at(-1)!.reason)?.outcome).toBe('timed_out');
    h.close();
  });

  it('rejects a request without positive quiescence at the schema', () => {
    const base = { leaseId: 'l', cause: 'agent_idle_no_result', workspaceId: 'w', agentName: 'a', agentStatus: 'idle' };
    expect(JobPauseRequestSchema.safeParse({ ...base, quiescent: true }).success).toBe(true);
    for (const bad of [
      { ...base },
      { ...base, quiescent: false },
      { ...base, quiescent: true, agentStatus: 'working' },
      { ...base, quiescent: true, agentStatus: 'unknown' },
      { ...base, quiescent: true, cause: 'quota_exhausted' },
      { ...base, quiescent: true, extra: 1 },
    ]) {
      expect(JobPauseRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('resuming a system pause', () => {
  it('survives two pause/resume cycles without touching attempts or question rounds', () => {
    const h = makeHarness();
    const job = submit(h);

    let c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);

    // Another repository may use the freed slot, but the SAME repository stays
    // held by the paused job.
    const sameRepo = submit(h, 'demo');
    const other = submit(h, 'other');
    const o = h.app.jobs.claim(h.executorId, 'k-other')!;
    expect(o.jobId).toBe(other.id);
    expect(h.store.jobs.byId(sameRepo.id)?.state).toBe('queued');
    h.app.jobs.submitResult(h.executorId, o.jobId, o.leaseId, implementedResult(), 500);

    expect(h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'go')).toMatchObject({ state: 'queued' });
    expect(h.store.jobs.byId(job.id)).toMatchObject({ attempts: 0, ownerInputRounds: 0 });
    expect(rowCount(h, 'job_owner_inputs', job.id)).toBe(0);
    // A repeated click is idempotent.
    expect(h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'go')).toMatchObject({
      note: expect.stringMatching(/already resumed/),
    });

    // The resumed job reacquires the slot and starts a NEW bounded attempt.
    c = h.app.jobs.claim(h.executorId, 'k2')!;
    expect(c.jobId).toBe(job.id);
    expect(c.payload.ownerInputRounds).toBe(0);
    expect(c.ownerInputs).toEqual([]);
    expect(c.attemptDeadlineAt).toBeTruthy();
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'active_attempt' });

    // Pause again: no unique (job, round) collision, nothing spent.
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    expect(h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'again')).toMatchObject({ state: 'queued' });
    expect(h.store.jobs.byId(job.id)).toMatchObject({ attempts: 0, ownerInputRounds: 0 });
    expect(rowCount(h, 'job_owner_inputs', job.id)).toBe(0);
    expect(
      h.store.jobs.transitions(job.id).filter((t) => t.reason === SYSTEM_RESUME_REASON),
    ).toHaveLength(2);
    h.close();
  });

  it('keeps a held slot blocking the resumed job without failing or backing it off', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    const other = submit(h, 'other');
    const o = h.app.jobs.claim(h.executorId, 'k-other')!;
    expect(o.jobId).toBe(other.id);

    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'go');
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'queued', attempts: 0 });
    h.close();
  });

  it('can be cancelled while paused, keeping the workspace', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    expect(h.app.jobs.requestCancel(h.owner, job.publicId).state).toBe('cancelled');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    expect(h.store.herdrWorkspaces.openForJob(job.id)).toBeDefined();
    h.close();
  });

  it('keeps the explicit 24-hour expiry of a paused job', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    const later = new Reconciler({
      store: h.store,
      approvals: h.app.approvals,
      pending: { sweep: () => 0 } as never,
      now: () => new Date(Date.now() + 25 * 60 * 60_000),
    });
    expect(later.expireReservations()).toBe(1);
    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('owner_input_expired');
    h.close();
  });
});

describe('what the owner sees during a system pause', () => {
  /** A real question round first, so a stale question and result exist. */
  function pausedAfterARealRound(h: H) {
    const job = submit(h);
    const first = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(
      h.executorId, first.jobId, first.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'STALE-QUESTION?', proposedActions: [] }),
      200,
    );
    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'the first one');
    const c = claimRegistered(h, 'k2');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    return job;
  }

  it('suppresses the earlier round in job detail and shows the generic explanation', () => {
    const h = makeHarness();
    const job = pausedAfterARealRound(h);
    const detail = h.app.jobs.detail(h.owner, job.publicId);
    expect(detail.result).toBeUndefined();
    expect(detail.systemPause?.message).toBe(SYSTEM_PAUSE_OWNER_TEXT.agent_idle_no_result);
    // The real round is untouched: its answer keeps its contract.
    expect(h.store.jobs.byId(job.id)?.ownerInputRounds).toBe(1);
    h.close();
  });

  it('does not offer a previous question or result in the pause notification', async () => {
    const h = makeHarness();
    pausedAfterARealRound(h);
    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const pauses = h.transport.sent.filter((s) =>
      s.message.embeds?.[0]?.fields?.some((f) => f.value === SYSTEM_PAUSE_OWNER_TEXT.agent_idle_no_result),
    );
    expect(pauses).toHaveLength(1);
    const fields = pauses[0]!.message.embeds![0]!.fields!;
    expect(fields.map((f) => f.name)).not.toContain('Question');
    expect(fields.map((f) => f.name)).not.toContain('Result');
    expect(JSON.stringify(pauses[0])).not.toContain('STALE-QUESTION');
    expect(JSON.stringify(pauses[0]!.message.rows)).toContain('Resume');
    // The earlier question's row is superseded by this pause and never reaches
    // the owner late: no stale question text and no stale button, anywhere.
    expect(JSON.stringify(h.transport.sent)).not.toContain('STALE-QUESTION');
    expect(JSON.stringify(h.transport.sent.map((m) => m.message.rows))).not.toContain('Answer');
    h.close();
  });

  it('keeps the shared projection free of the earlier round', () => {
    const h = makeHarness();
    const job = pausedAfterARealRound(h);
    const row = h.store.jobs.byId(job.id)!;
    expect(h.app.sharedJobs?.project(row)).toMatchObject({ resultSummary: null, resultVerdict: null });
    h.close();
  });
});

describe('transition reasons', () => {
  it('round-trips and rejects anything that is not a known cause and digest', () => {
    const reason = systemPauseReason('memory_headroom_unproven', 'lease-1');
    expect(parseSystemPauseReason(reason)?.cause).toBe('memory_headroom_unproven');
    for (const bad of [
      'system_pause:quota_exhausted:0123456789abcdef',
      'system_pause:agent_idle_no_result:xyz',
      'system_pause:agent_idle_no_result',
      'owner_answered',
    ]) {
      expect(parseSystemPauseReason(bad), bad).toBeUndefined();
    }
  });
});


/**
 * A delayed owner-input row must never describe, or act on, a wait that a later
 * wait has replaced. The ledger id of the latest move into the state decides.
 */
describe('superseded owner-input notifications', () => {
  const notifier = (h: H) =>
    new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });

  const labels = (h: H): string[] =>
    h.transport.sent.flatMap((m) =>
      (m.message.rows ?? []).flatMap((r) => r.buttons.map((b) => b.label)),
    );
  const text = (h: H): string => JSON.stringify(h.transport.sent);

  const realQuestion = (h: H, key: string, question: string) => {
    const c = h.app.jobs.claim(h.executorId, key)!;
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question, proposedActions: [] }),
      200,
    );
  };

  it('old question then system pause: only the pause speaks, and only with Resume', async () => {
    const h = makeHarness();
    const job = submit(h);
    realQuestion(h, 'k1', 'OLD-QUESTION?');
    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'answer one');
    const c = claimRegistered(h, 'k2');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);

    await notifier(h).deliverPending(); // one delayed sweep for everything
    expect(text(h)).not.toContain('OLD-QUESTION');
    expect(labels(h)).toEqual(['Resume']);
    h.close();
  });

  it('old system pause then a real question: only the question speaks, and only with Answer', async () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'go');
    realQuestion(h, 'k2', 'REAL-QUESTION?');

    await notifier(h).deliverPending();
    expect(text(h)).toContain('REAL-QUESTION');
    expect(text(h)).not.toContain(SYSTEM_PAUSE_OWNER_TEXT.agent_idle_no_result);
    expect(labels(h)).toEqual(['Answer']);
    h.close();
  });

  it('the same pause twice: the older row is dropped and exactly one Resume is offered', async () => {
    const h = makeHarness();
    const job = submit(h);
    let c = claimRegistered(h, 'k1');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'go');
    c = h.app.jobs.claim(h.executorId, 'k2')!;
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);

    const result = await notifier(h).deliverPending();
    expect(labels(h)).toEqual(['Resume']);
    expect(result.skipped).toBeGreaterThan(0);
    h.close();
  });

  it('a sweep that ran while a wait was current still delivers it, and the next wait speaks alone', async () => {
    const h = makeHarness();
    const job = submit(h);
    realQuestion(h, 'k1', 'LIVE-QUESTION?');
    await notifier(h).deliverPending();
    expect(text(h)).toContain('LIVE-QUESTION');
    expect(labels(h)).toEqual(['Answer']);

    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'answer one');
    const c = claimRegistered(h, 'k2');
    h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE);
    h.transport.sent.length = 0;
    await notifier(h).deliverPending();
    expect(text(h)).not.toContain('LIVE-QUESTION');
    expect(labels(h)).toEqual(['Resume']);
    h.close();
  });
});

/**
 * HONEST BOUNDARY. A pause the executor cannot deliver is not a pause. The job
 * is still running as far as the coordinator knows, so the reconciler treats the
 * silence as a lease expiry -- which SPENDS an attempt, keeps the slot as an
 * unconfirmed stop, and can exhaust the budget. These pin that behaviour so no
 * wording can claim otherwise. Retry-preserving delivery under an outage or
 * version skew is a required, unimplemented follow-up.
 */
describe('a pause that was never delivered', () => {
  const at = (h: H, ms: number) =>
    new Reconciler({
      store: h.store,
      approvals: h.app.approvals,
      pending: { sweep: () => 0 } as never,
      now: () => new Date(Date.now() + ms),
    });

  it('costs an attempt through lease expiry, retains the slot, and the recovery claim then pauses', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');

    expect(at(h, 10 * 60_000).expireLeases()).toBe(1);
    expect(h.store.jobs.byId(job.id)).toMatchObject({
      state: 'waiting_for_executor', attempts: 1, recoveryRequired: true, leaseId: null,
    });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toThrow(/lease/i);

    // The recovery claim meets the same quiet agent and pauses instead of prompting.
    const again = h.app.jobs.claim(h.executorId, 'k2')!;
    expect(again.payload.recoveryRequired).toBe(true);
    h.app.jobs.pauseJob(h.executorId, again.jobId, again.leaseId, PAUSE);
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 1 });
    expect(h.store.jobs.admission()).toBeUndefined();
    h.close();
  });

  it('exhausts a one-attempt budget on the second expiry and orphans the repository and the slot', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    expect(at(h, 10 * 60_000).expireLeases()).toBe(1);
    h.app.jobs.claim(h.executorId, 'k2');
    expect(at(h, 20 * 60_000).expireLeases()).toBe(1);

    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'failed', attempts: 2 });
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('lease_expired_exhausted');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id, reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    // Everything else stays blocked until the owner cleans up.
    const other = submit(h, 'other');
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();
    expect(h.store.jobs.byId(other.id)?.state).toBe('queued');
    h.close();
  });

  it('ends cancelled with an orphaned reservation when the owner cancelled before the silence', () => {
    const h = makeHarness();
    const job = submit(h);
    claimRegistered(h, 'k1');
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(at(h, 10 * 60_000).expireLeases()).toBe(1);

    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('lease_expired_after_cancel');
    expect(h.store.jobs.reservation('demo')).toMatchObject({ reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ reason: 'unconfirmed_stop' });
    h.close();
  });
});

describe('a lost response to a pause that lost the race', () => {
  it('replays a cancellation for the exact lease, and refuses any other lease or proof', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({ state: 'cancelled', paused: false });
    const transitions = h.store.jobs.transitions(job.id).length;

    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({ state: 'cancelled', paused: false });
    expect(h.store.jobs.transitions(job.id)).toHaveLength(transitions);
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, 'another-lease', PAUSE)).toThrow();
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, { ...PAUSE, workspaceId: 'wOther' })).toThrow();
    expect(() => h.app.jobs.pauseJob('other-executor', c.jobId, c.leaseId, PAUSE)).toThrow();
    h.close();
  });

  it('replays a deadline loss the same way', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.store.db
      .prepare('UPDATE jobs SET attempt_deadline_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), job.id);
    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({ state: 'failed', paused: false });
    expect(h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toEqual({ state: 'failed', paused: false });
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, 'another-lease', PAUSE)).toThrow();
    h.close();
  });
});


/**
 * A prompt that was submitted and never seen to settle (a stalled no-pickup) is
 * not a pause. Late pickup after the executor gave up looking must still find
 * the repository and the slot held, so no other job can start beside it.
 */
describe('an unsettled submitted prompt', () => {
  it('orphans the repository and the slot, so another repository cannot claim', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_prompt_unsettled', {
      detail: 'A prompt was submitted but the agent was not observed to pick it up or to finish a turn.',
    });

    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'failed', attempts: 0 });
    expect(h.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id, reason: 'orphan_agent' });
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });

    // The agent picks the work up late. Nothing about that frees anything.
    const other = submit(h, 'other');
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(h.store.jobs.byId(other.id)?.state).toBe('queued');
    const sameRepo = submit(h, 'demo');
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();
    expect(h.store.jobs.byId(sameRepo.id)?.state).toBe('queued');
    h.close();
  });

  it('is never a pause: the pause route will not take over the orphaned hold', () => {
    const h = makeHarness();
    const job = submit(h);
    const c = claimRegistered(h, 'k1');
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_prompt_unsettled');
    expect(() => h.app.jobs.pauseJob(h.executorId, c.jobId, c.leaseId, PAUSE)).toThrow();
    expect(h.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });
    h.close();
  });

  it('is accepted by the executor failure schema as an orphan reason', async () => {
    const { EXECUTOR_FAILURE_REASONS, ORPHAN_FAILURE_REASONS } = await import('@ducky/contracts');
    expect(EXECUTOR_FAILURE_REASONS).toContain('orphan_prompt_unsettled');
    expect(ORPHAN_FAILURE_REASONS).toContain('orphan_prompt_unsettled');
  });
});
