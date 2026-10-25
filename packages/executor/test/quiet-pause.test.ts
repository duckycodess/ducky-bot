import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimResponse } from '@ducky/contracts';
import type { OrchestrationOutcome, PiOrchestrator } from '@ducky/adapters';
import { runClaimedJob } from '../src/runner.js';
import { CoordinatorClient, PauseDeliveryError } from '../src/client.js';
import { MemoryPauseIntentStore } from '../src/pause-intents.js';

/**
 * The executor half of a system pause: a proven-quiet, result-less agent is
 * reported through the lease-checked pause route -- never as a failure, and
 * never silently downgraded to one when delivery is hard.
 */
let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-pause-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
});

let lockHome = '';
let previousState: string | undefined;
beforeEach(() => {
  previousState = process.env['XDG_STATE_HOME'];
  lockHome = mkdtempSync(path.join(os.tmpdir(), 'ducky-lock-'));
  process.env['XDG_STATE_HOME'] = lockHome;
});
afterEach(() => {
  if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = previousState;
});
const heldLocks = (): string[] => {
  const dir = path.join(lockHome, 'ducky', 'locks');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.lock')) : [];
};

const claim = (): ClaimResponse => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  attemptDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  ownerInputs: [],
  recordedWorkspace: null,
  payload: {
    repoSlug: 'demo', absolutePath: repoPath, defaultBranch: 'main', github: null,
    fetchBeforeJob: false, task: 'do it', context: null, bootstrap: true, allowWorktree: true,
    allowBootstrap: true, bootstrapAllowedEntries: ['.git'], maxOwnerInputRounds: 3,
    recoveryRequired: false, ownerInputRounds: 0,
  },
});

const makeClient = (pause: () => Promise<unknown>) => ({
  jobHeartbeat: vi.fn(async () => ({
    cancelRequested: false,
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    workPhase: null,
  })),
  cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
  reportFailure: vi.fn(async () => ({ state: 'failed', orphan: true })),
  submitResult: vi.fn(async () => ({ state: 'completed' })),
  registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
  closeWorkspace: vi.fn(async () => ({ closed: true })),
  pauseJob: vi.fn(pause),
});

const returning = (outcome: OrchestrationOutcome): PiOrchestrator => ({
  name: 'stub', verified: false, runJob: async () => outcome,
  cancel: async () => ({ terminated: true, agentStatus: 'idle', detail: 'x' }),
  cleanup: async () => ({ closed: true, detail: 'closed' }),
  proveQuiet: async () => ({ quiet: true, observed: 'idle' }),
});

const QUIET: OrchestrationOutcome = {
  kind: 'quiet_pause', cause: 'agent_idle_no_result', observed: 'done',
  workspaceId: 'wZ', agentName: 'ducky-pi-demo', workspacePath: repoPath,
};

describe('runner on a quiet_pause outcome', () => {
  it('reports a lease-checked pause with the exact proof, not a failure', async () => {
    const c = makeClient(async () => ({ state: 'needs_owner_input', paused: true }));
    await runClaimedJob({ client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: returning(QUIET), heartbeatMs: 50_000 }, claim());

    expect(c.pauseJob).toHaveBeenCalledTimes(1);
    expect(c.pauseJob).toHaveBeenCalledWith('job-1', {
      leaseId: 'lease-1', cause: 'agent_idle_no_result', workspaceId: 'wZ',
      agentName: 'ducky-pi-demo', agentStatus: 'done', quiescent: true,
    });
    expect(c.reportFailure).not.toHaveBeenCalled();
    expect(c.submitResult).not.toHaveBeenCalled();
    // The agent is proven quiet, so the host writer lock does not outlive the run.
    expect(heldLocks()).toEqual([]);
  });

  it('does not fail or downgrade the job when the pause cannot be delivered', async () => {
    const c = makeClient(async () => {
      throw new PauseDeliveryError(404, 'version skew');
    });
    const log = vi.fn();
    await expect(
      runClaimedJob({ client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: returning(QUIET), heartbeatMs: 50_000, log }, claim()),
    ).resolves.toBeUndefined();

    expect(c.reportFailure).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/pause was not delivered/);
  });

  it('lets a cancellation observed locally win over a late pause', async () => {
    const c = makeClient(async () => ({ state: 'needs_owner_input', paused: true }));
    c.jobHeartbeat.mockImplementation(async () => ({
      cancelRequested: true,
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      workPhase: null,
    }));
    const slow: PiOrchestrator = {
      ...returning(QUIET),
      runJob: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return QUIET;
      },
    };
    await runClaimedJob({ client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: slow, heartbeatMs: 5 }, claim());
    expect(c.cancelAck).toHaveBeenCalled();
    expect(c.pauseJob).not.toHaveBeenCalled();
  });
});

describe('runner on an unsettled orphan outcome', () => {
  const UNSETTLED: OrchestrationOutcome = {
    kind: 'orphan', reason: 'orphan_prompt_unsettled', workspaceId: 'wZ', agentName: 'ducky-pi-demo',
    detail: 'A prompt was submitted but the agent was not observed to pick it up or to finish a turn.',
  };

  it('reports it as an orphan with the honest detail, keeps the writer lock, and never pauses', async () => {
    const c = makeClient(async () => ({ state: 'needs_owner_input', paused: true }));
    await runClaimedJob({ client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: returning(UNSETTLED), heartbeatMs: 50_000 }, claim());

    expect(c.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'orphan_prompt_unsettled',
      expect.objectContaining({ detail: expect.stringMatching(/not observed to pick it up/) }),
    );
    expect(c.pauseJob).not.toHaveBeenCalled();
    // A possibly-live writer keeps the host lock, so a retry here cannot start a second one.
    expect(heldLocks()).toEqual(['demo.lock']);
  });
});

describe('the client pause report', () => {
  const clientWith = (responses: (Response | Error)[]) => {
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const client = new CoordinatorClient({
      baseUrl: 'http://127.0.0.1:1', executorId: 'ex-1', keyId: 'k', bearerToken: 'b'.repeat(20),
      hmacSecret: 'h'.repeat(20), fetchImpl: fetchImpl as never,
      pauseRetry: { attempts: 4, delayMs: 1, sleep: async () => {} },
    });
    return { client, fetchImpl };
  };
  const body = {
    leaseId: 'l', cause: 'agent_idle_no_result' as const, workspaceId: 'w', agentName: 'a',
    agentStatus: 'idle' as const, quiescent: true as const,
  };
  const ok = () => new Response(JSON.stringify({ state: 'needs_owner_input', paused: true }), { status: 200 });

  it('retries a lost response and a 5xx within bounds, then succeeds', async () => {
    const { client, fetchImpl } = clientWith([new Error('socket hang up'), new Response('', { status: 503 }), ok()]);
    await expect(client.pauseJob('job-1', body)).resolves.toEqual({ state: 'needs_owner_input', paused: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after the bound with a delivery error, not a different outcome', async () => {
    const { client, fetchImpl } = clientWith([1, 2, 3, 4].map(() => new Error('down')));
    await expect(client.pauseJob('job-1', body)).rejects.toBeInstanceOf(PauseDeliveryError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('never retries or downgrades a refusal: 404 is version skew, 409 is a bad lease', async () => {
    for (const status of [404, 409, 400]) {
      const { client, fetchImpl } = clientWith([new Response('', { status })]);
      const err = await client.pauseJob('job-1', body).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PauseDeliveryError);
      expect((err as PauseDeliveryError).status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('treats 401 as the credential failure it is', async () => {
    const { client } = clientWith([new Response('', { status: 401 })]);
    await expect(client.pauseJob('job-1', body)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
