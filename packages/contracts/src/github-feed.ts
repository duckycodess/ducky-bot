import { z } from 'zod';
import { GH_OWNER_RE, GH_REPO_RE, isSafeBranchName } from './github.js';
import {
  DUCKY_COLORS, GITHUB_FEED_DETAIL_MAX, GITHUB_FEED_TITLE_MAX, GITHUB_LINK_URL_MAX,
} from './limits.js';

/**
 * The actionable GitHub events Ducky reports the moment it observes them.
 *
 * Deliberately a CLOSED set, and deliberately small. Everything on it is
 * something the owner has to decide about; everything that is merely activity
 * -- a push, a comment, a label -- is either folded into the daily commit
 * digest or not reported at all. A feed that reported everything would be
 * reporting nothing, because nobody reads it.
 */
export const GITHUB_FEED_KINDS = [
  'pr_opened',
  'issue_opened',
  'review_requested',
  'changes_requested',
  'check_failed',
] as const;
export type GitHubFeedKind = (typeof GITHUB_FEED_KINDS)[number];

export const isGitHubFeedKind = (v: unknown): v is GitHubFeedKind =>
  typeof v === 'string' && (GITHUB_FEED_KINDS as readonly string[]).includes(v);

/**
 * The card heading per kind. Plain words, no emoji, no decoration: the card is
 * read at a glance beside a dozen others.
 */
export const GITHUB_FEED_KIND_LABEL = {
  pr_opened: 'Pull request opened',
  issue_opened: 'Issue opened',
  review_requested: 'Review requested',
  changes_requested: 'Changes requested',
  check_failed: 'Checks failed',
} as const satisfies Record<GitHubFeedKind, string>;

/**
 * Colour by MEANING, chosen here and never derived from observed text.
 *
 * Three of the five need the owner, and one is a failure. Nothing is coloured
 * for novelty -- an opened issue is neutral information.
 */
export const GITHUB_FEED_KIND_COLOR = {
  pr_opened: DUCKY_COLORS.neutral,
  issue_opened: DUCKY_COLORS.neutral,
  review_requested: DUCKY_COLORS.attention,
  changes_requested: DUCKY_COLORS.attention,
  check_failed: DUCKY_COLORS.failure,
} as const satisfies Record<GitHubFeedKind, number>;

/**
 * Where one observation may be shown.
 *
 * Two values and no third, because the third would be the interesting one: a
 * "best effort, put it somewhere" target is how private repository detail ends
 * up in a channel other people read. Every ambiguous case resolves to
 * `owner_dm` -- see `githubFeedTarget`.
 */
export const GITHUB_FEED_TARGETS = ['github_channel', 'owner_dm'] as const;
export type GitHubFeedTarget = (typeof GITHUB_FEED_TARGETS)[number];

/** One clickable destination on a card. Always a link, never a control. */
export interface GitHubFeedLink {
  readonly label: string;
  readonly url: string;
}

/**
 * The ONLY shape a GitHub feed presenter accepts.
 *
 * The same discipline `SharedJobProjection` enforces, for the same reason: a
 * presenter that took the raw observation could render a field nobody meant to
 * publish, and a redaction pass over a wide object only hides what somebody
 * remembered to name. This type carries exactly what a card shows, it is built
 * once at observation time, and it is what gets stored -- so what is delivered
 * three retries later is what was projected, not a fresh read of something that
 * may have become private in between.
 */
export interface GitHubFeedCard {
  readonly kind: GitHubFeedKind;
  /** `owner/repo`, as the owner would type it. */
  readonly repo: string;
  /** The pull request or issue number, when the event has one. */
  readonly number: number | null;
  readonly title: string;
  /** Short supporting lines. Never a body, never a diff, never a log. */
  readonly detail: readonly string[];
  readonly links: readonly GitHubFeedLink[];
  readonly observedAt: string;
}

/**
 * One repository's commits for one digest, as the presenter receives them.
 *
 * Built at SEND time from the commit buffer and from a fresh visibility read,
 * never stored: what a digest says is decided when it is delivered, so a
 * repository that went private in between cannot be published from a stale
 * projection.
 */
export interface GitHubCommitDigestSection {
  readonly repo: string;
  readonly branch: string;
  readonly commits: readonly { readonly sha: string; readonly headline: string; readonly author: string }[];
  /** How many there were in total, which may exceed the lines shown. */
  readonly total: number;
  /** True when the commit walk could not reach the previous cursor. */
  readonly truncated: boolean;
  readonly links: readonly GitHubFeedLink[];
}

/** A repository whose commits could not be read, named only where the reader may see it. */
export interface GitHubDigestUnreadable {
  readonly repo: string;
}

const LinkSchema = z.strictObject({
  label: z.string().min(1).max(80),
  url: z.string().max(GITHUB_LINK_URL_MAX),
});

/** Parsed back out of the database, so a stored card cannot widen on read. */
export const GitHubFeedCardSchema = z.strictObject({
  kind: z.enum(GITHUB_FEED_KINDS),
  repo: z.string().max(201),
  number: z.number().int().nullable(),
  title: z.string().max(GITHUB_FEED_TITLE_MAX),
  detail: z.array(z.string().max(GITHUB_FEED_DETAIL_MAX)).max(6),
  links: z.array(LinkSchema).max(5),
  observedAt: z.string().max(40),
});

/**
 * Where a card may be shown, decided from facts rather than from convenience.
 *
 * Four conditions, and EVERY one of them has to hold for a card to reach the
 * channel:
 *
 * 1. a GitHub-updates channel is configured at all;
 * 2. the repository is on the owner's explicitly selected watch list -- a
 *    repository discovered only because somebody asked the owner for a review
 *    is not one the owner chose to publish;
 * 3. the repository is known to be public;
 * 4. its visibility was actually OBSERVED. `undefined` is not "probably
 *    public"; a read that failed or a field GitHub did not return resolves to
 *    the DM.
 *
 * Read access to the channel confers nothing. Nobody who can see a card can act
 * on it: every control in this system is owner-only and signed, and a card
 * carries no control at all -- only links to GitHub, where GitHub's own
 * permissions decide what the reader may see.
 */
export function githubFeedTarget(input: {
  readonly channelConfigured: boolean;
  readonly selected: boolean;
  readonly isPrivate: boolean | undefined;
}): GitHubFeedTarget {
  if (!input.channelConfigured) return 'owner_dm';
  if (!input.selected) return 'owner_dm';
  if (input.isPrivate !== false) return 'owner_dm';
  return 'github_channel';
}

/** `owner/repo`, validated. Returns undefined rather than a half-formed key. */
export function repoKey(owner: string, repo: string): string | undefined {
  if (!GH_OWNER_RE.test(owner) || !GH_REPO_RE.test(repo)) return undefined;
  return `${owner}/${repo}`;
}

/**
 * The identity a repository is stored and deduplicated under.
 *
 * GitHub treats owner and repository names case-insensitively, so `Acme/Demo`
 * and `acme/demo` are one repository and must be one row. The display form is
 * kept separately, on the card.
 */
export const canonicalRepoKey = (key: string): string => key.toLowerCase();

/** Splits an `owner/repo` key back apart, validating both halves. */
export function parseRepoKey(key: string): { owner: string; repo: string } | undefined {
  const parts = key.split('/');
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts as [string, string];
  return repoKey(owner, repo) === undefined ? undefined : { owner, repo };
}

/**
 * The GitHub links a card may carry, BUILT rather than echoed.
 *
 * Every url here is assembled from validated components -- an owner, a repo, a
 * number, a hex sha, a branch name -- so none of them can be a url GitHub
 * handed back. That matters because the sanitizer's allowlist is the last line
 * and not the only one: a presenter that forwarded an API-supplied `url` would
 * be trusting a remote system to choose where the owner's Discord client
 * navigates.
 */
const SHA_SAFE = /^[0-9a-f]{7,64}$/;

export const githubRepoUrl = (owner: string, repo: string): string | undefined =>
  repoKey(owner, repo) === undefined ? undefined : `https://github.com/${owner}/${repo}`;

export const githubPrUrl = (owner: string, repo: string, n: number): string | undefined =>
  repoKey(owner, repo) === undefined || !Number.isSafeInteger(n) || n <= 0
    ? undefined
    : `https://github.com/${owner}/${repo}/pull/${n}`;

export const githubIssueUrl = (owner: string, repo: string, n: number): string | undefined =>
  repoKey(owner, repo) === undefined || !Number.isSafeInteger(n) || n <= 0
    ? undefined
    : `https://github.com/${owner}/${repo}/issues/${n}`;

export const githubPrFilesUrl = (owner: string, repo: string, n: number): string | undefined => {
  const pr = githubPrUrl(owner, repo, n);
  return pr === undefined ? undefined : `${pr}/files`;
};

export const githubPrChecksUrl = (owner: string, repo: string, n: number): string | undefined => {
  const pr = githubPrUrl(owner, repo, n);
  return pr === undefined ? undefined : `${pr}/checks`;
};

/**
 * The commits page. A branch that is not plainly safe (a space, a `#`, a `..`)
 * falls back to the repository's default commits page rather than to no link.
 */
export const githubCommitsUrl = (owner: string, repo: string, branch?: string): string | undefined => {
  if (repoKey(owner, repo) === undefined) return undefined;
  return branch !== undefined && isSafeBranchName(branch)
    ? `https://github.com/${owner}/${repo}/commits/${branch}`
    : `https://github.com/${owner}/${repo}/commits`;
};

export const githubCommitUrl = (owner: string, repo: string, sha: string): string | undefined =>
  repoKey(owner, repo) === undefined || !SHA_SAFE.test(sha)
    ? undefined
    : `https://github.com/${owner}/${repo}/commit/${sha}`;

export const githubRunUrl = (owner: string, repo: string, runId: number): string | undefined =>
  repoKey(owner, repo) === undefined || !Number.isSafeInteger(runId) || runId <= 0
    ? undefined
    : `https://github.com/${owner}/${repo}/actions/runs/${runId}`;

/** Collects the links that could actually be built; drops the ones that could not. */
export const links = (
  ...entries: readonly (readonly [label: string, url: string | undefined])[]
): GitHubFeedLink[] =>
  entries
    .filter((e): e is readonly [string, string] => typeof e[1] === 'string')
    .map(([label, url]) => ({ label, url }));
