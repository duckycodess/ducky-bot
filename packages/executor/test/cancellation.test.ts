import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MockPiOrchestrator, exampleImplementedResult } from '@ducky/adapters';
import type { ClaimResponse } from '@ducky/contracts';
import { runClaimedJob } from '../src/runner.js';
import { JobSupervisor } from '../src/supervisor.js';

/** A real empty git repo, so workspace resolution runs its genuine path. */
let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-cancel-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
});

const claim = (over: Partial<ClaimResponse['payload']> = {}): ClaimResponse => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  ownerInputs: [],
  payload: {
    repoSlug: 'demo',
    absolutePath: repoPath,
    defaultBranch: 'main',
    task: 'do it',
    context: null,
    // An uninitialised repo with bootstrap allowed resolves to direct mode.
    bootstrap: true,
    allowWorktree: true,
    allowBootstrap: true,
    bootstrapAllowedEntries: ['.git'],
    maxOwnerInputRounds: 3,
    recoveryRequired: false,
    ownerInputRounds: 0,
    ...over,
  },
});

function fakeClient(cancelAfter: number) {
  let beats = 0;
  return {
    beats: () => beats,
    jobHeartbeat: vi.fn(async () => {
      beats += 1;
      return {
        cancelRequested: beats > cancelAfter,
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    }),
    cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
    reportFailure: vi.fn(async () => ({ state: 'failed', orphan: true })),
    submitResult: vi.fn(async () => ({ state: 'completed', accepted: true, duplicate: false })),
    registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
  };
}

describe('JobSupervisor', () => {
  it('heartbeats while a turn runs and aborts when the owner cancels', async () => {
    const client = fakeClient(1);
    const supervisor = new JobSupervisor({
      client: client as never,
      jobId: 'job-1',
      leaseId: 'lease-1',
      intervalMs: 5,
    });
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.cancelRequested).toBe(true), { timeout: 2000 });
    supervisor.stop();

    expect(supervisor.signal.aborted).toBe(true);
    expect(client.beats()).toBeGreaterThan(1);
  });

  it('survives a transient heartbeat failure rather than killing the turn', async () => {
    let calls = 0;
    const client = {
      jobHeartbeat: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('network blip');
        return { cancelRequested: false, leaseExpiresAt: new Date().toISOString() };
      }),
    };
    const supervisor = new JobSupervisor({
      client: client as never,
      jobId: 'job-1',
      leaseId: 'lease-1',
      intervalMs: 5,
    });
    supervisor.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 2000 });
    supervisor.stop();
    expect(supervisor.signal.aborted).toBe(false);
  });
});

describe('cancelling a running job', () => {
  it('aborts a long-running turn and acknowledges only a confirmed stop', async () => {
    const client = fakeClient(0);
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult(), {
      runUntilAborted: true,
      cancelOutcome: {
        terminated: true,
        agentStatus: 'idle',
        detail: 'agent went idle',
        workspaceId: 'ws-1',
        agentName: 'ducky-pi-demo',
      },
    });

    await runClaimedJob(
      { client: client as never, orchestrator, heartbeatMs: 5 },
      claim(),
    );

    expect(orchestrator.cancels).toHaveLength(1);
    expect(client.cancelAck).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ leaseId: 'lease-1', terminated: true }),
    );
    // A confirmed stop needs no orphan report.
    expect(client.reportFailure).not.toHaveBeenCalled();
    expect(client.submitResult).not.toHaveBeenCalled();
  });

  it('fails closed when the agent is still working, never claiming a stop', async () => {
    const client = fakeClient(0);
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

    await runClaimedJob(
      { client: client as never, orchestrator, heartbeatMs: 5 },
      claim(),
    );

    expect(client.cancelAck).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ terminated: false }),
    );
    // The repository must stay blocked for the owner.
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1',
      'lease-1',
      'orphan_agent_still_working',
      expect.objectContaining({ workspaceId: 'ws-1', agentName: 'ducky-pi-demo' }),
    );
  });

  it('registers the workspace before an agent could be started', async () => {
    const client = fakeClient(99);
    const orchestrator = new MockPiOrchestrator();

    await runClaimedJob(
      { client: client as never, orchestrator, heartbeatMs: 50 },
      claim(),
    );

    expect(client.registerWorkspace).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ leaseId: 'lease-1', state: 'creating' }),
    );
    const registerOrder = client.registerWorkspace.mock.invocationCallOrder[0]!;
    const resultOrder = client.submitResult.mock.invocationCallOrder[0]!;
    expect(registerOrder).toBeLessThan(resultOrder);
  });
});
