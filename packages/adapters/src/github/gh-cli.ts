import {
  DuckyError, GH_OWNER_RE, GH_REPO_RE, GH_TIMEOUT_MS,
  PrChecksSchema, PrListSchema, PrViewSchema, RepoViewSchema,
} from '@ducky/contracts';
import type { PrChecks, PrList, PrView, RepoView } from '@ducky/contracts';
import { runArgv } from '../process/run.js';
import { redact } from '../redaction/redact.js';
import type { GitHubReader, RepoRef } from './github.port.js';

export type GhOperation = 'repoView' | 'prList' | 'prView' | 'prChecks';

/**
 * The complete set of gh invocations this system can make. Callers pass an
 * operation name and a validated repo reference -- never argv. There is no
 * write verb anywhere in this table, and a test asserts that.
 */
export const GH_OPERATIONS: Readonly<
  Record<GhOperation, (ref: RepoRef, n?: number) => readonly string[]>
> = Object.freeze({
  repoView: (ref) => [
    'repo', 'view', `${ref.owner}/${ref.repo}`,
    '--json', 'name,defaultBranchRef,isPrivate,updatedAt',
  ],
  prList: (ref) => [
    'pr', 'list', '-R', `${ref.owner}/${ref.repo}`, '--state', 'open', '--limit', '20',
    '--json', 'number,title,state,isDraft,headRefName,updatedAt',
  ],
  prView: (ref, n) => [
    'pr', 'view', String(n), '-R', `${ref.owner}/${ref.repo}`,
    '--json', 'number,title,state,mergeable,reviewDecision',
  ],
  prChecks: (ref, n) => [
    'pr', 'checks', String(n), '-R', `${ref.owner}/${ref.repo}`,
    '--json', 'name,state,bucket',
  ],
});

/** Verbs that would mutate GitHub. Asserted absent from the table by a test. */
export const FORBIDDEN_GH_VERBS = [
  'create', 'edit', 'merge', 'close', 'comment', 'delete', 'review', 'ready', 'api',
  'reopen', 'lock', 'unlock', 'transfer', 'rename', 'sync', 'clone', 'fork',
] as const;

function assertRef(ref: RepoRef): void {
  if (!GH_OWNER_RE.test(ref.owner) || !GH_REPO_RE.test(ref.repo)) {
    throw new DuckyError('invalid_input', 'That repository is not configured for GitHub lookups.');
  }
}

export class GhCliReader implements GitHubReader {
  constructor(private readonly bin = 'gh', private readonly timeoutMs = GH_TIMEOUT_MS) {}

  private async run(op: GhOperation, ref: RepoRef, n?: number): Promise<unknown> {
    assertRef(ref);
    const build = GH_OPERATIONS[op];
    if (!build) throw new DuckyError('invalid_input', 'Unsupported GitHub lookup.');
    const argv = build(ref, n);

    const res = await runArgv(this.bin, argv, {
      timeoutMs: this.timeoutMs,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
      },
    });
    if (res.code !== 0) {
      // stderr can echo tokens or absolute paths; never surface it raw
      throw new DuckyError('not_found', `GitHub lookup failed: ${redact(res.stderr).slice(0, 200)}`);
    }
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new DuckyError('not_found', 'GitHub returned an unreadable response.');
    }
  }

  async repoView(ref: RepoRef): Promise<RepoView> {
    return RepoViewSchema.parse(await this.run('repoView', ref));
  }

  async prList(ref: RepoRef): Promise<PrList> {
    return PrListSchema.parse(await this.run('prList', ref));
  }

  async prView(ref: RepoRef, number: number): Promise<PrView> {
    return PrViewSchema.parse(await this.run('prView', ref, number));
  }

  async prChecks(ref: RepoRef, number: number): Promise<PrChecks> {
    return PrChecksSchema.parse(await this.run('prChecks', ref, number));
  }
}
