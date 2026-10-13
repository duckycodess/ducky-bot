import { createHash, randomUUID } from 'node:crypto';
import {
  GITHUB_FEED_BACKOFF_MAX_MS, GITHUB_FEED_COMMIT_BUFFER_MAX_AGE_DAYS,
  GITHUB_FEED_COMMIT_MAX_PAGES, GITHUB_FEED_COMMIT_PAGE_SIZE, GITHUB_FEED_DIGEST_MAX_SECTIONS,
  GITHUB_FEED_EVENT_BATCH, GITHUB_FEED_LIST_LIMIT, GITHUB_FEED_MAX_DELIVERY_ATTEMPTS,
  GITHUB_FEED_MAX_PR_CHECKS, GITHUB_FEED_MAX_REVIEW_REQUESTS, GITHUB_FEED_MAX_SELECTED,
  GITHUB_FEED_UNIT_BATCH, GITHUB_DIGEST_STALE_AFTER_MS,
  GITHUB_DIGEST_SWEEP_GRACE_MS, GitHubFeedCardSchema,
  canonicalRepoKey, githubFeedTarget, parseRepoKey, zonedDateKey,
  type CommitsPage, type GitHubCommitDigestSection, type PrList, type GitHubFeedCard, type GitHubFeedKind,
  type GitHubFeedTarget,
} from '@ducky/contracts';
import { redact, type GitHubReader } from '@ducky/adapters';
import {
  withTransaction,
  type GitHubFeedCommitRow, type GitHubFeedCursorKind, type GitHubFeedCursorRow,
  type GitHubFeedDigestRow, type GitHubFeedEventRow, type GitHubFeedRepoRow, type NewFeedCommit,
  type NewFeedEvent, type Store,
} from '@ducky/persistence';
import type { RepoAllowlist } from './allowlist.js';
import type { OwnerClock } from './owner-clock.js';
import { slotInstantMs } from './briefing-notifications.service.js';
import {
  changesRequestedCard, checkFailedCard, digestLinks, externalCheckFailedCard, issueOpenedCard, prOpenedCard,
  reviewRequestedCard, type CardRepo,
} from './github-feed-cards.js';
import { channelTarget, dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { githubDigestMessage, githubFeedMessage } from '../discord/github-feed-presenters.js';

export interface GitHubFeedConfig {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  /** Repositories named outright. Added to the selected list, nothing else. */
  readonly explicitRepos: readonly string[];
  /** Seeds the owner does not want on the list. */
  readonly excludedRepos: readonly string[];
  /**
   * The operator's statement that the account `gh` is signed in as IS the owner,
   * which is what makes `user-review-requested:@me` the owner's review queue.
   */
  readonly reviewRequests: boolean;
  /** Local `HH:MM` of the daily digest. */
  readonly digestAt: string;
  /** The GitHub-updates channel, when one is configured. Delivery only. */
  readonly channelId?: string | undefined;
}

export interface GitHubFeedDeps {
  readonly store: Store;
  readonly reader: GitHubReader;
  readonly transport: DiscordTransport;
  /** Frozen configuration, never a stored row. */
  readonly ownerId: string;
  readonly clock: OwnerClock;
  /** Read only, to seed the selected list. Nothing here ever writes to it. */
  readonly allowlist: RepoAllowlist;
  readonly config: GitHubFeedConfig;
  /**
   * Whether an imported notification-only target already observes this kind of
   * event for a repository, so announcing it here as well would say it twice.
   *
   * It decides ONE thing -- that a native proactive card is skipped -- and it
   * changes no job read and no authorization. Omitted means nothing is
   * suppressed.
   */
  readonly coveredByImport?: ((repoKey: string, kind: GitHubFeedKind) => boolean) | undefined;
}

export interface GitHubFeedTickResult {
  /** Units read successfully. */
  readonly observed: number;
  readonly failed: number;
  /** New alerts recorded this tick (not the baseline rows). */
  readonly recorded: number;
  readonly delivered: number;
  readonly deliveryFailed: number;
  readonly abandoned: number;
  readonly skipped: number;
  readonly digestsDelivered: number;
  readonly digestsSkipped: number;
}

const EMPTY: GitHubFeedTickResult = Object.freeze({
  observed: 0, failed: 0, recorded: 0, delivered: 0, deliveryFailed: 0, abandoned: 0, skipped: 0,
  digestsDelivered: 0, digestsSkipped: 0,
});

/** How long a repository's visibility, once read, may be trusted. Never persisted. */
export const GITHUB_FEED_VISIBILITY_FRESH_MS = 5 * 60_000;
/** Digest messages sent per target per run; any further sections wait for the next digest. */
const DIGEST_MAX_MESSAGES = 3;
const DIGEST_ROWS_PER_TICK = 4;
const REPO_KINDS = ['prs', 'issues', 'runs', 'checks', 'commits'] as const satisfies readonly GitHubFeedCursorKind[];
const FAILED_CONCLUSIONS = /^(failure|timed_out|startup_failure)$/i;

const login = (a: { login?: string | undefined } | null | undefined): string | undefined =>
  a?.login === undefined ? undefined : redact(a.login).slice(0, 80);

/**
 * Actionable GitHub events as they are observed, and one daily commit digest.
 *
 * Read-only, bounded and durable. It reads GitHub through the existing
 * `GitHubReader` port, records WHAT IT SAW before anything is delivered, and
 * delivers from the record, so a failing Discord never causes a re-read and a
 * failing GitHub never causes a re-send.
 *
 * ## The properties it is built around
 *
 * - **History is not news.** The first successful read of each kind records
 *   everything that already exists as `baseline`, which is never delivered. A
 *   read that FAILED records nothing at all, so an unreachable repository can
 *   never become an empty baseline that makes its whole history look new later.
 * - **One identity per fact.** Every event has a stable key (repository and
 *   number, a review's own id, a workflow run's id and rerun attempt) under a
 *   UNIQUE constraint, so a repeated poll, an overlapping tick and a restart
 *   cannot announce anything twice.
 * - **Reads fail independently.** Each (repository, kind) unit has its own
 *   cursor, backoff and baseline. One repository, or one kind of read, failing
 *   delays only itself, and says so in `/status` rather than going quiet.
 * - **Visibility is read fresh and never stored.** A card reaches the channel
 *   only when the channel is configured, the repository is on the selected list
 *   and a repoView read within the last few minutes says it is public. Anything
 *   else, including a failed read, goes to the owner's DM. A card is never sent
 *   somewhere on the strength of what it was when it was first observed.
 * - **Reading is not authority.** Nothing here is reachable from Discord, and
 *   no card carries a control. Selection is not a job allowlist: this service
 *   never writes to `repos`, never sets `allowJobs`, and a selected repository
 *   is an owner/repo identity with no checkout and no write path.
 * - **It needs no model.** There is no conversation provider anywhere in this
 *   file, so a paused subscription quota cannot stop a poll or a digest.
 */
export class GitHubFeedService {
  private readonly store: Store;
  private readonly reader: GitHubReader;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;
  private readonly clock: OwnerClock;
  private readonly allowlist: RepoAllowlist;
  private readonly config: GitHubFeedConfig;
  private readonly coveredByImport: GitHubFeedDeps['coveredByImport'];
  private readonly visibility = new Map<string, { at: number; isPrivate: boolean }>();
  private ticking: Promise<GitHubFeedTickResult> | null = null;
  /** One open-PR read per repository per tick, shared by the `prs` and `checks` units. */
  private prListMemo = new Map<string, Promise<PrList>>();

  constructor(deps: GitHubFeedDeps) {
    this.store = deps.store;
    this.reader = deps.reader;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.clock = deps.clock;
    this.allowlist = deps.allowlist;
    this.config = deps.config;
    this.coveredByImport = deps.coveredByImport;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // ---- the selected list --------------------------------------------------------

  /**
   * Brings the stored selected list in line with configuration, and returns what
   * changed.
   *
   * The desired list is the enabled, GitHub-mapped allowlist repositories
   * (minus the excluded ones) plus the explicitly named ones. Three rules keep
   * this from ever doing something surprising:
   *
   * - **A cancelled seed is not recreated.** The row survives cancellation as a
   *   tombstone, so a repository taken off the list stays off when the same seed
   *   is reconciled again. Only an EXPLICIT naming brings one back, and it comes
   *   back with its baseline reset, so what happened meanwhile is not announced.
   * - **Nothing is published by reconciling.** It writes selection rows and
   *   nothing else; events come only from reads.
   * - **The allowlist is read, never written.** Selection widens nothing a job or
   *   a write could reach.
   */
  reconcileSelection(): { added: number; cancelled: number; reactivated: number; refused: number } {
    const out = { added: 0, cancelled: 0, reactivated: 0, refused: 0 };
    if (!this.config.enabled) return out;
    const at = this.clock.nowIso();
    const repo = this.store.githubFeed;

    const excluded = new Set(this.config.excludedRepos.map(canonicalRepoKey));
    const explicit = new Map(this.config.explicitRepos.map((k) => [canonicalRepoKey(k), k]));
    const desired = new Map<string, { display: string; source: 'seed' | 'explicit' }>();

    for (const r of this.allowlist.list()) {
      if (!r.enabled || r.github === null) continue;
      const display = `${r.github.owner}/${r.github.repo}`;
      const key = canonicalRepoKey(display);
      if (excluded.has(key)) continue;
      desired.set(key, { display, source: 'seed' });
    }
    for (const [key, display] of explicit) desired.set(key, { display, source: 'explicit' });

    withTransaction(this.store.db, () => {
      for (const [key, want] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
        const row = repo.repoByKey(key);
        if (!row) {
          if (repo.countActiveRepos() >= GITHUB_FEED_MAX_SELECTED) {
            out.refused += 1;
            continue;
          }
          if (repo.insertRepo({ repoKey: key, display: want.display, source: want.source, atIso: at })) {
            out.added += 1;
          }
        } else if (row.state === 'cancelled') {
          // Only the owner naming it outright brings a cancelled repository back.
          if (want.source === 'explicit' && repo.reactivateRepo(key, 'explicit', at)) out.reactivated += 1;
        } else if (want.source === 'explicit' && row.source !== 'explicit') {
          repo.setRepoSource(key, 'explicit', at);
        }
      }
      for (const row of repo.listRepos('active')) {
        if (!desired.has(row.repoKey) && repo.cancelRepo(row.repoKey, at)) out.cancelled += 1;
      }
    });
    return out;
  }

  /** The selected list, for `/status` and tests. */
  selected(): GitHubFeedRepoRow[] {
    return this.store.githubFeed.listRepos('active');
  }

  /**
   * An honest account of coverage: how many repositories, and which reads are
   * currently failing. Never a count of things that worked as proof that
   * everything did.
   */
  statusLine(): string {
    if (!this.config.enabled) return 'off';
    const repos = this.store.githubFeed.countActiveRepos();
    const bad = this.store.githubFeed.degradedCursors();
    const where = this.config.channelId ? 'public selected repositories in the channel, the rest in your DM' : 'your DM';
    const reviews = this.config.reviewRequests ? 'review requests on' : 'review requests off';
    const base = `on: ${repos} selected ${repos === 1 ? 'repository' : 'repositories'}, ${reviews}, ` +
      `digest at ${this.config.digestAt}, to ${where}`;
    const notes: string[] = [];
    if (bad.length > 0) {
      notes.push(`${bad.length} read${bad.length === 1 ? '' : 's'} failing and retrying with backoff`);
    }
    const unread = this.store.githubFeed.listRepos('active').reduce((n, r) => {
      return n + parseCheckState(this.store.githubFeed.cursor(r.repoKey, 'checks')?.meta ?? null).unread;
    }, 0);
    if (unread > 0) notes.push(`${unread} pull request check read${unread === 1 ? '' : 's'} skipped last pass`);
    if (this.config.reviewRequests &&
        parseRequestState(this.store.githubFeed.cursor('@me', 'review_requests')?.meta ?? null).saturated) {
      notes.push(`review request window full, so only the ${GITHUB_FEED_MAX_REVIEW_REQUESTS} most recently updated are watched`);
    }
    return notes.length === 0 ? base : `${base}. Degraded: ${notes.join('; ')}`;
  }

  // ---- the tick ---------------------------------------------------------------------

  async tick(): Promise<GitHubFeedTickResult> {
    if (this.ticking) return this.ticking;
    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  async waitForIdle(): Promise<void> {
    if (this.ticking) await this.ticking.catch(() => undefined);
  }

  private async runTick(): Promise<GitHubFeedTickResult> {
    if (!this.config.enabled) return EMPTY;
    const r = { ...EMPTY } as { -readonly [K in keyof GitHubFeedTickResult]: number };
    const feed = this.store.githubFeed;
    const nowIso = this.clock.nowIso();
    this.prListMemo.clear();

    for (const repo of feed.listRepos('active')) {
      for (const kind of REPO_KINDS) feed.ensureCursor(repo.repoKey, kind, nowIso);
    }
    if (this.config.reviewRequests) feed.ensureCursor('@me', 'review_requests', nowIso);

    // Claimed BEFORE the reads, so a newly due slot makes every repository due for
    // a commit read in this same tick and the digest need not wait for the next.
    this.claimDigestSlots();
    const due = feed.dueUnits(nowIso, GITHUB_FEED_UNIT_BATCH, this.config.reviewRequests);
    for (const unit of due) {
      await this.observeUnit(unit, r);
    }

    this.expireStaleCommits();
    await this.deliverEvents(r);
    await this.deliverDigests(r);
    return r;
  }

  // ---- observation ----------------------------------------------------------------------

  private async observeUnit(
    unit: GitHubFeedCursorRow,
    r: { -readonly [K in keyof GitHubFeedTickResult]: number },
  ): Promise<void> {
    const nowMs = this.clock.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const interval = this.config.intervalMinutes * 60_000;
    try {
      const read = await this.read(unit, nowIso);
      const committed = withTransaction(this.store.db, () =>
        this.store.githubFeed.recordSuccess({
          scope: unit.scope, kind: unit.kind, expectedNextCheckAt: unit.nextCheckAt,
          nextCheckAt: new Date(nowMs + interval).toISOString(), atIso: nowIso,
          baseline: unit.baselinedAt === null,
          cursor: read.cursor, meta: read.meta ?? null,
          events: read.events,
          ...(read.commits ? { commits: read.commits } : {}),
        }));
      if (committed) {
        r.observed += 1;
        r.recorded += read.events.filter((e) => e.status === 'pending').length;
        if (read.gap) this.store.githubFeed.setCommitGap(unit.scope, nowIso);
      }
    } catch {
      // The failure is recorded on the unit alone. No baseline, no cursor and no
      // dedup state moves, so the next success sees exactly what this one would
      // have, and an empty answer is never invented from a failed one.
      const failures = unit.failures + 1;
      const delay = Math.min(interval * 2 ** Math.min(failures, 10), GITHUB_FEED_BACKOFF_MAX_MS);
      this.store.githubFeed.recordFailure({
        scope: unit.scope, kind: unit.kind, expectedNextCheckAt: unit.nextCheckAt,
        nextCheckAt: new Date(nowMs + Math.max(delay, interval)).toISOString(),
        error: 'The GitHub read failed.', atIso: nowIso,
      });
      r.failed += 1;
    }
  }

  private async read(unit: GitHubFeedCursorRow, at: string): Promise<UnitRead> {
    if (unit.kind === 'review_requests') return this.readReviewRequests(unit, at);
    const row = this.store.githubFeed.repoByKey(unit.scope);
    const ref = row ? parseRepoKey(row.display) : undefined;
    if (!row || !ref) throw new Error('unknown repository');
    const repo: CardRepo = { display: row.display, owner: ref.owner, repo: ref.repo };
    switch (unit.kind) {
      case 'prs': return this.readPrs(unit, repo, at);
      case 'issues': return this.readIssues(unit, repo, at);
      case 'runs': return this.readRuns(unit, repo, at);
      case 'checks': return this.readChecks(unit, repo, at);
      case 'commits': return this.readCommits(unit, row, repo, at);
      default: throw new Error('unknown unit');
    }
  }

  /**
   * Open pull requests: the ones newly opened, and the reviews that asked for
   * changes. One read serves both, so they share a watermark.
   *
   * The watermark is the newest GitHub-supplied timestamp ever seen for this
   * repository. An event is announced only when it is UNSEEN (its key is new)
   * AND stamped at or after the watermark. The second condition is what stops an
   * old pull request that merely rolls into the 20-newest window, after other
   * ones close, from being announced as new.
   */
  private async readPrs(unit: GitHubFeedCursorRow, repo: CardRepo, at: string): Promise<UnitRead> {
    const list = await this.openPrs(repo);
    const baseline = unit.baselinedAt === null;
    const mark = unit.cursor ?? '';
    let newest = mark;
    const cands: Cand[] = [];
    for (const pr of list) {
      if (!/^open/i.test(pr.state)) continue;
      const created = pr.createdAt ?? '';
      newest = newest > created ? newest : created;
      cands.push({
        key: `pr_opened:${unit.scope}#${pr.number}`, kind: 'pr_opened', stamp: created,
        card: () => prOpenedCard(repo, {
          number: pr.number, title: pr.title, ...optional('author', login(pr.author)),
          draft: pr.isDraft === true,
        }, at),
      });
      for (const rv of pr.latestReviews ?? []) {
        const submitted = rv.submittedAt ?? '';
        newest = newest > submitted ? newest : submitted;
        if (!/CHANGES_REQUESTED/i.test(rv.state ?? '') || !rv.id) continue;
        cands.push({
          key: `changes_requested:${unit.scope}#${pr.number}:${rv.id}`, kind: 'changes_requested',
          stamp: submitted,
          card: () => changesRequestedCard(repo, {
            number: pr.number, title: pr.title, ...optional('reviewer', login(rv.author)),
          }, at),
        });
      }
    }
    return this.sort(unit, cands, baseline, mark, 'selected', newest);
  }

  private openPrs(repo: CardRepo): Promise<PrList> {
    const key = canonicalRepoKey(repo.display);
    let pending = this.prListMemo.get(key);
    if (!pending) {
      pending = this.reader.feedPrList({ owner: repo.owner, repo: repo.repo })
        .then((l) => l.slice(0, GITHUB_FEED_LIST_LIMIT));
      this.prListMemo.set(key, pending);
    }
    return pending;
  }

  private async readIssues(unit: GitHubFeedCursorRow, repo: CardRepo, at: string): Promise<UnitRead> {
    const list = (await this.reader.feedIssueList({ owner: repo.owner, repo: repo.repo }))
      .slice(0, GITHUB_FEED_LIST_LIMIT);
    const baseline = unit.baselinedAt === null;
    const mark = unit.cursor ?? '';
    let newest = mark;
    const cands: Cand[] = [];
    for (const issue of list) {
      if (issue.state !== undefined && !/^open/i.test(issue.state)) continue;
      const created = issue.createdAt ?? '';
      newest = newest > created ? newest : created;
      cands.push({
        key: `issue_opened:${unit.scope}#${issue.number}`, kind: 'issue_opened', stamp: created,
        card: () => issueOpenedCard(repo, {
          number: issue.number, title: issue.title, ...optional('author', login(issue.author)),
        }, at),
      });
    }
    return this.sort(unit, cands, baseline, mark, 'selected', newest);
  }

  /**
   * Workflow runs that finished badly.
   *
   * A run is identified by its id AND its rerun attempt, so a rerun that fails
   * again is a second, announceable fact while the same failure seen twice is
   * one. A run that is still going is simply not a failure yet, and becomes one
   * the moment it finishes (pending-to-failed needs no special case). The
   * watermark is on `updatedAt`: a run that fails after the baseline is stamped
   * after it, and a failure from last quarter is not.
   */
  private async readRuns(unit: GitHubFeedCursorRow, repo: CardRepo, at: string): Promise<UnitRead> {
    const list = (await this.reader.feedRunList({ owner: repo.owner, repo: repo.repo }))
      .slice(0, GITHUB_FEED_LIST_LIMIT);
    const baseline = unit.baselinedAt === null;
    const mark = unit.cursor ?? '';
    let newest = mark;
    const cands: Cand[] = [];
    for (const run of list) {
      const stamp = run.updatedAt ?? '';
      if (run.status === 'completed') newest = newest > stamp ? newest : stamp;
      if (run.databaseId === undefined || run.status !== 'completed') continue;
      if (!FAILED_CONCLUSIONS.test(run.conclusion ?? '')) continue;
      const attempt = run.attempt ?? 1;
      cands.push({
        key: `check_failed:${unit.scope}:${run.databaseId}:${attempt}`, kind: 'check_failed', stamp,
        card: () => checkFailedCard(repo, {
          id: run.databaseId!, workflow: run.workflowName ?? run.displayTitle ?? '',
          ...optional('branch', run.headBranch), ...optional('sha', run.headSha),
          attempt, ...optional('conclusion', run.conclusion ?? undefined),
        }, at),
      });
    }
    return this.sort(unit, cands, baseline, mark, 'selected', newest);
  }

  /**
   * Failed checks on pull requests that are NOT Actions workflow runs: an
   * external CI system's commit status, or an app's check run.
   *
   * Actions runs are covered by `readRuns` and are skipped here (a check with a
   * `workflow`, or whose link is an Actions run), so a failing workflow is one
   * alert and not two. What is read is bounded: the newest few open pull
   * requests, one `gh pr checks` call each, so an OLDER pull request's external
   * checks are not watched.
   *
   * ## Two kinds of failure, because `gh` reports two kinds of check
   *
   * A check run carries real `startedAt`/`completedAt`. A commit STATUS comes back
   * with the Go zero time (`0001-01-01T00:00:00Z`) in both, which is a
   * placeholder and not a time. A timestamp that is empty, unparseable or before
   * 1990 is therefore MISSING, and a missing one never advances the watermark: a
   * placeholder compared as a real time would otherwise sit below every real one
   * and silence status alerts, or the reverse.
   *
   * - **Dated** failures are identified by pull request, head commit, check name
   *   and completion time, and announced when unseen and not older than the
   *   watermark. A rerun that fails again completes later, so it is a new key.
   * - **Undated** failures (a status) cannot be dated, so their identity is the
   *   pull request, head, name and an EPISODE counter, and the decision comes from
   *   what was seen before: it is announced only when that check on that head was
   *   previously seen NOT failing (pending or passing, so a failure after a
   *   pending), or the head was seen without this check failing, or the head is a
   *   new one for a pull request already known, or the pull request itself was
   *   created after this unit's baseline. A pull request or head met for the
   *   first time WITHOUT any of that (an old one rolling into the window) is
   *   recorded silently. A status that fails, passes and fails again on the same
   *   head is a second episode, hence a second key.
   *
   * ## When a read fails
   *
   * The baseline needs EVERY pull request read, or it is not a baseline at all
   * (the unit fails and backs off). After it, a pass in which ANY pull request's
   * checks could not be read keeps the old watermark and the old state for that
   * pull request, so a failure that finishes earlier than another pull request's
   * newest completion is not mistaken for history when its pull request is read
   * again. Keys deduplicate everything the partial pass already announced.
   */
  private async readChecks(unit: GitHubFeedCursorRow, repo: CardRepo, at: string): Promise<UnitRead> {
    const ref = { owner: repo.owner, repo: repo.repo };
    const prs = (await this.openPrs(repo)).filter((p) => /^open/i.test(p.state))
      .slice(0, GITHUB_FEED_MAX_PR_CHECKS);
    const baseline = unit.baselinedAt === null;
    const mark = unit.cursor ?? '';
    const prior = parseCheckState(unit.meta);
    const seen: CheckState['seen'] = { ...prior.seen };
    const knownPrs = new Set(prior.prs);
    let newest = mark;
    let unread = 0;
    const dated: Cand[] = [];
    const undated: { key: string; announce: boolean; card: () => GitHubFeedCard }[] = [];

    for (const pr of prs) {
      let checks;
      try {
        checks = await this.reader.feedPrChecks(ref, pr.number);
      } catch {
        unread += 1;
        continue;
      }
      const head = (pr.headRefOid ?? '').slice(0, 12);
      const pk = `pr${pr.number}:${head}`;
      const before = seen[pk];
      const prKnown = knownPrs.has(pr.number);
      // Is the PR itself newer than this unit's baseline? Judged from the PR's own
      // creation time, NOT from whether the pull-request unit has recorded it yet:
      // that unit may be backing off or scheduled after this one, and a failure
      // recorded silently here would never be announced by it later. An old PR
      // rolling into the window was created before the baseline and stays silent.
      // (The local clock and GitHub's can differ by seconds, so a PR created in
      // the instant around the baseline may go either way.)
      const created = Date.parse(realStamp(pr.createdAt));
      const openedSinceBaseline = !baseline && !Number.isNaN(created) &&
        created >= Date.parse(unit.baselinedAt ?? '');
      const after: Record<string, { s: 'f' | 'n'; e: number }> = {};

      for (const c of checks.slice(0, 50)) {
        const actionsBacked = (c.workflow ?? '') !== '' || /\/actions\/runs\/\d+/.test(c.link ?? '');
        if (actionsBacked) continue;
        const bucket = (c.bucket ?? '').toLowerCase();
        const done = realStamp(c.completedAt);
        const stamp = done || realStamp(c.startedAt);
        const id = createHash('sha256').update(c.name).digest('hex').slice(0, 12);
        const prev = before?.[id];
        const card = (): GitHubFeedCard => externalCheckFailedCard(repo, {
          number: pr.number, check: c.name, pullTitle: pr.title, ...optional('sha', pr.headRefOid),
        }, at);

        // Only a REAL completion time moves the watermark. A pending check, or a
        // placeholder time, never does.
        if (bucket !== 'pending' && done !== '') newest = newest > done ? newest : done;

        if (bucket !== 'fail') {
          after[id] = { s: 'n', e: prev?.e ?? 0 };
          continue;
        }
        if (stamp !== '') {
          dated.push({
            key: `check_failed:${unit.scope}:pr${pr.number}:${head}:${id}:${stamp}`,
            kind: 'check_failed', stamp, card,
          });
          after[id] = { s: 'f', e: prev?.e ?? 0 };
          continue;
        }
        // Undated: a new episode starts when it was not already failing.
        const fresh = prev === undefined || prev.s === 'n';
        const e = (prev?.e ?? 0) + (fresh ? 1 : 0);
        after[id] = { s: 'f', e };
        if (!fresh) continue;
        const announce = !baseline && (
          prev?.s === 'n' || before !== undefined || prKnown || openedSinceBaseline
        );
        undated.push({
          key: `check_failed:${unit.scope}:pr${pr.number}:${head}:${id}:undated:e${e}`, announce, card,
        });
      }
      delete seen[pk];
      seen[pk] = after;
      knownPrs.add(pr.number);
    }

    if (prs.length > 0 && unread === prs.length) throw new Error('no pull request checks could be read');
    // A baseline that skipped any pull request is not one: it would call the
    // unread pull request's existing failures new when it is finally read.
    if (baseline && unread > 0) throw new Error('baseline needs every pull request read');

    const sorted = this.sort(unit, dated, baseline, mark, 'selected', unread > 0 ? mark : newest);
    const knownKeys = this.store.githubFeed.knownEventKeys(undated.map((u) => u.key));
    const extra: NewFeedEvent[] = undated.filter((u) => !knownKeys.has(u.key)).map((u) => ({
      id: randomUUID(), eventKey: u.key, kind: 'check_failed', repoKey: unit.scope, origin: 'selected',
      cardJson: u.announce ? JSON.stringify(u.card()) : null, status: u.announce ? 'pending' : 'baseline',
    }));
    const keep = Object.fromEntries(Object.entries(seen).slice(-60));
    const state: CheckState = { unread, prs: [...knownPrs].slice(-200), seen: keep };
    return { ...sorted, events: [...sorted.events, ...extra], meta: JSON.stringify(state) };
  }

  /**
   * Review requests aimed at the owner personally, across every repository the
   * signed-in account can see. Not scoped to the selected list, which is the
   * point; and it adds nothing TO it. The search has no request timestamp, so a
   * request's key is the only memory that it was announced, and retention never
   * deletes one.
   */
  private async readReviewRequests(unit: GitHubFeedCursorRow, at: string): Promise<UnitRead> {
    const found = await this.reader.reviewRequests();
    const baseline = unit.baselinedAt === null;
    const prior = parseRequestState(unit.meta);
    const saturated = found.length >= GITHUB_FEED_MAX_REVIEW_REQUESTS;
    const mark = unit.cursor ?? '';
    let newest = mark;

    interface Item { display: string; owner: string; repo: string; key: string; pr: (typeof found)[number] }
    const present = new Map<string, Item>();
    for (const pr of found) {
      const parsed = parseRepoKey(pr.repository.nameWithOwner);
      if (!parsed) continue;
      const display = `${parsed.owner}/${parsed.repo}`;
      const key = canonicalRepoKey(display);
      present.set(`${key}#${pr.number}`, { display, owner: parsed.owner, repo: parsed.repo, key, pr });
      const updated = pr.updatedAt ?? '';
      newest = newest > updated ? newest : updated;
    }

    /**
     * A request has an EPISODE. The search carries no request timestamp, so
     * identity comes from presence instead: while a pull request keeps appearing
     * it is one request; when it is absent from a read that was NOT full it has
     * ended (reviewed, dismissed, closed), and its next appearance is a renewed
     * request with a new key. A read that is full (the window is bounded to the
     * most recently updated requests) cannot tell "ended" from "pushed out", so
     * nothing is concluded from absence then, and an old request that merely
     * rolls back in is never announced. Both are dated by `updatedAt` as well:
     * a renewed or newly made request touches the pull request, an old one
     * rolling in does not.
     */
    const active = new Set(prior.active);
    const ended = new Set(prior.ended);
    const episodes = { ...prior.episodes };
    if (!saturated) {
      for (const id of prior.active) {
        if (!present.has(id)) {
          active.delete(id);
          ended.add(id);
        }
      }
    }
    const cands: Cand[] = [];
    for (const [id, item] of present) {
      let episode = episodes[id] ?? 1;
      if (!baseline && !active.has(id) && ended.has(id)) {
        episode += 1;
        episodes[id] = episode;
        ended.delete(id);
      }
      active.add(id);
      const display = item.display;
      cands.push({
        key: `review_requested:${id}${episode > 1 ? `:e${episode}` : ''}`,
        kind: 'review_requested', stamp: item.pr.updatedAt ?? '', repoKey: item.key,
        card: () => reviewRequestedCard({ display, owner: item.owner, repo: item.repo }, {
          number: item.pr.number, title: item.pr.title, ...optional('author', login(item.pr.author)),
          draft: item.pr.isDraft === true,
        }, at),
      });
    }
    // A PR that is still active (same episode) is already known by key and is
    // skipped by `sort`; a first sighting is dated by the watermark.
    const read = this.sort(unit, cands, baseline, mark, 'discovery', newest);
    const bound = (xs: Iterable<string>, n: number): string[] => [...xs].slice(-n);
    return {
      ...read,
      meta: JSON.stringify({
        active: bound(active, 100), ended: bound(ended, 100), saturated,
        episodes: Object.fromEntries(Object.entries(episodes).slice(-100)),
      }),
    };
  }

  /**
   * Commits on the default branch, direct pushes included.
   *
   * Reads newest-first from the head, at most three pages, and records every
   * commit whose (repository, sha) has not been seen. The walk stops at the
   * previous head once it is reached, so an ordinary poll is one request. Three
   * cases are handled on purpose rather than left to fall out:
   *
   * - **First read, or a renamed default branch.** The newest pages are recorded
   *   as already-seen, and the head becomes the cursor. Nothing is reported.
   * - **The previous head is not in the window** (a force-push, or more new
   *   commits than the walk may read). Only unseen commits committed since the
   *   last successful read are reported; the rest are recorded as seen; and the
   *   repository is flagged so the next digest says coverage may be incomplete.
   * - **A failed read** records nothing at all.
   */
  private async readCommits(
    unit: GitHubFeedCursorRow, row: GitHubFeedRepoRow, repo: CardRepo, at: string,
  ): Promise<UnitRead> {
    const ref = { owner: repo.owner, repo: repo.repo };
    const view = await this.reader.repoView(ref);
    if (typeof view.isPrivate === 'boolean') this.remember(unit.scope, view.isPrivate);
    const branch = view.defaultBranchRef?.name;
    if (!branch) throw new Error('no default branch');
    if (row.defaultBranch !== branch) this.store.githubFeed.setDefaultBranch(unit.scope, branch, at);

    const fresh = unit.baselinedAt === null || unit.meta !== branch;
    const window: CommitsPage = [];
    let found = false;
    for (let page = 1; page <= GITHUB_FEED_COMMIT_MAX_PAGES; page += 1) {
      const items = await this.reader.commits(ref, branch, page);
      window.push(...items);
      const at = fresh ? -1 : items.findIndex((c) => c.sha === unit.cursor);
      if (at >= 0) found = true;
      // End of history: nothing further to read.
      if (items.length < GITHUB_FEED_COMMIT_PAGE_SIZE) break;
      // An ordinary poll is one request: stop once the previous head is reached
      // and everything older than it on that page is already known. Anything
      // else keeps reading, up to the page cap.
      if (found && at >= 0) {
        const tail = items.slice(at + 1).map((c) => c.sha);
        if (this.store.githubFeed.knownShas(unit.scope, tail).size === tail.length) break;
      }
    }

    const head = window[0]?.sha ?? null;
    const known = this.store.githubFeed.knownShas(unit.scope, window.map((c) => c.sha));
    const unseen = window.filter((c) => !known.has(c.sha));
    const since = unit.lastSuccessAt ? Date.parse(unit.lastSuccessAt) - 5 * 60_000 : Number.NaN;
    const gap = !fresh && !found && unseen.length > 0;

    const rows: NewFeedCommit[] = unseen.map((c) => {
      const committedAt = c.commit.committer?.date ?? c.commit.author?.date ?? at;
      const recent = !Number.isNaN(since) && Date.parse(committedAt) >= since;
      return {
        sha: c.sha,
        headline: redact((c.commit.message ?? '').split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
        author: redact(c.author?.login ?? c.commit.author?.name ?? '').slice(0, 80),
        committedAt,
        baseline: fresh || (gap && !recent),
      };
    });
    return {
      events: [], cursor: head ?? unit.cursor, meta: branch, gap,
      commits: { repoKey: unit.scope, branch, rows },
    };
  }

  /**
   * Turns candidates into rows.
   *
   * Baseline, or an unstamped one, or one stamped before the watermark, is
   * recorded as `baseline` -- remembered, never delivered. Everything else that
   * is unseen becomes a pending alert.
   */
  private sort(
    unit: GitHubFeedCursorRow, cands: Cand[], baseline: boolean, mark: string,
    origin: 'selected' | 'discovery', newest: string | null,
  ): UnitRead {
    const known = this.store.githubFeed.knownEventKeys(cands.map((c) => c.key));
    const events: NewFeedEvent[] = [];
    for (const c of cands) {
      if (known.has(c.key)) continue;
      const announce = !baseline && c.stamp !== '' && c.stamp >= mark;
      events.push({
        id: randomUUID(), eventKey: c.key, kind: c.kind, repoKey: c.repoKey ?? unit.scope, origin,
        cardJson: announce ? JSON.stringify(c.card()) : null,
        status: announce ? 'pending' : 'baseline',
      });
    }
    return { events, cursor: newest ?? unit.cursor };
  }

  // ---- delivery: alerts ------------------------------------------------------------------------

  private async deliverEvents(r: { -readonly [K in keyof GitHubFeedTickResult]: number }): Promise<void> {
    const feed = this.store.githubFeed;
    for (const event of feed.pendingEvents(GITHUB_FEED_EVENT_BATCH)) {
      const at = this.clock.nowIso();
      const repo = feed.repoByKey(event.repoKey);
      const selected = repo?.state === 'active';
      // An alert about a repository that is no longer on the list is retired, not sent.
      if (event.origin === 'selected' && !selected) {
        feed.markEventSkipped(event.id, at);
        r.skipped += 1;
        continue;
      }
      // The imported typed observation takes precedence for the events it
      // covers: the owner hears about it once, privately, and the shared channel
      // card for the same fact is retired rather than sent.
      if (this.coveredByImport?.(event.repoKey, event.kind)) {
        feed.markEventSkipped(event.id, at);
        r.skipped += 1;
        continue;
      }
      const card = parseCard(event);
      if (!card) {
        feed.recordEventFailure(event.id, at, 1);
        r.abandoned += 1;
        continue;
      }
      try {
        const target = await this.routeFor(repo, selected);
        await this.transport.send(
          target === 'github_channel' ? channelTarget(this.config.channelId!) : dmTarget(this.ownerId),
          githubFeedMessage(card),
        );
        feed.markEventDelivered(event.id, at, target);
        r.delivered += 1;
      } catch {
        feed.recordEventFailure(event.id, at, GITHUB_FEED_MAX_DELIVERY_ATTEMPTS);
        if (event.attempts + 1 >= GITHUB_FEED_MAX_DELIVERY_ATTEMPTS) r.abandoned += 1;
        else r.deliveryFailed += 1;
      }
    }
  }

  /**
   * Where one card may go, decided NOW.
   *
   * Visibility is read from GitHub at send time (or from a read made within the
   * last few minutes), never from what was true when the event was observed. A
   * read that fails resolves to the DM, so an outage can only make a card more
   * private, never less.
   */
  private async routeFor(repo: GitHubFeedRepoRow | undefined, selected: boolean): Promise<GitHubFeedTarget> {
    const channelConfigured = this.config.channelId !== undefined;
    if (!channelConfigured || !selected || !repo) return 'owner_dm';
    return githubFeedTarget({ channelConfigured, selected, isPrivate: await this.isPrivate(repo) });
  }

  private remember(repoKey: string, isPrivate: boolean): void {
    this.visibility.set(repoKey, { at: this.clock.nowMs(), isPrivate });
  }

  /** `undefined` means "could not be established", which every caller treats as private. */
  private async isPrivate(repo: GitHubFeedRepoRow): Promise<boolean | undefined> {
    const cached = this.visibility.get(repo.repoKey);
    if (cached && this.clock.nowMs() - cached.at <= GITHUB_FEED_VISIBILITY_FRESH_MS) return cached.isPrivate;
    this.visibility.delete(repo.repoKey);
    const ref = parseRepoKey(repo.display);
    if (!ref) return undefined;
    try {
      const view = await this.reader.repoView(ref);
      if (typeof view.isPrivate !== 'boolean') return undefined;
      this.remember(repo.repoKey, view.isPrivate);
      return view.isPrivate;
    } catch {
      return undefined;
    }
  }

  // ---- delivery: the daily commit digest -----------------------------------------------------------

  private expireStaleCommits(): void {
    const nowMs = this.clock.nowMs();
    const cutoff = new Date(nowMs - GITHUB_FEED_COMMIT_BUFFER_MAX_AGE_DAYS * 86_400_000).toISOString();
    this.store.githubFeed.expireOpenCommits(cutoff, new Date(nowMs).toISOString());
  }

  /**
   * Records that today's slot has come due, once per target.
   *
   * Only TODAY's slot is ever claimed. A day the host was off produces no row, so
   * a restart after a long outage does not replay a week of digests: the commits
   * it would have described are still open and are in the next one, bounded.
   */
  private claimDigestSlots(): void {
    const nowMs = this.clock.nowMs();
    const tz = this.clock.timeZone;
    const dayKey = zonedDateKey(nowMs, tz);
    const dueMs = slotInstantMs(dayKey, this.config.digestAt, tz);
    if (dueMs === undefined || dueMs > nowMs) return;
    const targets: GitHubFeedTarget[] = this.config.channelId ? ['github_channel', 'owner_dm'] : ['owner_dm'];
    let claimed = false;
    for (const target of targets) {
      claimed = this.store.githubFeed.claimDigest({
        id: randomUUID(), discordUserId: this.ownerId, dayKey, target,
        dueAt: new Date(dueMs).toISOString(),
      }) || claimed;
    }
    // A new slot asks every selected repository for a commit read AFTER the slot,
    // so a commit pushed at 08:58 is not left to tomorrow by a 09:05 poll.
    if (claimed) {
      const at = this.clock.nowIso();
      for (const repo of this.store.githubFeed.listRepos('active')) {
        this.store.githubFeed.makeDue(repo.repoKey, 'commits', at);
      }
    }
  }

  private async deliverDigests(r: { -readonly [K in keyof GitHubFeedTickResult]: number }): Promise<void> {
    const feed = this.store.githubFeed;
    // The channel row is processed before the DM row, so a section that turns
    // out private at send time is still there for the DM row to pick up.
    const pending = feed.pendingDigests(DIGEST_ROWS_PER_TICK * 2)
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey) || (a.target === b.target ? 0 : a.target === 'github_channel' ? -1 : 1))
      .slice(0, DIGEST_ROWS_PER_TICK);
    for (const row of pending) await this.deliverDigestRow(row, r);
  }

  private async deliverDigestRow(
    row: GitHubFeedDigestRow,
    r: { -readonly [K in keyof GitHubFeedTickResult]: number },
  ): Promise<void> {
    const feed = this.store.githubFeed;
    const nowMs = this.clock.nowMs();
    const at = new Date(nowMs).toISOString();
    const dueMs = Date.parse(row.dueAt);

    // A slot that came due during a long outage describes a day that has gone. It
    // is kept as a record and NOT sent; its commits stay open for the next digest.
    if (row.discordUserId !== this.ownerId ||
        (Number.isFinite(dueMs) && nowMs - dueMs > GITHUB_DIGEST_STALE_AFTER_MS)) {
      feed.markDigestSkipped(row.id, at, 'stale');
      r.digestsSkipped += 1;
      return;
    }
    if (row.target === 'github_channel' && this.config.channelId === undefined) {
      feed.markDigestSkipped(row.id, at, 'channel no longer configured');
      r.digestsSkipped += 1;
      return;
    }

    const active = feed.listRepos('active');
    const swept = active.every((a) => {
      const c = feed.cursor(a.repoKey, 'commits');
      return c?.lastSuccessAt !== null && c?.lastSuccessAt !== undefined && c.lastSuccessAt >= row.dueAt;
    });
    if (!swept && nowMs - dueMs < GITHUB_DIGEST_SWEEP_GRACE_MS) return;

    try {
      const plan = await this.planDigest(active);
      const own = row.target === 'github_channel' ? plan.channel : plan.dm;
      const unreadable = row.target === 'owner_dm' ? plan.unreadable : [];
      let sent = 0;
      sent += await this.sendDigestParts(row, own, row.target, unreadable);

      // A section that is private (or whose visibility could not be read) NOW is
      // never dropped and never sent to the channel: if the DM slot for the day
      // has already settled, it goes to the DM here, now.
      if (row.target === 'github_channel' && plan.dm.length > 0) {
        const dmRow = feed.digestBySlot(this.ownerId, row.dayKey, 'owner_dm');
        if (dmRow !== undefined && dmRow.status !== 'pending') {
          sent += await this.sendDigestParts(row, plan.dm, 'owner_dm', []);
        }
      }
      if (sent === 0 && unreadable.length === 0) {
        feed.markDigestSkipped(row.id, at, 'nothing to report');
        r.digestsSkipped += 1;
      } else {
        feed.markDigestDelivered(row.id, at, `${sent} message${sent === 1 ? '' : 's'}`);
        r.digestsDelivered += 1;
      }
    } catch {
      feed.recordDigestFailure(row.id, at, GITHUB_FEED_MAX_DELIVERY_ATTEMPTS);
    }
  }

  /** Builds both halves of the digest from one set of visibility reads. */
  private async planDigest(active: readonly GitHubFeedRepoRow[]): Promise<DigestPlan> {
    const feed = this.store.githubFeed;
    const channel: PlanSection[] = [];
    const dm: PlanSection[] = [];
    const unreadable: string[] = [];
    for (const repo of active) {
      const commits = feed.openCommits(repo.repoKey);
      const cursor = feed.cursor(repo.repoKey, 'commits');
      if (cursor && cursor.failures > 0) unreadable.push(repo.display);
      if (commits.length === 0) continue;
      const ref = parseRepoKey(repo.display);
      if (!ref) continue;
      const branch = repo.defaultBranch ?? 'main';
      const newestFirst = [...commits].reverse();
      const section: PlanSection = {
        repoKey: repo.repoKey,
        shas: commits.map((c) => c.sha),
        section: {
          repo: repo.display, branch,
          commits: newestFirst.map((c: GitHubFeedCommitRow) => ({ sha: c.sha, headline: c.headline, author: c.author })),
          total: commits.length, truncated: repo.commitGapAt !== null,
          links: digestLinks({ display: repo.display, ...ref }, branch),
        },
      };
      const toChannel = this.config.channelId !== undefined && (await this.isPrivate(repo)) === false;
      (toChannel ? channel : dm).push(section);
    }
    return { channel, dm, unreadable };
  }

  /**
   * Sends sections in numbered parts (up to three messages), consuming each
   * part's commits only after that part was delivered. A failure part-way leaves
   * the row pending, and the retry carries on with what is still open.
   */
  private async sendDigestParts(
    row: GitHubFeedDigestRow, sections: readonly PlanSection[], target: GitHubFeedTarget,
    unreadable: readonly string[],
  ): Promise<number> {
    if (sections.length === 0 && unreadable.length === 0) return 0;
    const feed = this.store.githubFeed;
    const parts: PlanSection[][] = [];
    for (let i = 0; i < sections.length; i += GITHUB_FEED_DIGEST_MAX_SECTIONS) {
      parts.push(sections.slice(i, i + GITHUB_FEED_DIGEST_MAX_SECTIONS));
    }
    if (parts.length === 0) parts.push([]);
    const shown = parts.slice(0, DIGEST_MAX_MESSAGES);
    const omittedRepos = parts.slice(DIGEST_MAX_MESSAGES).reduce((n, p) => n + p.length, 0);
    const to = target === 'github_channel' ? channelTarget(this.config.channelId!) : dmTarget(this.ownerId);

    let sent = 0;
    for (const [i, part] of shown.entries()) {
      const last = i === shown.length - 1;
      await this.transport.send(to, githubDigestMessage({
        dayLabel: row.dayKey,
        sections: part.map((p) => p.section),
        ...(shown.length > 1 ? { part: { index: i + 1, of: shown.length } } : {}),
        ...(last && unreadable.length > 0 ? { unreadable } : {}),
        ...(last && omittedRepos > 0 ? { omittedRepos } : {}),
      }));
      const at = this.clock.nowIso();
      for (const p of part) {
        feed.consumeCommits(p.repoKey, p.shas, at, target);
        if (p.section.truncated) feed.setCommitGap(p.repoKey, null);
      }
      sent += 1;
    }
    return sent;
  }
}

// ---- local types and helpers ---------------------------------------------------------------------

interface UnitRead {
  readonly events: NewFeedEvent[];
  readonly cursor: string | null;
  readonly meta?: string | null;
  readonly gap?: boolean;
  readonly commits?: { repoKey: string; branch: string; rows: readonly NewFeedCommit[] };
}

interface Cand {
  readonly key: string;
  readonly kind: GitHubFeedKind;
  /** The GitHub timestamp the event is dated by. Empty means unknown. */
  readonly stamp: string;
  readonly repoKey?: string;
  readonly card: () => GitHubFeedCard;
}

interface PlanSection {
  readonly repoKey: string;
  readonly shas: readonly string[];
  readonly section: GitHubCommitDigestSection;
}

interface DigestPlan {
  readonly channel: PlanSection[];
  readonly dm: PlanSection[];
  readonly unreadable: string[];
}

/** `{}` or `{ [key]: value }`, so an absent value is absent rather than `undefined`. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** What `readChecks` remembers between passes, in the unit's cursor `meta`. */
interface CheckState {
  /** Pull requests whose checks could not be read on the last pass. */
  readonly unread: number;
  /** Pull requests ever read, so a new head on a KNOWN one is recognisably new. */
  readonly prs: number[];
  /** `pr<n>:<head>` -> check-name hash -> failing or not, and its failure episode. */
  readonly seen: Record<string, Record<string, { s: 'f' | 'n'; e: number }>>;
}

function parseCheckState(meta: string | null): CheckState {
  const empty: CheckState = { unread: 0, prs: [], seen: {} };
  if (!meta) return empty;
  try {
    const v = JSON.parse(meta) as Partial<CheckState>;
    return {
      unread: typeof v.unread === 'number' ? v.unread : 0,
      prs: Array.isArray(v.prs) ? v.prs.filter((n): n is number => typeof n === 'number') : [],
      seen: v.seen && typeof v.seen === 'object' ? v.seen : {},
    };
  } catch {
    return empty;
  }
}

/**
 * A GitHub timestamp, or '' when it is not a real one. `gh` reports the Go zero
 * time for a commit status, and an unparseable or pre-1990 value is no better.
 */
export function realStamp(v: string | null | undefined): string {
  if (!v) return '';
  const t = Date.parse(v);
  if (Number.isNaN(t) || new Date(t).getUTCFullYear() < 1990) return '';
  return v;
}

interface RequestState {
  readonly active: string[];
  readonly ended: string[];
  readonly episodes: Record<string, number>;
  readonly saturated: boolean;
}

function parseRequestState(meta: string | null): RequestState {
  const empty: RequestState = { active: [], ended: [], episodes: {}, saturated: false };
  if (!meta) return empty;
  try {
    const v = JSON.parse(meta) as Partial<RequestState>;
    return {
      active: Array.isArray(v.active) ? v.active.filter((x): x is string => typeof x === 'string') : [],
      ended: Array.isArray(v.ended) ? v.ended.filter((x): x is string => typeof x === 'string') : [],
      episodes: v.episodes && typeof v.episodes === 'object' ? v.episodes : {},
      saturated: v.saturated === true,
    };
  } catch {
    return empty;
  }
}

function parseCard(event: GitHubFeedEventRow): GitHubFeedCard | undefined {
  if (event.cardJson === null) return undefined;
  try {
    const parsed = GitHubFeedCardSchema.safeParse(JSON.parse(event.cardJson));
    return parsed.success ? (parsed.data as GitHubFeedCard) : undefined;
  } catch {
    return undefined;
  }
}
