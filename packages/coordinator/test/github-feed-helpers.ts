import type {
  CommitsPage, FeedPrChecks, IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, ReviewRequestSearch,
  WorkflowRuns,
} from '@ducky/contracts';
import type { GitHubReader, RepoRef } from '@ducky/adapters';
import type { OutboundMessage, SendTarget } from '../src/discord/message.js';

export const key = (ref: RepoRef): string => `${ref.owner}/${ref.repo}`.toLowerCase();

export const sha = (n: number): string => n.toString(16).padStart(40, '0');

/**
 * A scriptable `GitHubReader` for the feed.
 *
 * Every default is EMPTY, never helpful, and every read can be made to fail,
 * per operation and per repository. That second part is the one that matters:
 * the properties under test are about what happens when GitHub is partly
 * unreachable, and a stub that cannot fail can only ever show the happy path.
 */
export class FeedReader implements GitHubReader {
  views = new Map<string, RepoView>();
  prs = new Map<string, PrList>();
  issues = new Map<string, IssueList>();
  runs = new Map<string, WorkflowRuns>();
  /** `owner/repo` -> PR number -> that pull request's checks. */
  checks = new Map<string, Record<number, FeedPrChecks>>();
  /** Newest first, per repository (the default branch). */
  commitList = new Map<string, CommitsPage>();
  requests: ReviewRequestSearch = [];
  /** `op` or `op:owner/repo` entries make that read throw. */
  failing = new Set<string>();
  calls: string[] = [];

  count(op: string): number {
    return this.calls.filter((c) => c === op || c.startsWith(`${op}:`)).length;
  }

  private gate(op: string, ref?: RepoRef): void {
    this.calls.push(ref ? `${op}:${key(ref)}` : op);
    if (this.failing.has(op) || (ref && this.failing.has(`${op}:${key(ref)}`))) {
      throw new Error(`scripted failure: ${op}`);
    }
  }

  setView(repo: string, over: Partial<RepoView> = {}): void {
    this.views.set(repo.toLowerCase(), {
      name: repo.split('/')[1]!, defaultBranchRef: { name: 'main' }, isPrivate: false, ...over,
    });
  }

  async repoView(ref: RepoRef): Promise<RepoView> {
    this.gate('repoView', ref);
    return this.views.get(key(ref)) ?? {
      name: ref.repo, defaultBranchRef: { name: 'main' }, isPrivate: false,
    };
  }

  async feedPrList(ref: RepoRef): Promise<PrList> {
    this.gate('feedPrList', ref);
    return this.prs.get(key(ref)) ?? [];
  }

  async feedIssueList(ref: RepoRef): Promise<IssueList> {
    this.gate('feedIssueList', ref);
    return this.issues.get(key(ref)) ?? [];
  }

  async feedPrChecks(ref: RepoRef, n: number): Promise<FeedPrChecks> {
    this.gate('feedPrChecks', ref);
    return this.checks.get(key(ref))?.[n] ?? [];
  }

  async feedRunList(ref: RepoRef): Promise<WorkflowRuns> {
    this.gate('feedRunList', ref);
    return this.runs.get(key(ref)) ?? [];
  }

  async reviewRequests(): Promise<ReviewRequestSearch> {
    this.gate('reviewRequests');
    return this.requests;
  }

  async commits(ref: RepoRef, _branch: string, page: number): Promise<CommitsPage> {
    this.gate('commits', ref);
    return (this.commitList.get(key(ref)) ?? []).slice((page - 1) * 30, page * 30);
  }

  // The older watch surface. The feed must never reach for it.
  async prList(_ref: RepoRef): Promise<PrList> { this.calls.push('prList'); return []; }
  async prView(_ref: RepoRef, n: number): Promise<PrView> { this.calls.push('prView'); return { number: n, title: '', state: 'OPEN' }; }
  async prChecks(_ref: RepoRef, _n: number): Promise<PrChecks> { this.calls.push('prChecks'); return []; }
  async prListAll(_ref: RepoRef): Promise<PrList> { this.calls.push('prListAll'); return []; }
  async prReviews(_ref: RepoRef, n: number): Promise<PrReviews> { this.calls.push('prReviews'); return { number: n }; }
  async runList(_ref: RepoRef): Promise<WorkflowRuns> { this.calls.push('runList'); return []; }
  async issueList(_ref: RepoRef): Promise<IssueList> { this.calls.push('issueList'); return []; }
}

export const pr = (
  number: number, over: Partial<PrList[number]> = {},
): PrList[number] => ({
  number, title: `Change ${number}`, state: 'OPEN', isDraft: false,
  author: { login: 'alice' }, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z',
  latestReviews: [], ...over,
});

export const issue = (
  number: number, over: Partial<IssueList[number]> = {},
): IssueList[number] => ({
  number, title: `Problem ${number}`, state: 'OPEN', author: { login: 'bob' },
  createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z', ...over,
});

export const run = (
  databaseId: number, over: Partial<WorkflowRuns[number]> = {},
): WorkflowRuns[number] => ({
  databaseId, attempt: 1, workflowName: 'ci', headBranch: 'main', headSha: sha(databaseId),
  status: 'completed', conclusion: 'success', createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z', ...over,
});

export const commit = (n: number, date: string, message = `Commit ${n}`): CommitsPage[number] => ({
  sha: sha(n), commit: { message, author: { name: 'Alice', date }, committer: { date } },
  author: { login: 'alice' }, parents: [],
});

export const review = (id: string, state: string, submittedAt: string, login = 'carol') => ({
  id, state, submittedAt, author: { login },
});

/** What a transport recorded, narrowed to what these tests ask about. */
export const sentTo = (
  sent: readonly { target: SendTarget; message: OutboundMessage }[],
): { where: string; text: string; message: OutboundMessage }[] =>
  sent.map(({ target, message }) => ({
    where: target.kind === 'channel' ? `channel:${target.channelId}` : `dm:${target.userId}`,
    text: [
      ...(message.embeds ?? []).flatMap((e) => [e.title ?? '', e.description ?? '']),
      message.content ?? '',
    ].join('\n'),
    message,
  }));
