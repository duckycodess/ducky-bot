import type {
  IssueList, PrChecks, PrList, PrReviews, PrView, RepoView, WorkflowRuns,
} from '@ducky/contracts';
import type { GitHubReader, RepoRef } from './github.port.js';

/**
 * A read-only stand-in for `gh`.
 *
 * Every default is the EMPTY answer, not a helpful one. That is deliberate:
 * the Herdr mocks were each more accommodating than the real CLI, which is why
 * five live defects survived a full unit suite. A test that has not said what
 * GitHub returns gets "nothing", and a summary built from nothing is visibly
 * empty rather than plausibly wrong.
 */
export class MockGitHubReader implements GitHubReader {
  readonly calls: { op: string; ref: RepoRef; n?: number }[] = [];

  constructor(
    private readonly fixtures: {
      repoView?: RepoView;
      prList?: PrList;
      prView?: PrView;
      prChecks?: PrChecks;
      prListAll?: PrList;
      /** Keyed by PR number, so one test can script several reviews. */
      prReviews?: Record<number, PrReviews>;
      runList?: WorkflowRuns;
      issueList?: IssueList;
    } = {},
  ) {}

  async repoView(ref: RepoRef): Promise<RepoView> {
    this.calls.push({ op: 'repoView', ref });
    return this.fixtures.repoView ?? { name: ref.repo, defaultBranchRef: { name: 'main' } };
  }

  async prList(ref: RepoRef): Promise<PrList> {
    this.calls.push({ op: 'prList', ref });
    return this.fixtures.prList ?? [];
  }

  async prView(ref: RepoRef, n: number): Promise<PrView> {
    this.calls.push({ op: 'prView', ref, n });
    return this.fixtures.prView ?? { number: n, title: 'pr', state: 'OPEN' };
  }

  async prChecks(ref: RepoRef, n: number): Promise<PrChecks> {
    this.calls.push({ op: 'prChecks', ref, n });
    return this.fixtures.prChecks ?? [];
  }

  async prListAll(ref: RepoRef): Promise<PrList> {
    this.calls.push({ op: 'prListAll', ref });
    // Falls back to the open list, never to invented rows: a test that scripted
    // only `prList` should see exactly what it scripted.
    return this.fixtures.prListAll ?? this.fixtures.prList ?? [];
  }

  async prReviews(ref: RepoRef, n: number): Promise<PrReviews> {
    this.calls.push({ op: 'prReviews', ref, n });
    return this.fixtures.prReviews?.[n] ?? { number: n };
  }

  async runList(ref: RepoRef): Promise<WorkflowRuns> {
    this.calls.push({ op: 'runList', ref });
    return this.fixtures.runList ?? [];
  }

  async issueList(ref: RepoRef): Promise<IssueList> {
    this.calls.push({ op: 'issueList', ref });
    return this.fixtures.issueList ?? [];
  }
}
