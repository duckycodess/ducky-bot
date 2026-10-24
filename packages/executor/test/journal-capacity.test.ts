import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchJournalError } from '@ducky/adapters';
import type { OrchestrationOutcome, PiOrchestrator } from '@ducky/adapters';
import { leaseDigest, type ClaimResponse, type PauseDeliveryResponse } from '@ducky/contracts';
import { PauseDeliveryError } from '../src/client.js';
import { FileDispatchJournal } from '../src/dispatch-journal-file.js';
import { sweepJournal } from '../src/journal-sweep.js';
import { ExecutorLoop } from '../src/loop.js';
import { applyAnswer } from '../src/pause-delivery.js';
import { FilePauseIntentStore, MemoryPauseIntentStore, type PauseIntent } from '../src/pause-intents.js';
import { runClaimedJob } from '../src/runner.js';
import { StateDir } from '../src/state-store.js';

/**
 * The dispatch journal is bounded, and the bound must be a managed resource, not
 * a cliff: finished jobs are pruned (on the coordinator's word), a full journal
 * stops claims BEFORE an agent is started, and a refusal by the executor's own
 * state is reported as that and not as "the agent left no result".
 */
const uid = process.getuid!();
let scratch: string;
let repoPath = '';
let lockHome = '';
let previousState: string | undefined;
beforeAll(() => {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'ducky-cap-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
});
beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'ducky-cap-'));
  previousState = process.env['XDG_STATE_HOME'];
  lockHome = mkdtempSync(path.join(os.tmpdir(), 'ducky-lock-'));
  process.env['XDG_STATE_HOME'] = lockHome;
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = previousState;
});

const journalOf = (max: number): FileDispatchJournal =>
  new FileDispatchJournal(StateDir.open(path.join(scratch, 'journal'), { uid, forbiddenRoots: [], maxRecords: max }));
const entry = (jobId: string) => ({ jobId, leaseId: 'l', workspaceId: 'w', agentName: 'ducky-pi-demo', state: 'settled' as const });
const fill = async (j: FileDispatchJournal, ids: string[]) => {
  for (const id of ids) await j.record(entry(id));
};
const status = (state: string, executorDone: boolean) => ({
  kind: 'known' as const, status: { jobId: 'x', state, executorDone },
});

describe('pruning, on the coordinator\'s word only', () => {
  const deps = (journal: FileDispatchJournal, answer: (id: string) => unknown, intents = new MemoryPauseIntentStore()) => {
    const client = { jobStatus: vi.fn(async (id: string) => answer(id)) };
    return { client: client as never, journal, intents, log: vi.fn(), calls: client.jobStatus };
  };

  it('drops completed, failed, cancelled, awaiting-approval and unknown jobs, and keeps every job that can still run', async () => {
    const journal = journalOf(32);
    const states: Record<string, unknown> = {
      done1: status('completed', true), done2: status('failed', true), done3: status('cancelled', true),
      done4: status('needs_approval', true), gone: { kind: 'gone' },
      live1: status('running', false), live2: status('queued', false),
      live3: status('waiting_for_executor', false), live4: status('needs_owner_input', false),
      live5: status('waiting_on_dependency', false),
    };
    await fill(journal, Object.keys(states));
    const d = deps(journal, (id) => states[id]);
    const r = await sweepJournal(d);

    expect(r).toEqual({ pruned: 5, kept: 5, unanswered: 0 });
    expect([...(journal.jobIds() ?? [])].sort()).toEqual(['live1', 'live2', 'live3', 'live4', 'live5']);
  });

  it('keeps the entry of a job with a pause still owed, without even asking', async () => {
    const journal = journalOf(8);
    await fill(journal, ['job-1']);
    const intents = new MemoryPauseIntentStore();
    intents.write({
      v: 1, reportId: '11111111-1111-4111-8111-111111111111', executorId: 'exec-a', jobId: 'job-1',
      publicId: 'jabcde', leaseId: 'l', workspaceId: 'w', agentName: 'ducky-pi-demo',
      cause: 'agent_idle_no_result', agentStatus: 'idle',
    });
    const d = deps(journal, () => status('completed', true), intents);
    await sweepJournal(d);
    expect(d.calls).not.toHaveBeenCalled();
    expect(journal.jobIds()).toEqual(['job-1']);
  });

  it('keeps everything it was not told about: another executor, a refusal, an outage, an old coordinator, a malformed answer', async () => {
    for (const failure of [
      new PauseDeliveryError(409, 'mismatch', 'mismatch'),
      new PauseDeliveryError(400, 'refused', 'refused'),
      new PauseDeliveryError(200, 'bad', 'malformed'),
      new PauseDeliveryError(undefined, 'down', 'transport'),
      new PauseDeliveryError(404, 'no route', 'version_skew'),
      new Error('boom'),
    ]) {
      const journal = journalOf(8);
      await fill(journal, ['job-1', 'job-2']);
      const r = await sweepJournal(deps(journal, () => { throw failure; }));
      expect(r.pruned).toBe(0);
      expect([...(journal.jobIds() ?? [])].sort()).toEqual(['job-1', 'job-2']);
    }
  });

  it('stops asking after an outage or an old coordinator instead of failing every query', async () => {
    const journal = journalOf(8);
    await fill(journal, ['a', 'b', 'c']);
    const d = deps(journal, () => { throw new PauseDeliveryError(undefined, 'down', 'transport'); });
    await sweepJournal(d);
    expect(d.calls).toHaveBeenCalledTimes(1);
  });

  it('never prunes by age and never touches an unreadable record', async () => {
    const journal = journalOf(8);
    await fill(journal, ['job-1']);
    const dir = path.join(scratch, 'journal');
    rmSync(path.join(dir, 'job-1.json'));
    // A record that cannot be read is listed by name only and is kept: the sweep
    // asks about the id, and a coordinator that says "done" is the only way out.
    const d = deps(journal, () => status('running', false));
    expect((await sweepJournal(d)).pruned).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('bounds the queries of one sweep', async () => {
    const journal = journalOf(200);
    await fill(journal, Array.from({ length: 100 }, (_, i) => `job-${i}`));
    const d = deps(journal, () => status('running', false));
    await sweepJournal(d, 10);
    expect(d.calls).toHaveBeenCalledTimes(10);
  });
});

describe('a full journal stops claims before an agent exists', () => {
  const makeLoop = (journal: FileDispatchJournal, answer: (id: string) => unknown, log = vi.fn()) => {
    const client = {
      executorId: 'exec-a',
      heartbeat: vi.fn(async () => undefined),
      claim: vi.fn(async () => undefined as ClaimResponse | undefined),
      jobStatus: vi.fn(async (id: string) => answer(id)),
    };
    const loop = new ExecutorLoop({
      client: client as never, journal, intents: new MemoryPauseIntentStore(), pollWaitMs: 0, version: 't',
      log, journalSweepMs: 3_600_000,
      orchestrator: { name: 's', verified: false } as never,
    });
    return { loop, client, log };
  };

  it('prunes finished jobs to make room, then claims', async () => {
    const journal = journalOf(3);
    await fill(journal, ['a', 'b', 'c']);
    const { loop, client } = makeLoop(journal, () => status('completed', true));
    expect(await loop.runOnce()).toBe('idle');
    expect(client.claim).toHaveBeenCalledTimes(1);
    expect(journal.jobIds()).toEqual([]);
  });

  it('with every entry belonging to a job that can still run, makes no claim, deletes nothing, and says so once', async () => {
    const journal = journalOf(3);
    await fill(journal, ['a', 'b', 'c']);
    const { loop, client, log } = makeLoop(journal, () => status('running', false));
    expect(await loop.runOnce()).toBe('held');
    expect(await loop.runOnce()).toBe('held');
    expect(client.claim).not.toHaveBeenCalled();
    expect([...(journal.jobIds() ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect(log.mock.calls.flat().filter((l) => /journal is full/.test(String(l)))).toHaveLength(1);
  });

  it('claims again once a job finishes', async () => {
    const journal = journalOf(2);
    await fill(journal, ['a', 'b']);
    let aDone = false;
    const { loop, client } = makeLoop(journal, (id) => (id === 'a' && aDone ? status('cancelled', true) : status('running', false)));
    expect(await loop.runOnce()).toBe('held');
    aDone = true;
    expect(await loop.runOnce()).toBe('idle');
    expect(client.claim).toHaveBeenCalled();
    expect(journal.jobIds()).toEqual(['b']);
  });

  it('a job that already has an entry needs no room, a new one does', async () => {
    const journal = journalOf(2);
    await fill(journal, ['a', 'b']);
    expect(journal.hasRoom()).toBe(false);
    expect(journal.hasRoomFor('a')).toBe(true);
    expect(journal.hasRoomFor('new')).toBe(false);
  });
});

const claim = (): ClaimResponse => ({
  jobId: 'job-new', publicId: 'jabcde', leaseId: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  attemptDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(), ownerInputs: [], recordedWorkspace: null,
  payload: {
    repoSlug: 'demo', absolutePath: repoPath, defaultBranch: 'main', github: null, fetchBeforeJob: false,
    task: 'do it', context: null, bootstrap: true, allowWorktree: true, allowBootstrap: true,
    bootstrapAllowedEntries: ['.git'], maxOwnerInputRounds: 3, recoveryRequired: false, ownerInputRounds: 0,
  },
});
const clientFor = (over: Record<string, unknown> = {}) => ({
  executorId: 'exec-a',
  heartbeat: vi.fn(async () => undefined),
  jobHeartbeat: vi.fn(async () => ({ cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), workPhase: null })),
  cancelAck: vi.fn(async () => ({ state: 'cancelled' })),
  reportFailure: vi.fn(async () => ({ state: 'failed', orphan: false })),
  submitResult: vi.fn(async () => ({ state: 'completed' })),
  registerWorkspace: vi.fn(async () => ({ registered: true })),
  closeWorkspace: vi.fn(async () => ({ closed: true })),
  ...over,
});
const orch = (runJob: () => Promise<OrchestrationOutcome>): PiOrchestrator => ({
  name: 's', verified: false, runJob,
  cancel: async () => ({ terminated: true, agentStatus: 'idle', detail: 'x' }),
  cleanup: async () => ({ closed: true, detail: 'closed' }),
  proveQuiet: async () => ({ quiet: false, detail: 'x' }),
});

describe('the runner when the journal cannot take the job', () => {
  it('does not start a turn at all when there is no room for it', async () => {
    const c = clientFor();
    const runJob = vi.fn(async (): Promise<OrchestrationOutcome> => ({ kind: 'unavailable' }));
    const log = vi.fn();
    await runClaimedJob(
      { client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: orch(runJob), heartbeatMs: 50_000, log, journalHasRoomFor: () => false },
      claim(),
    );
    expect(runJob).not.toHaveBeenCalled();
    expect(c.reportFailure).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/no room/);
  });

  it('reports a journal or gate refusal as executor_state_unavailable, NOT no_result', async () => {
    for (const err of [
      new DispatchJournalError(),
      new DispatchJournalError('Model work is withheld: a pause report is still owed.'),
    ]) {
      const c = clientFor();
      await runClaimedJob(
        { client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: orch(async () => { throw err; }), heartbeatMs: 50_000 },
        claim(),
      );
      expect(c.reportFailure).toHaveBeenCalledWith('job-new', 'lease-1', 'executor_state_unavailable', expect.objectContaining({ detail: expect.any(String) }));
    }
  });

  it('keeps no_result for an ordinary failure', async () => {
    const c = clientFor();
    await runClaimedJob(
      { client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: orch(async () => { throw new Error('boom'); }), heartbeatMs: 50_000 },
      claim(),
    );
    expect(c.reportFailure).toHaveBeenCalledWith('job-new', 'lease-1', 'no_result', expect.anything());
  });
});

describe('the runner prunes only on the coordinator\'s terminal answer', () => {
  const run = async (c: ReturnType<typeof clientFor>, outcome: OrchestrationOutcome) => {
    const forget = vi.fn();
    await runClaimedJob(
      { client: c as never, intents: new MemoryPauseIntentStore(), orchestrator: orch(async () => outcome), heartbeatMs: 50_000, forgetJournal: forget },
      claim(),
    );
    return forget;
  };
  const RESULT = {
    kind: 'result', workspaceId: 'w', agentName: 'ducky-pi-demo', workspacePath: repoPath, reused: false,
    result: { schemaVersion: 1, verdict: 'implemented', summary: 's', changedFiles: [], review: { performed: true, independent: true, verdict: 'pass', notes: 'n' }, verification: { commands: [], passed: true }, proposedActions: [] },
  } as unknown as OrchestrationOutcome;

  for (const [state, prunes] of [
    ['completed', true], ['needs_approval', true], ['failed', true], ['cancelled', true],
    ['needs_owner_input', false], ['waiting_on_dependency', false], ['running', false],
  ] as const) {
    it(`a result answered ${state} ${prunes ? 'drops' : 'keeps'} the journal`, async () => {
      const c = clientFor({ submitResult: vi.fn(async () => ({ state })) });
      const forget = await run(c, RESULT);
      expect(forget).toHaveBeenCalledTimes(prunes ? 1 : 0);
    });
  }

  it('a failure the coordinator ends as failed drops it, orphan or not', async () => {
    for (const orphan of [true, false]) {
      const c = clientFor({ reportFailure: vi.fn(async () => ({ state: 'failed', orphan })) });
      const forget = await run(c, { kind: 'unavailable' });
      expect(forget).toHaveBeenCalledTimes(1);
    }
  });

  it('a failure answered with anything else keeps it', async () => {
    const c = clientFor({ reportFailure: vi.fn(async () => ({ state: 'running', orphan: false })) });
    expect(await run(c, { kind: 'unavailable' })).not.toHaveBeenCalled();
  });
});

describe('what a pause answer says and drops', () => {
  const i: PauseIntent = {
    v: 1, reportId: '11111111-1111-4111-8111-111111111111', executorId: 'exec-a', jobId: 'job-1',
    publicId: 'jabcde', leaseId: 'lease-1', workspaceId: 'w', agentName: 'ducky-pi-demo',
    cause: 'agent_idle_no_result', agentStatus: 'idle',
  };
  const answer = (disposition: PauseDeliveryResponse['disposition'], state: string): PauseDeliveryResponse => ({
    protocol: 1, reportId: i.reportId, workspaceId: i.workspaceId, agentName: i.agentName, cause: i.cause,
    jobId: i.jobId, executorId: 'exec-a', leaseDigest: leaseDigest(i.leaseId), disposition, state,
  });
  const apply = (r: PauseDeliveryResponse) => {
    const intents = new MemoryPauseIntentStore();
    intents.write(i);
    const log = vi.fn();
    const forget = vi.fn();
    applyAnswer({ client: { executorId: 'exec-a' } as never, intents, log, forgetJournal: forget }, i, r);
    return { log: log.mock.calls.flat().join('\n'), forget };
  };

  it('a superseded answer does not claim that no attempt was charged', () => {
    const { log } = apply(answer('superseded', 'waiting_for_executor'));
    expect(log).toMatch(/moved past that attempt/);
    expect(log).toMatch(/changed nothing/);
    expect(log).not.toMatch(/no attempt was charged/);
  });

  it('only a pause says no attempt was charged', () => {
    expect(apply(answer('paused', 'needs_owner_input')).log).toMatch(/no attempt was charged/);
    expect(apply(answer('overtaken_timed_out', 'failed')).log).not.toMatch(/no attempt was charged/);
  });

  it('drops the journal only when the answer shows the job is finished', () => {
    expect(apply(answer('paused', 'needs_owner_input')).forget).not.toHaveBeenCalled();
    expect(apply(answer('superseded', 'running')).forget).not.toHaveBeenCalled();
    expect(apply(answer('superseded', 'cancelled')).forget).toHaveBeenCalledWith('job-1');
    expect(apply(answer('overtaken_timed_out', 'failed')).forget).toHaveBeenCalledWith('job-1');
  });
});
