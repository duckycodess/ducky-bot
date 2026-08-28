import path from 'node:path';
import {
  checkCommandAllowed, DuckyError, GIT_TIMEOUT_MS, GH_TIMEOUT_MS,
  isRepoRelativePath, ProposedActionSchema,
  type ApprovalActionKind, type CommandClass,
} from '@ducky/contracts';
import { runArgv, type RunResult } from '@ducky/adapters';
import type { HerdrWorkspaceRow } from '@ducky/persistence';
import type { ActionExecutionContext, ActionPerformer } from './action-performer.js';
import type { RepoAllowlist } from './allowlist.js';

/**
 * A concrete performer for the Phase 2 Git path.
 *
 * It is deliberately separate from approval recording. The caller must first
 * prove owner authorization, an unexpired approval, an unchanged proposal and
 * a durable workspace, then claim the approval-execution ledger. This class
 * only receives that already-validated context and still validates it again at
 * the command boundary.
 *
 * The performer is disabled by default. When enabled, it is intended for a
 * coordinator and executor that share the same filesystem (the development
 * topology). A production coordinator whose repository workspaces live on a
 * separate WSL host must route this operation through an executor before
 * enabling the flag; it must not point a cloud coordinator at arbitrary local
 * paths.
 */
export interface GitActionPerformerOptions {
  readonly allowlist: RepoAllowlist;
  readonly enabled: boolean;
  readonly run?: typeof runArgv;
}

export class GitActionPerformer implements ActionPerformer {
  readonly enabled: boolean;
  private readonly allowlist: RepoAllowlist;
  private readonly run: typeof runArgv;

  constructor(opts: GitActionPerformerOptions) {
    this.enabled = opts.enabled;
    this.allowlist = opts.allowlist;
    this.run = opts.run ?? runArgv;
  }

  async perform(
    kind: ApprovalActionKind,
    details: unknown,
    context?: ActionExecutionContext,
  ): Promise<void> {
    if (!this.enabled) {
      throw new DuckyError(
        'not_enabled_in_phase1',
        'Approved action execution is disabled. The decision is recorded.',
      );
    }
    if (!context) {
      throw new DuckyError('invalid_input', 'The approved action has no execution context.');
    }

    // This is a defense-in-depth parse. ApprovalsService compares the same
    // action against the immutable result snapshot before reaching us, but a
    // performer must not become a generic `(kind, unknown) -> shell` adapter if
    // another caller is added later.
    const action = ProposedActionSchema.safeParse({
      kind,
      description: context.approval.description,
      details,
    });
    if (!action.success) {
      throw new DuckyError('invalid_input', 'The approved action details are no longer valid.');
    }

    const repo = this.allowlist.resolve(context.job.repoSlug);
    const workspace = assertWorkspace(context);
    const cwd = workspace.workspacePath!;

    switch (action.data.kind) {
      case 'git_commit':
        await this.commit(cwd, action.data.details.message, action.data.details.files);
        return;
      case 'git_push':
        await this.push(cwd, action.data.details.remote, action.data.details.branch, repo.github);
        return;
      case 'github_pr':
        await this.pullRequest(
          cwd,
          action.data.details.title,
          action.data.details.body,
          action.data.details.base,
          action.data.details.head,
          repo.github,
        );
        return;
      default:
        // Issues, deployments and Azure mutations are not part of this
        // concrete local performer. They remain recorded-only rather than
        // being mistaken for a safe local Git operation.
        throw new DuckyError(
          'not_enabled_in_phase1',
          `Approved ${action.data.kind.replace(/_/g, ' ')} execution is not enabled.`,
        );
    }
  }

  private async commit(cwd: string, message: string, files: readonly string[]): Promise<void> {
    if (files.length === 0 || files.some((file) => !isSafeCommitPath(file))) {
      throw new DuckyError('invalid_input', 'The approved commit has no valid repository files.');
    }

    const status = await this.invoke('git', ['status', '--porcelain=v1', '--untracked-files=all'], cwd, 'read_only');
    const changed = parseStatusPaths(status.stdout);
    for (const file of files) {
      if (!changed.has(file)) {
        throw new DuckyError(
          'invalid_input',
          `The approved commit file \`${file}\` is no longer changed in the workspace.`,
        );
      }
    }

    // Stage and commit ONLY the exact allowlisted files in the immutable
    // approval. Extra workspace changes remain untouched and therefore cannot
    // hitch a ride on an approved commit.
    await this.invoke('git', ['add', '--', ...files], cwd, 'local_mutation');
    await this.invoke('git', ['commit', '--only', '-m', message, '--', ...files], cwd, 'local_mutation');
  }

  private async push(
    cwd: string,
    remote: 'origin',
    branch: string,
    github: { owner: string; repo: string } | null,
  ): Promise<void> {
    if (!github) {
      throw new DuckyError('invalid_input', 'The approved push has no configured GitHub repository.');
    }
    const current = await this.currentBranch(cwd);
    if (current !== branch) {
      throw new DuckyError(
        'invalid_input',
        `The workspace is on branch \`${current || 'detached'}\`, not the approved branch.`,
      );
    }
    const origin = await this.invoke('git', ['remote', 'get-url', remote], cwd, 'read_only');
    if (!matchesGitHubRemote(origin.stdout, github.owner, github.repo)) {
      throw new DuckyError('invalid_input', 'The configured origin is not the approved GitHub repository.');
    }

    // No force flag exists in this argv, and the command policy rejects it
    // again even for an approved external mutation.
    await this.invoke('git', ['push', remote, branch], cwd, 'external_mutation');
  }

  private async pullRequest(
    cwd: string,
    title: string,
    body: string,
    base: string,
    head: string,
    github: { owner: string; repo: string } | null,
  ): Promise<void> {
    if (!github) {
      throw new DuckyError('invalid_input', 'The approved pull request has no configured GitHub repository.');
    }
    if (base === head) {
      throw new DuckyError('invalid_input', 'A pull request base and head must be different.');
    }
    const current = await this.currentBranch(cwd);
    if (current !== head) {
      throw new DuckyError(
        'invalid_input',
        `The workspace is on branch \`${current || 'detached'}\`, not the approved head branch.`,
      );
    }

    // The repository is taken from the operator allowlist; title/body/base/head
    // came from the immutable, owner-approved action. No shell or URL supplied
    // by Discord is involved.
    await this.invoke(
      'gh',
      [
        'pr', 'create', '-R', `${github.owner}/${github.repo}`,
        '--base', base, '--head', head, '--title', title, '--body', body,
      ],
      cwd,
      'external_mutation',
    );
  }

  private async currentBranch(cwd: string): Promise<string> {
    const result = await this.invoke('git', ['branch', '--show-current'], cwd, 'read_only');
    return result.stdout.trim();
  }

  private async invoke(
    bin: string,
    argv: readonly string[],
    cwd: string,
    maxClass: CommandClass,
  ): Promise<RunResult> {
    const refusal = checkCommandAllowed(bin, argv, maxClass);
    if (refusal) {
      throw new DuckyError('not_enabled_in_phase1', refusal.detail);
    }
    const result = await this.run(bin, argv, {
      cwd,
      timeoutMs: bin === 'gh' ? GH_TIMEOUT_MS : GIT_TIMEOUT_MS,
      ...(maxClass === 'external_mutation'
        ? {
            env: {
              ...process.env,
              ...(bin === 'gh'
                ? { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
                : { GIT_TERMINAL_PROMPT: '0' }),
            },
          }
        : {}),
    });
    if (result.code !== 0) {
      // Never surface command output: it can contain paths, remote URLs or
      // credential-helper diagnostics. The audit/service layer records only a
      // fixed failure category.
      throw new DuckyError(
        'invalid_input',
        `The approved ${bin} action failed. Inspect the job and workspace for the command result.`,
      );
    }
    return result;
  }
}

function assertWorkspace(context: ActionExecutionContext): HerdrWorkspaceRow {
  const workspace = context.workspace;
  if (!workspace || workspace.jobId !== context.job.id || workspace.repoSlug !== context.job.repoSlug) {
    throw new DuckyError('invalid_input', 'The approved action has no matching Ducky workspace.');
  }
  if (workspace.closedAt !== null || workspace.workspacePath === null) {
    throw new DuckyError('invalid_input', 'The approved action workspace is no longer available.');
  }
  if (
    !path.isAbsolute(workspace.workspacePath) ||
    path.normalize(workspace.workspacePath) !== workspace.workspacePath ||
    /[\u0000-\u001f\u007f]/.test(workspace.workspacePath)
  ) {
    throw new DuckyError('invalid_input', 'The approved action workspace path is invalid.');
  }
  return workspace;
}

/**
 * Parses the stable porcelain-v1 status form. Renames and quoted paths are
 * rejected rather than guessed, because committing the wrong side of a rename
 * is worse than asking the owner to re-propose the action.
 */
function isSafeCommitPath(file: string): boolean {
  // A proposed `.git` path could expose repository metadata or credential
  // configuration. Git normally does not report it as a worktree file, but
  // rejecting it here keeps the approval surface safe if that ever changes.
  return isRepoRelativePath(file) && file !== '.git' && !file.startsWith('.git/');
}

function parseStatusPaths(raw: string): Set<string> {
  const out = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue;
    if (line.length < 4 || line.includes('"') || line.slice(2, 3) !== ' ') {
      throw new DuckyError('invalid_input', 'The workspace has a Git status shape this action cannot verify.');
    }
    const file = line.slice(3);
    if (file.includes(' -> ') || !isRepoRelativePath(file)) {
      throw new DuckyError('invalid_input', 'The workspace reported an unsafe Git path.');
    }
    out.add(file);
  }
  return out;
}

function matchesGitHubRemote(raw: string, owner: string, repo: string): boolean {
  const value = raw.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const expected = `${owner}/${repo}`.toLowerCase();
  const forms = [
    `https://github.com/${expected}`,
    `http://github.com/${expected}`,
    `git@github.com:${expected}`,
    `ssh://git@github.com/${expected}`,
  ];
  return forms.includes(value.toLowerCase());
}
