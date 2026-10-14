import { WATCH_EVENT_KINDS, type WatchReaderCapabilities } from '@ducky/contracts';
import {
  WatchReadError,
  type AssistantWatchReader, type CommitRecord, type DiscoveredRepository, type IssueRecord, type Page,
  type PullRecord, type ReleaseRecord, type RepositoryRecord, type ReviewRecord, type RunRecord,
  type WatchRepoRef,
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
  /** Throw this typed failure on the next call of a method. */
  failWith = new Map<string, WatchReadError>();
  /**
   * Runs at the START of every call, before its page is cut, so a test can change
   * what the provider holds BETWEEN two requests of one read: the drift cases.
   */
  hook: ((method: string, ref: WatchRepoRef | null, page: number) => void) | null = null;
  private counts = new Map<string, number>();

  commitsBy = new Map<string, CommitRecord[]>();
  pullsBy = new Map<string, PullRecord[]>();
  reviewsBy = new Map<string, ReviewRecord[]>();
  issuesBy = new Map<string, IssueRecord[]>();
  /** The sort-key time of the last RAW issue-listing row, for pages that held pull requests too. */
  issuesStampBy = new Map<string, string>();
  runsBy = new Map<string, RunRecord[]>();
  releasesBy = new Map<string, ReleaseRecord[]>();
  repoBy = new Map<string, Partial<RepositoryRecord>>();
  discoveredBy: DiscoveredRepository[] = [];
  /** The provider total a runs page reports; defaults to the list's length. */
  runsTotalOverride: number | null = null;

  private key = (r: WatchRepoRef): string => `${r.owner}/${r.repo}`.toLowerCase();

  private touch(method: string, ref: WatchRepoRef | null, page?: number): void {
    this.calls += 1;
    this.log.push(`${method}:${ref ? this.key(ref) : '-'}${page === undefined ? '' : `:${page}`}`);
    const n = (this.counts.get(method) ?? 0) + 1;
    this.counts.set(method, n);
    this.hook?.(method, ref, page ?? 0);
    const typed = this.failWith.get(method);
    if (typed) {
      this.failWith.delete(method);
      throw typed;
    }
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

  async repository(ref: WatchRepoRef): Promise<RepositoryRecord> {
    this.touch('repository', ref);
    const o = this.repoBy.get(this.key(ref)) ?? {};
    return {
      fullName: o.fullName ?? `${ref.owner}/${ref.repo}`,
      defaultBranch: o.defaultBranch ?? 'main',
      archived: o.archived ?? false,
      fork: o.fork ?? false,
      pushedAt: o.pushedAt ?? null,
    };
  }
  async commits(ref: WatchRepoRef, _branch: string, page: number): Promise<Page<CommitRecord>> {
    this.touch('commits', ref, page);
    return this.paged(this.commitsBy.get(this.key(ref)), page);
  }
  async pulls(ref: WatchRepoRef, page: number): Promise<Page<PullRecord>> {
    this.touch('pulls', ref, page);
    const res = this.paged(this.pullsBy.get(this.key(ref)), page);
    return { ...res, windowStamp: res.items.at(-1)?.updatedAt ?? null };
  }
  async pullReviews(ref: WatchRepoRef, number: number, page: number): Promise<Page<ReviewRecord>> {
    this.touch('pullReviews', ref, page);
    return this.paged(this.reviewsBy.get(`${this.key(ref)}#${number}`), page);
  }
  async issues(ref: WatchRepoRef, page: number): Promise<Page<IssueRecord>> {
    this.touch('issues', ref, page);
    const res = this.paged(this.issuesBy.get(this.key(ref)), page);
    return {
      ...res,
      windowStamp: this.issuesStampBy.get(this.key(ref)) ?? res.items.at(-1)?.updatedAt ?? null,
    };
  }
  async runs(ref: WatchRepoRef, _branch: string, page: number): Promise<Page<RunRecord>> {
    this.touch('runs', ref, page);
    const all = this.runsBy.get(this.key(ref)) ?? [];
    return { ...this.paged(all, page), total: this.runsTotalOverride ?? all.length };
  }
  async releases(ref: WatchRepoRef, page: number): Promise<Page<ReleaseRecord>> {
    this.touch('releases', ref, page);
    return this.paged(this.releasesBy.get(this.key(ref)), page);
  }
  async discover(page: number): Promise<Page<DiscoveredRepository>> {
    this.touch('discover', null, page);
    const start = (page - 1) * this.pageSize;
    return {
      items: this.discoveredBy.slice(start, start + this.pageSize),
      hasMore: start + this.pageSize < this.discoveredBy.length,
    };
  }
}
