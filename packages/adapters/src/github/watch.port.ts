import { NO_WATCH_CAPABILITIES, type WatchReaderCapabilities } from '@ducky/contracts';

/**
 * What a notification-only watch can read, as typed records.
 *
 * This is a PORT, not an adapter, and it is narrower than the engineering
 * reader on purpose: every method is ONE bounded request (one page of one
 * surface), so the engine can charge each against its call budget and no
 * pagination hides inside a method. Each returns the timestamps an event's
 * identity and the cursor boundary depend on.
 *
 * Timestamps are the provider's own strings, unmodified. An event's identity is
 * built from them, and an identity built from a re-formatted time would not
 * match one imported from the source and would announce the same event twice.
 *
 * A reader declares what it can actually answer in `capabilities`. The shipped
 * `UnavailableAssistantWatchReader` observes nothing; `GhWatchReader` observes
 * through the exact typed `gh api --method GET` shapes the owner approved.
 */
export interface WatchRepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface Page<T> {
  /** In the provider's order. */
  readonly items: readonly T[];
  /**
   * Whether a further page MAY exist. It is true when the page came back full: a
   * full page proves nothing about the next one, and an under-full page proves
   * there is none. For a listing that mixes kinds (issues and pull requests) the
   * raw page size is what decides this, before anything is filtered out.
   */
  readonly hasMore: boolean;
  /**
   * The sort-key time of the LAST raw item on the page, filtered or not. A page of
   * issues can be all pull requests; the sort key is shared, so that last item's
   * time still proves how far down the window this page reached.
   */
  readonly windowStamp?: string | null;
  /** The provider's own total for the whole listing, where it gives one. */
  readonly total?: number | null;
}

export interface CommitRecord {
  readonly sha: string;
  readonly committedAt: string;
  readonly subject: string;
}

export interface PullRecord {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
}

export interface ReviewRecord {
  readonly id: string;
  /** The provider's verdict word, any case. */
  readonly state: string;
  readonly submittedAt: string | null;
  readonly body: string;
  /** The provider's global node id of the review, for exact comparison with a native card. */
  readonly nodeId?: string | null;
}

export interface IssueRecord {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface RunRecord {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  /** The rerun attempt, when the provider said one. */
  readonly attempt?: number | null;
}

export interface ReleaseRecord {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  /** A draft is not a published release; it has no publication time. */
  readonly draft: boolean;
  readonly publishedAt: string | null;
  readonly createdAt: string | null;
}

export interface RepositoryRecord {
  /** `owner/repo` as the provider names it NOW; compared with the requested identity. */
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly archived: boolean;
  readonly fork: boolean;
  readonly pushedAt: string | null;
}

export interface DiscoveredRepository {
  readonly fullName: string;
  readonly ownerLogin: string;
  readonly ownerType: string | null;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly pushedAt: string | null;
}

/**
 * Why a read failed, in words that are safe to store: a short code, never a
 * provider body, a URL or a repository name.
 */
export type WatchReadErrorCode =
  | 'rate_limited'
  | 'auth'
  | 'not_found'
  | 'unavailable'
  | 'malformed'
  | 'oversized'
  | 'window_exceeded'
  | 'identity_changed'
  | 'not_enabled';

export class WatchReadError extends Error {
  constructor(readonly code: WatchReadErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'WatchReadError';
  }
}

export interface AssistantWatchReader {
  readonly capabilities: WatchReaderCapabilities;
  /** The repository's current identity, default branch and eligibility facts. One request. */
  repository(ref: WatchRepoRef): Promise<RepositoryRecord>;
  /** One page of a branch's commits, newest first. */
  commits(ref: WatchRepoRef, branch: string, page: number): Promise<Page<CommitRecord>>;
  /** One page of pull requests of any state, most recently updated first. */
  pulls(ref: WatchRepoRef, page: number): Promise<Page<PullRecord>>;
  /** One page of one pull request's reviews, oldest first. */
  pullReviews(ref: WatchRepoRef, number: number, page: number): Promise<Page<ReviewRecord>>;
  /** One page of issues of any state (never pull requests), most recently updated first. */
  issues(ref: WatchRepoRef, page: number): Promise<Page<IssueRecord>>;
  /** One page of workflow runs on a branch, newest CREATED first. */
  runs(ref: WatchRepoRef, branch: string, page: number): Promise<Page<RunRecord>>;
  /** One page of releases, newest CREATED first. */
  releases(ref: WatchRepoRef, page: number): Promise<Page<ReleaseRecord>>;
  /** One page of repositories the authenticated account can reach, most recently pushed first. */
  discover(page: number): Promise<Page<DiscoveredRepository>>;
}

/**
 * The shipped default: it observes nothing and says so.
 *
 * Every method refuses, so nothing can be mistaken for an observation, and
 * `capabilities` is empty, so the importer refuses a watch category that needs
 * any kind and `/status` can name the blocker.
 */
export class UnavailableAssistantWatchReader implements AssistantWatchReader {
  readonly capabilities: WatchReaderCapabilities = NO_WATCH_CAPABILITIES;

  private refuse(): never {
    throw new WatchReadError('not_enabled', 'No typed notification reader is available in this build.');
  }
  async repository(): Promise<RepositoryRecord> { return this.refuse(); }
  async commits(): Promise<Page<CommitRecord>> { return this.refuse(); }
  async pulls(): Promise<Page<PullRecord>> { return this.refuse(); }
  async pullReviews(): Promise<Page<ReviewRecord>> { return this.refuse(); }
  async issues(): Promise<Page<IssueRecord>> { return this.refuse(); }
  async runs(): Promise<Page<RunRecord>> { return this.refuse(); }
  async releases(): Promise<Page<ReleaseRecord>> { return this.refuse(); }
  async discover(): Promise<Page<DiscoveredRepository>> { return this.refuse(); }
}
