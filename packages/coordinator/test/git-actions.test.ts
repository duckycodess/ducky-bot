import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApprovalRow, HerdrWorkspaceRow, JobRow } from '@ducky/persistence';
import { GitActionPerformer } from '../src/domain/git-action-performer.js';
import { RepoAllowlist, RepoConfigSchema } from '../src/domain/allowlist.js';

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const contextFor = (cwd: string): {
  job: JobRow;
  approval: ApprovalRow;
  workspace: HerdrWorkspaceRow;
} => ({
  job: {
    id: 'job-1', publicId: 'jabcde', discordUserId: '100000000000000001', repoSlug: 'demo',
    task: 'change it', context: null, bootstrap: false, state: 'completed', workPhase: null,
    cancelRequested: false, attempts: 1, maxAttempts: 1, ownerInputRounds: 0,
    maxOwnerInputRounds: 3, recoveryRequired: false, leaseId: null, leaseExpiresAt: null,
    executorId: 'exec-a', retainedWorkspaceId: 'ws-1', originSharedChannelId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z',
  },
  approval: {
    id: 'approval-1', jobId: 'job-1', actionIndex: 0, actionKind: 'git_commit',
    description: 'commit the approved file',
    detailsJson: JSON.stringify({ message: 'feat: approved change', files: ['a.txt'] }),
    state: 'approved', expiresAt: '2099-01-01T00:00:00.000Z', decidedBy: 'owner',
    decidedAt: '2026-01-01T00:00:00.000Z', decisionReason: 'owner_approved',
  },
  workspace: {
    workspaceId: 'ws-1', repoSlug: 'demo', jobId: 'job-1', label: 'ducky-mgd-demo',
    mode: 'worktree', agentName: 'ducky-pi-demo', worktreePath: cwd, workspacePath: cwd,
    state: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
  },
});

describe('approved Git action performer', () => {
  it('commits only the exact files in the immutable proposal', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'ducky-git-action-'));
    try {
      runGit(cwd, 'init', '-q', '-b', 'main');
      runGit(cwd, 'config', 'user.email', 'ducky-test@example.invalid');
      runGit(cwd, 'config', 'user.name', 'Ducky Test');
      await writeFile(path.join(cwd, 'a.txt'), 'base\n');
      await writeFile(path.join(cwd, 'extra.txt'), 'base\n');
      runGit(cwd, 'add', '.');
      runGit(cwd, 'commit', '-q', '-m', 'baseline');
      await writeFile(path.join(cwd, 'a.txt'), 'changed\n');
      await writeFile(path.join(cwd, 'extra.txt'), 'unapproved\n');

      const allowlist = new RepoAllowlist([RepoConfigSchema.parse({
        slug: 'demo', absolutePath: cwd, defaultBranch: 'main', github: null,
        allowWorktree: true, allowBootstrap: false, bootstrapAllowedEntries: ['.git'], enabled: true,
      })]);
      const performer = new GitActionPerformer({ allowlist, enabled: true });
      await performer.perform('git_commit', {
        message: 'feat: approved change', files: ['a.txt'],
      }, contextFor(cwd));

      expect(runGit(cwd, 'show', '--format=%s', '--no-patch', 'HEAD')).toContain('feat: approved change');
      expect(runGit(cwd, 'show', '--format=', '--name-only', 'HEAD')).toContain('a.txt');
      expect(runGit(cwd, 'show', '--format=', '--name-only', 'HEAD')).not.toContain('extra.txt');
      expect(await readFile(path.join(cwd, 'extra.txt'), 'utf8')).toBe('unapproved\n');
      expect(runGit(cwd, 'status', '--porcelain')).toContain('extra.txt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a proposal for a file that is no longer changed', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'ducky-git-action-'));
    try {
      runGit(cwd, 'init', '-q', '-b', 'main');
      runGit(cwd, 'config', 'user.email', 'ducky-test@example.invalid');
      runGit(cwd, 'config', 'user.name', 'Ducky Test');
      await writeFile(path.join(cwd, 'a.txt'), 'base\n');
      runGit(cwd, 'add', '.');
      runGit(cwd, 'commit', '-q', '-m', 'baseline');
      const allowlist = new RepoAllowlist([RepoConfigSchema.parse({
        slug: 'demo', absolutePath: cwd, defaultBranch: 'main', github: null,
        allowWorktree: true, allowBootstrap: false, bootstrapAllowedEntries: ['.git'], enabled: true,
      })]);
      const performer = new GitActionPerformer({ allowlist, enabled: true });
      await expect(performer.perform('git_commit', {
        message: 'feat: approved change', files: ['a.txt'],
      }, contextFor(cwd))).rejects.toThrow(/no longer changed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
