import { describe, expect, it } from 'vitest';
import { AUDIT_FORBIDDEN_SUBSTRINGS, JOB_WORK_PHASES } from '@ducky/contracts';
import { OWNER, commitAction, implementedResult, makeHarness } from './helpers.js';

const claimed = (h: ReturnType<typeof makeHarness>, key = 'k1') => {
  h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
  return h.app.jobs.claim(h.executorId, key)!;
};

describe('work phases move a leased job through the engineering loop', () => {
  it('starts at preparing on claim, so a running job always has a phase', () => {
    const h = makeHarness();
    const claim = claimed(h);
    expect(h.store.jobs.byId(claim.jobId)?.workPhase).toBe('preparing');
    h.close();
  });

  it('advances on a progress report and reports the phase back', () => {
    const h = makeHarness();
    const claim = claimed(h);

    for (const phase of ['planning', 'implementing', 'reviewing', 'fixing', 'verifying'] as const) {
      const out = h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
        kind: 'progress', message: `now ${phase}`, phase,
      });
      expect(out.workPhase, phase).toBe(phase);
      expect(h.store.jobs.byId(claim.jobId)?.workPhase, phase).toBe(phase);
    }
    h.close();
  });

  it('is idempotent for the same phase, because a retried heartbeat is normal', () => {
    const h = makeHarness();
    const claim = claimed(h);
    h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
      kind: 'p', message: 'x', phase: 'planning',
    });
    const before = h.store.jobs.events(claim.jobId).filter((e) => e.kind === 'phase_changed').length;

    for (let i = 0; i < 3; i += 1) {
      expect(
        h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
          kind: 'p', message: 'x', phase: 'planning',
        }).workPhase,
      ).toBe('planning');
    }
    // No new phase_changed events: nothing actually changed.
    const after = h.store.jobs.events(claim.jobId).filter((e) => e.kind === 'phase_changed').length;
    expect(after).toBe(before);
    h.close();
  });

  it('refuses a backwards edge and leaves the phase untouched', () => {
    const h = makeHarness();
    const claim = claimed(h);
    h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
      kind: 'p', message: 'x', phase: 'implementing',
    });
    expect(() =>
      h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
        kind: 'p', message: 'x', phase: 'planning',
      }),
    ).toThrow(/cannot move from implementing to planning/);
    expect(h.store.jobs.byId(claim.jobId)?.workPhase).toBe('implementing');
    h.close();
  });

  it('still renews the lease when no phase is reported at all', () => {
    const h = makeHarness();
    const claim = claimed(h);
    const out = h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
      kind: 'progress', message: 'still going',
    });
    expect(out.workPhase).toBe('preparing');
    expect(out.leaseExpiresAt.length).toBeGreaterThan(0);
    h.close();
  });

  it('clears the phase the moment the job stops being leased', () => {
    const h = makeHarness();
    const claim = claimed(h);
    for (const phase of ['implementing', 'verifying'] as const) {
      h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, { kind: 'p', message: 'x', phase });
    }
    h.app.jobs.submitResult(
      h.executorId, claim.jobId, claim.leaseId,
      implementedResult({ proposedActions: [commitAction()] }), 400,
    );
    const after = h.store.jobs.byId(claim.jobId)!;
    expect(after.state).toBe('needs_approval');
    // A stale `verifying` on a paused job would be a rendered lie.
    expect(after.workPhase).toBeNull();
    h.close();
  });

  it('refuses a phase from a stale lease, exactly as any other report is', () => {
    const h = makeHarness();
    const claim = claimed(h);
    expect(() =>
      h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, 'not-the-lease', {
        kind: 'p', message: 'x', phase: 'planning',
      }),
    ).toThrow(/lease is no longer current/);
    h.close();
  });

  it('shows the phase on the owner’s private surface and never on a shared one', async () => {
    const SHARED = '900000000000000001';
    const h = makeHarness({ env: { DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED } });
    await h.transport.start((e) => h.app.router.handle(e));

    h.app.jobs.submit(
      h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false },
      { sharedChannelId: SHARED },
    );
    const claim = h.app.jobs.claim(h.executorId, 'k-shared')!;
    for (const phase of ['implementing', 'reviewing'] as const) {
      h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, { kind: 'p', message: 'x', phase });
    }
    const publicId = h.store.jobs.byId(claim.jobId)!.publicId;

    const priv = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'status', userId: OWNER, options: { id: publicId },
    });
    expect(JSON.stringify(priv)).toContain('reviewing');

    const shared = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'status', userId: OWNER,
      options: { id: publicId },
      context: { channelId: SHARED, guildId: '800000000000000001' },
    });
    const body = JSON.stringify(shared);
    for (const phase of JOB_WORK_PHASES) expect(body, phase).not.toContain(phase);
    h.close();
  });
});

describe('the audit log records the high-value events', () => {
  it('records creation, claim, phase change, approval and cancellation', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    const claim = h.app.jobs.claim(h.executorId, 'k-audit')!;
    h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
      kind: 'p', message: 'x', phase: 'implementing',
    });
    h.app.jobs.submitResult(
      h.executorId, claim.jobId, claim.leaseId,
      implementedResult({ proposedActions: [commitAction()] }), 400,
    );
    const approval = h.store.approvals.forJob(claim.jobId)[0]!;
    h.app.approvals.decide(h.owner, approval.id, 'approved');

    expect(h.store.auditLog.countByEvent('job.created')).toBe(1);
    expect(h.store.auditLog.countByEvent('job.claimed')).toBe(1);
    expect(h.store.auditLog.countByEvent('job.phase_changed')).toBe(1);
    expect(h.store.auditLog.countByEvent('approval.decided')).toBe(1);

    const forJob = h.store.auditLog.forSubject('job', job.publicId, 20);
    expect(forJob.map((r) => r.event)).toContain('job.created');
    expect(forJob.map((r) => r.event)).toContain('job.claimed');
    h.close();
  });

  it('records a failure and a cancellation with their reason', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    const claim = h.app.jobs.claim(h.executorId, 'k-fail')!;
    h.app.jobs.reportFailure(h.executorId, claim.jobId, claim.leaseId, 'no_result');
    expect(h.store.auditLog.countByEvent('job.failed')).toBe(1);
    expect(h.store.auditLog.recent(5)[0]?.outcome).toBe('failed');

    const second = h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 't', bootstrap: false });
    h.app.jobs.requestCancel(h.owner, second.publicId);
    expect(h.store.auditLog.countByEvent('job.cancelled')).toBe(1);
    h.close();
  });

  it('records a refused phase change as refused, not as success', () => {
    const h = makeHarness();
    const claim = claimed(h, 'k-refuse');
    h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
      kind: 'p', message: 'x', phase: 'implementing',
    });
    expect(() =>
      h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
        kind: 'p', message: 'x', phase: 'preparing',
      }),
    ).toThrow();
    const refused = h.store.auditLog.recent(20).find((r) => r.outcome === 'refused');
    expect(refused?.event).toBe('job.phase_changed');
    expect(refused?.detail).toMatch(/refused implementing -> preparing/);
    h.close();
  });

  it('names the executor by id and the owner by role, never by Discord id', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    h.app.jobs.claim(h.executorId, 'k-actor');

    const rows = h.store.auditLog.recent(20);
    const created = rows.find((r) => r.event === 'job.created')!;
    expect(created.actorKind).toBe('owner');
    expect(created.actorRef).toBe('owner');

    const claimRow = rows.find((r) => r.event === 'job.claimed')!;
    expect(claimRow.actorKind).toBe('executor');
    expect(claimRow.actorRef).toBe(h.executorId);

    // The owner's Discord id is unnecessary personal data in a long-lived
    // table, and there is exactly one owner, so it adds nothing.
    expect(JSON.stringify(rows)).not.toContain(OWNER);
    h.close();
  });
});

describe('the audit log holds no secret and no raw authentication material', () => {
  it('contains none of the forbidden substrings after a full job lifecycle', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    const claim = h.app.jobs.claim(h.executorId, 'k-secret')!;
    h.app.jobs.jobHeartbeat(h.executorId, claim.jobId, claim.leaseId, {
      kind: 'p', message: 'x', phase: 'implementing',
    });
    h.app.jobs.submitResult(
      h.executorId, claim.jobId, claim.leaseId,
      implementedResult({ proposedActions: [commitAction()] }), 400,
    );
    h.app.approvals.decide(h.owner, h.store.approvals.forJob(claim.jobId)[0]!.id, 'rejected');

    const dumped = JSON.stringify(h.store.auditLog.recent(200)).toLowerCase();
    expect(dumped.length).toBeGreaterThan(0);
    for (const forbidden of AUDIT_FORBIDDEN_SUBSTRINGS) {
      expect(dumped, forbidden).not.toContain(forbidden);
    }
    // The live credential material never appears either.
    expect(dumped).not.toContain(h.bearer.toLowerCase());
    expect(dumped).not.toContain(h.hmac.toLowerCase());
    // Nor does the lease, which is a capability rather than an identifier.
    expect(dumped).not.toContain(claim.leaseId.toLowerCase());
    h.close();
  });

  it('does not copy an action’s details into a long-lived record', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    const claim = h.app.jobs.claim(h.executorId, 'k-detail')!;
    h.app.jobs.submitResult(
      h.executorId, claim.jobId, claim.leaseId,
      implementedResult({ proposedActions: [commitAction('feat: a very distinctive message')] }),
      400,
    );
    h.app.approvals.decide(h.owner, h.store.approvals.forJob(claim.jobId)[0]!.id, 'approved');

    const dumped = JSON.stringify(h.store.auditLog.recent(50));
    // The KIND and the decision, not the content.
    expect(dumped).toContain('approved git_commit');
    expect(dumped).not.toContain('a very distinctive message');
    h.close();
  });

  it('clamps a long detail rather than storing it whole', () => {
    const h = makeHarness();
    h.store.auditLog.record({
      event: 'job.transitioned', actorKind: 'system', detail: 'y'.repeat(9000),
    });
    expect(h.store.auditLog.recent(1)[0]?.detail?.length).toBeLessThanOrEqual(300);
    h.close();
  });

  it('is never consulted by an authorization decision', () => {
    const h = makeHarness();
    // A forged row claiming anything at all confers nothing: authorization
    // reads frozen configuration, exactly as authorized_user_audit does not.
    h.store.auditLog.record({
      event: 'approval.decided', actorKind: 'owner', actorRef: '999999999999999999',
      subjectKind: 'job', subjectRef: 'jzzzzz', detail: 'owner',
    });
    expect(h.app.authz.roleOf('999999999999999999')).toBe('none');
    expect(() => h.app.jobs.list(h.app.authz.actor('999999999999999999'))).toThrow(
      /not authorized/i,
    );
    h.close();
  });
});
