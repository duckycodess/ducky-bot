import type {
  IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, WorkflowRuns,
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
}
