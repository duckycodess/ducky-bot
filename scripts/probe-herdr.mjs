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
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/herdr/herdr.fixtures');
const LABEL = 'ducky-mgd:probe';
const AGENT = 'ducky-pi-probe';
const HOME = os.homedir();

const created = { workspaces: [], agentStarted: false, tmpDir: null };

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });

/** Same spirit as the runtime redactor: never write a host path or a token. */
function redact(value) {
  if (typeof value === 'string') {
    return value
      .split(HOME).join('~')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED:guid]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[REDACTED:token]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

/** Commands whose success is reported only by their exit code. */
async function herdrVoid(name, args) {
  const res = await run('herdr', args);
  if (res.code !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  writeFileSync(
    path.join(FIXTURES, `${name}.json`),
    `${JSON.stringify({ _note: 'succeeds with an empty response body', exitCode: res.code, stdout: res.stdout }, null, 2)}\n`,
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

async function cleanup() {
  for (const id of created.workspaces.reverse()) {
    const res = await run('herdr', ['workspace', 'close', id]);
    console.log(`cleanup workspace ${id}: ${res.code === 0 ? 'closed' : 'already gone'}`);
  }
  if (created.tmpDir) {
    rmSync(created.tmpDir, { recursive: true, force: true });
    console.log('cleanup temp repository removed');
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

  const repo = seedRepo();
  console.log(`probe repository: ${repo.split(HOME).join('~')}`);

  try {
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
    if (wtWorkspace) created.workspaces.push(wtWorkspace);

    console.log('\nFixtures recorded. Run `pnpm test` so the contract test parses them.');
    console.log('Only then may the Herdr/Pi orchestrator be reported as verified.');
  } finally {
    await cleanup();
  }
}

main().catch(async (err) => {
  console.error(`probe failed: ${err.message}`);
  await cleanup().catch(() => {});
  process.exit(1);
});
