#!/usr/bin/env tsx
/**
 * PROBE B -- production-path certification for the Herdr/Pi integration.
 *
 * Probe A proves the Herdr CLI CONTRACT. This proves the shipped CODE PATH:
 *
 *   router -> JobsService -> real Fastify HTTP + bearer/HMAC/nonce auth
 *          -> CoordinatorClient -> ExecutorLoop -> runClaimedJob
 *          -> resolveWorkspace (real git) -> acquireWriterLock
 *          -> HerdrPiOrchestrator -> HerdrCli -> Herdr -> Pi
 *          -> .ducky/result.json -> FileResultReader -> ResultIntake
 *
 * Nothing is mocked except the Discord TRANSPORT, which is forced to the
 * in-memory one so no gateway connection is opened and no message reaches a
 * real channel. The executor's client talks to a real server on a real loopback
 * port with real signing, so the boundary that matters is genuinely crossed.
 *
 * SAFETY
 * - Only the allowlisted disposable repository is ever a job target, and its
 *   clean baseline is checked first. The Ducky repository is refused outright.
 * - Approved actions stay off, so no commit, push or PR can be performed.
 * - Credentials are read from the runtime store into memory only, never printed.
 * - Nothing is written to Discord, GitHub, Azure, Railway or RunPod.
 * - Teardown reports any agent, workspace, worktree or writer lock left behind.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../packages/coordinator/src/app.js';
import { buildServer } from '../packages/coordinator/src/http/server.js';
import { MockDiscordTransport } from '../packages/coordinator/src/discord/mock.transport.js';
import type { Incoming } from '../packages/coordinator/src/discord/transport.js';
import { CoordinatorClient } from '../packages/executor/src/client.js';
import { ExecutorLoop } from '../packages/executor/src/loop.js';
import { HerdrCli, HerdrPiOrchestrator, redact } from '../packages/adapters/src/index.js';
import { JOB_MAX_WALL_CLOCK_MS } from '../packages/contracts/src/index.js';

/**
 * The ONLY repository this probe will ever target.
 *
 * Hard-coded, not read from the environment. `PROBE_REPO_SLUG` used to allow
 * any allowlisted slug, which meant one stray variable pointed a real Pi agent
 * with edit capability at a real repository. An override is accepted only when
 * it ALSO satisfies the disposable invariant below, and the invariant is what
 * actually authorises the run -- never the name.
 */
const DEFAULT_SLUG = 'example-sandbox';

/**
 * A repository is disposable only if it says so about itself.
 *
 * Requires a marker file committed into the repository. A slug cannot grant
 * this, an environment variable cannot grant this, and a real project will
 * never accidentally have one.
 */
const DISPOSABLE_MARKER = '.ducky-disposable';

const SLUG = process.env['PROBE_REPO_SLUG'] ?? DEFAULT_SLUG;
const HOME = os.homedir();
const fold = (s: string): string => s.split(HOME).join('~');
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * The task, fixed in source and NOT overridable.
 *
 * `PROBE_TASK` used to be read from the environment, which meant one variable
 * could put arbitrary text in front of a real Pi agent that has edit capability
 * in a real git worktree. The task is part of what makes this probe safe, so it
 * is not a parameter. Change it here, in review, or not at all.
 */
const PROBE_TASK =
  'Append a single line reading "// ducky probe" to the end of README.md. ' +
  'Then run `git status --porcelain` and report its real exit code as verification. ' +
  'Do not create, delete or modify any other file. Do not commit.';

const herdrArgv: string[] = [];

function assertDisposableBaseline(repoPath: string, slug: string): void {
  const duckyRoot = path.resolve(import.meta.dirname, '..');
  if (path.resolve(repoPath) === duckyRoot) {
    throw new Error('refusing to run a probe job against the Ducky repository itself');
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`${fold(repoPath)} is not a git repository`);
  }

  /**
   * The invariant that actually authorises this run.
   *
   * A real Pi agent with edit capability is about to be pointed at this
   * directory. The slug is not evidence -- it is a label somebody typed into a
   * config file -- so the repository has to assert its own disposability with a
   * committed marker. A non-default slug is additionally refused unless it
   * carries the marker, so no environment variable can redirect this at a real
   * project.
   */
  if (!existsSync(path.join(repoPath, DISPOSABLE_MARKER))) {
    throw new Error(
      `${fold(repoPath)} has no ${DISPOSABLE_MARKER} marker, so it is not provably ` +
        'disposable. A real Pi agent with edit capability runs here; refusing. ' +
        `Create and COMMIT ${DISPOSABLE_MARKER} in that repository if it genuinely is ` +
        'throwaway.',
      );
  }

  /**
   * The marker must be COMMITTED, not merely present.
   *
   * An untracked file is something anything can drop into a directory -- an
   * editor, a stray script, a previous probe run, this one. Requiring it in the
   * index means somebody made a deliberate, reviewable change to that
   * repository saying it is throwaway. The comment above this check used to
   * claim "committed" while the code only checked existence, which is precisely
   * the gap that makes a safety check decorative.
   */
  const tracked = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', DISPOSABLE_MARKER],
    { cwd: repoPath, encoding: 'utf8' },
  );
  if (tracked.status !== 0) {
    throw new Error(
      `${fold(repoPath)} has an UNTRACKED ${DISPOSABLE_MARKER}. An untracked file proves ` +
        'nothing -- anything can drop one in. Commit it, so the claim that this repository ' +
        'is disposable is a deliberate, reviewable change.',
    );
  }
  if (slug !== DEFAULT_SLUG) {
    out(
      `WARNING: targeting "${slug}" rather than "${DEFAULT_SLUG}". Allowed only because ` +
        `${DISPOSABLE_MARKER} is present.`,
    );
  }
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();

  const dirty = git(['status', '--porcelain']);
  if (dirty !== '') throw new Error(`${fold(repoPath)} is not clean; refusing:\n${dirty}`);
  const stale = git(['branch', '--list', 'ducky/*']);
  if (stale !== '') throw new Error(`${fold(repoPath)} already has ducky/* branches:\n${stale}`);

  out(
    `baseline ok: ${fold(repoPath)} @ ${git(['rev-parse', '--short', 'HEAD'])} ` +
      `on ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}, clean, no ducky/* branches`,
  );
}

/**
 * Everything this run acquired, so ONE place can release it.
 *
 * The previous shape put the `try/finally` after app, server, credential,
 * transport and job setup -- so a throw in `buildServer`, `listen`,
 * `firstWorkingCredential`, `dispatch` or the precondition queries left the
 * server listening, the app's SQLite handle open, and (once started) a loop
 * polling a database nobody was going to close.
 */
interface Live {
  app?: App;
  server?: Awaited<ReturnType<typeof buildServer>>;
  transport?: MockDiscordTransport;
  loop?: ExecutorLoop;
  running?: Promise<unknown>;
}

/** Whether a promise reached ANY conclusion (resolve or reject) inside `ms`. */
async function didSettle(p: Promise<unknown>, ms: number): Promise<boolean> {
  const done = Symbol('settled');
  const outcome = await Promise.race([
    p.then(() => done, () => done),
    sleep(ms).then(() => undefined),
  ]);
  return outcome === done;
}

interface Shutdown {
  readonly problems: string[];
  /** False when the executor loop was still running when the grace ran out. */
  readonly loopSettled: boolean;
}

/**
 * Releases in reverse order of acquisition, and REFUSES to release anything if
 * the executor loop is still running.
 *
 * The previous version raced the loop against a timeout and then closed the
 * transport, the server and the database anyway. That is the worst available
 * outcome: a still-running loop goes on claiming and writing against a closed
 * SQLite handle, which is either a crash or silent corruption of whatever it was
 * mid-write on. There is no safe way to force a wedged loop to stop from here,
 * so the honest move is to leave everything open, say so, and let process exit
 * take the whole thing down at once.
 *
 * Order otherwise matters: stop accepting work, wait for the in-flight turn,
 * then the transport and the server, and only then the database.
 */
async function releaseAll(live: Live): Promise<Shutdown> {
  const problems: string[] = [];

  if (live.loop) {
    live.loop.stop();
    const settledOk =
      live.running === undefined ? true : await didSettle(live.running, SHUTDOWN_GRACE_MS);
    if (!settledOk) {
      problems.push(
        `the executor loop did not stop within ${SHUTDOWN_GRACE_MS}ms; the transport, HTTP ` +
          'server and database were LEFT OPEN deliberately, because closing SQLite under a ' +
          'running loop risks corrupting whatever it is mid-write on. Process exit will take ' +
          'them down together.',
      );
      return { problems, loopSettled: false };
    }
  }

  const step = async (what: string, fn: () => unknown): Promise<void> => {
    try {
      const done = await didSettle(Promise.resolve(fn()), SHUTDOWN_GRACE_MS);
      if (!done) problems.push(`${what} did not shut down within the grace period`);
    } catch (err) {
      problems.push(`${what} did not shut down cleanly: ${redact((err as Error).message)}`);
    }
  };

  if (live.transport) await step('transport', () => live.transport!.stop());
  if (live.server) await step('http server', () => live.server!.close());
  // LAST, and only once the loop is provably done with it.
  if (live.app) await step('app', () => live.app!.close());
  return { problems, loopSettled: true };
}

async function main(): Promise<ProbeOutcome> {
  // Refused rather than ignored: somebody who set this expects it to take
  // effect, and silently discarding it would be its own surprise.
  if (process.env['PROBE_TASK'] !== undefined) {
    throw new Error(
      'PROBE_TASK is not overridable. The task is part of what makes this probe safe -- ' +
        'a real Pi agent with edit capability runs it in a real worktree. Edit PROBE_TASK ' +
        'in scripts/probe-live-job.ts if it genuinely needs to change.',
    );
  }

  // Validated HERE, with the other pure configuration checks, so a bad value
  // fails on the cheapest thing rather than after the git and database
  // preconditions have run.
  resolveWatchBudgetMs(process.env['PROBE_TIMEOUT_MS']);

  const live: Live = {};
  let outcome: ProbeOutcome | undefined;
  try {
    outcome = await run(live);
    return outcome;
  } finally {
    // Runs on success, on throw, and on a failed precondition alike. A shutdown
    // problem is a FAILURE of the run, not a footnote: an unsettled loop means
    // the evidence may have been read while the executor was still mutating.
    const shutdown = await releaseAll(live);
    for (const p of shutdown.problems) process.stderr.write(`  shutdown: ${p}\n`);
    if (outcome !== undefined && shutdown.problems.length > 0) {
      outcome.verdict.push(...shutdown.problems.map((p) => `shutdown: ${p}`));
    }
  }
}

async function run(live: Live): Promise<ProbeOutcome> {
  // Forced even though a development token exists in the environment: a
  // certification run must never open a Discord gateway.
  const transport = new MockDiscordTransport();
  live.transport = transport;
  const app = createApp(process.env, { transport });
  live.app = app;

  const ownerId = app.authz.ownerId;
  const repo = app.allowlist.list().find((r) => r.slug === SLUG);
  if (!repo) throw new Error(`slug "${SLUG}" is not allowlisted`);
  assertDisposableBaseline(repo.absolutePath, SLUG);

  // A leftover non-terminal job would be claimed instead of this one, and an
  // orphaned reservation blocks the repository entirely -- both of which make
  // the run measure the wrong thing. Refuse rather than produce noise.
  const stuck = app.store.db
    .prepare(
      "SELECT public_id, state FROM jobs WHERE state NOT IN ('completed','failed','cancelled')",
    )
    .all() as { public_id: string; state: string }[];
  if (stuck.length > 0) {
    throw new Error(
      `the database already has non-terminal jobs: ${stuck
        .map((j) => `${j.public_id}=${j.state}`)
        .join(', ')}. Clear them first (/job cleanup) so this run measures itself.`,
    );
  }
  const held = app.store.db.prepare('SELECT repo_slug, reason FROM repo_reservations').all() as {
    repo_slug: string; reason: string | null;
  }[];
  if (held.length > 0) {
    throw new Error(
      `repository reservations are still held: ${held
        .map((r) => `${r.repo_slug}(${r.reason ?? 'active'})`)
        .join(', ')}. A reserved repository can never be claimed.`,
    );
  }

  const t0 = Date.now();
  const herdr = new HerdrCli({
    onInvoke: (argv) => {
      const line = `${argv.join(' ')}`;
      herdrArgv.push(line);
      out(`  [+${Math.round((Date.now() - t0) / 1000)}s] herdr ${fold(line).slice(0, 120)}`);
    },
  });
  if (!(await herdr.available())) throw new Error('herdr is not reachable; nothing to certify');
  const orchestrator = new HerdrPiOrchestrator({ herdr, verified: false });
  out(`EVIDENCE 1  orchestrator=${orchestrator.name} verified=${orchestrator.verified}`);
  if (orchestrator.name !== 'herdr-pi') throw new Error('not the production orchestrator');

  const server = await buildServer({
    store: app.store, jobs: app.jobs, credentials: app.credentials,
  });
  live.server = server;
  await server.listen({ host: '127.0.0.1', port: 0 });
  const port = server.addresses()[0]!.port;
  out(`coordinator listening on 127.0.0.1:${port} (real HTTP, real signing)`);

  // Credential selection, verified rather than assumed.
  //
  // The credential FILE can legitimately hold several keys (that is how
  // rotation works), and only the ones with a matching active database row can
  // authenticate. So each is tried against a real authenticated call and the
  // first that the coordinator accepts is used. Secret material is read from
  // the runtime store into memory only -- never printed, logged or persisted.
  const client = await firstWorkingCredential(app, port);

  await transport.start((event) => app.router.handle(event));

  const event: Incoming = {
    kind: 'command',
    name: 'job',
    subcommand: 'submit',
    userId: ownerId,
    options: { repo: SLUG, task: PROBE_TASK },
  };
  const reply = await transport.dispatch(event);
  out(`submit: ${(reply?.content ?? '').slice(0, 200).replace(/\n/g, ' | ')}`);

  const row = app.store.jobs.listRecent(ownerId, 5)[0];
  if (!row) throw new Error('no job row was created');
  out(`job ${row.publicId} created (${row.state})`);

  const loop = new ExecutorLoop({
    client, orchestrator, pollWaitMs: 1_000, version: 'probe-b',
    log: (line) => out(`executor: ${line}`),
  });
  live.loop = loop;
  const running = loop.run();
  live.running = running;

  const budgetMs = resolveWatchBudgetMs(process.env['PROBE_TIMEOUT_MS']);
  const startedAt = Date.now();
  const seen: string[] = [];
  /** Whether the loop provably stopped, so the evidence read is of a still state. */
  let quiesced = false;

  /**
   * Everything after the loop starts runs inside try/finally.
   *
   * The loop, the HTTP server and the database are all live at this point. An
   * exception used to escape past `loop.stop()` and `server.close()`, leaving a
   * polling executor running against a database the process then abandoned --
   * and on the way out `app.close()` could close SQLite underneath an in-flight
   * turn. Shutdown is bounded so a wedged loop cannot hang the probe either.
   */
  try {
    let last = '';
    while (Date.now() - startedAt < budgetMs) {
      await new Promise((r) => setTimeout(r, 1_500));
      try {
        app.reconciler.run();
      } catch {
        /* reconciliation is incidental to the probe */
      }
      const now = app.store.jobs.byId(row.id);
      if (!now) break;
      const stamp = `${now.state}${now.workPhase ? `/${now.workPhase}` : ''}`;
      if (stamp !== last) {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        out(`  +${secs}s  ${stamp}`);
        seen.push(`${stamp}@${secs}s`);
        last = stamp;
      }
      if (TERMINALS.includes(now.state)) break;
    }
  } finally {
    // Stop accepting work BEFORE the evidence is read, so nothing changes
    // underneath it. `releaseAll` in `main` guarantees release on every other
    // path; this is about ordering the happy one.
    loop.stop();
    quiesced = await didSettle(running, SHUTDOWN_GRACE_MS);
  }

  /**
   * Evidence read while the executor may still be writing is not evidence.
   *
   * A job row, a result row or a phase event can all still change under a loop
   * that has not stopped, so a report taken now could describe a state that
   * never existed as a whole. Refuse rather than certify a snapshot that may be
   * mid-flight.
   */
  if (!quiesced) {
    out('');
    out('The executor loop did not stop; refusing to read evidence while it may still write.');
    return {
      verdict: [
        `the executor loop was still running after ${SHUTDOWN_GRACE_MS}ms, so no evidence ` +
          'could be read safely',
      ],
      teardown: teardownFindings(),
    };
  }

  report(app, row.id, row.publicId, seen, Date.now() - startedAt);

  // Read the verdict BEFORE the store closes.
  const verdict = assertEvidence(app, row.id);
  // A completed worktree job KEEPS its workspace and agent, because the checkout
  // holds the implementation and nothing has committed it. Built from what the
  // DATABASE says was retained for THIS job, so nothing else can be waved
  // through as expected.
  const kept = app.store.db
    .prepare(
      `SELECT workspace_id, agent_name, worktree_path
         FROM herdr_workspaces WHERE job_id = ? AND closed_at IS NULL`,
    )
    .all(row.id) as { workspace_id: string; agent_name: string; worktree_path: string | null }[];

  const teardown = teardownFindings({
    repoName: path.basename(repo.absolutePath),
    // The checkout directory name, taken from the recorded path rather than
    // reconstructed from the branch.
    checkoutNames: kept
      .map((k) => (k.worktree_path === null ? '' : path.basename(k.worktree_path)))
      .filter((n) => n !== ''),
    agentNames: kept.map((k) => k.agent_name),
  });

  if (teardown.retained.length > 0) {
    out('11. retained ON PURPOSE (the work is uncommitted, so Ducky kept it):');
    for (const r of teardown.retained) out(`      ${r}`);
    out('    clear with `/job cleanup` once you have inspected or salvaged the diff.');
  }

  // Released by `releaseAll` in `main`, on this path and every other.
  return { verdict, teardown };
}

/**
 * What a run is ALLOWED to leave behind, named exactly.
 *
 * A completed worktree job keeps its workspace and agent because the checkout
 * holds the implementation and nothing has committed it. That is the product
 * working as designed -- but it is not a clean teardown either, so it is
 * reported as RETAINED and kept out of the leak list only when it matches
 * exactly what this run created.
 */
interface ExpectedLeftovers {
  readonly repoName: string;
  readonly checkoutNames: string[];
  readonly agentNames: string[];
}

/** Mutable so `main` can append a shutdown failure discovered after `run`. */
interface ProbeOutcome {
  readonly verdict: string[];
  readonly teardown: TeardownReport;
}

interface TeardownReport {
  readonly leaks: string[];
  readonly retained: string[];
}

const EXPECT_NOTHING: ExpectedLeftovers = { repoName: '', checkoutNames: [], agentNames: [] };

/** Floor: below this the watch loop cannot observe even a fast turn. */
export const MIN_WATCH_BUDGET_MS = 60_000;
/**
 * Ceiling: a job cannot outlive `JOB_MAX_WALL_CLOCK_MS`, so watching longer
 * observes nothing and only extends how long a real Pi agent is left running.
 * The grace covers the executor noticing its own wall-clock failure.
 */
export const MAX_WATCH_BUDGET_MS = JOB_MAX_WALL_CLOCK_MS + 5 * 60_000;

/**
 * Validates and CLAMPS the watch budget.
 *
 * Raw `Number(env)` was unbounded and unvalidated, which broke the
 * bounded-probe contract two different ways: a large value leaves a real Pi
 * agent with edit capability running for as long as somebody typed, and a
 * non-numeric value produces `NaN` — which makes `elapsed < NaN` false, so the
 * watch loop never runs at all and the probe reads evidence from a job that has
 * not started. The second is worse than the first, because it looks like a
 * fast failure rather than a misconfiguration.
 *
 * Unlike `PROBE_TASK` this stays a knob: a slow host legitimately needs longer.
 * It is bounded rather than refused.
 */
export function resolveWatchBudgetMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 900_000;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `PROBE_TIMEOUT_MS must be a number of milliseconds; got ${JSON.stringify(raw)}. ` +
        'Refused rather than defaulted: a non-numeric value used to make the watch loop ' +
        'skip entirely and the probe read evidence from a job that had not started.',
    );
  }
  if (parsed < MIN_WATCH_BUDGET_MS) {
    out(`PROBE_TIMEOUT_MS ${parsed}ms is below the floor; using ${MIN_WATCH_BUDGET_MS}ms.`);
    return MIN_WATCH_BUDGET_MS;
  }
  if (parsed > MAX_WATCH_BUDGET_MS) {
    out(
      `PROBE_TIMEOUT_MS ${parsed}ms exceeds the ceiling; using ${MAX_WATCH_BUDGET_MS}ms ` +
        '(a job cannot outlive its own wall-clock budget, so watching longer observes ' +
        'nothing and only leaves a real Pi agent running).',
    );
    return MAX_WATCH_BUDGET_MS;
  }
  return Math.floor(parsed);
}

const TERMINALS = ['completed', 'failed', 'cancelled', 'needs_owner_input', 'needs_approval'];
const SHUTDOWN_GRACE_MS = 15_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The evidence checklist, as assertions rather than prose.
 *
 * The probe used to print a report and exit 0 regardless of what the report
 * said -- so a job that failed, produced no result, or was reviewed by nobody
 * still looked like a passing certification. Every item below is now a
 * requirement, and a missing one is a non-zero exit.
 */
/** Tries each loaded credential with a real signed call; returns the first accepted. */
async function firstWorkingCredential(app: App, port: number): Promise<CoordinatorClient> {
  const metas = app.credentials.listActive();
  if (metas.length === 0) {
    throw new Error('no active executor credential; run pnpm executor:issue-credential');
  }
  for (const meta of metas) {
    const cred = app.credentials.get(meta.executorId, meta.keyId);
    if (!cred) continue;
    const candidate = new CoordinatorClient({
      baseUrl: `http://127.0.0.1:${port}`,
      executorId: cred.executorId,
      keyId: cred.keyId,
      bearerToken: cred.revealBearer(),
      hmacSecret: cred.revealHmacSecret(),
    });
    try {
      await candidate.heartbeat({ version: 'probe-b', capabilities: ['herdr-pi'], activeJobIds: [] });
      out(`credential accepted: executor=${meta.executorId} key=${meta.keyId}`);
      return candidate;
    } catch {
      out(`credential rejected: executor=${meta.executorId} key=${meta.keyId} (trying next)`);
    }
  }
  throw new Error(
    'no loaded credential was accepted; the database rows and the credential file disagree. ' +
      'Run pnpm executor:issue-credential for this profile.',
  );
}

/**
 * Prints the evidence, item by item.
 *
 * Printing is NOT the assertion -- `assertEvidence` is. This exists so a human
 * reading a failed run can see what was and was not there, which is why the
 * numbering matches the evidence checklist in docs/integrations/herdr.md.
 */
function report(
  app: App,
  jobId: string,
  publicId: string,
  seen: string[],
  elapsedMs: number,
): void {
  out('\n================ PROBE B EVIDENCE ================');
  out('2. transitions');
  for (const t of app.store.jobs.transitions(jobId)) {
    out(`     ${t.from || '-'} -> ${t.to}  (${t.reason})`);
  }

  out('3. work phases observed');
  out(`     ${seen.join('  ->  ') || '(none)'}`);
  for (const e of app.store.jobs.events(jobId, 200).reverse()) {
    if (e.kind.includes('phase')) out(`     event ${e.kind}: ${e.message}`);
  }

  out('4. audit rows');
  for (const a of app.store.auditLog.forSubject('job', publicId, 200)) {
    out(`     ${a.event} ${a.outcome} ${a.detail ?? ''}`);
  }

  out('5. herdr workspace record');
  const rows = app.store.db
    .prepare(
      `SELECT workspace_id, mode, state, worktree_path, closed_at
         FROM herdr_workspaces WHERE job_id = ?`,
    )
    .all(jobId) as Record<string, unknown>[];
  for (const w of rows) {
    out(
      `     ${String(w['workspace_id'])} mode=${String(w['mode'])} state=${String(w['state'])} ` +
        `worktree=${fold(String(w['worktree_path'] ?? '-'))} closed=${String(w['closed_at'] ?? 'no')}`,
    );
  }
  const open = app.store.herdrWorkspaces.openForJob(jobId);
  out(`     still open: ${open ? open.workspaceId : 'none'}`);

  out('6. herdr argv actually issued');
  for (const a of herdrArgv) out(`     ${fold(a).slice(0, 150)}`);

  out('7. accepted result');
  const res = app.store.results.byJobId(jobId);
  if (res) {
    const snap = res.snapshot;
    out(`     verdict=${res.verdict}`);
    out(`     review=${JSON.stringify(snap.review)}`);
    out(`     verification=${JSON.stringify(snap.verification)}`);
    out(`     changedFiles=${JSON.stringify(snap.changedFiles)}`);
    out(`     summary=${res.summaryRedacted.slice(0, 200).replace(/\n/g, ' | ')}`);
  } else {
    out('     (none)');
  }

  const job = app.store.jobs.byId(jobId);
  out(
    `9. elapsed ${Math.round(elapsedMs / 1000)}s; final state=${job?.state} ` +
      `phase=${job?.workPhase ?? '-'}`,
  );
  out('==================================================');
}

function assertEvidence(app: App, jobId: string): string[] {
  const problems: string[] = [];
  const job = app.store.jobs.byId(jobId);

  if (!job) {
    return ['the job row is gone, so nothing can be certified'];
  }
  if (job.state !== 'completed') {
    problems.push(`final state is ${job.state}, not completed`);
  }

  const res = app.store.results.byJobId(jobId);
  if (!res) {
    problems.push('no result was accepted');
  } else {
    if (res.verdict !== 'implemented') problems.push(`result verdict is ${res.verdict}`);
    const snap = res.snapshot;
    if (snap.review.performed !== true) problems.push('no review was performed');
    if (snap.review.independent !== true) problems.push('the review was not independent');
    if (snap.review.verdict !== 'pass') problems.push(`review verdict is ${snap.review.verdict}`);
    if (snap.verification.passed !== true) problems.push('verification did not pass');
    if (snap.verification.commands.length === 0) {
      problems.push('verification ran no commands, so its exit codes are not evidence');
    }
    if (snap.changedFiles.length === 0) problems.push('no file was reported changed');
  }

  // The engineering loop has to have been OBSERVED, not merely possible.
  const phases = app.store.jobs
    .events(jobId, 500)
    .filter((e) => e.kind === 'phase_changed')
    .map((e) => e.message);
  for (const required of ['planning', 'implementing']) {
    if (!phases.some((p) => p.includes(required))) {
      problems.push(`phase ${required} was never reported`);
    }
  }

  // The orchestrator must have gone through Herdr for real.
  for (const required of ['worktree create', 'agent start', 'agent prompt']) {
    if (!herdrArgv.some((a) => a.startsWith(required))) {
      problems.push(`herdr "${required}" was never invoked`);
    }
  }

  return problems;
}

/**
 * What this run left behind, MEASURED rather than printed.
 *
 * The previous version logged a teardown line and exited 0 whatever it found,
 * which is exactly the kind of cleanup evidence that is not evidence.
 *
 * `expected` names leftovers the PRODUCT deliberately keeps: a completed
 * worktree job's workspace is retained because its checkout holds the
 * implementation and nothing has committed it, so `worktree remove` refuses and
 * `cleanup()` reports it kept. Reporting that as a leak would train a reader to
 * ignore this check; reporting it as clean would be a lie. It is reported as
 * expected, and anything NOT on that list is a genuine leak.
 */
function teardownFindings(expected: ExpectedLeftovers = EXPECT_NOTHING): TeardownReport {
  const leaks: string[] = [];
  const retained: string[] = [];

  /**
   * Only this probe's own checkouts are in scope.
   *
   * `~/.herdr/worktrees/<repo-name>/<label>` is shared with every other repo on
   * the host, so scanning all of it reports somebody else's work as our leak.
   * We look at the ONE repo directory this run could have written to, and match
   * checkouts against the branch this run created.
   */
  const repoDir = path.join(HOME, '.herdr', 'worktrees', expected.repoName);
  if (existsSync(repoDir)) {
    for (const entry of readdirSync(repoDir)) {
      const full = path.join(repoDir, entry);
      let empty = false;
      try {
        empty = readdirSync(full).length === 0;
      } catch {
        // Unreadable: treat as present rather than assume it is gone.
      }
      // Herdr leaves the per-repo parent behind and reuses it; an empty child is
      // not a leftover.
      if (empty) continue;
      if (expected.checkoutNames.includes(entry)) {
        // Ducky KEPT this on purpose: the checkout holds the implementation and
        // nothing has committed it, so `worktree remove` refuses. Reported as
        // retained -- never as a clean teardown, and never as a leak.
        retained.push(`worktree checkout ${entry} (holds uncommitted work)`);
      } else {
        leaks.push(`unexpected worktree checkout: ${entry}`);
      }
    }
  }

  const lockDir = path.join(
    process.env['XDG_STATE_HOME'] ?? path.join(HOME, '.local', 'state'),
    'ducky', 'locks',
  );
  if (existsSync(lockDir)) {
    const locks = readdirSync(lockDir).filter((f) => f.endsWith('.lock'));
    // A writer lock is NEVER expected after a run: it is released on every
    // non-orphan path, and an orphan means a live writer the owner must clear.
    if (locks.length > 0) leaks.push(`writer locks remain: ${locks.join(', ')}`);
  }

  // A live Ducky agent is the most consequential leftover, so the exact name is
  // matched rather than the prefix.
  try {
    const listed = execFileSync('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    const parsed = JSON.parse(listed) as { result?: { agents?: { name?: string | null }[] } };
    for (const a of parsed.result?.agents ?? []) {
      const name = a.name ?? '';
      if (!name.startsWith('ducky-pi-')) continue;
      if (expected.agentNames.includes(name)) {
        retained.push(`agent ${name} (in the retained workspace)`);
      } else {
        leaks.push(`unexpected ducky agent still live: ${name}`);
      }
    }
  } catch {
    leaks.push('could not read the herdr agent list to confirm teardown');
  }

  return { leaks, retained };
}

/**
 * Exit codes, so a caller can tell the three outcomes apart:
 *   0  certified -- every evidence item present and nothing left behind
 *   1  the run itself failed (threw, or could not start)
 *   4  the run completed but the evidence is incomplete
 *   5  the run is certified but teardown left something behind
 */
/**
 * Only run when invoked directly.
 *
 * Without this the module starts a probe on IMPORT, which means a unit test for
 * anything in here (the budget clamp, say) launches a real Pi agent as a side
 * effect of loading the file.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
      .then(({ verdict, teardown }) => {
      out('');
      if (verdict.length > 0) {
        process.stderr.write('NOT CERTIFIED — missing or failed evidence:\n');
        for (const p of verdict) process.stderr.write(`  - ${p}\n`);
      } else {
        out('CERTIFIED: every evidence item present.');
      }

      if (teardown.leaks.length > 0) {
        process.stderr.write('TEARDOWN LEAKED:\n');
        for (const p of teardown.leaks) process.stderr.write(`  - ${p}\n`);
        process.stderr.write(
          'Clear these by hand before the next run; a live agent or a held writer lock ' +
            'changes what the next probe measures.\n',
        );
      } else if (teardown.retained.length > 0) {
        // NOT called clean: something is still on disk, deliberately.
        out(
          `Teardown: no leak. ${teardown.retained.length} artefact(s) retained on purpose ` +
            '(see item 11) — clear them with `/job cleanup`.',
        );
      } else {
        out('Teardown verified: nothing retained and nothing leaked.');
      }

      if (verdict.length > 0) process.exit(4);
      if (teardown.leaks.length > 0) process.exit(5);
      process.exit(0);
    })
    .catch((err: unknown) => {
      // Redacted: a startup failure quotes configuration.
      process.stderr.write(`probe B failed: ${redact((err as Error).message)}\n`);
      // Best-effort, and reported rather than assumed -- the run aborted, so
      // something is more likely to be left behind here than on the happy path.
      try {
        const t = teardownFindings();
        for (const p of [...t.leaks, ...t.retained]) {
          process.stderr.write(`  leftover: ${p}\n`);
        }
      } catch {
        process.stderr.write('  leftover state could not be inspected\n');
      }
      process.exit(1);
    });
}
