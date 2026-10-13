import { z } from 'zod';
import {
  GITHUB_FEED_COMMIT_MAX_PAGES, GITHUB_FEED_COMMIT_PAGE_SIZE, GITHUB_FEED_MAX_REVIEW_REQUESTS,
  GITHUB_WATCH_INTERVAL_MAX_MINUTES, GITHUB_WATCH_INTERVAL_MIN_MINUTES,
} from './limits.js';
import { PUBLIC_WATCH_ID_RE, REPO_SLUG_RE } from './ids.js';

export const GH_OWNER_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const RepoViewSchema = z.object({
  name: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
  isPrivate: z.boolean().optional(),
  updatedAt: z.string().optional(),
});
export type RepoView = z.infer<typeof RepoViewSchema>;

/**
 * One review, as `gh` reports it. Every field optional, every unknown key
 * ignored: the names are recorded, the values only partly.
 */
export const ReviewSchema = z.object({
  id: z.string().optional(),
  author: z.object({ login: z.string().optional() }).nullable().optional(),
  state: z.string().optional(),
  submittedAt: z.string().nullable().optional(),
  body: z.string().optional(),
});

export const PrListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean().optional(),
    headRefName: z.string().optional(),
    updatedAt: z.string().optional(),
    // Added by the final milestone so a watch can see a MERGE and a review
    // verdict, not only that a title changed. Optional for the same reason the
    // review schema is: the names are recorded, the values are not.
    headRefOid: z.string().optional(),
    mergedAt: z.string().nullable().optional(),
    reviewDecision: z.string().nullable().optional(),
    // Added for the GitHub feed: when it opened, who opened it, and the latest
    // verdict per reviewer. All optional, for the same reason as the rest.
    createdAt: z.string().optional(),
    author: z.object({ login: z.string().optional() }).nullable().optional(),
    latestReviews: z.array(ReviewSchema).optional(),
  }),
);
export type PrList = z.infer<typeof PrListSchema>;

export const PrViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  mergeable: z.string().optional(),
  reviewDecision: z.string().nullable().optional(),
});
export type PrView = z.infer<typeof PrViewSchema>;

/**
 * The review surface of one pull request.
 *
 * Every field is OPTIONAL and every unknown key is ignored, deliberately. The
 * field NAMES are recorded (`pnpm probe:gh` reads them from `gh` itself, with no
 * repository named and no network request), but the response VALUES are not: no
 * GitHub repository is configured in this host's allowlist, so a strict schema
 * here would be asserting a shape nobody has seen. A tolerant schema degrades to
 * "less detail in the summary"; a strict one would turn an unremarkable API
 * difference into a failed observation.
 */
export const PrReviewsSchema = z.object({
  number: z.number(),
  title: z.string().optional(),
  state: z.string().optional(),
  headRefOid: z.string().optional(),
  reviewDecision: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  reviews: z.array(ReviewSchema).optional(),
  latestReviews: z.array(ReviewSchema).optional(),
  reviewRequests: z.array(z.object({ login: z.string().optional() }).loose()).optional(),
  comments: z.array(z.object({ author: z.object({ login: z.string().optional() }).nullable().optional() }).loose()).optional(),
  commits: z.array(z.object({ oid: z.string().optional(), messageHeadline: z.string().optional() }).loose()).optional(),
});
export type PrReviews = z.infer<typeof PrReviewsSchema>;

/** Workflow runs, for failures and for recovery. Bounded by `--limit`. */
export const WorkflowRunsSchema = z.array(
  z.object({
    databaseId: z.number().optional(),
    number: z.number().optional(),
    workflowName: z.string().optional(),
    displayTitle: z.string().optional(),
    headBranch: z.string().optional(),
    headSha: z.string().optional(),
    event: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    // The rerun counter: a rerun keeps its `databaseId` and bumps this, which is
    // what lets a second failure of the same run be a distinct, alertable fact.
    attempt: z.number().int().optional(),
  }),
);
export type WorkflowRuns = z.infer<typeof WorkflowRunsSchema>;

export const IssueListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string().optional(),
    stateReason: z.string().nullable().optional(),
    updatedAt: z.string().optional(),
    createdAt: z.string().optional(),
    author: z.object({ login: z.string().optional() }).nullable().optional(),
    labels: z.array(z.object({ name: z.string().optional() }).loose()).optional(),
  }),
);
export type IssueList = z.infer<typeof IssueListSchema>;

export const PrChecksSchema = z.array(
  z.object({ name: z.string(), state: z.string().optional(), bucket: z.string().optional() }),
);
export type PrChecks = z.infer<typeof PrChecksSchema>;

export const PublicWatchIdSchema = z.string().regex(PUBLIC_WATCH_ID_RE, 'not a watch id');

export const GitHubWatchAddInputSchema = z.strictObject({
  repoSlug: z.string().regex(REPO_SLUG_RE),
  /** Polling interval in minutes; the service validates the allowlisted repo. */
  everyMinutes: z.coerce.number().int()
    .min(GITHUB_WATCH_INTERVAL_MIN_MINUTES)
    .max(GITHUB_WATCH_INTERVAL_MAX_MINUTES)
    .default(GITHUB_WATCH_INTERVAL_MIN_MINUTES),
});
export type GitHubWatchAddInput = z.infer<typeof GitHubWatchAddInputSchema>;

export const GITHUB_WATCH_STATES = ['active', 'cancelled'] as const;
export type GitHubWatchState = (typeof GITHUB_WATCH_STATES)[number];

export interface RepoStatusSummary {
  slug: string;
  repoName: string;
  defaultBranch: string | null;
  openPrCount: number;
  latestPr: { number: number; title: string; state: string; checks: string } | null;
  /**
   * Where this repository can run, in the owner's terms.
   *
   * Executor IDS only. A filesystem path never reaches Discord in either
   * direction: Discord names a slug and Ducky answers with hosts, so nothing
   * here could be pasted back as a path. `hosts: null` means the single-path
   * form -- any executor -- which is what every configuration meant before
   * placements existed.
   */
  placement: {
    jobsAllowed: boolean;
    hosts: readonly string[] | null;
    preferred: string | null;
  };
}

// ---- the GitHub feed's two extra read surfaces --------------------------------
//
// Everything above reads through `gh <noun> <verb> --json <selectors>`, whose
// selectors are recorded from `gh` itself. Two things the feed needs have no
// such form: the commits of a branch (the REST API only) and the review
// requests assigned to the owner across repositories (a search). Both are
// pinned here to ONE exact argv shape each, and `command-policy.ts` re-checks
// that shape independently of whatever built it.

/**
 * What a default-branch commit looks like, and nothing more.
 *
 * `gh api` has no `--json` selector, so there is no recorded field list to
 * check against; this schema, and the fixture `commits-live.json` recorded from
 * a real read, are the contract instead. Tolerant for the same reason every
 * schema in this file is: a missing optional field degrades a digest line, it
 * does not fail an observation.
 */
export const CommitsPageSchema = z.array(
  z.object({
    sha: z.string().regex(/^[0-9a-f]{7,64}$/),
    commit: z.object({
      message: z.string().optional(),
      author: z.object({ name: z.string().nullable().optional(), date: z.string().optional() })
        .nullable().optional(),
      committer: z.object({ date: z.string().optional() }).nullable().optional(),
    }),
    author: z.object({ login: z.string().optional() }).nullable().optional(),
    parents: z.array(z.object({ sha: z.string().optional() })).optional(),
  }),
);
export type CommitsPage = z.infer<typeof CommitsPageSchema>;

/**
 * Review requests addressed to the authenticated account, from a search.
 *
 * `user-review-requested:@me` means requests aimed at the INDIVIDUAL, not at a
 * team the individual belongs to, and GitHub resolves `@me` to whichever
 * account `gh` is signed in as. That is why this surface only runs when the
 * operator has stated that account IS the owner.
 */
export const ReviewRequestSearchSchema = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    state: z.string().optional(),
    isDraft: z.boolean().optional(),
    author: z.object({ login: z.string().optional() }).nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    repository: z.object({
      name: z.string().optional(),
      nameWithOwner: z.string(),
    }),
  }),
);
export type ReviewRequestSearch = z.infer<typeof ReviewRequestSearchSchema>;

/** The one search query, and the one selector list. Exact strings, never composed. */
export const GH_REVIEW_SEARCH_QUERY = 'user-review-requested:@me';
export const GH_REVIEW_SEARCH_FIELDS =
  'number,title,state,isDraft,author,createdAt,updatedAt,repository';

const NAME_SAFE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RAW = /^[A-Za-z0-9._\-/]{1,180}$/;
// An owner or repo of `.` or `..`, or one containing `..`, satisfies the general
// name pattern and is a path traversal in a URL path. Refused on this surface.
const isPlainName = (n: string): boolean =>
  NAME_SAFE.test(n) && n !== '.' && n !== '..' && !n.includes('..');
export const isSafeBranchName = (b: string): boolean =>
  BRANCH_RAW.test(b) && !b.includes('..') && !b.startsWith('/') && !b.endsWith('/') &&
  !b.includes('//') && !b.startsWith('-') && !b.endsWith('.lock') && !b.endsWith('.');

/**
 * `repos/{owner}/{repo}/commits?sha=<branch>&per_page=N&page=P`, built from
 * validated parts. Throws rather than returning something half-formed: an
 * endpoint that could not be validated is not one to send.
 */
export function commitsEndpoint(owner: string, repo: string, branch: string, page: number): string {
  if (!isPlainName(owner) || !isPlainName(repo)) throw new Error('invalid repository');
  if (!isSafeBranchName(branch)) throw new Error('invalid branch');
  if (!Number.isInteger(page) || page < 1 || page > GITHUB_FEED_COMMIT_MAX_PAGES) {
    throw new Error('invalid page');
  }
  return `repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}` +
    `&per_page=${GITHUB_FEED_COMMIT_PAGE_SIZE}&page=${page}`;
}

const COMMITS_ENDPOINT_RE =
  /^repos\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/commits\?sha=([A-Za-z0-9._~%-]{1,400})&per_page=(\d{1,3})&page=(\d{1,2})$/;

/**
 * The inverse, used by the policy gate. Accepts ONLY a string `commitsEndpoint`
 * would have produced: the branch must decode to a safe name AND re-encode to
 * exactly the text given, which rejects every alternate spelling (`%2e%2e`,
 * lower-case hex, an over-encoded character, a placeholder) rather than trying
 * to enumerate them.
 */
export function parseCommitsEndpoint(
  endpoint: string,
): { owner: string; repo: string; branch: string; page: number } | undefined {
  const m = COMMITS_ENDPOINT_RE.exec(endpoint);
  if (!m) return undefined;
  const [, owner, repo, rawBranch, perPage, page] = m as unknown as [
    string, string, string, string, string, string,
  ];
  if (!isPlainName(owner) || !isPlainName(repo)) return undefined;
  if (Number(perPage) !== GITHUB_FEED_COMMIT_PAGE_SIZE) return undefined;
  const p = Number(page);
  if (p < 1 || p > GITHUB_FEED_COMMIT_MAX_PAGES) return undefined;
  let branch: string;
  try {
    branch = decodeURIComponent(rawBranch);
  } catch {
    return undefined;
  }
  if (!isSafeBranchName(branch) || encodeURIComponent(branch) !== rawBranch) return undefined;
  return { owner, repo, branch, page: p };
}

/** The whole argv of the commits read. Nothing else is an acceptable `gh api` call. */
export const isCommitsApiArgv = (argv: readonly string[]): boolean =>
  argv.length === 4 && argv[0] === 'api' && argv[1] === '--method' && argv[2] === 'GET' &&
  typeof argv[3] === 'string' && parseCommitsEndpoint(argv[3]) !== undefined;

/** The whole argv of the review-request search. */
export const isReviewSearchArgv = (argv: readonly string[]): boolean => {
  if (argv.length !== 9) return false;
  const limit = Number(argv[6]);
  return argv[0] === 'search' && argv[1] === 'prs' && argv[2] === GH_REVIEW_SEARCH_QUERY &&
    argv[3] === '--state' && argv[4] === 'open' && argv[5] === '--limit' &&
    /^\d{1,3}$/.test(argv[6] ?? '') && limit >= 1 && limit <= GITHUB_FEED_MAX_REVIEW_REQUESTS &&
    argv[7] === '--json' && argv[8] === GH_REVIEW_SEARCH_FIELDS;
};
