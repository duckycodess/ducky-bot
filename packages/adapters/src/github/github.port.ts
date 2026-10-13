import type {
  CommitsPage, FeedPrChecks, IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, ReviewRequestSearch,
  WorkflowRuns,
} from '@ducky/contracts';

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Read-only by construction. There is deliberately no writer implementation in
 * Phase 1: every consequential GitHub action goes through the approval gate and
 * the deferred performer instead.
 */
export interface GitHubReader {
  repoView(ref: RepoRef): Promise<RepoView>;
  prList(ref: RepoRef): Promise<PrList>;
  prView(ref: RepoRef, number: number): Promise<PrView>;
  prChecks(ref: RepoRef, number: number): Promise<PrChecks>;
  /**
   * Open AND recently closed pull requests, so a merge is observable as a merge
   * rather than as a PR that vanished.
   */
  prListAll(ref: RepoRef): Promise<PrList>;
  /** Approvals, requested changes, review comments, and commits under review. */
  prReviews(ref: RepoRef, number: number): Promise<PrReviews>;
  /** Workflow runs: a failure, and the recovery after one. */
  runList(ref: RepoRef): Promise<WorkflowRuns>;
  issueList(ref: RepoRef): Promise<IssueList>;

  // ---- the GitHub feed's reads -------------------------------------------
  //
  // Each is bounded before it is parsed and each is independent of the others,
  // so one failing never turns another's empty answer into a baseline.

  /** Open pull requests, newest first, with created time and latest reviews. */
  feedPrList(ref: RepoRef): Promise<PrList>;
  feedIssueList(ref: RepoRef): Promise<IssueList>;
  /**
   * The checks on one pull request: check runs AND external commit statuses.
   * A pull request with no checks answers an empty list, not an error.
   */
  feedPrChecks(ref: RepoRef, number: number): Promise<FeedPrChecks>;
  /** Workflow runs with their rerun attempt. */
  feedRunList(ref: RepoRef): Promise<WorkflowRuns>;
  /**
   * Open pull requests, in ANY repository the authenticated account can see,
   * whose review was requested of that account personally.
   */
  reviewRequests(): Promise<ReviewRequestSearch>;
  /** One page of a branch's commits, newest first. `page` is 1-based and capped. */
  commits(ref: RepoRef, branch: string, page: number): Promise<CommitsPage>;
}
