import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimResponse } from '@ducky/contracts';
import type { OrchestrationOutcome, PiOrchestrator } from '@ducky/adapters';
import { runClaimedJob } from '../src/runner.js';

/**
 * The host-side half of the single-writer guarantee, on the orphan path.
 *
 * An ORPHAN outcome means the orchestrator saw an agent that may still be
 * writing. The coordinator keeps the repository reserved for exactly that
 * reason -- but the writer lock lives on THIS host, and it used to be released
 * unconditionally the moment the turn ended, before the orphan branch was even
 * reached. A retry on this host could then take the lock and start a second
 * writer beside the live agent.
 */
let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-orphan-'));
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

const locksDir = () => path.join(lockHome, 'ducky', 'locks');
const heldLocks = (): string[] =>
  existsSync(locksDir()) ? readdirSync(locksDir()).filter((f) => f.endsWith('.lock')) : [];

const claim = (): ClaimResponse => ({
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

const client = () => ({
  jobHeartbeat: vi.fn(async () => ({
    cancelRequested: false,
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    workPhase: null,
  })),
  cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
  reportFailure: vi.fn(async () => ({ state: 'failed', orphan: true })),
  submitResult: vi.fn(async () => ({ state: 'completed', accepted: true, duplicate: false })),
  registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
  closeWorkspace: vi.fn(async () => ({ closed: true, workspaceId: 'ws' })),
});

const orchestratorReturning = (outcome: OrchestrationOutcome): PiOrchestrator => ({
  name: 'stub',
  verified: false,
  runJob: async () => outcome,
  cancel: async () => ({ terminated: true, agentStatus: 'idle', detail: 'x' }),
  cleanup: async () => ({ closed: true, detail: 'closed' }),
});

describe('writer lock on an orphan outcome', () => {
  for (const reason of ['orphan_agent_still_working', 'orphan_agent_blocked'] as const) {
    it(`retains the writer lock for ${reason}`, async () => {
      const c = client();
      await runClaimedJob(
        {
          client: c as never,
          orchestrator: orchestratorReturning({
            kind: 'orphan', reason, workspaceId: 'wZ', agentName: 'ducky-pi-demo',
          }),
          heartbeatMs: 50_000,
        },
        claim(),
      );

      expect(c.reportFailure).toHaveBeenCalledWith('job-1', 'lease-1', reason, expect.anything());
      // The point of the test: a possibly-live writer keeps the host lock.
      expect(heldLocks()).toEqual(['demo.lock']);
    });
  }

  it('releases the writer lock on an ordinary completed result', async () => {
    const c = client();
    await runClaimedJob(
      {
        client: c as never,
        orchestrator: orchestratorReturning({
          kind: 'no_result', workspaceId: 'wZ', agentName: 'ducky-pi-demo', workspacePath: repoPath,
        }),
        heartbeatMs: 50_000,
      },
      claim(),
    );
    expect(heldLocks()).toEqual([]);
  });

  it('releases the writer lock when Herdr was never reachable', async () => {
    const c = client();
    await runClaimedJob(
      {
        client: c as never,
        orchestrator: orchestratorReturning({ kind: 'unavailable' }),
        heartbeatMs: 50_000,
      },
      claim(),
    );
    expect(heldLocks()).toEqual([]);
  });
});
