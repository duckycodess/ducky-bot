import { describe, expect, it } from 'vitest';
import {
  JobPauseRequestSchema, SYSTEM_PAUSE_OWNER_TEXT, SYSTEM_RESUME_REASON, parseSystemPauseReason,
  systemPauseReason,
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
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('wall_clock_exceeded');
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
    // The earlier, genuine question notification still carries its question.
    expect(JSON.stringify(h.transport.sent)).toContain('STALE-QUESTION');
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
