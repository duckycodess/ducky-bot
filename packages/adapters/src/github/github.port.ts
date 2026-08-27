import type { PrChecks, PrList, PrView, RepoView } from '@ducky/contracts';

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
}
