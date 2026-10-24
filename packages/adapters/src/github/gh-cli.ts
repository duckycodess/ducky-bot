import {
  CommitsPageSchema, DuckyError, FeedPrChecksSchema, GH_OWNER_RE, GH_REPO_RE, GH_REVIEW_SEARCH_FIELDS,
  GH_REVIEW_SEARCH_QUERY, GH_TIMEOUT_MS, GITHUB_FEED_LIST_LIMIT, GITHUB_FEED_MAX_REVIEW_REQUESTS,
  IssueListSchema, PrChecksSchema, PrListSchema, PrReviewsSchema, PrViewSchema, RepoViewSchema,
  ReviewRequestSearchSchema, WorkflowRunsSchema,
  checkCommandAllowed, commitsEndpoint,
} from '@ducky/contracts';
import type {
  CommitsPage, FeedPrChecks, IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, ReviewRequestSearch,
  WorkflowRuns,
} from '@ducky/contracts';
import { runArgv } from '../process/run.js';
import { redact } from '../redaction/redact.js';
import type { GitHubReader, RepoRef } from './github.port.js';

export type GhOperation =
  | 'repoView' | 'prList' | 'prView' | 'prChecks'
  // Added by the final milestone. Every one is a READ, and every field selector
  // in it was recorded from `gh` itself by `pnpm probe:gh` rather than guessed.
  | 'prListAll' | 'prReviews' | 'runList' | 'issueList'
  // The GitHub feed's bounded lists: open items only, newest first, each with
  // the fields that give an event a stable identity (created time, reviews,
  // rerun attempt).
  | 'feedPrList' | 'feedIssueList' | 'feedRunList' | 'feedPrChecks';

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

  /**
   * Open AND recently closed pull requests, so a watch can see a MERGE.
   *
   * `--state all` with a small limit rather than a second call: a merge is the
   * disappearance of an open PR, which the open-only list could only ever report
   * as "it is gone".
   *
   * `createdAt` is a field `gh pr list --json` already lists (`pnpm probe:gh` records it, the feed's own
   * list selects it). It is read only to PROVE an opening against the watch's last read boundary; it adds
   * no verb, flag, endpoint or authority to this argv.
   */
  prListAll: (ref) => [
    'pr', 'list', '-R', `${ref.owner}/${ref.repo}`, '--state', 'all', '--limit', '20',
    '--json', 'number,title,state,isDraft,headRefName,headRefOid,updatedAt,mergedAt,reviewDecision,createdAt',
  ],

  /**
   * The review surface of one pull request: approvals, requested changes, review
   * comments, and the commits under review.
   */
  prReviews: (ref, n) => [
    'pr', 'view', String(n), '-R', `${ref.owner}/${ref.repo}`,
    '--json', 'number,title,state,headRefOid,reviewDecision,mergedAt,reviews,latestReviews,reviewRequests,comments,commits',
  ],

  /** Workflow runs: failures, and the recovery that follows one. */
  runList: (ref) => [
    'run', 'list', '-R', `${ref.owner}/${ref.repo}`, '--limit', '10',
    '--json', 'databaseId,number,workflowName,displayTitle,headBranch,headSha,event,status,conclusion,createdAt,updatedAt',
  ],

  /** Issue updates, bounded and open-only: a closed backlog is not news. */
  issueList: (ref) => [
    'issue', 'list', '-R', `${ref.owner}/${ref.repo}`, '--state', 'open', '--limit', '20',
    '--json', 'number,title,state,stateReason,updatedAt,labels',
  ],
  feedPrList: (ref) => [
    'pr', 'list', '-R', `${ref.owner}/${ref.repo}`, '--state', 'open',
    '--limit', String(GITHUB_FEED_LIST_LIMIT),
    '--json',
    'number,title,state,isDraft,author,createdAt,updatedAt,headRefName,headRefOid,reviewDecision,latestReviews',
  ],
  feedIssueList: (ref) => [
    'issue', 'list', '-R', `${ref.owner}/${ref.repo}`, '--state', 'open',
    '--limit', String(GITHUB_FEED_LIST_LIMIT),
    '--json', 'number,title,state,author,createdAt,updatedAt,labels',
  ],
  /**
   * The checks on ONE pull request, external CI included. Every selector is one
   * the installed `gh` lists (`pnpm probe:gh`); the call reuses the same read
   * access as every other lookup and asks for nothing broader.
   */
  feedPrChecks: (ref, n) => [
    'pr', 'checks', String(n), '-R', `${ref.owner}/${ref.repo}`,
    '--json', 'name,state,bucket,link,workflow,startedAt,completedAt',
  ],
  feedRunList: (ref) => [
    'run', 'list', '-R', `${ref.owner}/${ref.repo}`, '--limit', String(GITHUB_FEED_LIST_LIMIT),
    '--json',
    'databaseId,attempt,workflowName,displayTitle,headBranch,headSha,event,status,conclusion,createdAt,updatedAt',
  ],
});

/**
 * The review-request search: not scoped to a repository, so not in the table
 * above, whose builders all take one. One fixed argv; the central policy
 * re-checks that exact shape (`isReviewSearchArgv`) before it can run.
 */
export const GH_SEARCH_OPERATIONS: Readonly<Record<'reviewRequests', () => readonly string[]>> =
  Object.freeze({
    reviewRequests: () => [
      'search', 'prs', GH_REVIEW_SEARCH_QUERY, '--state', 'open',
      '--sort', 'updated', '--order', 'desc',
      '--limit', String(GITHUB_FEED_MAX_REVIEW_REQUESTS),
      '--json', GH_REVIEW_SEARCH_FIELDS,
    ],
  });

/**
 * The ONE `gh api` call this system can make: a GET of a branch's commits.
 *
 * `api` is on `FORBIDDEN_GH_VERBS` and stays there -- the argv-table tests still
 * assert that no operation in `GH_OPERATIONS` contains it. This table is the
 * single, named exemption, and it is exempt from nothing else: the endpoint is
 * built by `commitsEndpoint` (which throws on an invalid owner, repo, branch or
 * page) and the policy gate re-parses the finished argv from scratch.
 */
export const GH_API_OPERATIONS: Readonly<
  Record<'commits', (ref: RepoRef, branch: string, page: number) => readonly string[]>
> = Object.freeze({
  commits: (ref, branch, page) => [
    'api', '--method', 'GET', commitsEndpoint(ref.owner, ref.repo, branch, page),
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
    return this.exec(build(ref, n));
  }

  private async exec(argv: readonly string[]): Promise<unknown> {
    const res = await this.execRaw(argv);
    if (res.code !== 0) {
      // stderr can echo tokens or absolute paths; never surface it raw
      throw new DuckyError('not_found', `GitHub lookup failed: ${redact(res.stderr).slice(0, 200)}`);
    }
    return this.parse(res.stdout);
  }

  private parse(stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new DuckyError('not_found', 'GitHub returned an unreadable response.');
    }
  }

  /** Policy-checked, spawned, and NOT yet judged on its exit code. */
  private async execRaw(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    // The frozen table decides what can be CONSTRUCTED; the central policy
    // decides whether what was constructed may RUN in this phase. Two
    // independent gates, so adding a write verb to the table above still does
    // not reach a subprocess.
    const refusal = checkCommandAllowed('gh', argv);
    if (refusal) throw new DuckyError('not_enabled_in_phase1', refusal.detail);

    const res = await runArgv(this.bin, argv, {
      timeoutMs: this.timeoutMs,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
      },
    });
    return res;
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

  async prListAll(ref: RepoRef): Promise<PrList> {
    return PrListSchema.parse(await this.run('prListAll', ref));
  }

  async prReviews(ref: RepoRef, number: number): Promise<PrReviews> {
    return PrReviewsSchema.parse(await this.run('prReviews', ref, number));
  }

  async runList(ref: RepoRef): Promise<WorkflowRuns> {
    return WorkflowRunsSchema.parse(await this.run('runList', ref));
  }

  async issueList(ref: RepoRef): Promise<IssueList> {
    return IssueListSchema.parse(await this.run('issueList', ref));
  }

  async feedPrList(ref: RepoRef): Promise<PrList> {
    return PrListSchema.parse(await this.run('feedPrList', ref));
  }

  async feedIssueList(ref: RepoRef): Promise<IssueList> {
    return IssueListSchema.parse(await this.run('feedIssueList', ref));
  }

  /**
   * The checks on one pull request.
   *
   * `gh pr checks` has two exit behaviours that are NOT failures of the read:
   * a pull request with no checks at all exits non-zero with a "no checks
   * reported" message (observed live), and the CLI documents exit code 8 for
   * pending checks. So a non-zero exit is trusted as an answer only when stdout
   * is a JSON list, or the message says there are no checks; anything else is a
   * real failure and throws.
   */
  async feedPrChecks(ref: RepoRef, number: number): Promise<FeedPrChecks> {
    assertRef(ref);
    if (!Number.isInteger(number) || number <= 0) {
      throw new DuckyError('invalid_input', 'That pull request number is not valid.');
    }
    const res = await this.execRaw(GH_OPERATIONS.feedPrChecks(ref, number));
    if (res.code === 0) return FeedPrChecksSchema.parse(this.parse(res.stdout));
    const body = res.stdout.trim();
    if (body.startsWith('[')) return FeedPrChecksSchema.parse(this.parse(body));
    if (/no checks reported/i.test(res.stderr)) return [];
    throw new DuckyError('not_found', `GitHub lookup failed: ${redact(res.stderr).slice(0, 200)}`);
  }

  async feedRunList(ref: RepoRef): Promise<WorkflowRuns> {
    return WorkflowRunsSchema.parse(await this.run('feedRunList', ref));
  }

  async reviewRequests(): Promise<ReviewRequestSearch> {
    return ReviewRequestSearchSchema.parse(await this.exec(GH_SEARCH_OPERATIONS.reviewRequests()));
  }

  async commits(ref: RepoRef, branch: string, page: number): Promise<CommitsPage> {
    assertRef(ref);
    let argv: readonly string[];
    try {
      argv = GH_API_OPERATIONS.commits(ref, branch, page);
    } catch {
      throw new DuckyError('invalid_input', 'That commit lookup is not allowed.');
    }
    return CommitsPageSchema.parse(await this.exec(argv));
  }
}
