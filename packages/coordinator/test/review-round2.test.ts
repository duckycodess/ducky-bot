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

interface Registration {
  workspaceId: string;
  label: string;
  mode: 'worktree' | 'direct';
  agentName: string;
  workspacePath: string;
}

const REGISTRATION: Registration = {
  workspaceId: 'wX',
  label: 'ducky-mgd:demo',
  mode: 'direct',
  agentName: 'ducky-pi-demo',
  workspacePath: '/tmp/ducky-demo',
};

const registerWorkspace = (
  h: ReturnType<typeof makeHarness>,
  c: { jobId: string; leaseId: string },
) => h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);

describe('a restarted executor can reattach', () => {
  it('receives the recorded workspace on the claim', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    registerWorkspace(h, claimOne(h));

    // The executor dies: the lease expires and the job is requeued for
    // recovery, with the reservation deliberately retained.
    reconcilerAt(h, later(10 * 60_000)).expireLeases();
    expect(h.store.jobs.byId(job.id)?.recoveryRequired).toBe(true);

    // A FRESH executor process has no in-memory map at all, so ownership has
    // to arrive with the claim or recovery would meet its own agent as a
    // stranger.
    const again = claimOne(h, 'after-restart');
    expect(again.jobId).toBe(job.id);
    expect(again.payload.recoveryRequired).toBe(true);
    expect(again.recordedWorkspace).toEqual({
      workspaceId: 'wX',
      agentName: 'ducky-pi-demo',
      workspacePath: '/tmp/ducky-demo',
      mode: 'direct',
      state: 'creating',
    });
    h.close();
  });

  it('sends null when nothing was ever registered', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    expect(claimOne(h).recordedWorkspace).toBeNull();
    h.close();
  });
});

describe('workspace registration is validated at the boundary', () => {
  const attempt = (over: Partial<Registration>) => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    try {
      h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, { ...REGISTRATION, ...over });
      return { ok: true, h, err: undefined };
    } catch (err) {
      return { ok: false, h, err: err as Error };
    }
  };

  it('accepts what the executor genuinely sends', () => {
    const { ok, h } = attempt({});
    expect(ok).toBe(true);
    h.close();
  });

  it('rejects a foreign agent name or label', () => {
    for (const over of [
      { agentName: 'someone-elses-agent' },
      { agentName: 'ducky-pi-other' },
      { label: 'ducky' },
      { label: 'ducky-mgd:other' },
    ]) {
      const { ok, h, err } = attempt(over);
      expect(ok, JSON.stringify(over)).toBe(false);
      expect(err?.message).toMatch(/not the one Ducky uses|not Ducky-managed/);
      h.close();
    }
  });

  it('rejects a path that escapes the repository or is not normalized', () => {
    for (const workspacePath of [
      '/etc',
      '/tmp/ducky-demo/../../etc',
      'relative/path',
      '/tmp/ducky-demo/./x',
      '/tmp/ducky-demo-elsewhere',
    ]) {
      const { ok, h } = attempt({ workspacePath });
      expect(ok, workspacePath).toBe(false);
      h.close();
    }
  });

  it('rejects a malformed workspace id', () => {
    for (const workspaceId of ['w X', '../../etc', '']) {
      const { ok, h } = attempt({ workspaceId });
      expect(ok, workspaceId).toBe(false);
      h.close();
    }
  });

  it('rejects a control character in the path', () => {
    const { ok, h } = attempt({ workspacePath: `/tmp/ducky-demo${String.fromCharCode(10)}/x` });
    expect(ok).toBe(false);
    h.close();
  });

  it('allows a Herdr-managed worktree outside the repo, but nothing else', () => {
    // Herdr checks linked worktrees out under its own directory, so this one
    // legitimately sits outside the source repository.
    const inHerdr = attempt({
      mode: 'worktree',
      workspacePath: '/home/someone/.herdr/worktrees/demo/ducky-job-jabcde',
    });
    expect(inHerdr.ok).toBe(true);
    inHerdr.h.close();

    const elsewhere = attempt({ mode: 'worktree', workspacePath: '/var/tmp/anywhere' });
    expect(elsewhere.ok).toBe(false);
    elsewhere.h.close();
  });
});

describe('approval decisions cannot settle a job that moved on', () => {
  const pending = (h: ReturnType<typeof makeHarness>) => {
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({ proposedActions: [commitAction(), commitAction('feat: b')] }),
      2000,
    );
    return { job, approvals: h.store.approvals.forJob(job.id) };
  };

  it('refuses once the owner cancelled the job', () => {
    const h = makeHarness();
    const { job, approvals } = pending(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');

    expect(() => h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved')).toThrow(
      /no longer awaiting approval|already/i,
    );
    // The cancellation's rejection stands; nothing was flipped to approved.
    expect(h.store.approvals.forJob(job.id).every((a) => a.state === 'rejected')).toBe(true);
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    h.close();
  });

  it('refuses an expired approval and leaves it pending', () => {
    const h = makeHarness();
    const { approvals } = pending(h);
    h.store.db
      .prepare(`UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(approvals[0]!.id);
    expect(() => h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved')).toThrow(/expired/);
    expect(h.store.approvals.byId(approvals[0]!.id)?.state).toBe('pending');
    h.close();
  });

  it('refuses a decision on a job owned by another account', () => {
    const h = makeHarness();
    const { job, approvals } = pending(h);
    h.store.db.prepare('UPDATE jobs SET discord_user_id = ? WHERE id = ?').run('999', job.id);
    expect(() => h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved')).toThrow(
      /no longer exists/,
    );
    h.close();
  });
});

describe('approval expiry settles in one step', () => {
  const withPendingAction = (h: ReturnType<typeof makeHarness>) => {
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({ proposedActions: [commitAction()] }),
      900,
    );
    return job;
  };

  it('expires and settles together, never leaving one without the other', () => {
    const h = makeHarness();
    const job = withPendingAction(h);
    h.store.db.prepare(`UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z'`).run();

    expect(reconcilerAt(h, new Date()).expireApprovals()).toBe(1);

    expect(h.store.approvals.forJob(job.id).every((a) => a.state === 'expired')).toBe(true);
    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });

  it('skips a job the owner already cancelled', () => {
    const h = makeHarness();
    const job = withPendingAction(h);
    h.app.jobs.requestCancel(h.owner, job.publicId);
    h.store.db.prepare(`UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z'`).run();

    expect(reconcilerAt(h, new Date()).expireApprovals()).toBe(0);
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    h.close();
  });
});
