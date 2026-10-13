import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPiOrchestrator, exampleImplementedResult } from '@ducky/adapters';
import {
  ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS, ENGINEERING_ATTEMPT_BUDGET_MAX_MS,
  type ClaimResponse,
} from '@ducky/contracts';
import { attemptDeadlineMs } from '../src/attempt-deadline.js';
import { runClaimedJob } from '../src/runner.js';
import { JobSupervisor } from '../src/supervisor.js';

let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-budget-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
});

// The writer lock is host-wide and is retained on an unconfirmed stop.
let previousState: string | undefined;
beforeEach(() => {
  previousState = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = mkdtempSync(path.join(os.tmpdir(), 'ducky-budget-lock-'));
});
afterEach(() => {
  if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = previousState;
});

const claim = (attemptDeadlineAt: string | undefined): ClaimResponse => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  ...(attemptDeadlineAt === undefined ? {} : { attemptDeadlineAt }),
  ownerInputs: [],
  recordedWorkspace: null,
  payload: {
    repoSlug: 'demo',
    absolutePath: repoPath,
    defaultBranch: 'main',
    github: null,
    fetchBeforeJob: false,
    task: 'do it',
    context: null,
    bootstrap: true,
    allowWorktree: true,
    allowBootstrap: true,
    bootstrapAllowedEntries: ['.git'],
    maxOwnerInputRounds: 3,
    recoveryRequired: false,
    ownerInputRounds: 0,
  },
});

function fakeClient(cancelRequested = false) {
  return {
    jobHeartbeat: vi.fn(async () => ({
      cancelRequested,
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
    cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
    reportFailure: vi.fn(async () => ({ state: 'failed', orphan: false })),
    submitResult: vi.fn(async () => ({ state: 'completed', accepted: true, duplicate: false })),
    registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
    closeWorkspace: vi.fn(async () => ({ closed: true, workspaceId: 'ws' })),
  };
}

const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

describe('attemptDeadlineMs', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('uses the coordinator deadline when it is sane', () => {
    const deadline = new Date(now + 10 * 60_000).toISOString();
    expect(attemptDeadlineMs(deadline, now)).toBe(now + 10 * 60_000);
  });

  it('applies the default budget from now when the claim carries none', () => {
    expect(attemptDeadlineMs(undefined, now)).toBe(now + ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS);
  });

  it('treats an unparseable deadline as absent rather than as unbounded', () => {
    expect(attemptDeadlineMs('not a date', now)).toBe(now + ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS);
  });

  it('caps a far-future deadline at the local ceiling', () => {
    const far = new Date(now + 365 * 24 * 3600_000).toISOString();
    expect(attemptDeadlineMs(far, now)).toBe(now + ENGINEERING_ATTEMPT_BUDGET_MAX_MS);
  });

  it('keeps a deadline already in the past, so a spent budget stays spent', () => {
    const past = new Date(now - 60_000).toISOString();
    expect(attemptDeadlineMs(past, now)).toBe(now - 60_000);
  });
});

describe('JobSupervisor deadline', () => {
  it('aborts the turn at the deadline and says it was the budget, not the owner', async () => {
    const supervisor = new JobSupervisor({
      client: fakeClient() as never,
      jobId: 'job-1',
      leaseId: 'lease-1',
      intervalMs: 1000,
      deadlineAtMs: Date.now() + 20,
    });
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.signal.aborted).toBe(true), { timeout: 2000 });
    supervisor.stop();

    expect(supervisor.timedOut).toBe(true);
    expect(supervisor.cancelRequested).toBe(false);
  });

  it('does not report a timeout when the owner cancelled first', async () => {
    const supervisor = new JobSupervisor({
      client: fakeClient(true) as never,
      jobId: 'job-1',
      leaseId: 'lease-1',
      intervalMs: 1000,
      deadlineAtMs: Date.now() + 60_000,
    });
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.cancelRequested).toBe(true), { timeout: 2000 });
    supervisor.stop();
    expect(supervisor.timedOut).toBe(false);
  });

  it('never fires after stop()', async () => {
    const supervisor = new JobSupervisor({
      client: fakeClient() as never,
      jobId: 'job-1',
      leaseId: 'lease-1',
      intervalMs: 1000,
      deadlineAtMs: Date.now() + 30,
    });
    supervisor.start();
    supervisor.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(supervisor.timedOut).toBe(false);
    expect(supervisor.signal.aborted).toBe(false);
  });
});

describe('a claimed attempt that runs out of budget', () => {
  it('reports a timeout with the checkpoint and quiescence when the agent is idle', async () => {
    const client = fakeClient();
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult(), {
      runUntilAborted: true,
      cancelOutcome: {
        terminated: true,
        agentStatus: 'idle',
        detail: 'The agent finished its turn and is idle.',
        workspaceId: 'ws-1',
        agentName: 'ducky-pi-demo',
      },
    });

    await runClaimedJob({ client: client as never, orchestrator, heartbeatMs: 1000 }, claim(soon(60)));

    expect(orchestrator.cancels).toHaveLength(1);
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'wall_clock_exceeded',
      expect.objectContaining({
        quiescent: true,
        detail: expect.stringMatching(/attempt budget ran out .*idle/),
        workspaceId: 'ws-1',
      }),
    );
    // A timeout is not a cancellation the owner asked for.
    expect(client.cancelAck).not.toHaveBeenCalled();
    expect(client.submitResult).not.toHaveBeenCalled();
  });

  it('becomes an orphan, never a fabricated stop, when the agent is still working', async () => {
    const client = fakeClient();
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult(), {
      runUntilAborted: true,
      cancelOutcome: {
        terminated: false,
        agentStatus: 'working',
        detail: 'The Pi agent is still working.',
        workspaceId: 'ws-1',
        agentName: 'ducky-pi-demo',
      },
    });

    await runClaimedJob({ client: client as never, orchestrator, heartbeatMs: 1000 }, claim(soon(60)));

    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'orphan_agent_still_working',
      expect.not.objectContaining({ quiescent: true }),
    );
    expect(client.cancelAck).not.toHaveBeenCalled();
    // Held on purpose: a retry here must not start a second writer.
    const { acquireWriterLock } = await import('../src/single-writer.js');
    expect(() => acquireWriterLock('demo')).toThrow(/already holds/);
  });

  it('does not start a turn at all when the persisted budget is already spent', async () => {
    const client = fakeClient();
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult());

    await runClaimedJob(
      { client: client as never, orchestrator, heartbeatMs: 1000 },
      claim(new Date(Date.now() - 60_000).toISOString()),
    );

    expect(orchestrator.runs).toHaveLength(0);
    expect(orchestrator.cancels).toHaveLength(1);
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'wall_clock_exceeded', expect.objectContaining({ quiescent: true }),
    );
  });

  it('hands the turn only what is left of the budget as its prompt wait', async () => {
    const client = fakeClient();
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult());
    await runClaimedJob(
      { client: client as never, orchestrator, heartbeatMs: 1000 },
      claim(soon(30 * 60_000)),
    );
    const wait = orchestrator.runs[0]!.promptTimeoutMs;
    expect(wait).toBeLessThanOrEqual(30 * 60_000);
    expect(wait).toBeGreaterThan(29 * 60_000);
  });

  it('applies the bounded local default when a claim carries no deadline', async () => {
    const client = fakeClient();
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult());
    await runClaimedJob({ client: client as never, orchestrator, heartbeatMs: 1000 }, claim(undefined));
    const wait = orchestrator.runs[0]!.promptTimeoutMs;
    expect(wait).toBeLessThanOrEqual(ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS);
    expect(wait).toBeGreaterThan(ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS - 60_000);
  });

  it('lets an owner cancellation keep its own report when both apply', async () => {
    const client = fakeClient(true);
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult(), {
      runUntilAborted: true,
      cancelOutcome: { terminated: true, agentStatus: 'idle', detail: 'stopped' },
    });
    await runClaimedJob({ client: client as never, orchestrator, heartbeatMs: 5 }, claim(soon(60_000)));

    expect(client.cancelAck).toHaveBeenCalledWith(
      'job-1', expect.objectContaining({ terminated: true }),
    );
    expect(client.reportFailure).not.toHaveBeenCalled();
  });
});
