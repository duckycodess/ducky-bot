import { WATCH_EVENT_KINDS, type WatchReaderCapabilities } from '@ducky/contracts';
import type {
  AssistantWatchReader, CommitRecord, IssueRecord, Page, PullRecord, ReleaseRecord, ReviewRecord,
  RunRecord, WatchRepoRef,
} from '../src/domain/assistant-watch.reader.js';

/**
 * A scripted typed reader for tests.
 *
 * Every call is counted and logged, a method can be told to fail once, and each
 * page is a slice of a newest-first list, so the engine's paging, budgeting and
 * boundary behavior is driven for real without a network. Defaults are EMPTY,
 * never helpful: a stub that answers more than the real thing is how defects
 * survive a unit suite. Invented data only.
 */
export class FakeWatchReader implements AssistantWatchReader {
  capabilities: WatchReaderCapabilities = {
    observableKinds: [...WATCH_EVENT_KINDS],
    discovery: false,
  };
  pageSize = 2;
  calls = 0;
  log: string[] = [];
  failNext = new Set<string>();
  /** Fail the Nth call (1-based, per method) once, e.g. the third page of a read. */
  failNth = new Map<string, number>();
  private counts = new Map<string, number>();

  commitsBy = new Map<string, CommitRecord[]>();
  pullsBy = new Map<string, PullRecord[]>();
  reviewsBy = new Map<string, ReviewRecord[]>();
  issuesBy = new Map<string, IssueRecord[]>();
  runsBy = new Map<string, RunRecord[]>();
  releasesBy = new Map<string, ReleaseRecord[]>();
  branchBy = new Map<string, string>();

  private key = (r: WatchRepoRef): string => `${r.owner}/${r.repo}`.toLowerCase();

  private touch(method: string, ref: WatchRepoRef, page?: number): void {
    this.calls += 1;
    this.log.push(`${method}:${this.key(ref)}${page === undefined ? '' : `:${page}`}`);
    const n = (this.counts.get(method) ?? 0) + 1;
    this.counts.set(method, n);
    if (this.failNext.delete(method)) throw new Error('boom');
    if (this.failNth.get(method) === n) {
      this.failNth.delete(method);
      throw new Error('boom');
    }
  }

  private paged<T>(items: readonly T[] | undefined, page: number): Page<T> {
    const all = items ?? [];
    const start = (page - 1) * this.pageSize;
    return { items: all.slice(start, start + this.pageSize), hasMore: start + this.pageSize < all.length };
  }

  async commits(ref: WatchRepoRef, _branch: string | null, page: number): Promise<Page<CommitRecord>> {
    this.touch('commits', ref, page);
    return this.paged(this.commitsBy.get(this.key(ref)), page);
  }
  async pulls(ref: WatchRepoRef, page: number): Promise<Page<PullRecord>> {
    this.touch('pulls', ref, page);
    return this.paged(this.pullsBy.get(this.key(ref)), page);
  }
  async pullReviews(ref: WatchRepoRef, number: number): Promise<readonly ReviewRecord[]> {
    this.touch('pullReviews', ref, number);
    return this.reviewsBy.get(`${this.key(ref)}#${number}`) ?? [];
  }
  async issues(ref: WatchRepoRef, page: number): Promise<Page<IssueRecord>> {
    this.touch('issues', ref, page);
    return this.paged(this.issuesBy.get(this.key(ref)), page);
  }
  async runs(ref: WatchRepoRef): Promise<readonly RunRecord[]> {
    this.touch('runs', ref);
    return this.runsBy.get(this.key(ref)) ?? [];
  }
  async releases(ref: WatchRepoRef): Promise<readonly ReleaseRecord[]> {
    this.touch('releases', ref);
    return this.releasesBy.get(this.key(ref)) ?? [];
  }
  async defaultBranch(ref: WatchRepoRef): Promise<string> {
    this.touch('defaultBranch', ref);
    return this.branchBy.get(this.key(ref)) ?? 'main';
  }
}
