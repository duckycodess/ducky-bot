import {
  DuckyError, NO_WATCH_CAPABILITIES, type WatchReaderCapabilities,
} from '@ducky/contracts';

/**
 * What a notification-only watch can read, as typed records.
 *
 * This is a PORT, not an adapter. It is narrower than the engineering reader on
 * purpose: every method here is one bounded read, so the engine can charge each
 * against its call budget, and each returns the timestamps an event's identity
 * and the cursor boundary depend on (a closing time, a publication time).
 *
 * Timestamps are the provider's own strings, unmodified. An event's identity is
 * built from them, and an identity built from a re-formatted time would not
 * match one imported from the source and would announce the same event twice.
 *
 * A reader declares what it can actually answer in `capabilities`. The existing
 * installed reader cannot observe a release, a pull request's or an issue's
 * closing time, or discover repositories, and this build adds no argv shape
 * that could (AGENTS.md allows `gh api` and `gh search prs` in one shape each).
 * So the shipped reader is `UnavailableAssistantWatchReader`: it observes
 * nothing, and an import that needs a kind it cannot observe is refused rather
 * than accepted and quietly never watched.
 */
export interface WatchRepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface Page<T> {
  /** Newest first. */
  readonly items: readonly T[];
  /** Whether a further page exists beyond this one. */
  readonly hasMore: boolean;
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
}

export interface ReleaseRecord {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly publishedAt: string | null;
  readonly createdAt: string | null;
}

export interface AssistantWatchReader {
  readonly capabilities: WatchReaderCapabilities;
  /** One page of a branch's commits, newest first. `branch` null means the default branch. */
  commits(ref: WatchRepoRef, branch: string | null, page: number): Promise<Page<CommitRecord>>;
  /** One page of pull requests of any state, most recently updated first. */
  pulls(ref: WatchRepoRef, page: number): Promise<Page<PullRecord>>;
  /** The reviews of one pull request. */
  pullReviews(ref: WatchRepoRef, number: number): Promise<readonly ReviewRecord[]>;
  /** One page of issues of any state (never pull requests), most recently updated first. */
  issues(ref: WatchRepoRef, page: number): Promise<Page<IssueRecord>>;
  /** Recent workflow runs on a branch, newest first. */
  runs(ref: WatchRepoRef, branch: string | null): Promise<readonly RunRecord[]>;
  /** Recent releases, newest first. */
  releases(ref: WatchRepoRef): Promise<readonly ReleaseRecord[]>;
  /** The repository's current default branch name. */
  defaultBranch(ref: WatchRepoRef): Promise<string>;
}

/**
 * The shipped reader: it observes nothing and says so.
 *
 * Every method refuses, so nothing can be mistaken for an observation, and
 * `capabilities` is empty, so the importer refuses a watch category that needs
 * any kind and `/status` can name the blocker.
 */
export class UnavailableAssistantWatchReader implements AssistantWatchReader {
  readonly capabilities: WatchReaderCapabilities = NO_WATCH_CAPABILITIES;

  private refuse(): never {
    throw new DuckyError(
      'integration_not_verified',
      'No typed notification reader is available in this build.',
    );
  }
  commits(): Promise<Page<CommitRecord>> { return this.refuse(); }
  pulls(): Promise<Page<PullRecord>> { return this.refuse(); }
  pullReviews(): Promise<readonly ReviewRecord[]> { return this.refuse(); }
  issues(): Promise<Page<IssueRecord>> { return this.refuse(); }
  runs(): Promise<readonly RunRecord[]> { return this.refuse(); }
  releases(): Promise<readonly ReleaseRecord[]> { return this.refuse(); }
  defaultBranch(): Promise<string> { return this.refuse(); }
}
