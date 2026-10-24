import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HerdrPiOrchestrator, MemoryBriefWriter, MockHerdr } from '@ducky/adapters';
import type { ClaimResponse } from '@ducky/contracts';
import { runClaimedJob } from '../src/runner.js';

/**
 * A timeout releases the repository, the writer lock and the engineering slot
 * only on a POSITIVE proof that the recorded agent is quiet. These run the real
 * runner against the real orchestrator (over a mock Herdr) with a short budget.
 */
let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-timeout-'));
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

const claim = (budgetMs: number): ClaimResponse => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  attemptDeadlineAt: new Date(Date.now() + budgetMs).toISOString(),
  ownerInputs: [],
  recordedWorkspace: null,
  payload: {
    repoSlug: 'demo', absolutePath: repoPath, defaultBranch: 'main', github: null,
    fetchBeforeJob: false, task: 'do it', context: null, bootstrap: true, allowWorktree: true,
    allowBootstrap: true, bootstrapAllowedEntries: ['.git'], maxOwnerInputRounds: 3,
    recoveryRequired: false, ownerInputRounds: 0,
  },
});

const makeClient = () => ({
  jobHeartbeat: vi.fn(async () => ({
    cancelRequested: false,
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    workPhase: null,
  })),
  cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
  reportFailure: vi.fn(async () => ({ state: 'failed', orphan: false })),
  submitResult: vi.fn(async () => ({ state: 'completed' })),
  registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
  closeWorkspace: vi.fn(async () => ({ closed: true })),
  pauseJob: vi.fn(async () => ({ state: 'needs_owner_input', paused: true })),
});

/** An orchestrator whose prompt settles at once and whose result re-read then takes a while. */
const orchestratorOver = (herdr: MockHerdr) =>
  new HerdrPiOrchestrator({
    herdr,
    briefWriter: new MemoryBriefWriter(),
    pollIntervalMs: 5,
    readyWaitMs: 50,
    readyMarkerWaitMs: 5,
    resultSettleAttempts: 30,
    resultSettleDelayMs: 50,
    cancelDrainMs: 4000,
  });

const run = async (herdr: MockHerdr) => {
  const client = makeClient();
  await runClaimedJob(
    { client: client as never, orchestrator: orchestratorOver(herdr), heartbeatMs: 50_000 },
    claim(700),
  );
  return client;
};

/** Settles the prompt as idle, then lets the test change the world before the deadline. */
const settlesThen = (herdr: MockHerdr, afterSettle: (h: MockHerdr) => void) => {
  herdr.agentPrompt = async (target) => {
    const agent = herdr.state.agents.find((a) => a.name === target)!;
    const snapshot = { ...agent };
    afterSettle(herdr);
    return snapshot;
  };
  return herdr;
};

describe('a timeout releases only on a positive quiet proof', () => {
  it('confirmed quiet: the settled, identified, idle agent is released as a wall-clock timeout', async () => {
    const herdr = settlesThen(new MockHerdr(), () => {});
    const client = await run(herdr);
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'wall_clock_exceeded', expect.objectContaining({ quiescent: true }),
    );
    expect(heldLocks()).toEqual([]);
  }, 30_000);

  it('an agent that vanished is NOT quiet proof: it stays an orphan and keeps the writer lock', async () => {
    const herdr = settlesThen(new MockHerdr(), (h) => { h.state.agents = []; });
    const client = await run(herdr);
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'orphan_agent_still_working', expect.not.objectContaining({ quiescent: true }),
    );
    expect(heldLocks()).toEqual(['demo.lock']);
  }, 30_000);

  it('a same-name idle agent in another workspace is NOT quiet proof either', async () => {
    const herdr = settlesThen(new MockHerdr(), (h) => { h.state.agents[0]!.workspace_id = 'wElsewhere'; });
    const client = await run(herdr);
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'orphan_agent_still_working', expect.anything(),
    );
    expect(heldLocks()).toEqual(['demo.lock']);
  }, 30_000);

  it('a prompt delivered but never seen to settle is NOT released, even though Herdr says idle', async () => {
    const herdr = new MockHerdr();
    herdr.promptBlocks = true; // the wait only ends when the deadline aborts it
    const client = await run(herdr);
    expect(herdr.state.agents[0]!.agent_status).toBe('idle');
    expect(client.reportFailure).toHaveBeenCalledWith(
      'job-1', 'lease-1', 'orphan_agent_still_working', expect.anything(),
    );
    expect(client.reportFailure).not.toHaveBeenCalledWith(
      'job-1', 'lease-1', 'wall_clock_exceeded', expect.anything(),
    );
    expect(heldLocks()).toEqual(['demo.lock']);
  }, 30_000);
});
