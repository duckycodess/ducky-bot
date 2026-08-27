import { readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DuckyError, GIT_TIMEOUT_MS, type JobPayload } from '@ducky/contracts';
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

async function git(cwd: string, args: readonly string[]) {
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

  const base = await resolveBaseRef(repoPath, payload);
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

/** Resolve, then verify, the base ref -- before any Herdr call is made. */
async function resolveBaseRef(repoPath: string, payload: JobPayload): Promise<string> {
  const candidates: string[] = [];
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
