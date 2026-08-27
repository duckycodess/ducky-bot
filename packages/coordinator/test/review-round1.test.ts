import { describe, expect, it } from 'vitest';
import { Reconciler } from '../src/domain/reconciler.js';
import { PendingScheduleStore } from '../src/domain/pending-schedules.js';
import { commitAction, implementedResult, makeHarness } from './helpers.js';

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

const later = (ms: number) => new Date(Date.now() + ms);

/** Matches what the executor really sends: Ducky prefixes and the repo path. */
const registerWorkspace = (h: ReturnType<typeof makeHarness>, c: { jobId: string; leaseId: string }) =>
  h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, {
    workspaceId: 'wX',
    label: 'ducky-mgd:demo',
    mode: 'direct',
    agentName: 'ducky-pi-demo',
    workspacePath: '/tmp/ducky-demo',
  });

describe('forced cleanup cannot release a live reservation', () => {
  const states = [
    ['running', (h: ReturnType<typeof makeHarness>, c: ReturnType<typeof claimOne>) => void c],
    [
      'needs_owner_input',
      (h: ReturnType<typeof makeHarness>, c: ReturnType<typeof claimOne>) =>
        h.app.jobs.submitResult(
          h.executorId, c.jobId, c.leaseId,
          implementedResult({ verdict: 'needs_owner_input', question: 'q?', proposedActions: [] }),
          400,
        ),
    ],
    [
      'needs_approval',
      (h: ReturnType<typeof makeHarness>, c: ReturnType<typeof claimOne>) =>
        h.app.jobs.submitResult(
          h.executorId, c.jobId, c.leaseId,
          implementedResult({ proposedActions: [commitAction()] }),
          900,
        ),
    ],
  ] as const;

  it.each(states)('refuses force on a %s job', (label, advance) => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    advance(h, c);
    expect(h.store.jobs.byId(job.id)?.state).toBe(label);

    for (const force of [false, true]) {
      const out = h.app.jobs.cleanup(h.owner, job.publicId, force);
      expect(out.released, `force=${force}`).toBe(false);
      expect(out.note).toMatch(/cancel it instead/i);
    }
    // Still held, so no second writer can start.
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    h.close();
  });

  it('still releases an orphan reservation, with force recorded', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_agent_still_working', {
      workspaceId: 'wX',
    });
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');

    const out = h.app.jobs.cleanup(h.owner, job.publicId, true);
    expect(out.released).toBe(true);
    expect(h.store.jobs.events(job.id).some((e) => e.kind === 'forced_cleanup')).toBe(true);
    h.close();
  });
});

describe('a cancelled job is not resurrected by lease expiry', () => {
  it('goes terminal instead of being requeued', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    claimOne(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);

    expect(reconcilerAt(h, later(10 * 60_000)).expireLeases()).toBe(1);

    const after = h.store.jobs.byId(job.id)!;
    expect(after.state).toBe('cancelled');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('lease_expired_after_cancel');
    // and it is not claimable again
    expect(h.app.jobs.claim(h.executorId, 'k9')).toBeUndefined();
    h.close();
  });

  it('keeps the repository blocked when a workspace was recorded', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    registerWorkspace(h, c);
    h.app.jobs.requestCancel(h.owner, job.publicId);

    reconcilerAt(h, later(10 * 60_000)).expireLeases();

    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    const reservation = h.store.jobs.reservation('demo');
    expect(reservation?.reason).toBe('orphan_agent');
    expect(reservation?.expiresAt).toBeNull();
    h.close();
  });

  it('releases the repository when nothing was ever created', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    claimOne(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);
    reconcilerAt(h, later(10 * 60_000)).expireLeases();
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });
});

describe('workspace registration makes ownership durable', () => {
  it('records the workspace before an agent exists', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);

    expect(registerWorkspace(h, c)).toEqual({ registered: true, workspaceId: 'wX' });
    const row = h.store.herdrWorkspaces.byWorkspaceId('wX')!;
    expect(row).toMatchObject({ jobId: job.id, repoSlug: 'demo', state: 'creating' });
    expect(h.store.herdrWorkspaces.openByAgentName('ducky-pi-demo')?.jobId).toBe(job.id);
    h.close();
  });

  it('is idempotent and refuses to re-point a workspace at another job', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    registerWorkspace(h, c);
    expect(() => registerWorkspace(h, c)).not.toThrow();

    const other = h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 'b', bootstrap: false });
    const c2 = h.app.jobs.claim(h.executorId, 'k2')!;
    expect(c2.jobId).toBe(other.id);
    expect(() =>
      h.app.jobs.registerWorkspace(h.executorId, c2.jobId, c2.leaseId, {
        workspaceId: 'wX',
        label: 'ducky-mgd:other',
        mode: 'direct',
        agentName: 'ducky-pi-other',
        workspacePath: '/tmp/ducky-other',
      }),
    ).toThrow(/different job/);
    h.close();
  });

  it('rejects registration on a stale lease', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    expect(() =>
      h.app.jobs.registerWorkspace(h.executorId, c.jobId, 'stale', {
        workspaceId: 'wY',
        label: 'ducky-mgd:demo',
        mode: 'direct',
        agentName: 'ducky-pi-demo',
        workspacePath: '/tmp/ducky-demo',
      }),
    ).toThrow(/no longer current/);
    h.close();
  });

  it('never releases the repository when a foreign agent holds a registered name', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    registerWorkspace(h, c);

    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'foreign_agent_conflict', {
      agentName: 'ducky-pi-demo',
    });
    expect(out.orphan).toBe(true);
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');

    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'b', bootstrap: false });
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();
    h.close();
  });

  it('keeps the repository blocked for ANY failure once a workspace exists', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    registerWorkspace(h, c);

    // Not an orphan reason: an ordinary "the agent produced nothing" failure.
    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {
      workspaceId: 'wX',
    });
    expect(out.orphan).toBe(true);
    expect(h.store.jobs.reservation('demo')?.reason).toBe('orphan_agent');
    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    h.close();
  });

  it('does release when a conflict happened with nothing of ours recorded', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    const out = h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'foreign_agent_conflict', {
      agentName: 'ducky-pi-demo',
    });
    expect(out.orphan).toBe(false);
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });
});

describe('approval decisions are atomic with settlement', () => {
  it('leaves no partial decision when settlement fails', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ proposedActions: [commitAction()] }),
      900,
    );
    const approval = h.store.approvals.forJob(job.id)[0]!;

    // Make the final transition fail from inside the same transaction.
    const original = h.store.jobs.transition.bind(h.store.jobs);
    h.store.jobs.transition = (() => {
      throw new Error('injected settlement failure');
    }) as typeof h.store.jobs.transition;

    expect(() => h.app.approvals.decide(h.owner, approval.id, 'approved')).toThrow(/injected/);
    h.store.jobs.transition = original;

    // The decision must have rolled back with it.
    expect(h.store.approvals.byId(approval.id)?.state).toBe('pending');
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_approval');

    // And the owner can still decide it afterwards.
    expect(h.app.approvals.decide(h.owner, approval.id, 'approved').jobState).toBe('completed');
    h.close();
  });
});

describe('every action kind is deep-sanitized before it is stored', () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

  it('scrubs secrets from branch names, targets and operations', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);

    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({
        proposedActions: [
          { kind: 'git_push', description: `push ${SECRET}`, details: { remote: 'origin', branch: `feat/${SECRET}` } },
          { kind: 'deploy', description: 'deploy', details: { target: `prod-${SECRET}` } },
          { kind: 'azure_mutation', description: 'scale', details: { operation: `op-${SECRET}` } },
          { kind: 'github_pr', description: 'pr', details: { title: SECRET, body: SECRET, base: `main-${SECRET}`, head: `h-${SECRET}` } },
          { kind: 'github_issue', description: 'issue', details: { title: SECRET, body: SECRET } },
          { kind: 'git_commit', description: 'commit', details: { message: SECRET, files: ['src/a.ts'] } },
        ],
      }),
      8000,
    );

    const stored = JSON.stringify(h.store.results.byJobId(job.id));
    expect(stored).not.toContain('ghp_');
    expect(stored).toContain('[REDACTED:github-token]');

    const approvals = JSON.stringify(h.store.approvals.forJob(job.id));
    expect(approvals).not.toContain('ghp_');
    h.close();
  });
});
