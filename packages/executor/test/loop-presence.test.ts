import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPiOrchestrator, exampleImplementedResult } from '@ducky/adapters';
import type { ClaimResponse } from '@ducky/contracts';
import { ExecutorLoop } from '../src/loop.js';

/** A real empty repo so workspace resolution succeeds and the turn starts. */
let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-presence-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
});

// The writer lock is host-wide; keep it out of the developer's real state dir.
let previousState: string | undefined;
beforeEach(() => {
  previousState = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = mkdtempSync(path.join(os.tmpdir(), 'ducky-presence-state-'));
});
afterEach(() => {
  if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = previousState;
});

const claimResponse = (): ClaimResponse => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  ownerInputs: [],
  recordedWorkspace: null,
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
  },
});

/**
 * The loop is blocked inside a running turn, so without an independent
 * presence timer the general heartbeat -- the one carrying capabilities and
 * activeJobIds -- would go silent for the whole job and activeJobIds would
 * only ever be reported empty.
 */
describe('structured executor state stays useful while a job runs', () => {
  it('reports the active job on heartbeats sent during the turn', async () => {
    const heartbeats: string[][] = [];
    let claimed = false;
    let sawActive = false;

    const client = {
      heartbeat: vi.fn(async (b: { activeJobIds: string[] }) => {
        heartbeats.push([...b.activeJobIds]);
        if (b.activeJobIds.includes('job-1')) sawActive = true;
      }),
      claim: vi.fn(async () => {
        if (claimed) return undefined;
        claimed = true;
        return claimResponse();
      }),
      // Ends the turn once presence has been demonstrated, so the test does
      // not depend on an unbounded run.
      jobHeartbeat: vi.fn(async () => ({
        cancelRequested: sawActive,
        leaseExpiresAt: new Date().toISOString(),
      })),
      reportFailure: vi.fn(async () => ({ state: 'failed', orphan: false })),
      submitResult: vi.fn(async () => ({ state: 'completed', accepted: true, duplicate: false })),
      registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
      closeWorkspace: vi.fn(async () => ({ closed: true, workspaceId: 'ws' })),
      cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
    };

    // A turn that stays open long enough for the presence timer to fire.
    const orchestrator = new MockPiOrchestrator(() => exampleImplementedResult(), {
      runUntilAborted: true,
    });

    const loop = new ExecutorLoop({
      client: client as never,
      orchestrator,
      pollWaitMs: 0,
      version: '0.1.0',
      presenceIntervalMs: 5,
    });

    await loop.runOnce();

    // A heartbeat sent DURING the turn carried the active job, which is the
    // whole point: the claim-loop heartbeat cannot, because it is blocked.
    expect(heartbeats.some((h) => h.includes('job-1'))).toBe(true);
    // ...and nothing is reported active once the turn is over.
    expect(loop.activeJobIds()).toEqual([]);
    loop.stop();
  });

  it('reports nothing active once no job is running', () => {
    const loop = new ExecutorLoop({
      client: {} as never,
      orchestrator: new MockPiOrchestrator(),
      pollWaitMs: 0,
      version: '0.1.0',
    });
    expect(loop.activeJobIds()).toEqual([]);
  });
});
