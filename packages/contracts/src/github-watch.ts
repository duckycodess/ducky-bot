import { z } from 'zod';
import { GH_OWNER_RE, GH_REPO_RE, isSafeBranchName } from './github.js';

/**
 * The typed GET reads behind notification-only watch targets (ADR 0030, ADR 0031).
 *
 * The owner approved these on 2026-10-14, and only these: each is `gh api
 * --method GET <endpoint>` with a CANONICAL relative endpoint, built here from
 * validated parts and re-parsed here by the policy gate from scratch. There is no
 * `/notifications` endpoint, no file or review-comment endpoint, no hostname,
 * header, field, input, template, filter, cache, include or pagination flag, and
 * the shape's argv is exactly four words long.
 *
 * "Notification results" means the typed event surfaces below, nothing else.
 */

/** Items per page on every repository surface. A page is one unit of work. */
export const WATCH_API_PAGE_SIZE = 10;
/** Discovery lists wider, because a repository row is small and the source reads the same way. */
export const WATCH_API_DISCOVERY_PAGE_SIZE = 100;
/** At most this many discovery pages; more than that is incompleteness, said so. */
export const WATCH_API_DISCOVERY_MAX_PAGES = 5;
/** The deepest page any watch surface grammar accepts; services cap lower, per surface. */
export const WATCH_API_MAX_PAGE = 50;
/** Reviews pages one pull request may span before it is called too large to read whole. */
export const WATCH_API_REVIEWS_MAX_PAGES = 10;
/** One response, in bytes. A page that does not fit is refused, not truncated. */
export const WATCH_API_MAX_BUFFER = 2 * 1024 * 1024;
/** Characters kept of a review body. The text is scrubbed again before it leaves. */
export const WATCH_API_REVIEW_BODY_MAX = 2_000;

export const WATCH_API_SURFACES = [
  'repository', 'pulls', 'reviews', 'issues', 'runs', 'releases', 'discovery',
] as const;
export type WatchApiSurface = (typeof WATCH_API_SURFACES)[number];

/** The `affiliation` list discovery asks for; the source asks for exactly these three. */
export const WATCH_DISCOVERY_AFFILIATION = 'owner,collaborator,organization_member';

export type WatchApiRequest =
  | { readonly surface: 'repository'; readonly owner: string; readonly repo: string }
  | { readonly surface: 'pulls'; readonly owner: string; readonly repo: string; readonly page: number }
  | {
      readonly surface: 'reviews'; readonly owner: string; readonly repo: string;
      readonly number: number; readonly page: number;
    }
  | { readonly surface: 'issues'; readonly owner: string; readonly repo: string; readonly page: number }
  | {
      readonly surface: 'runs'; readonly owner: string; readonly repo: string;
      readonly branch: string; readonly page: number;
    }
  | { readonly surface: 'releases'; readonly owner: string; readonly repo: string; readonly page: number }
  | { readonly surface: 'discovery'; readonly page: number };

// An owner or repo of `.` or `..`, or containing `..`, satisfies the general
// name pattern and is a path traversal in a URL path. Refused on every surface.
export const isPlainRepoName = (n: string): boolean =>
  GH_OWNER_RE.test(n) && GH_REPO_RE.test(n) && n !== '.' && n !== '..' && !n.includes('..');

const okPage = (p: number, max: number): boolean => Number.isInteger(p) && p >= 1 && p <= max;
const okNumber = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 99_999_999;

/**
 * The endpoint for a request, or a throw. An endpoint that could not be
 * validated is not one to send, so nothing half-formed is ever returned.
 */
export function watchEndpoint(req: WatchApiRequest): string {
  if (req.surface === 'discovery') {
    if (!okPage(req.page, WATCH_API_DISCOVERY_MAX_PAGES)) throw new Error('invalid page');
    return `user/repos?affiliation=${WATCH_DISCOVERY_AFFILIATION}&sort=pushed&direction=desc` +
      `&per_page=${WATCH_API_DISCOVERY_PAGE_SIZE}&page=${req.page}`;
  }
  if (!isPlainRepoName(req.owner) || !isPlainRepoName(req.repo)) throw new Error('invalid repository');
  const base = `repos/${req.owner}/${req.repo}`;
  switch (req.surface) {
    case 'repository':
      return base;
    case 'pulls':
      if (!okPage(req.page, WATCH_API_MAX_PAGE)) throw new Error('invalid page');
      return `${base}/pulls?state=all&sort=updated&direction=desc&per_page=${WATCH_API_PAGE_SIZE}` +
        `&page=${req.page}`;
    case 'reviews':
      if (!okNumber(req.number)) throw new Error('invalid number');
      if (!okPage(req.page, WATCH_API_REVIEWS_MAX_PAGES)) throw new Error('invalid page');
      return `${base}/pulls/${req.number}/reviews?per_page=${WATCH_API_PAGE_SIZE}&page=${req.page}`;
    case 'issues':
      if (!okPage(req.page, WATCH_API_MAX_PAGE)) throw new Error('invalid page');
      return `${base}/issues?state=all&sort=updated&direction=desc&per_page=${WATCH_API_PAGE_SIZE}` +
        `&page=${req.page}`;
    case 'runs':
      if (!isSafeBranchName(req.branch)) throw new Error('invalid branch');
      if (!okPage(req.page, WATCH_API_MAX_PAGE)) throw new Error('invalid page');
      return `${base}/actions/runs?branch=${encodeURIComponent(req.branch)}` +
        `&per_page=${WATCH_API_PAGE_SIZE}&page=${req.page}`;
    case 'releases':
      if (!okPage(req.page, WATCH_API_MAX_PAGE)) throw new Error('invalid page');
      return `${base}/releases?per_page=${WATCH_API_PAGE_SIZE}&page=${req.page}`;
  }
}

const NAME = '([A-Za-z0-9._-]{1,100})';
const PAGE = '(\\d{1,2})';
const PATTERNS: readonly (readonly [WatchApiSurface, RegExp])[] = [
  ['repository', new RegExp(`^repos/${NAME}/${NAME}$`)],
  ['pulls', new RegExp(
    `^repos/${NAME}/${NAME}/pulls\\?state=all&sort=updated&direction=desc&per_page=10&page=${PAGE}$`,
  )],
  ['reviews', new RegExp(`^repos/${NAME}/${NAME}/pulls/(\\d{1,8})/reviews\\?per_page=10&page=${PAGE}$`)],
  ['issues', new RegExp(
    `^repos/${NAME}/${NAME}/issues\\?state=all&sort=updated&direction=desc&per_page=10&page=${PAGE}$`,
  )],
  ['runs', new RegExp(`^repos/${NAME}/${NAME}/actions/runs\\?branch=([A-Za-z0-9._~%-]{1,400})&per_page=10&page=${PAGE}$`)],
  ['releases', new RegExp(`^repos/${NAME}/${NAME}/releases\\?per_page=10&page=${PAGE}$`)],
  ['discovery', new RegExp(
    `^user/repos\\?affiliation=${WATCH_DISCOVERY_AFFILIATION}&sort=pushed&direction=desc&per_page=100&page=${PAGE}$`,
  )],
];

/**
 * The inverse, used by the policy gate. It reads a candidate endpoint into a
 * request and then REBUILDS the endpoint from that request: it accepts only a
 * string `watchEndpoint` would have produced, byte for byte. That rejects every
 * alternate spelling (a different key order, an extra key, `%2e%2e`, lower-case
 * hex, a placeholder, a repeated key) rather than trying to enumerate them.
 */
export function parseWatchEndpoint(endpoint: string): WatchApiRequest | undefined {
  for (const [surface, re] of PATTERNS) {
    const m = re.exec(endpoint);
    if (!m) continue;
    let req: WatchApiRequest;
    try {
      switch (surface) {
        case 'repository':
          req = { surface, owner: m[1]!, repo: m[2]! };
          break;
        case 'pulls':
        case 'issues':
        case 'releases':
          req = { surface, owner: m[1]!, repo: m[2]!, page: Number(m[3]) };
          break;
        case 'reviews':
          req = { surface, owner: m[1]!, repo: m[2]!, number: Number(m[3]), page: Number(m[4]) };
          break;
        case 'runs':
          req = {
            surface, owner: m[1]!, repo: m[2]!, branch: decodeURIComponent(m[3]!), page: Number(m[4]),
          };
          break;
        case 'discovery':
          req = { surface, page: Number(m[1]) };
          break;
      }
      return watchEndpoint(req) === endpoint ? req : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The whole argv of a watch read. Nothing else is an acceptable shape here. */
export const isWatchApiArgv = (argv: readonly string[]): boolean =>
  argv.length === 4 && argv[0] === 'api' && argv[1] === '--method' && argv[2] === 'GET' &&
  typeof argv[3] === 'string' && parseWatchEndpoint(argv[3]) !== undefined;

// ---- the response schemas -----------------------------------------------------
//
// Each schema asks for the fields an event's identity and cursor depend on and
// ignores the rest. They are written from GitHub's documented REST shapes. A live
// read-only probe (`pnpm probe:watch-reader`) of the owner-approved public repository
// showed real, non-empty responses for the repository, pull request, issue and
// commit surfaces; the reviews, workflow-runs and releases answers there were EMPTY,
// so those three ITEM schemas have been checked against the documented shape only,
// not against a live item. The probe says so and exits non-zero for them unless
// told to accept shape-only evidence. A page longer than the `per_page` asked for
// is a malformed answer, not a longer window.

const Iso = z.string().min(1).max(64);

export const WatchRepositorySchema = z.object({
  full_name: z.string().min(1).max(201),
  default_branch: z.string().min(1).max(255),
  archived: z.boolean().optional(),
  fork: z.boolean().optional(),
  private: z.boolean().optional(),
  pushed_at: Iso.nullable().optional(),
});
export type WatchRepositoryResponse = z.infer<typeof WatchRepositorySchema>;

export const WatchPullsSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string().max(1_000),
    state: z.enum(['open', 'closed']),
    created_at: Iso,
    updated_at: Iso,
    closed_at: Iso.nullable().optional(),
    merged_at: Iso.nullable().optional(),
  }),
).max(WATCH_API_PAGE_SIZE);
export type WatchPullsResponse = z.infer<typeof WatchPullsSchema>;

export const WatchReviewsSchema = z.array(
  z.object({
    id: z.number().int().nonnegative(),
    state: z.string().max(40),
    submitted_at: Iso.nullable().optional(),
    body: z.string().nullable().optional(),
    // The review's global node id: the same id GraphQL (and so `gh pr list --json latestReviews`)
    // calls `id`. Bounded and optional, and an unusable value becomes "absent" rather than failing
    // the page: it is only ever compared by exact equality, and an absent one means no match. It
    // is hashed before it is stored; the raw value is never kept.
    node_id: z.string().min(1).max(255).optional().catch(undefined),
  }),
).max(WATCH_API_PAGE_SIZE);
export type WatchReviewsResponse = z.infer<typeof WatchReviewsSchema>;

export const WatchIssuesSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string().max(1_000),
    state: z.string().max(20),
    created_at: Iso,
    updated_at: Iso,
    closed_at: Iso.nullable().optional(),
    // Present only on a pull request, which this listing also returns.
    pull_request: z.unknown().optional(),
  }),
).max(WATCH_API_PAGE_SIZE);
export type WatchIssuesResponse = z.infer<typeof WatchIssuesSchema>;

export const WatchRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      name: z.string().max(300).nullable().optional(),
      head_branch: z.string().max(255).nullable().optional(),
      status: z.string().max(40).nullable().optional(),
      conclusion: z.string().max(40).nullable().optional(),
      created_at: Iso,
      updated_at: Iso.nullable().optional(),
      // The rerun attempt, which with the run id identifies a native failure card exactly. Bounded
      // and optional; an unusable value is "absent" and then no run failure is matched by it.
      run_attempt: z.number().int().min(1).max(9999).optional().catch(undefined),
    }),
  ).max(WATCH_API_PAGE_SIZE),
});
export type WatchRunsResponse = z.infer<typeof WatchRunsSchema>;

export const WatchReleasesSchema = z.array(
  z.object({
    id: z.number().int().nonnegative(),
    tag_name: z.string().max(255),
    name: z.string().max(500).nullable().optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    created_at: Iso.nullable().optional(),
    published_at: Iso.nullable().optional(),
  }),
).max(WATCH_API_PAGE_SIZE);
export type WatchReleasesResponse = z.infer<typeof WatchReleasesSchema>;

export const WatchDiscoverySchema = z.array(
  z.object({
    full_name: z.string().min(1).max(201),
    fork: z.boolean().optional(),
    archived: z.boolean().optional(),
    private: z.boolean().optional(),
    pushed_at: Iso.nullable().optional(),
    owner: z.object({
      login: z.string().min(1).max(100),
      type: z.string().max(40).optional(),
    }),
  }),
).max(WATCH_API_DISCOVERY_PAGE_SIZE);
export type WatchDiscoveryResponse = z.infer<typeof WatchDiscoverySchema>;

/** Pages a runs or releases window may span before it is called too deep to prove. */
export const WATCH_RUNS_MAX_PAGES = 10;
export const WATCH_RELEASES_MAX_PAGES = 10;
