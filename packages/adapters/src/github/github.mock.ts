import type { PrChecks, PrList, PrView, RepoView } from '@ducky/contracts';
import type { GitHubReader, RepoRef } from './github.port.js';

export class MockGitHubReader implements GitHubReader {
  readonly calls: { op: string; ref: RepoRef; n?: number }[] = [];

  constructor(
    private readonly fixtures: {
      repoView?: RepoView;
      prList?: PrList;
      prView?: PrView;
      prChecks?: PrChecks;
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
}
