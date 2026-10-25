import type {
  CommitsPage, FeedPrChecks, IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, ReviewRequestSearch,
  WorkflowRuns,
} from '@ducky/contracts';
import type { GitHubReader, RepoRef } from '@ducky/adapters';

/** A GitHub reader a test can change between passes. Defaults are EMPTY, never helpful. */
export class MutableGitHubReader implements GitHubReader {
  repo: RepoView = { name: 'demo', defaultBranchRef: { name: 'main' } };
  prs: PrList = [];
  checks = new Map<number, PrChecks>();
  calls: string[] = [];

  async repoView(_ref: RepoRef): Promise<RepoView> {
    this.calls.push('repoView');
    return this.repo;
  }

  async prList(_ref: RepoRef): Promise<PrList> {
    this.calls.push('prList');
    return this.prs;
  }

  async prView(_ref: RepoRef, n: number): Promise<PrView> {
    this.calls.push(`prView:${n}`);
    return { number: n, title: 'unused', state: 'OPEN' };
  }

  async prChecks(_ref: RepoRef, n: number): Promise<PrChecks> {
    this.calls.push(`prChecks:${n}`);
    return this.checks.get(n) ?? [];
  }

  // The wider surface the final milestone added. Defaults are EMPTY, never
  // helpful: a stub that answers more than the real thing is how five live
  // Herdr defects survived a full unit suite.
  reviews = new Map<number, PrReviews>();
  runs: WorkflowRuns = [];
  issues: IssueList = [];

  async prListAll(_ref: RepoRef): Promise<PrList> {
    this.calls.push('prListAll');
    return this.prs;
  }

  async prReviews(_ref: RepoRef, n: number): Promise<PrReviews> {
    this.calls.push(`prReviews:${n}`);
    // The real `gh` always answers with the arrays, empty when there is nothing: a pull request with no
    // reviews is a COMPLETE empty answer, not an absent one (an absent field proves nothing, and the watch
    // keeps what it knew). A test that wants a partial answer sets one explicitly.
    return this.reviews.get(n) ?? { number: n, reviews: [], latestReviews: [], comments: [], commits: [] };
  }

  async runList(_ref: RepoRef): Promise<WorkflowRuns> {
    this.calls.push('runList');
    return this.runs;
  }

  async issueList(_ref: RepoRef): Promise<IssueList> {
    this.calls.push('issueList');
    return this.issues;
  }

  // The GitHub feed's reads. A watch never calls them, and the empty answers
  // keep it that way: a watch test that reached for one would see nothing.
  async feedPrList(_ref: RepoRef): Promise<PrList> {
    return [];
  }

  async feedIssueList(_ref: RepoRef): Promise<IssueList> {
    return [];
  }

  async feedRunList(_ref: RepoRef): Promise<WorkflowRuns> {
    return [];
  }

  async feedPrChecks(): Promise<FeedPrChecks> {
    return [];
  }

  async reviewRequests(): Promise<ReviewRequestSearch> {
    return [];
  }

  async commits(): Promise<CommitsPage> {
    return [];
  }
}
