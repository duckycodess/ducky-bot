import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobPayload } from '@ducky/contracts';
import { resolveWorkspace } from '../src/workspace.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'ducky-ws-'));

const payload = (absolutePath: string, over: Partial<JobPayload> = {}): JobPayload => ({
  repoSlug: 'demo',
  absolutePath,
  defaultBranch: null,
  task: 'do it',
  context: null,
  bootstrap: false,
  allowWorktree: true,
  allowBootstrap: true,
  bootstrapAllowedEntries: ['.git'],
  maxOwnerInputRounds: 3,
  recoveryRequired: false,
  ownerInputRounds: 0,
  ...over,
});

function initRepo(withCommit: boolean): string {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  if (withCommit) {
    writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

describe('worktree mode', () => {
  it('uses a worktree once a baseline exists and resolves the base ref', async () => {
    const dir = initRepo(true);
    const resolved = await resolveWorkspace(payload(dir, { defaultBranch: 'main' }), 'jabcde');
    expect(resolved.mode).toBe('worktree');
    expect(resolved.base).toBe('main');
    expect(resolved.branch).toBe('ducky/job-jabcde');
  });

  it('falls back to HEAD when no default branch is configured', async () => {
    const dir = initRepo(true);
    const resolved = await resolveWorkspace(payload(dir), 'jabcde');
    expect(resolved.base).toBe('HEAD');
  });

  it('rejects a configured base ref that does not exist, before touching Herdr', async () => {
    const dir = initRepo(true);
    await expect(
      resolveWorkspace(payload(dir, { defaultBranch: 'does-not-exist' }), 'jabcde'),
    ).rejects.toThrow(/Base ref .* does not exist/);
  });

  it('rejects a colliding job branch', async () => {
    const dir = initRepo(true);
    git(dir, 'branch', 'ducky/job-jabcde');
    await expect(resolveWorkspace(payload(dir, { defaultBranch: 'main' }), 'jabcde')).rejects.toThrow(
      /already exists/,
    );
  });

  it('leaves a dirty main working tree untouched', async () => {
    const dir = initRepo(true);
    writeFileSync(path.join(dir, 'work-in-progress.txt'), 'do not lose me\n');
    const before = git(dir, 'status', '--porcelain');
    await resolveWorkspace(payload(dir, { defaultBranch: 'main' }), 'jabcde');
    expect(git(dir, 'status', '--porcelain')).toBe(before);
  });

  it('refuses a worktree job for a repo that disallows it', async () => {
    const dir = initRepo(true);
    await expect(
      resolveWorkspace(payload(dir, { defaultBranch: 'main', allowWorktree: false }), 'jabcde'),
    ).rejects.toThrow(/not configured to allow worktree/);
  });
});

describe('bootstrap mode is fail-closed', () => {
  it('accepts an empty directory and a bare freshly-initialised repo', async () => {
    const empty = tmp();
    expect((await resolveWorkspace(payload(empty, { bootstrap: true }), 'jabcde')).mode).toBe('direct');

    const bare = initRepo(false);
    expect((await resolveWorkspace(payload(bare, { bootstrap: true }), 'jabcde')).mode).toBe('direct');
  });

  it('rejects an uninitialised repo when bootstrap was not requested', async () => {
    const dir = initRepo(false);
    await expect(resolveWorkspace(payload(dir), 'jabcde')).rejects.toThrow(/no git baseline/);
  });

  it('rejects bootstrap when the repository does not allow it', async () => {
    const dir = initRepo(false);
    await expect(
      resolveWorkspace(payload(dir, { bootstrap: true, allowBootstrap: false }), 'jabcde'),
    ).rejects.toThrow(/no git baseline/);
  });

  it('refuses a directory that holds anything unexpected, and changes nothing', async () => {
    for (const extra of ['notes.txt', '.env', 'node_modules']) {
      const dir = tmp();
      git(dir, 'init', '-q', '-b', 'main');
      if (extra === 'node_modules') mkdirSync(path.join(dir, extra));
      else writeFileSync(path.join(dir, extra), 'precious\n');

      await expect(
        resolveWorkspace(payload(dir, { bootstrap: true }), 'jabcde'),
        extra,
      ).rejects.toThrow(/not empty/);
      // the file is still there, untouched
      expect(() => execFileSync('ls', [path.join(dir, extra)])).not.toThrow();
    }
  });

  it('refuses a directory that already has commits', async () => {
    const dir = initRepo(true);
    await expect(resolveWorkspace(payload(dir, { bootstrap: true }), 'jabcde')).rejects.toThrow(
      /already has commits/,
    );
  });

  it('refuses a repo with staged changes or an in-progress operation', async () => {
    const staged = initRepo(false);
    writeFileSync(path.join(staged, 'a.txt'), 'x');
    git(staged, 'add', 'a.txt');
    await expect(
      resolveWorkspace(payload(staged, { bootstrap: true }), 'jabcde'),
    ).rejects.toThrow(/not empty/);

    // Even inside an allowlisted directory, pending changes are rejected.
    const dirtyInAllowed = initRepo(false);
    mkdirSync(path.join(dirtyInAllowed, 'seed'));
    writeFileSync(path.join(dirtyInAllowed, 'seed', 'a.txt'), 'x');
    git(dirtyInAllowed, 'add', 'seed/a.txt');
    await expect(
      resolveWorkspace(
        payload(dirtyInAllowed, { bootstrap: true, bootstrapAllowedEntries: ['.git'] }),
        'jabcde',
      ),
    ).rejects.toThrow(/not empty/);

    const merging = initRepo(false);
    writeFileSync(path.join(merging, '.git', 'MERGE_HEAD'), 'deadbeef');
    await expect(
      resolveWorkspace(payload(merging, { bootstrap: true }), 'jabcde'),
    ).rejects.toThrow(/in-progress git operation/);
  });

  it('honours a configured entry allowlist', async () => {
    const dir = tmp();
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    await expect(resolveWorkspace(payload(dir, { bootstrap: true }), 'jabcde')).rejects.toThrow(/not empty/);
    const resolved = await resolveWorkspace(
      payload(dir, { bootstrap: true, bootstrapAllowedEntries: ['.git', '.gitignore'] }),
      'jabcde',
    );
    expect(resolved.mode).toBe('direct');
  });
});

describe('path containment', () => {
  it('rejects a relative or missing path', async () => {
    await expect(resolveWorkspace(payload('relative/path'), 'jabcde')).rejects.toThrow(/not absolute/);
    await expect(resolveWorkspace(payload('/nope/does/not/exist'), 'jabcde')).rejects.toThrow(
      /does not exist/,
    );
  });
});
