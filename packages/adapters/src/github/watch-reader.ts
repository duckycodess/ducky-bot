import {
  GH_TIMEOUT_MS, GITHUB_FEED_COMMIT_MAX_PAGES, GITHUB_FEED_COMMIT_PAGE_SIZE, CommitsPageSchema,
  WATCH_API_DISCOVERY_PAGE_SIZE, WATCH_API_MAX_BUFFER, WATCH_API_PAGE_SIZE, WATCH_API_REVIEW_BODY_MAX,
  WATCH_EVENT_KINDS, WatchDiscoverySchema, WatchIssuesSchema, WatchPullsSchema, WatchReleasesSchema,
  WatchRepositorySchema, WatchReviewsSchema, WatchRunsSchema, checkCommandAllowed, commitsEndpoint,
  watchEndpoint, type WatchApiRequest, type WatchReaderCapabilities,
} from '@ducky/contracts';
import type { ZodType } from 'zod';
import { runArgv } from '../process/run.js';
import {
  WatchReadError, type AssistantWatchReader, type CommitRecord, type DiscoveredRepository, type IssueRecord,
  type Page, type PullRecord, type ReleaseRecord, type RepositoryRecord, type ReviewRecord, type RunRecord,
  type WatchRepoRef,
} from './watch.port.js';

/**
 * The ONLY module that builds the notification-watch `gh api` shapes.
 *
 * A test asserts that no other source file names a watch endpoint builder, so the
 * engineering reader (`gh-cli.ts`) and everything else can still reach `gh api`
 * for the one commits shape alone. Every request here is
 *
 *     gh api --method GET <canonical-relative-endpoint>
 *
 * built by `watchEndpoint`/`commitsEndpoint` from validated parts, re-checked by
 * the central policy (`checkCommandAllowed`) from scratch, and run through
 * `runArgv` with a mandatory timeout and an explicit output bound. There is no
 * second HTTP or subprocess path.
 */

export interface GhWatchReaderOptions {
  readonly bin?: string;
  readonly timeoutMs?: number;
  /** Whether frozen configuration enabled discovery. Never assumed. */
  readonly discovery?: boolean;
  /** For tests: the spawn seam. Defaults to `runArgv`. */
  readonly run?: typeof runArgv;
}

const RUN_ENV = { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' } as const;

/**
 * Reads what `gh` said when it failed into a short code. Matches on the status
 * line `gh` prints (`... (HTTP 404)`), never on a provider message, and never
 * returns any of the text.
 */
export function classifyGhFailure(stderr: string): WatchReadError {
  const text = stderr.slice(0, 2_000);
  if (/rate limit|abuse|secondary|HTTP 429/i.test(text)) return new WatchReadError('rate_limited');
  if (/HTTP 40[13]|bad credentials|authentication|not logged in|requires authentication/i.test(text)) {
    return new WatchReadError('auth');
  }
  if (/HTTP 404|not found/i.test(text)) return new WatchReadError('not_found');
  return new WatchReadError('unavailable');
}

const WATCH_KINDS = [...WATCH_EVENT_KINDS] as const;

export class GhWatchReader implements AssistantWatchReader {
  readonly capabilities: WatchReaderCapabilities;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly run: typeof runArgv;
  private readonly discoveryEnabled: boolean;

  constructor(options: GhWatchReaderOptions = {}) {
    this.bin = options.bin ?? 'gh';
    this.timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
    this.run = options.run ?? runArgv;
    this.discoveryEnabled = options.discovery === true;
    this.capabilities = Object.freeze({ observableKinds: WATCH_KINDS, discovery: this.discoveryEnabled });
  }

  // ---- the one execution path ----------------------------------------------------

  private async get<T>(argv: readonly string[], schema: ZodType<T>): Promise<T> {
    // Two independent gates: the builder decided what could be CONSTRUCTED, and
    // the central policy decides whether what was constructed may RUN.
    const refusal = checkCommandAllowed('gh', argv);
    if (refusal) throw new WatchReadError('not_enabled', refusal.reason);

    const res = await this.run(this.bin, argv, {
      timeoutMs: this.timeoutMs,
      maxBuffer: WATCH_API_MAX_BUFFER,
      env: { ...process.env, ...RUN_ENV },
    });
    if (res.code !== 0) throw classifyGhFailure(res.stderr);

    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      // A body that hit the output bound arrives cut off; say which it was.
      throw new WatchReadError(res.stdout.length >= WATCH_API_MAX_BUFFER - 1_024 ? 'oversized' : 'malformed');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new WatchReadError('malformed');
    return parsed.data;
  }

  private request<T>(req: WatchApiRequest, schema: ZodType<T>): Promise<T> {
    let endpoint: string;
    try {
      endpoint = watchEndpoint(req);
    } catch {
      // A page past a grammar cap is a window this build will not chase.
      throw new WatchReadError('window_exceeded');
    }
    return this.get(['api', '--method', 'GET', endpoint], schema);
  }

  // ---- the surfaces ----------------------------------------------------------------

  async repository(ref: WatchRepoRef): Promise<RepositoryRecord> {
    const r = await this.request({ surface: 'repository', ...ref }, WatchRepositorySchema);
    // The provider answers a renamed or transferred repository under its old name,
    // so the name in the answer is what says it is still the repository asked for.
    if (r.full_name.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) {
      throw new WatchReadError('identity_changed');
    }
    return {
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      archived: r.archived === true,
      fork: r.fork === true,
      pushedAt: r.pushed_at ?? null,
    };
  }

  async commits(ref: WatchRepoRef, branch: string, page: number): Promise<Page<CommitRecord>> {
    let endpoint: string;
    try {
      endpoint = commitsEndpoint(ref.owner, ref.repo, branch, page);
    } catch {
      // The existing commits builder stops at its page cap; reaching it is
      // reported as an exceeded window, never as an endless read failure.
      if (Number.isInteger(page) && page > GITHUB_FEED_COMMIT_MAX_PAGES) throw new WatchReadError('window_exceeded');
      throw new WatchReadError('not_enabled', 'invalid commit lookup');
    }
    const rows = await this.get(['api', '--method', 'GET', endpoint], CommitsPageSchema);
    const items = rows.map((c) => ({
      sha: c.sha,
      committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? '',
      subject: (c.commit.message ?? '').split('\n', 1)[0] ?? '',
    }));
    return { items, hasMore: rows.length >= GITHUB_FEED_COMMIT_PAGE_SIZE };
  }

  async pulls(ref: WatchRepoRef, page: number): Promise<Page<PullRecord>> {
    const rows = await this.request({ surface: 'pulls', ...ref, page }, WatchPullsSchema);
    const items = rows.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.merged_at ? ('merged' as const) : p.state,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      mergedAt: p.merged_at ?? null,
      closedAt: p.closed_at ?? null,
    }));
    return {
      items, hasMore: rows.length >= WATCH_API_PAGE_SIZE, windowStamp: rows.at(-1)?.updated_at ?? null,
    };
  }

  async pullReviews(ref: WatchRepoRef, number: number, page: number): Promise<Page<ReviewRecord>> {
    const rows = await this.request({ surface: 'reviews', ...ref, number, page }, WatchReviewsSchema);
    const items = rows.map((r) => ({
      id: String(r.id),
      state: r.state,
      submittedAt: r.submitted_at ?? null,
      body: (r.body ?? '').slice(0, WATCH_API_REVIEW_BODY_MAX),
    }));
    return { items, hasMore: rows.length >= WATCH_API_PAGE_SIZE };
  }

  async issues(ref: WatchRepoRef, page: number): Promise<Page<IssueRecord>> {
    const rows = await this.request({ surface: 'issues', ...ref, page }, WatchIssuesSchema);
    // The listing returns pull requests too. `hasMore` and the window stamp come
    // from the RAW rows: a page of nothing but pull requests is still a full page.
    const items = rows
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({
        number: i.number,
        title: i.title,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        closedAt: i.closed_at ?? null,
      }));
    return {
      items, hasMore: rows.length >= WATCH_API_PAGE_SIZE, windowStamp: rows.at(-1)?.updated_at ?? null,
    };
  }

  async runs(ref: WatchRepoRef, branch: string, page: number): Promise<Page<RunRecord>> {
    const res = await this.request({ surface: 'runs', ...ref, branch, page }, WatchRunsSchema);
    const items = res.workflow_runs.map((r) => ({
      id: String(r.id),
      name: r.name ?? '',
      branch: r.head_branch ?? branch,
      status: r.status ?? '',
      conclusion: r.conclusion ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? null,
    }));
    return {
      items, hasMore: items.length >= WATCH_API_PAGE_SIZE, total: res.total_count,
      windowStamp: res.workflow_runs.at(-1)?.created_at ?? null,
    };
  }

  async releases(ref: WatchRepoRef, page: number): Promise<Page<ReleaseRecord>> {
    const rows = await this.request({ surface: 'releases', ...ref, page }, WatchReleasesSchema);
    const items = rows.map((r) => ({
      id: String(r.id),
      tag: r.tag_name,
      name: r.name ?? '',
      draft: r.draft === true,
      publishedAt: r.published_at ?? null,
      createdAt: r.created_at ?? null,
    }));
    return {
      items, hasMore: rows.length >= WATCH_API_PAGE_SIZE, windowStamp: rows.at(-1)?.created_at ?? null,
    };
  }

  async discover(page: number): Promise<Page<DiscoveredRepository>> {
    if (!this.discoveryEnabled) throw new WatchReadError('not_enabled', 'discovery is not enabled');
    const rows = await this.request({ surface: 'discovery', page }, WatchDiscoverySchema);
    const items = rows.map((r) => ({
      fullName: r.full_name,
      ownerLogin: r.owner.login,
      ownerType: r.owner.type ?? null,
      fork: r.fork === true,
      archived: r.archived === true,
      pushedAt: r.pushed_at ?? null,
    }));
    return { items, hasMore: rows.length >= WATCH_API_DISCOVERY_PAGE_SIZE };
  }
}
