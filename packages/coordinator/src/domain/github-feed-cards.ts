import {
  GITHUB_FEED_DETAIL_MAX, GITHUB_FEED_TITLE_MAX,
  githubCommitsUrl, githubIssueUrl, githubPrChecksUrl, githubPrFilesUrl, githubPrUrl,
  githubRunUrl, links,
  type GitHubFeedCard, type GitHubFeedKind,
} from '@ducky/contracts';
import { redact } from '@ducky/adapters';

/**
 * Observation -> card. The ONLY place a card is built.
 *
 * Every function here takes already-validated parts (an owner, a repo, a number)
 * and returns a `GitHubFeedCard`, which is what is stored and what a presenter
 * accepts. Three rules hold throughout:
 *
 * - **Text is redacted and clamped on the way IN**, before it reaches SQLite, so
 *   a title that happens to contain a token never becomes a stored row.
 * - **Links are built, not echoed.** The `url` GitHub returns in a payload is
 *   never used; every href is assembled from the validated owner, repo and
 *   number, so a remote system cannot choose where a button points.
 * - **No bodies, diffs or logs.** A card carries a title and a few short
 *   details, because a card is read at a glance and published to a channel.
 */

const clean = (value: string | undefined, max: number): string =>
  redact((value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);

export const cardTitle = (v: string | undefined): string => clean(v, GITHUB_FEED_TITLE_MAX);
const detail = (v: string | undefined): string => clean(v, GITHUB_FEED_DETAIL_MAX);

const compact = (lines: readonly (string | undefined)[]): string[] =>
  lines.filter((l): l is string => typeof l === 'string' && l.length > 0).slice(0, 6);

export interface CardRepo {
  /** `owner/repo`, as the owner would type it. */
  readonly display: string;
  readonly owner: string;
  readonly repo: string;
}

export function prOpenedCard(
  r: CardRepo, p: { number: number; title: string; author?: string; draft?: boolean }, at: string,
): GitHubFeedCard {
  return {
    kind: 'pr_opened', repo: r.display, number: p.number, title: cardTitle(p.title),
    detail: compact([p.author ? `Opened by ${detail(p.author)}` : undefined, p.draft ? 'Draft' : undefined]),
    links: links(
      ['Open PR', githubPrUrl(r.owner, r.repo, p.number)],
      ['View changes', githubPrFilesUrl(r.owner, r.repo, p.number)],
    ),
    observedAt: at,
  };
}

export function issueOpenedCard(
  r: CardRepo, i: { number: number; title: string; author?: string }, at: string,
): GitHubFeedCard {
  return {
    kind: 'issue_opened', repo: r.display, number: i.number, title: cardTitle(i.title),
    detail: compact([i.author ? `Opened by ${detail(i.author)}` : undefined]),
    links: links(['Open issue', githubIssueUrl(r.owner, r.repo, i.number)]),
    observedAt: at,
  };
}

export function reviewRequestedCard(
  r: CardRepo, p: { number: number; title: string; author?: string; draft?: boolean }, at: string,
): GitHubFeedCard {
  return {
    kind: 'review_requested', repo: r.display, number: p.number, title: cardTitle(p.title),
    detail: compact([p.author ? `From ${detail(p.author)}` : undefined, p.draft ? 'Draft' : undefined]),
    links: links(
      ['Open PR', githubPrUrl(r.owner, r.repo, p.number)],
      ['View changes', githubPrFilesUrl(r.owner, r.repo, p.number)],
    ),
    observedAt: at,
  };
}

export function changesRequestedCard(
  r: CardRepo, p: { number: number; title: string; reviewer?: string }, at: string,
): GitHubFeedCard {
  return {
    kind: 'changes_requested', repo: r.display, number: p.number, title: cardTitle(p.title),
    detail: compact([p.reviewer ? `Requested by ${detail(p.reviewer)}` : undefined]),
    links: links(
      ['Open PR', githubPrUrl(r.owner, r.repo, p.number)],
      ['View changes', githubPrFilesUrl(r.owner, r.repo, p.number)],
    ),
    observedAt: at,
  };
}

export function checkFailedCard(
  r: CardRepo,
  run: { id: number; workflow: string; branch?: string; sha?: string; attempt?: number; conclusion?: string },
  at: string,
): GitHubFeedCard {
  const sha = run.sha && /^[0-9a-f]{7,64}$/.test(run.sha) ? run.sha.slice(0, 7) : undefined;
  return {
    kind: 'check_failed', repo: r.display, number: null, title: cardTitle(run.workflow) || 'Workflow run',
    detail: compact([
      run.branch ? `Branch ${detail(run.branch)}` : undefined,
      sha ? `Commit ${sha}` : undefined,
      run.attempt !== undefined && run.attempt > 1 ? `Attempt ${run.attempt}` : undefined,
      run.conclusion ? detail(run.conclusion.replace(/_/g, ' ')) : undefined,
    ]),
    links: links(['View checks', githubRunUrl(r.owner, r.repo, run.id)]),
    observedAt: at,
  };
}

/**
 * A check that failed on a pull request and is NOT an Actions workflow run: an
 * external CI system's status, or an app's check run. The check's own `link` is
 * a URL that system chose, so it is never used; the buttons are the pull
 * request and its checks tab, both built from validated parts.
 */
export function externalCheckFailedCard(
  r: CardRepo,
  c: { number: number; check: string; pullTitle?: string; sha?: string },
  at: string,
): GitHubFeedCard {
  const sha = c.sha && /^[0-9a-f]{7,64}$/.test(c.sha) ? c.sha.slice(0, 7) : undefined;
  return {
    kind: 'check_failed', repo: r.display, number: c.number, title: cardTitle(c.check) || 'Check',
    detail: compact([c.pullTitle ? detail(c.pullTitle) : undefined, sha ? `Commit ${sha}` : undefined]),
    links: links(
      ['Open PR', githubPrUrl(r.owner, r.repo, c.number)],
      ['View checks', githubPrChecksUrl(r.owner, r.repo, c.number)],
    ),
    observedAt: at,
  };
}

/** The View commits link for a digest section. */
export const digestLinks = (r: CardRepo, branch: string): GitHubFeedCard['links'] =>
  links(['View commits', githubCommitsUrl(r.owner, r.repo, branch)]);

/** The PR checks page, for a card that is about a pull request's checks. */
export const prChecksLink = (r: CardRepo, n: number): string | undefined =>
  githubPrChecksUrl(r.owner, r.repo, n);

export type { GitHubFeedKind };
