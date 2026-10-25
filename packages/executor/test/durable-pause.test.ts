import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { leaseDigest, type ClaimResponse, type PauseDeliveryResponse } from '@ducky/contracts';
import type { OrchestrationOutcome, PiOrchestrator, QuietProof } from '@ducky/adapters';
import { runClaimedJob } from '../src/runner.js';
import { ExecutorLoop } from '../src/loop.js';
import { PauseDeliveryError } from '../src/client.js';
import { MemoryPauseIntentStore, type PauseIntent } from '../src/pause-intents.js';

/**
 * The executor half of DURABLE pause delivery: the intent is written before
 * anything is released or sent, it is forgotten only on a matched terminal
 * answer, and while one is owed no claim is made and no prompt is sent.
 */
let repoPath = '';
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-durable-'));
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

const claim = (over: Partial<ClaimResponse> = {}): ClaimResponse => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  attemptDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  pauseProtocol: 1,
  ownerInputs: [],
  recordedWorkspace: null,
  payload: {
    repoSlug: 'demo', absolutePath: repoPath, defaultBranch: 'main', github: null,
    fetchBeforeJob: false, task: 'do it', context: null, bootstrap: true, allowWorktree: true,
    allowBootstrap: true, bootstrapAllowedEntries: ['.git'], maxOwnerInputRounds: 3,
    recoveryRequired: false, ownerInputRounds: 0,
  },
  ...over,
});

const QUIET: OrchestrationOutcome = {
  kind: 'quiet_pause', cause: 'agent_idle_no_result', observed: 'done',
  workspaceId: 'wZ', agentName: 'ducky-pi-demo', workspacePath: repoPath,
};

const orchestrator = (over: Partial<PiOrchestrator> = {}, outcome: OrchestrationOutcome = QUIET) => {
  const runJob = vi.fn(async () => outcome);
  const proveQuiet = vi.fn(async (): Promise<QuietProof> => ({ quiet: true, observed: 'idle' }));
  const o: PiOrchestrator = {
    name: 'stub', verified: false, runJob,
    cancel: async () => ({ terminated: true, agentStatus: 'idle', detail: 'x' }),
    cleanup: async () => ({ closed: true, detail: 'closed' }),
    proveQuiet,
    ...over,
  };
  return { o, runJob, proveQuiet };
};

/** Answers about the intent it was given, the way a coordinator that knows the report would. */
const answerFor = (i: PauseIntent, disposition: PauseDeliveryResponse['disposition'], over: Partial<PauseDeliveryResponse> = {}): PauseDeliveryResponse => ({
  protocol: 1, reportId: i.reportId, workspaceId: i.workspaceId, agentName: i.agentName, cause: i.cause,
  jobId: i.jobId, executorId: 'exec-a', leaseDigest: leaseDigest(i.leaseId), disposition, state: 'needs_owner_input',
  ...over,
});

const makeClient = () => {
  const intents = new MemoryPauseIntentStore();
  const client = {
    executorId: 'exec-a',
    heartbeat: vi.fn(async () => undefined),
    claim: vi.fn(async () => undefined as ClaimResponse | undefined),
    jobHeartbeat: vi.fn(async () => ({
      cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), workPhase: null,
    })),
    cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
    reportFailure: vi.fn(async () => ({ state: 'failed', orphan: true })),
    submitResult: vi.fn(async () => ({ state: 'completed' })),
    registerWorkspace: vi.fn(async () => ({ registered: true, workspaceId: 'ws' })),
    closeWorkspace: vi.fn(async () => ({ closed: true })),
    pauseJob: vi.fn(async () => ({ state: 'needs_owner_input', paused: true })),
    pauseReport: vi.fn(async (_job: string, body: { reportId: string }) => {
      const i = [...intents.byJob.values()].find((x) => x.reportId === body.reportId)!;
      return answerFor(i, 'paused');
    }),
    pauseDisposition: vi.fn(async (_job: string, body: { reportId: string }) => {
      const i = [...intents.byJob.values()].find((x) => x.reportId === body.reportId)!;
      return answerFor(i, 'pending');
    }),
  };
  return { client, intents };
};

describe('runner: a negotiated quiet pause is durable before it is sent', () => {
  it('writes the intent, then releases the lock, then reports; forgets it on a matched terminal answer', async () => {
    const { client, intents } = makeClient();
    const { o } = orchestrator();
    const order: string[] = [];
    const write = intents.write.bind(intents);
    intents.write = (i) => {
      order.push(`write(lock held: ${heldLocks().length})`);
      write(i);
    };
    client.pauseReport.mockImplementation(async (_j, body) => {
      order.push(`report(lock held: ${heldLocks().length}, intent: ${intents.byJob.size})`);
      return answerFor([...intents.byJob.values()][0]!, 'paused');
    });

    await runClaimedJob({ client: client as never, intents, orchestrator: o, heartbeatMs: 50_000 }, claim());

    expect(order).toEqual(['write(lock held: 1)', 'report(lock held: 0, intent: 1)']);
    expect(client.pauseReport).toHaveBeenCalledWith('job-1', expect.objectContaining({
      protocol: 1, leaseId: 'lease-1', cause: 'agent_idle_no_result', workspaceId: 'wZ',
      agentName: 'ducky-pi-demo', agentStatus: 'done', quiescent: true,
      reportId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    expect(intents.byJob.size).toBe(0);
    expect(client.pauseJob).not.toHaveBeenCalled();
    expect(client.reportFailure).not.toHaveBeenCalled();
    expect(heldLocks()).toEqual([]);
  });

  it('keeps the lease alive while delivery is retried', async () => {
    const { client, intents } = makeClient();
    client.pauseReport.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return answerFor([...intents.byJob.values()][0]!, 'paused');
    });
    client.jobHeartbeat.mockClear();
    await runClaimedJob({ client: client as never, intents, orchestrator: orchestrator().o, heartbeatMs: 10 }, claim());
    // The turn itself was instant; every beat here came from the delivery keepalive.
    expect(client.jobHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  for (const [label, failure] of [
    ['a transport failure', new PauseDeliveryError(undefined, 'down', 'transport')],
    ['version skew', new PauseDeliveryError(404, 'no route', 'version_skew')],
    ['an unknown job', new PauseDeliveryError(404, 'unknown', 'unknown_job')],
    ['a mismatch', new PauseDeliveryError(409, 'mismatch', 'mismatch')],
    ['a refusal', new PauseDeliveryError(400, 'refused', 'refused')],
    ['a malformed answer', new PauseDeliveryError(200, 'bad body', 'malformed')],
  ] as const) {
    it(`keeps the intent and reports no failure on ${label}`, async () => {
      const { client, intents } = makeClient();
      client.pauseReport.mockRejectedValue(failure);
      const log = vi.fn();
      await expect(
        runClaimedJob({ client: client as never, intents, orchestrator: orchestrator().o, heartbeatMs: 50_000, log }, claim()),
      ).resolves.toBeUndefined();

      expect(intents.byJob.size).toBe(1);
      expect(client.reportFailure).not.toHaveBeenCalled();
      expect(client.pauseJob).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toMatch(/kept and will be retried/);
      // The agent was proven quiet and the intent is durable, so the host lock goes.
      expect(heldLocks()).toEqual([]);
    });
  }

  it('keeps the intent when the answer is about a different report, or is not terminal', async () => {
    for (const make of [
      (i: PauseIntent) => answerFor(i, 'paused', { reportId: '99999999-9999-4999-8999-999999999999' }),
      (i: PauseIntent) => answerFor(i, 'paused', { jobId: 'job-2' }),
      (i: PauseIntent) => answerFor(i, 'paused', { executorId: 'exec-b' }),
      (i: PauseIntent) => answerFor(i, 'paused', { workspaceId: 'wOther' }),
      (i: PauseIntent) => answerFor(i, 'paused', { agentName: 'ducky-pi-x' }),
      (i: PauseIntent) => answerFor(i, 'paused', { cause: 'memory_headroom_unproven' }),
      (i: PauseIntent) => answerFor(i, 'paused', { leaseDigest: '0'.repeat(16) }),
      (i: PauseIntent) => answerFor(i, 'pending'),
    ]) {
      const { client, intents } = makeClient();
      client.pauseReport.mockImplementation(async () => make([...intents.byJob.values()][0]!));
      await runClaimedJob({ client: client as never, intents, orchestrator: orchestrator().o, heartbeatMs: 50_000 }, claim());
      expect(intents.byJob.size).toBe(1);
    }
  });

  for (const disposition of ['paused', 'overtaken_cancelled', 'overtaken_timed_out', 'superseded'] as const) {
    it(`forgets the intent on ${disposition}`, async () => {
      const { client, intents } = makeClient();
      client.pauseReport.mockImplementation(async () => answerFor([...intents.byJob.values()][0]!, disposition));
      await runClaimedJob({ client: client as never, intents, orchestrator: orchestrator().o, heartbeatMs: 50_000 }, claim());
      expect(intents.byJob.size).toBe(0);
    });
  }

  it('CRASH WINDOW before the intent is written: nothing is released or reported and the lock stays', async () => {
    const { client, intents } = makeClient();
    intents.failWrites = true;
    const log = vi.fn();
    await runClaimedJob({ client: client as never, intents, orchestrator: orchestrator().o, heartbeatMs: 50_000, log }, claim());

    expect(client.pauseReport).not.toHaveBeenCalled();
    expect(client.pauseJob).not.toHaveBeenCalled();
    expect(client.reportFailure).not.toHaveBeenCalled();
    expect(heldLocks()).toHaveLength(1);
    expect(log.mock.calls.flat().join('\n')).toMatch(/could not be recorded durably; nothing was released/);
  });

  it('still uses the ordinary lease-checked pause when the coordinator did not negotiate', async () => {
    const { client, intents } = makeClient();
    await runClaimedJob(
      { client: client as never, intents, orchestrator: orchestrator().o, heartbeatMs: 50_000 },
      claim({ pauseProtocol: undefined }),
    );
    expect(client.pauseJob).toHaveBeenCalledTimes(1);
    expect(client.pauseReport).not.toHaveBeenCalled();
    expect(intents.byJob.size).toBe(0);
    expect(heldLocks()).toEqual([]);
  });

  it('never starts a turn while a pause is owed or a record is unreadable', async () => {
    for (const setup of [
      (s: MemoryPauseIntentStore) => s.write({ v: 1, reportId: '11111111-1111-4111-8111-111111111111', executorId: 'exec-a', jobId: 'job-9', publicId: 'jzzzzz', leaseId: 'l', workspaceId: 'w', agentName: 'a', cause: 'agent_idle_no_result', agentStatus: 'idle' }),
      (s: MemoryPauseIntentStore) => { s.blocked = ['job-9.json: malformed']; },
    ]) {
      const { client, intents } = makeClient();
      setup(intents);
      const { o, runJob } = orchestrator();
      await runClaimedJob({ client: client as never, intents, orchestrator: o, heartbeatMs: 50_000 }, claim());
      expect(runJob).not.toHaveBeenCalled();
      expect(client.reportFailure).not.toHaveBeenCalled();
      expect(heldLocks()).toEqual([]);
    }
  });
});

describe('loop: owed pauses are settled before any claim', () => {
  const owedIntent = (over: Partial<PauseIntent> = {}): PauseIntent => ({
    v: 1, reportId: '11111111-1111-4111-8111-111111111111', executorId: 'exec-a', jobId: 'job-1',
    publicId: 'jabcde', leaseId: 'lease-1', workspaceId: 'wZ', agentName: 'ducky-pi-demo',
    cause: 'agent_idle_no_result', agentStatus: 'idle', ...over,
  });
  const loopWith = (h: ReturnType<typeof makeClient>, o: PiOrchestrator, log = vi.fn()) =>
    new ExecutorLoop({ client: h.client as never, orchestrator: o, intents: h.intents, pollWaitMs: 0, version: 't', log });

  it('claims with the attestation only when nothing is owed, and not at all while something is', async () => {
    const h = makeClient();
    const loop = loopWith(h, orchestrator().o);
    expect(await loop.runOnce()).toBe('idle');
    expect(h.client.claim).toHaveBeenCalledWith(0, { holdsNoPauseIntent: true });

    h.client.claim.mockClear();
    h.intents.write(owedIntent());
    h.client.pauseDisposition.mockRejectedValue(new PauseDeliveryError(undefined, 'down', 'transport'));
    expect(await loop.runOnce()).toBe('pause_held');
    expect(h.client.claim).not.toHaveBeenCalled();
  });

  it('a lost response after the commit: asks first, forgets it on the terminal answer, needs no proof', async () => {
    const h = makeClient();
    h.intents.write(owedIntent());
    h.client.pauseDisposition.mockImplementation(async () => answerFor(owedIntent(), 'paused'));
    const { o, proveQuiet } = orchestrator();
    const loop = loopWith(h, o);

    expect(await loop.runOnce()).toBe('idle');
    expect(h.intents.byJob.size).toBe(0);
    expect(proveQuiet).not.toHaveBeenCalled();
    expect(h.client.pauseReport).not.toHaveBeenCalled();
    expect(h.client.claim).toHaveBeenCalledWith(0, { holdsNoPauseIntent: true });
  });

  it('an owner resume or cancellation before the replay is superseded: forgotten, nothing re-paused', async () => {
    const h = makeClient();
    h.intents.write(owedIntent());
    h.client.pauseDisposition.mockImplementation(async () => answerFor(owedIntent(), 'superseded', { state: 'running' }));
    expect(await loopWith(h, orchestrator().o).runOnce()).toBe('idle');
    expect(h.intents.byJob.size).toBe(0);
    expect(h.client.pauseReport).not.toHaveBeenCalled();
  });

  it('a still-owed pause is reported only after a FRESH positive proof, with what that proof saw', async () => {
    const h = makeClient();
    h.intents.write(owedIntent({ agentStatus: 'idle' }));
    const { o, proveQuiet } = orchestrator();
    proveQuiet.mockResolvedValue({ quiet: true, observed: 'done' });
    expect(await loopWith(h, o).runOnce()).toBe('idle');

    expect(proveQuiet).toHaveBeenCalledWith({ jobId: 'job-1', workspaceId: 'wZ', agentName: 'ducky-pi-demo' });
    expect(h.client.pauseReport).toHaveBeenCalledWith('job-1', expect.objectContaining({ agentStatus: 'done' }));
    expect(h.intents.byJob.size).toBe(0);
  });

  it('a still-owed pause with no fresh proof is held: nothing reported, nothing claimed, intent kept', async () => {
    const h = makeClient();
    h.intents.write(owedIntent());
    const { o, proveQuiet } = orchestrator();
    proveQuiet.mockResolvedValue({ quiet: false, detail: 'The agent reports working, not idle or done.' });
    const log = vi.fn();
    expect(await loopWith(h, o, log).runOnce()).toBe('pause_held');

    expect(h.client.pauseReport).not.toHaveBeenCalled();
    expect(h.client.claim).not.toHaveBeenCalled();
    expect(h.intents.byJob.size).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toMatch(/not proven quiet now/);
  });

  for (const [label, failure] of [
    ['an unreachable coordinator', new PauseDeliveryError(undefined, 'down', 'transport')],
    ['a coordinator without the route (version skew)', new PauseDeliveryError(404, 'no route', 'version_skew')],
    ['an unknown job', new PauseDeliveryError(404, 'unknown', 'unknown_job')],
    ['a mismatch', new PauseDeliveryError(409, 'mismatch', 'mismatch')],
    ['a refusal', new PauseDeliveryError(400, 'refused', 'refused')],
    ['a malformed answer', new PauseDeliveryError(200, 'bad', 'malformed')],
    ['rejected credentials', new PauseDeliveryError(401, 'no', 'unauthorized')],
  ] as const) {
    it(`holds, forgets nothing and claims nothing on ${label}`, async () => {
      const h = makeClient();
      h.intents.write(owedIntent());
      h.client.pauseDisposition.mockRejectedValue(failure);
      expect(await loopWith(h, orchestrator().o).runOnce()).toBe('pause_held');
      expect(h.intents.byJob.size).toBe(1);
      expect(h.client.claim).not.toHaveBeenCalled();
      expect(h.client.pauseReport).not.toHaveBeenCalled();
    });
  }

  it('holds when the answer is about another report or is malformed in identity', async () => {
    const h = makeClient();
    h.intents.write(owedIntent());
    h.client.pauseDisposition.mockImplementation(async () =>
      answerFor(owedIntent(), 'paused', { reportId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect(await loopWith(h, orchestrator().o).runOnce()).toBe('pause_held');
    expect(h.intents.byJob.size).toBe(1);
  });

  it('holds on an unreadable record without touching it', async () => {
    const h = makeClient();
    h.intents.blocked = ['job-1.json: malformed'];
    const log = vi.fn();
    expect(await loopWith(h, orchestrator().o, log).runOnce()).toBe('pause_held');
    expect(h.client.claim).not.toHaveBeenCalled();
    expect(h.client.pauseDisposition).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/cannot be trusted/);
  });

  it('a held pause is retried on a later tick and then claiming resumes', async () => {
    const h = makeClient();
    h.intents.write(owedIntent());
    h.client.pauseDisposition
      .mockRejectedValueOnce(new PauseDeliveryError(undefined, 'down', 'transport'))
      .mockImplementation(async () => answerFor(owedIntent(), 'paused'));
    const loop = loopWith(h, orchestrator().o);
    expect(await loop.runOnce()).toBe('pause_held');
    expect(await loop.runOnce()).toBe('idle');
    expect(h.intents.byJob.size).toBe(0);
  });
});
