import { readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DuckyError, GIT_TIMEOUT_MS, checkCommandAllowed, type JobPayload } from '@ducky/contracts';
import { runArgv } from '@ducky/adapters';

export interface ResolvedWorkspace {
  readonly mode: 'worktree' | 'direct';
  readonly repoPath: string;
  readonly branch: string;
  readonly base: string;
}

const GIT_STATE_FILES = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'rebase-merge',
];

/**
 * Every git invocation in the executor.
 *
 * The central command policy is consulted before the subprocess starts, so a
 * read-only workspace inspection cannot quietly grow a `reset`, a `clean` or a
 * `push`: those verbs are refused outright, and anything not classified at all
 * is refused too. `runArgv` already forbids a shell string; this forbids the
 * argv itself.
 */
async function git(cwd: string, args: readonly string[]) {
  const refusal = checkCommandAllowed('git', args);
  if (refusal) throw new DuckyError('not_enabled_in_phase1', refusal.detail);
  return runArgv('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

/**
 * Decides how a job may touch a repository, entirely before Herdr is involved.
 *
 * Every check fails closed with a message the owner can act on. In particular a
 * bootstrap job refuses to run in a directory that holds anything unexpected,
 * so unrelated files can never be overwritten or discarded.
 */
export async function resolveWorkspace(payload: JobPayload, publicId: string): Promise<ResolvedWorkspace> {
  const repoPath = assertContainedDirectory(payload.absolutePath);
  await assertExpectedOrigin(repoPath, payload);

  const head = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const hasBaseline = head.code === 0 && head.stdout.trim() !== '';

  if (!hasBaseline) {
    if (!payload.bootstrap || !payload.allowBootstrap) {
      throw new DuckyError(
        'repo_not_initialized',
        `\`${payload.repoSlug}\` has no git baseline. Automated worktree jobs require an initialized ` +
          'repository; submit with `bootstrap:true` if this is a greenfield checkout.',
      );
    }
    await assertBootstrapClean(repoPath, payload);
    return { mode: 'direct', repoPath, branch: 'main', base: 'HEAD' };
  }

  // A bootstrap request against an already-initialised repository is a
  // mismatch worth saying out loud rather than silently running as a normal job.
  if (payload.bootstrap) {
    throw new DuckyError(
      'repo_already_initialized',
      `\`${payload.repoSlug}\` already has commits; submit it as a normal job instead of a bootstrap.`,
    );
  }

  if (!payload.allowWorktree) {
    throw new DuckyError(
      'repo_not_allowed',
      `\`${payload.repoSlug}\` is initialized but is not configured to allow worktree jobs.`,
    );
  }

  // Opt-in, and after every refusal above: nothing reaches the network until
  // the checkout has been proved to be the right repository in a usable state.
  const fetched = await fetchIfRequested(repoPath, payload);
  const base = await resolveBaseRef(repoPath, payload, fetched);
  const branch = `ducky/job-${publicId}`;
  const existing = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (existing.code === 0 && existing.stdout.trim() !== '') {
    throw new DuckyError(
      'branch_already_exists',
      `Branch \`${branch}\` already exists in \`${payload.repoSlug}\`.`,
    );
  }

  return { mode: 'worktree', repoPath, branch, base };
}

function assertContainedDirectory(configured: string): string {
  if (!path.isAbsolute(configured)) {
    throw new DuckyError('repo_not_allowed', 'That repository path is not absolute.');
  }
  if (!existsSync(configured)) {
    throw new DuckyError('repo_not_allowed', 'That repository path does not exist.');
  }
  const real = realpathSync(configured);
  if (real !== path.resolve(configured)) {
    // A symlinked repo root would let the configured path point elsewhere.
    throw new DuckyError('repo_not_allowed', 'That repository path resolves somewhere else.');
  }
  if (!statSync(real).isDirectory()) {
    throw new DuckyError('repo_not_allowed', 'That repository path is not a directory.');
  }
  return real;
}

/**
 * The checkout has to be the repository the operator MEANT.
 *
 * A path that exists and contains a `.git` used to be the whole test, and with
 * one host and one checkout per slug that was very nearly enough. It stops
 * being enough as soon as the same logical slug is checked out on several
 * hosts: a stale placement, a copy-pasted path, a directory somebody moved,
 * and the executor is pointing a real agent with edit capability at somebody
 * else's code.
 *
 * So when configuration says which GitHub repository a slug IS, the remote is
 * checked against it. The claim comes from operator configuration and is used
 * only to REFUSE -- it grants nothing and authorizes nothing.
 *
 * A repository with no GitHub mapping is not refused: plenty of real
 * repositories have no remote at all, and inventing a requirement would break
 * every local-only checkout for no safety gain.
 */
async function assertExpectedOrigin(repoPath: string, payload: JobPayload): Promise<void> {
  if (!payload.github) return;

  const res = await git(repoPath, ['remote', 'get-url', 'origin']);
  const url = res.stdout.trim();
  if (res.code !== 0 || url === '') {
    throw new DuckyError(
      'repo_not_allowed',
      `\`${payload.repoSlug}\` is configured as \`${payload.github.owner}/${payload.github.repo}\` ` +
        'on GitHub, but the checkout on this host has no `origin` remote. Refusing rather than ' +
        'assuming it is the right repository.',
    );
  }

  const actual = parseGitHubRemote(url);
  const expected = `${payload.github.owner}/${payload.github.repo}`.toLowerCase();
  if (actual === null || actual !== expected) {
    // The URL is deliberately NOT echoed: it can carry a username, and the
    // owner already knows what they configured. What they need is which host
    // disagrees, not a string to compare by eye.
    throw new DuckyError(
      'repo_not_allowed',
      `\`${payload.repoSlug}\` is configured as \`${expected}\`, but the checkout on this ` +
        'host has a different `origin`. Refusing: this is not the repository the job was ' +
        'submitted for.',
    );
  }
}

/**
 * `owner/repo`, lowercased, from either remote URL form GitHub hands out.
 *
 * Both `https://github.com/o/r.git` and `git@github.com:o/r.git` are ordinary;
 * anything that is not recognisably a GitHub remote returns null and is
 * refused by the caller rather than guessed at.
 */
function parseGitHubRemote(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(
      url,
    );
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null;
}

/**
 * Bring remote-tracking refs up to date, when the repository asked for it.
 *
 * Off unless a repository opts in, because this is the only step in workspace
 * resolution that touches the network. It exists for the host that is NOT
 * where the owner works: an Azure executor's checkout is exactly as current as
 * its last fetch, and branching from a week-old `main` produces a diff nobody
 * asked for and a review full of noise.
 *
 * A fetch FAILURE is not fatal. The network is not a precondition for doing
 * work in a checkout that already exists, and failing the job here would turn
 * a transient outage into a lost job. The caller is told, and falls back to
 * the local ref.
 */
async function fetchIfRequested(repoPath: string, payload: JobPayload): Promise<boolean> {
  if (!payload.fetchBeforeJob || !payload.defaultBranch) return false;
  const res = await git(repoPath, ['fetch', '--quiet', 'origin', payload.defaultBranch]);
  return res.code === 0;
}

/** Resolve, then verify, the base ref -- before any Herdr call is made. */
async function resolveBaseRef(
  repoPath: string,
  payload: JobPayload,
  fetched: boolean,
): Promise<string> {
  const candidates: string[] = [];
  // A successful fetch makes the remote-tracking ref the freshest thing here,
  // and it is preferred ONLY then: `origin/main` after a failed fetch is just
  // an older local copy wearing a more convincing name.
  if (fetched && payload.defaultBranch) candidates.push(`origin/${payload.defaultBranch}`);
  if (payload.defaultBranch) candidates.push(payload.defaultBranch);
  else {
    const originHead = await git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (originHead.code === 0 && originHead.stdout.trim()) {
      candidates.push(originHead.stdout.trim().replace(/^refs\/remotes\//, ''));
    }
    candidates.push('HEAD');
  }

  for (const ref of candidates) {
    const check = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (check.code === 0 && check.stdout.trim() !== '') return ref;
  }

  throw new DuckyError(
    'base_ref_not_found',
    `Base ref \`${candidates[0] ?? 'HEAD'}\` does not exist in \`${payload.repoSlug}\`.`,
  );
}

/**
 * A bootstrap directory must be empty apart from an explicitly allowed set
 * (by default just `.git`), have no commits, no pending changes, no stash and
 * no in-progress operation. Anything else is rejected, so DIRECT mode can never
 * touch work that is already there.
 */
async function assertBootstrapClean(repoPath: string, payload: JobPayload): Promise<void> {
  const allowed = new Set(payload.bootstrapAllowedEntries);
  const entries = readdirSync(repoPath).filter((e) => !allowed.has(e));
  if (entries.length > 0) {
    const names = entries.slice(0, 10).join(', ');
    throw new DuckyError(
      'bootstrap_directory_not_empty',
      `\`${payload.repoSlug}\` is not empty (${entries.length} unexpected entr${
        entries.length === 1 ? 'y' : 'ies'
      }: ${names}). Bootstrap refuses to touch a directory that already has content.`,
    );
  }

  if (!existsSync(path.join(repoPath, '.git'))) return; // truly empty directory

  const head = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code === 0 && head.stdout.trim() !== '') {
    throw new DuckyError(
      'repo_already_initialized',
      `\`${payload.repoSlug}\` already has commits; submit it as a normal job instead of a bootstrap.`,
    );
  }

  // An explicitly allowlisted entry is expected to be there, so it does not
  // count as the directory being dirty; anything else does.
  const status = await git(repoPath, ['status', '--porcelain']);
  const dirty = status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((p) => p !== '')
    .filter((p) => !allowed.has(p.split('/')[0] ?? p));
  if (dirty.length > 0) {
    throw new DuckyError(
      'bootstrap_directory_not_empty',
      `\`${payload.repoSlug}\` has uncommitted changes; bootstrap refuses to run there.`,
    );
  }

  const stash = await git(repoPath, ['stash', 'list']);
  if (stash.stdout.trim() !== '') {
    throw new DuckyError(
      'bootstrap_directory_not_empty',
      `\`${payload.repoSlug}\` has stashed changes; bootstrap refuses to run there.`,
    );
  }

  for (const marker of GIT_STATE_FILES) {
    if (existsSync(path.join(repoPath, '.git', marker))) {
      throw new DuckyError(
        'bootstrap_directory_not_empty',
        `\`${payload.repoSlug}\` has an in-progress git operation; resolve it first.`,
      );
    }
  }

  const worktrees = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const count = worktrees.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
  if (count > 1) {
    throw new DuckyError(
      'bootstrap_directory_not_empty',
      `\`${payload.repoSlug}\` has additional git worktrees; bootstrap refuses to run there.`,
    );
  }
}
