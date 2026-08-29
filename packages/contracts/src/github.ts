import { z } from 'zod';
import { GITHUB_WATCH_INTERVAL_MAX_MINUTES, GITHUB_WATCH_INTERVAL_MIN_MINUTES } from './limits.js';
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
const ReviewSchema = z.object({
  id: z.string().optional(),
  author: z.object({ login: z.string().optional() }).nullable().optional(),
  state: z.string().optional(),
  submittedAt: z.string().nullable().optional(),
  body: z.string().optional(),
});

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
