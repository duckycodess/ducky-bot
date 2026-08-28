#!/usr/bin/env node
/**
 * Records real Herdr responses so the adapter's schemas are checked against
 * this host rather than against assumptions.
 *
 * It creates a throwaway git repository under a temp directory, exercises the
 * mutating commands the orchestrator actually uses, writes redacted responses
 * into packages/adapters/src/herdr/herdr.fixtures/, and removes everything it
 * created -- including on failure.
 *
 * It never touches a workspace it did not create.
 *
 * `--with-agent` additionally exercises `agent start`, `agent prompt` and
 * `agent get`, which launch a REAL Pi agent and consume real model capacity.
 * It is opt-in for that reason, and the brief it sends asks only for a result
 * file: no edit, no build, no commit.
 *
 * CLEANUP ORDER IS LOAD-BEARING. A linked worktree is checked out under
 * Herdr's own directory, but its bookkeeping lives in the SOURCE repository's
 * .git. Deleting the temp source first -- which is what this script used to do
 * -- leaves a checkout that can never be cleanly removed again. Two such
 * orphans were found on this host and had to be deleted by hand.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/herdr/herdr.fixtures');
const LABEL = 'ducky-mgd:probe';
const AGENT = 'ducky-pi-probe';
const HOME = os.homedir();

const WITH_AGENT = process.argv.includes('--with-agent');

/**
 * Everything that makes this run NOT a valid recording.
 *
 * Collected rather than logged, because the previous version printed each
 * problem and then exited 0 -- so a run that recorded no result file and no
 * phase file still looked like a successful contract capture.
 */
const failures = [];

const created = {
  /** Plain workspaces, closed with `workspace close`. */
  workspaces: [],
  /** Worktree-backed workspaces, removed with `worktree remove` FIRST. */
  worktreeWorkspaces: [],
  agentName: null,
  tmpDir: null,
  /** Set when a worktree could not be removed; the source must then be kept. */
  worktreeRemovalFailed: false,
};

/**
 * Extra parent budget on top of whatever wait the command itself was asked for.
 *
 * Mirrors `HERDR_PROMPT_GRACE_MS` in the adapter, for the same reason: a parent
 * timeout shorter than the child's requested wait kills a healthy wait and
 * reports it as a failure. This script asked `agent start` for 120s and
 * `agent prompt` for 300s while capping the child at 60s, so both were being
 * killed before they could succeed.
 */
const PARENT_GRACE_MS = 30_000;

/** Reads the `--timeout <ms>` the command is asking herdr for, if any. */
function requestedWaitMs(args) {
  const i = args.indexOf('--timeout');
  if (i < 0 || i + 1 >= args.length) return 0;
  const ms = Number(args[i + 1]);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    // Derived, never fixed: the parent must outlive the wait it is hosting.
    const timeout = opts.timeout ?? requestedWaitMs(args) + PARENT_GRACE_MS;
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, ...opts, timeout }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });

/**
 * Free-text fields that describe whatever ELSE is running on this machine.
 *
 * `agent list` returns every agent in the session, so a recorded fixture picks
 * up the titles of unrelated work -- and a terminal title is often a task
 * description, i.e. somebody's private prompt. None of these fields is used by
 * any schema, so blanking them costs the contract record nothing.
 */
const OPAQUE_KEYS = new Set([
  'terminal_title',
  'terminal_title_stripped',
  'title',
  'display_agent',
]);

/** Same spirit as the runtime redactor: never write a host path or a token. */
function redact(value, key) {
  if (typeof value === 'string') {
    if (key !== undefined && OPAQUE_KEYS.has(key)) return '[REDACTED:title]';
    return value
      .split(HOME).join('~')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED:guid]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[REDACTED:token]');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

/** Commands whose success is reported only by their exit code. */
async function herdrVoid(name, args) {
  const res = await run('herdr', args);
  if (res.code !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  // Redacted like every other fixture. This one recorded `res.stdout` RAW --
  // and an exit-code-only command is exactly the kind that prints an
  // unstructured line nobody predicted, so "it is normally empty" is not a
  // reason to skip the redactor on the way into a committed file.
  writeFileSync(
    path.join(FIXTURES, `${name}.json`),
    `${JSON.stringify(
      redact({
        _note: 'succeeds with an empty response body',
        exitCode: res.code,
        stdout: res.stdout,
      }),
      null,
      2,
    )}\n`,
  );
  console.log(`recorded ${name}.json (empty response)`);
}

async function herdr(name, args) {
  const res = await run('herdr', args);
  if (res.code !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`herdr ${args.join(' ')} did not return JSON`);
  }
  writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(redact(parsed), null, 2)}\n`);
  console.log(`recorded ${name}.json`);
  return parsed.result ?? parsed;
}

/**
 * Creates the throwaway repository.
 *
 * `created.tmpDir` is recorded IMMEDIATELY after mkdtemp and before any git
 * command, so a failure part-way through seeding still leaves a directory the
 * cleanup path knows about. It used to be recorded before the git calls too --
 * but the whole function ran before `main`'s try/finally, so a `git init` or
 * `git commit` failure left the temp directory on disk with nothing to remove
 * it.
 */
function seedRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-probe-'));
  created.tmpDir = dir;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ducky Probe', GIT_AUTHOR_EMAIL: 'probe@example.com',
    GIT_COMMITTER_NAME: 'Ducky Probe', GIT_COMMITTER_EMAIL: 'probe@example.com',
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  writeFileSync(path.join(dir, 'README.md'), '# ducky probe\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'probe baseline'], { cwd: dir, env });
  return dir;
}

/**
 * Removes only what this run created, in the only order that works.
 *
 * 1. worktrees, while their source repository still exists;
 * 2. plain workspaces;
 * 3. the temp source repository -- and ONLY if every worktree really went.
 *
 * Nothing here can touch a workspace this script did not create: the ids come
 * exclusively from our own responses.
 */
let cleanedUp = false;

async function cleanup() {
  // Runs from the `finally` AND from main()'s catch. Running the removals
  // twice turns "already gone" into a reported failure and strands the temp
  // repository, which is exactly what happened the first time this was tried.
  if (cleanedUp) return;
  cleanedUp = true;

  for (const id of created.worktreeWorkspaces.reverse()) {
    // `--force` is safe HERE and only here: this checkout lives under a temp
    // directory this script created and holds nothing but probe artefacts.
    // Production cleanup deliberately does not force, because a real job's
    // checkout holds the implementation and nothing has committed it.
    const res = await run('herdr', ['worktree', 'remove', '--workspace', id, '--force']);
    if (res.code === 0) {
      console.log(`cleanup worktree ${id}: removed`);
    } else {
      created.worktreeRemovalFailed = true;
      console.error(
        `cleanup worktree ${id}: FAILED -- ${(res.stderr || res.stdout).trim().slice(0, 200)}`,
      );
    }
  }

  for (const id of created.workspaces.reverse()) {
    const res = await run('herdr', ['workspace', 'close', id]);
    console.log(`cleanup workspace ${id}: ${res.code === 0 ? 'closed' : 'already gone'}`);
  }

  // Herdr groups checkouts as `~/.herdr/worktrees/<repo-name>/<label>` and
  // leaves the per-repo PARENT behind once the checkout is gone. In production
  // that directory is reused by the next job on the same repository and is
  // none of our business; here it is named after our temp repo, so it is our
  // litter and only ours.
  if (created.tmpDir && !created.worktreeRemovalFailed) {
    const parent = path.join(HOME, '.herdr', 'worktrees', path.basename(created.tmpDir));
    try {
      if (
        parent.startsWith(path.join(HOME, '.herdr', 'worktrees', 'ducky-probe-')) &&
        existsSync(parent) &&
        readdirSync(parent).length === 0
      ) {
        rmdirSync(parent);
        console.log('cleanup empty worktree parent removed');
      }
    } catch (err) {
      // Tidying is best-effort; it must never abort the removals that follow.
      console.error(`cleanup empty worktree parent: ${err.message}`);
    }
  }

  if (created.tmpDir) {
    if (created.worktreeRemovalFailed) {
      console.error(
        `cleanup temp repository KEPT at ${created.tmpDir.split(HOME).join('~')}: a worktree ` +
          'could not be removed, and deleting the source would strand its checkout forever. ' +
          'Remove the worktree by hand, then delete this directory.',
      );
    } else {
      rmSync(created.tmpDir, { recursive: true, force: true });
      console.log('cleanup temp repository removed');
    }
  }

  await assertNothingLeftBehind();
}

/** Proves the run left no trace, rather than assuming the commands worked. */
async function assertNothingLeftBehind() {
  const problems = [];

  const worktreeRoot = path.join(HOME, '.herdr', 'worktrees');
  if (existsSync(worktreeRoot)) {
    const leftovers = readdirSync(worktreeRoot).filter((d) => d.startsWith('ducky-probe-'));
    if (leftovers.length > 0) problems.push(`orphaned worktree checkouts: ${leftovers.join(', ')}`);
  }

  if (created.agentName) {
    const res = await run('herdr', ['agent', 'get', created.agentName]);
    if (res.code === 0) problems.push(`agent ${created.agentName} is still live`);
  }

  if (problems.length > 0) {
    console.error(`cleanup INCOMPLETE: ${problems.join('; ')}`);
    for (const p of problems) failures.push(`cleanup: ${p}`);
  } else {
    console.log('cleanup verified: no probe workspace, agent or worktree remains');
  }
}

async function main() {
  mkdirSync(FIXTURES, { recursive: true });

  const probe = await run('herdr', ['agent', 'list']);
  if (probe.code !== 0) {
    console.error('herdr is not reachable on this host; nothing was recorded.');
    console.error('The Herdr/Pi orchestrator stays EXPERIMENTAL until this probe succeeds.');
    process.exit(2);
  }

  // INSIDE the try, so a failure while seeding is cleaned up like any other.
  let repo;
  try {
    repo = seedRepo();
    console.log(`probe repository: ${repo.split(HOME).join('~')}`);

    await herdr('agent-list', ['agent', 'list']);
    await herdr('workspace-list', ['workspace', 'list']);

    const ws = await herdr('workspace-create', [
      'workspace', 'create', '--cwd', repo, '--label', LABEL, '--no-focus',
    ]);
    const workspaceId = ws?.workspace?.workspace_id;
    const rootPane = ws?.root_pane?.pane_id;
    if (workspaceId) created.workspaces.push(workspaceId);
    if (!workspaceId || !rootPane) throw new Error('workspace create returned no workspace/pane');

    await herdrVoid('workspace-report-metadata', [
      'workspace', 'report-metadata', workspaceId, '--source', 'ducky', '--token', 'owner=ducky',
    ]);
    await herdr('pane-split', [
      'pane', 'split', rootPane, '--direction', 'right', '--cwd', repo, '--no-focus',
    ]);

    const wt = await herdr('worktree-create', [
      'worktree', 'create', '--cwd', repo, '--branch', 'ducky/job-probe', '--base', 'main', '--no-focus',
    ]);
    const wtWorkspace = wt?.workspace?.workspace_id;
    // Recorded separately: a worktree-backed workspace needs `worktree remove`
    // BEFORE the source repository is deleted. `workspace close` alone leaves
    // the checkout behind, which is exactly how two orphans accumulated here.
    if (wtWorkspace) created.worktreeWorkspaces.push(wtWorkspace);
    const wtPane = wt?.root_pane?.pane_id;
    const wtPath = expandHome(wt?.worktree?.path ?? wt?.workspace?.worktree?.checkout_path);

    if (WITH_AGENT) {
      await probeAgent({ pane: wtPane, checkout: wtPath });
    } else {
      console.log('\nSkipped agent start/prompt (opt in with --with-agent).');
      console.log('Until they are recorded, `herdr agent start` and `agent prompt` stay UNVERIFIED');
      console.log('and HerdrPiOrchestrator.verified must remain false.');
    }

    console.log('\nFixtures recorded. Run `pnpm test` so the contract test parses them.');
    console.log('Only then may the Herdr/Pi orchestrator be reported as verified.');
  } finally {
    await cleanup();
  }
}

const expandHome = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

/**
 * The two commands the original probe could not cover, because they launch a
 * real Pi agent.
 *
 * The brief is deliberately the smallest thing that still exercises the real
 * contract: write one result file. Nothing is edited, built or committed, and
 * `--thinking minimal` keeps the model spend bounded.
 */
async function probeAgent({ pane, checkout }) {
  if (!pane) throw new Error('worktree create returned no root pane; cannot start an agent');
  console.log('\n--- agent stages (--with-agent) ---');

  const startedAt = Date.now();
  const started = await herdr('agent-start', [
    'agent', 'start', AGENT,
    '--kind', 'pi',
    '--pane', pane,
    '--timeout', '120000',
    '--', '--session-id', 'ducky-probe', '--thinking', 'minimal',
  ]);
  created.agentName = AGENT;
  console.log(`agent start took ${Date.now() - startedAt}ms; status=${started?.agent?.agent_status}`);

  const brief = [
    'This is an automated contract probe. Do NOT edit, build, commit or run anything.',
    '',
    'Perform exactly one action: write the file `.ducky/result.json` in this working',
    'directory with EXACTLY this content, then reply with the single word done.',
    '',
    '{',
    '  "schemaVersion": 1,',
    '  "verdict": "failed",',
    '  "summary": "contract probe: no work was performed",',
    '  "changedFiles": [],',
    '  "review": { "performed": false, "independent": false, "verdict": "skipped", "notes": "probe" },',
    '  "verification": { "commands": [], "passed": false },',
    '  "proposedActions": []',
    '}',
    '',
    'Also write the single word `verifying` into `.ducky/phase`.',
  ].join('\n');

  const promptedAt = Date.now();
  const prompted = await herdr('agent-prompt', [
    'agent', 'prompt', AGENT, brief, '--wait', '--timeout', '300000',
  ]);
  console.log(
    `agent prompt took ${Date.now() - promptedAt}ms; settled=${prompted?.agent?.agent_status}`,
  );

  await herdr('agent-get', ['agent', 'get', AGENT]);

  // The detail the original probe caught, re-checked on the agent path: the
  // result file lives in Herdr's checkout, not in the source repository.
  const resultPath = checkout ? path.join(checkout, '.ducky', 'result.json') : null;
  if (resultPath && existsSync(resultPath)) {
    console.log(`result file FOUND at <checkout>/.ducky/result.json (${readFileSync(resultPath, 'utf8').length} bytes)`);
    writeFileSync(
      path.join(FIXTURES, 'agent-result-file.json'),
      `${JSON.stringify(redact(JSON.parse(readFileSync(resultPath, 'utf8'))), null, 2)}\n`,
    );
    console.log('recorded agent-result-file.json');
  } else {
    console.error('result file NOT written by the agent; H4/H5 unresolved.');
    // A recorded contract with no result file is not a recorded contract: the
    // result file is the ONLY channel back from Pi, so this is a failure, not a
    // note. It used to be logged and then exited 0.
    failures.push('the agent wrote no result file');
  }

  const phasePath = checkout ? path.join(checkout, '.ducky', 'phase') : null;
  if (phasePath && existsSync(phasePath)) {
    console.log(`phase file FOUND: ${JSON.stringify(readFileSync(phasePath, 'utf8').trim())}`);
  } else {
    console.error('phase file NOT written by the agent; reviewing/verifying stay unobservable.');
    failures.push('the agent wrote no phase file');
  }
}

/**
 * ONE place decides the exit code.
 *
 * The old success path called `process.exit(0)` unconditionally, which threw
 * away the `exitCode = 3` that `assertNothingLeftBehind` had just set -- so a
 * run that leaked a workspace still reported success.
 *
 *   0  recorded cleanly and left nothing behind
 *   1  the probe itself threw
 *   2  herdr is not reachable (nothing was recorded)
 *   3  recorded, but evidence is missing or cleanup was incomplete
 */
main()
  .then(() => {
    if (failures.length === 0) {
      console.log('\nprobe OK: contract recorded and nothing left behind.');
      process.exit(0);
    }
    console.error('\nprobe NOT clean:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(3);
  })
  .catch(async (err) => {
    console.error(`probe failed: ${redactMessage(err.message)}`);
    await cleanup().catch(() => {});
    if (failures.length > 0) {
      console.error('additionally:');
      for (const f of failures) console.error(`  - ${f}`);
    }
    process.exit(1);
  });

/** A thrown message can quote a host path; fold it the same way fixtures are. */
const redactMessage = (m) => String(m ?? '').split(HOME).join('~');
