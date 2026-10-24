import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  OrchestrationOutcome, OrchestrationSpec, PiOrchestrator, QuietProof, QuietProofTarget,
} from '@ducky/adapters';
import { CoordinatorClient, ExecutorLoop, PauseDeliveryError, openExecutorState } from '@ducky/executor';
import { createStore, openDatabase, runMigrations, type Store } from '@ducky/persistence';
import { buildServer } from '../src/http/server.js';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { Reconciler } from '../src/domain/reconciler.js';
import { makeHarness, OWNER } from './helpers.js';

/**
 * Durable pause delivery, end to end, from REAL persisted state on both sides.
 *
 * A real coordinator (SQLite on disk, real HTTP, real signing) and a real
 * executor loop, runner, client and file-backed outbox. Only the Herdr/Pi
 * orchestrator is a stub, so no real agent is started. Every "restart" below
 * discards every in-memory object of that side and rebuilds it from disk.
 */
const uid = process.getuid!();
let scratch: string;
let servers: FastifyInstance[] = [];
let stores: Store[] = [];
let lockHome: string;
let previousState: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'ducky-durable-e2e-'));
  previousState = process.env['XDG_STATE_HOME'];
  lockHome = mkdtempSync(path.join(os.tmpdir(), 'ducky-lock-'));
  process.env['XDG_STATE_HOME'] = lockHome;
});
afterEach(async () => {
  for (const s of servers) await s.close();
  for (const s of stores) {
    try { s.db.close(); } catch { /* already closed */ }
  }
  servers = [];
  stores = [];
  rmSync(scratch, { recursive: true, force: true });
  if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = previousState;
});

function initRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-e2e-repo-'));
  const env = {
    ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: dir, env });
  return dir;
}

const REPO = initRepo();
const dbFile = (): string => path.join(scratch, 'coordinator.db');

/** The coordinator process: opens the on-disk database and serves it over real HTTP. */
async function bootCoordinator(first: boolean, creds?: { bearer: string; hmac: string }) {
  const db = openDatabase({ location: dbFile() });
  runMigrations(db);
  const store = createStore(db);
  stores.push(store);
  // A restarted coordinator reads the SAME credential file, so the executor's secrets are
  // unchanged across it; the harness would otherwise mint new ones.
  const h = makeHarness({
    store,
    registerExecutor: first,
    ...(creds
      ? {
          env: {
            DUCKY_EXECUTOR_CREDENTIALS: JSON.stringify({
              version: 1,
              executors: [{ executorId: 'exec-a', keyId: 'k1', bearerToken: creds.bearer, hmacSecret: creds.hmac, state: 'active' }],
            }),
          },
        }
      : {}),
  });
  if (first) store.executors.upsertExecutor(h.executorId, 'test executor');
  store.repos.upsert({
    slug: 'demo', localPath: REPO, allowJobs: true, defaultBranch: 'main', githubOwner: null,
    githubRepo: null, allowWorktree: true, allowBootstrap: true,
    bootstrapAllowedEntries: ['.git'], enabled: true,
  });
  (h.app.allowlist as unknown as { bySlug: Map<string, { absolutePath: string }> }).bySlug.get('demo')!.absolutePath = REPO;
  const server = await buildServer({ store, jobs: h.app.jobs, credentials: h.app.credentials });
  await server.listen({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  return {
    h, store, server, url: `http://127.0.0.1:${server.addresses()[0]!.port}`,
    creds: creds ?? { bearer: h.bearer, hmac: h.hmac },
  };
}
type Coordinator = Awaited<ReturnType<typeof bootCoordinator>>;

/** Fault injection on the wire: the coordinator can be unreachable, or drop the RESPONSE after committing. */
interface Wire {
  down: boolean;
  /** Pass the request through, then lose the answer, this many times. */
  dropResponses: number;
}

/** The executor process: a client, a loop and a file-backed state directory. */
function bootExecutor(c: Coordinator, orchestrator: PiOrchestrator, wire: Wire, stateDir = path.join(scratch, 'executor-state')) {
  const state = openExecutorState(stateDir, { uid, forbiddenRoots: [] });
  const client = new CoordinatorClient({
    baseUrl: c.url, executorId: c.h.executorId, keyId: c.h.keyId, bearerToken: c.creds.bearer,
    hmacSecret: c.creds.hmac, timeoutMs: 5_000,
    pauseRetry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (wire.down) throw new TypeError('connection refused');
      const res = await fetch(input, init);
      if (wire.dropResponses > 0 && String(input).includes('/pause-report')) {
        wire.dropResponses -= 1;
        await res.arrayBuffer();
        throw new TypeError('connection reset before the response');
      }
      return res;
    }) as typeof fetch,
  });
  const loop = new ExecutorLoop({
    client, orchestrator, intents: state.intents, pollWaitMs: 0, version: 'e2e',
    journal: state.journal, journalHasRoomFor: (id) => state.journal.hasRoomFor(id),
    forgetJournal: (id) => state.journal.forget(id),
    log: () => undefined,
  });
  return { state, client, loop, stateDir };
}

/** Starts no agent: registers ownership as the real one does, then reports what it is told. */
class StubOrchestrator implements PiOrchestrator {
  readonly name = 'stub';
  readonly verified = false;
  prompts = 0;
  proofs: QuietProofTarget[] = [];
  constructor(
    private readonly outcome: 'quiet' | 'result',
    private readonly proof: QuietProof = { quiet: true, observed: 'idle' },
    private readonly during: () => void = () => undefined,
  ) {}

  async runJob(spec: OrchestrationSpec): Promise<OrchestrationOutcome> {
    const ws = { workspaceId: `wZ-${spec.publicId}`, agentName: `ducky-pi-${spec.slugKey}` };
    await spec.onWorkspaceCreated?.({
      ...ws, label: `ducky-mgd:${spec.slugKey}`, mode: spec.mode, workspacePath: spec.repoPath,
      worktreePath: spec.mode === 'worktree' ? spec.repoPath : null,
    });
    await spec.onAgentStarted?.(ws);
    this.prompts += 1;
    this.during();
    return { kind: 'quiet_pause', cause: 'agent_idle_no_result', observed: 'idle', ...ws, workspacePath: spec.repoPath };
  }

  async proveQuiet(target: QuietProofTarget): Promise<QuietProof> {
    this.proofs.push(target);
    return this.proof;
  }

  async cancel(): Promise<never> {
    throw new Error('not used');
  }
  async cleanup(): Promise<{ closed: boolean; detail: string }> {
    return { closed: true, detail: 'closed' };
  }
}

const reconcilerAt = (c: Coordinator, ms: number) =>
  new Reconciler({
    store: c.store, approvals: c.h.app.approvals, pending: { sweep: () => 0 } as never,
    now: () => new Date(Date.now() + ms),
  });
const EXPIRED = 10 * 60_000;
const submit = (c: Coordinator) =>
  c.h.app.jobs.submit(c.h.owner, { repoSlug: 'demo', task: 'work', bootstrap: false });
const intentFiles = (stateDir: string): string[] => {
  const dir = path.join(stateDir, 'pause-intents');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
};
const intoPaused = (c: Coordinator, jobId: string) =>
  c.store.jobs.transitions(jobId).filter((t) => t.to === 'needs_owner_input');

describe('a pause undelivered through an outage, an executor crash, lease expiry and a coordinator restart', () => {
  it('FAILURE-BEFORE / SUCCESS-AFTER: reconciles with the budget intact, no second prompt, one owner notification', async () => {
    const wire: Wire = { down: false, dropResponses: 0 };
    const c1 = await bootCoordinator(true);
    const job = submit(c1);

    // Executor #1: the coordinator becomes unreachable as the turn ends.
    const o1 = new StubOrchestrator('quiet', undefined, () => { wire.down = true; });
    const e1 = bootExecutor(c1, o1, wire);
    expect(await e1.loop.runOnce()).toBe('claimed');
    expect(o1.prompts).toBe(1);
    expect(intentFiles(e1.stateDir)).toEqual([`${c1.h.store.jobs.byId(job.id)!.id}.json`]);
    expect(c1.store.jobs.byId(job.id)).toMatchObject({ state: 'running', deliveryProtocol: 1 });

    // Executor #1 dies; its lease lapses. Nothing is charged, every hold stays.
    expect(reconcilerAt(c1, EXPIRED).expireLeases()).toBe(1);
    expect(c1.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 0 });
    expect(c1.store.jobs.admission()).toMatchObject({ jobId: job.id, reason: 'unconfirmed_stop' });

    // The coordinator restarts over the same file; its first reconcile tick changes nothing.
    await c1.server.close();
    c1.store.db.close();
    const c2 = await bootCoordinator(false, c1.creds);
    expect(reconcilerAt(c2, 2 * EXPIRED).expireLeases()).toBe(0);
    expect(reconcilerAt(c2, 2 * EXPIRED).expireReservations()).toBe(0);

    // Executor #2 starts from the same state directory with nothing in memory.
    wire.down = false;
    const o2 = new StubOrchestrator('quiet');
    const e2 = bootExecutor(c2, o2, wire);
    expect(e2.state.intents.list().intents).toHaveLength(1);
    expect(await e2.loop.runOnce()).toBe('idle');

    expect(c2.store.jobs.byId(job.id)).toMatchObject({
      state: 'needs_owner_input', attempts: 0, ownerInputRounds: 0, recoveryRequired: false,
    });
    expect(c2.store.jobs.admission()).toBeUndefined();
    expect(c2.store.jobs.reservation('demo')).toMatchObject({ jobId: job.id });
    expect(c2.store.herdrWorkspaces.openForJob(job.id)).toBeDefined();
    expect(intentFiles(e2.stateDir)).toEqual([]);
    // A fresh proof was taken, and no model work was sent by the reconcile.
    expect(o2.proofs).toEqual([{ jobId: job.id, workspaceId: `wZ-${job.publicId}`, agentName: expect.stringMatching(/^ducky-pi-/) }]);
    expect(o2.prompts).toBe(0);
    expect(intoPaused(c2, job.id)).toHaveLength(1);

    // One owner DM, and a lost one is retried independently of the HTTP answer.
    const notifier = new JobNotifier({ store: c2.store, transport: c2.h.transport, ownerId: OWNER, signer: c2.h.app.signer });
    c2.h.transport.failSends = true;
    await notifier.deliverPending();
    c2.h.transport.failSends = false;
    await notifier.deliverPending();
    expect(c2.h.transport.sent.filter((s) => JSON.stringify(s).includes('Resume'))).toHaveLength(1);

    // The owner resumes; the executor, which owes nothing, claims and attests.
    c2.h.app.jobs.submitOwnerInput(c2.h.owner, job.publicId, 'resume');
    const o3 = new StubOrchestrator('quiet');
    const e3 = bootExecutor(c2, o3, wire);
    expect(await e3.loop.runOnce()).toBe('claimed');
    expect(o3.prompts).toBe(1);
  });

  it('a lost response after the commit: the receipt answers, no proof is needed, nothing is paused twice', async () => {
    const wire: Wire = { down: false, dropResponses: 2 };
    const c = await bootCoordinator(true);
    const job = submit(c);
    const o1 = new StubOrchestrator('quiet');
    const e1 = bootExecutor(c, o1, wire);
    await e1.loop.runOnce();

    // The coordinator committed (the response was lost every time it was tried).
    expect(c.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');
    expect(intentFiles(e1.stateDir)).toHaveLength(1);

    // Executor restarts. The agent no longer reads quiet -- and that must not matter,
    // because the coordinator already answered for this report.
    const o2 = new StubOrchestrator('quiet', { quiet: false, detail: 'working' });
    const e2 = bootExecutor(c, o2, wire);
    expect(await e2.loop.runOnce()).toBe('idle');
    expect(intentFiles(e2.stateDir)).toEqual([]);
    expect(o2.proofs).toEqual([]);
    expect(intoPaused(c, job.id)).toHaveLength(1);
    expect(c.store.jobs.byId(job.id)?.attempts).toBe(0);
  });

  it('an owner resume before the replay: superseded or receipt, the newer attempt is never paused', async () => {
    const wire: Wire = { down: false, dropResponses: 2 };
    const c = await bootCoordinator(true);
    const job = submit(c);
    const e1 = bootExecutor(c, new StubOrchestrator('quiet'), wire);
    await e1.loop.runOnce();
    expect(c.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');

    c.h.app.jobs.submitOwnerInput(c.h.owner, job.publicId, 'resume');
    expect(c.store.jobs.byId(job.id)?.state).toBe('queued');

    const o2 = new StubOrchestrator('quiet');
    const e2 = bootExecutor(c, o2, wire);
    // Settles the old intent first (the receipt), THEN claims the newer attempt.
    expect(await e2.loop.runOnce()).toBe('claimed');
    // The old report was settled without a proof, then the newer attempt ran and paused ON ITS OWN
    // report (a second, separate pause), neither charged and neither overwriting the other.
    expect(o2.proofs).toEqual([]);
    expect(o2.prompts).toBe(1);
    expect(intentFiles(e2.stateDir)).toEqual([]);
    expect(intoPaused(c, job.id)).toHaveLength(2);
    expect(c.store.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 0 });
  });

  it('CRASH WINDOW before the intent is durable: nothing is released, the lease lapses deferred, and the attested recovery charges once', async () => {
    const wire: Wire = { down: false, dropResponses: 0 };
    const c = await bootCoordinator(true);
    const job = submit(c);

    const o1 = new StubOrchestrator('quiet');
    const e1 = bootExecutor(c, o1, wire);
    const write = e1.state.intents.write.bind(e1.state.intents);
    e1.state.intents.write = () => { throw new Error('disk full'); };
    await e1.loop.runOnce();
    expect(intentFiles(e1.stateDir)).toEqual([]);
    expect(c.store.jobs.byId(job.id)?.state).toBe('running');

    reconcilerAt(c, EXPIRED).expireLeases();
    expect(c.store.jobs.byId(job.id)).toMatchObject({ state: 'waiting_for_executor', attempts: 0 });

    // Executor #1's process died: its lock file names a dead pid and is not honoured. The
    // restarted original executor, attested, takes the job: ordinary recovery, charged once.
    rmSync(path.join(lockHome, 'ducky', 'locks'), { recursive: true, force: true });
    void write;
    const o2 = new StubOrchestrator('quiet');
    const e2 = bootExecutor(c, o2, wire);
    expect(await e2.loop.runOnce()).toBe('claimed');
    expect(c.store.jobs.byId(job.id)).toMatchObject({ state: 'needs_owner_input', attempts: 1 });
  });

  it('while the coordinator is down or does not know the route, the executor holds every claim and keeps the intent', async () => {
    const wire: Wire = { down: false, dropResponses: 0 };
    const c = await bootCoordinator(true);
    submit(c);
    const o1 = new StubOrchestrator('quiet', undefined, () => { wire.down = true; });
    const e1 = bootExecutor(c, o1, wire);
    await e1.loop.runOnce();
    expect(intentFiles(e1.stateDir)).toHaveLength(1);

    // Still down: held, and no second job is started on a possibly-owed slot.
    submit(c);
    const o2 = new StubOrchestrator('quiet');
    const e2 = bootExecutor(c, o2, wire);
    expect(await e2.loop.runOnce()).toBe('pause_held');
    expect(o2.prompts).toBe(0);
    expect(intentFiles(e2.stateDir)).toHaveLength(1);

    // An older coordinator: the same hold, named as version skew by the client.
    wire.down = false;
    const skewed = Object.assign(Object.create(e2.client), {
      pauseDisposition: async () => {
        throw new PauseDeliveryError(404, 'no route', 'version_skew');
      },
    }) as CoordinatorClient;
    const loop = new ExecutorLoop({ client: skewed, orchestrator: o2, intents: e2.state.intents, pollWaitMs: 0, version: 'e2e' });
    expect(await loop.runOnce()).toBe('pause_held');
    expect(intentFiles(e2.stateDir)).toHaveLength(1);
  });
});

describe('the dispatch journal is pruned on the coordinator\'s word, over real HTTP', () => {
  it('keeps a paused job that can still be resumed, drops an unknown one, and drops the job once it is cancelled', async () => {
    const wire: Wire = { down: false, dropResponses: 0 };
    const c = await bootCoordinator(true);
    const job = submit(c);
    const e = bootExecutor(c, new StubOrchestrator('quiet'), wire);
    await e.loop.runOnce(); // runs and pauses for the owner
    expect(c.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');

    const entry = (jobId: string) => ({ jobId, leaseId: 'l', workspaceId: 'w', agentName: 'ducky-pi-demo', state: 'settled' as const });
    await e.state.journal.record(entry(job.id));
    await e.state.journal.record(entry('ghost-job'));

    // Paused for the owner: it can be resumed, so its journal is what a later proof rests on.
    const first = bootExecutor(c, new StubOrchestrator('quiet'), wire);
    expect(await first.loop.runOnce()).toBe('idle');
    expect([...(first.state.journal.jobIds() ?? [])]).toEqual([job.id]);

    // Cancelled by the owner: nothing will ever run it again.
    c.h.app.jobs.requestCancel(c.h.owner, job.publicId);
    const second = bootExecutor(c, new StubOrchestrator('quiet'), wire);
    await second.loop.runOnce();
    expect(second.state.journal.jobIds()).toEqual([]);
  });
});
