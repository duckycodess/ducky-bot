import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_DIGEST_MAX_LINES_PER_REPO, ASSISTANT_DIGEST_MAX_REPOS, ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS,
  ASSISTANT_WATCH_BACKOFF_MAX_MS, ASSISTANT_WATCH_CALLS_PER_HOUR, ASSISTANT_WATCH_CALLS_PER_TICK,
  ASSISTANT_WATCH_EVENT_BATCH, ASSISTANT_WATCH_EVENT_KEEP_DAYS, ASSISTANT_WATCH_INTERVAL_MINUTES,
  ASSISTANT_WATCH_MAX_PAGES, ASSISTANT_WATCH_PAGE_SIZE, DuckyError, GITHUB_FEED_COMMIT_MAX_PAGES,
  ASSISTANT_WATCH_CYCLE_TARGETS, ASSISTANT_WATCH_DISCOVERY_INTERVAL_HOURS, ASSISTANT_WATCH_MAX_TARGETS,
  ASSISTANT_WATCH_METADATA_INTERVAL_HOURS, GH_OWNER_RE, GH_REPO_RE, isPlainRepoName, WATCH_API_DISCOVERY_MAX_PAGES,
  WATCH_API_REVIEWS_MAX_PAGES, WATCH_EVENT_KINDS, newPublicWatchId, WATCH_EVENT_SURFACE, WATCH_RELEASES_MAX_PAGES,
  WATCH_RUNS_MAX_PAGES, AUDIT_OWNER_REF, type GitHubFeedKind, type WatchEventKind, type WatchSurface,
} from '@ducky/contracts';
import {
  withTransaction, type DueCheckpoint, type ObservedEventWrite, type PollCycle, type Store,
  type WatchEventWithTarget, type WatchTargetRow,
} from '@ducky/persistence';
import { dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { assistantWatchAlert } from '../discord/assistant-presenters.js';
import type { ActorContext, Authorizer } from '../security/authz.js';
import {
  UnreadableTimestamp, bareRepoName, deriveCommits,
  deriveDefaultBranch, deriveIssues, derivePullList, deriveReleases, deriveReviews, deriveRuns,
  reviewPendingMarker, scrubText, secondBoundaryMs, type DerivedEvent, type SurfaceRead,
} from './assistant-watch.engine.js';
import {
  EMPTY_SCAN, keyOf, parseScan, serializeScan, windowHeldStill, type ScanState,
} from './assistant-watch.scan.js';
import {
  WatchReadError, type AssistantWatchReader, type CommitRecord, type IssueRecord, type Page, type PullRecord,
  type ReleaseRecord, type RunRecord, type WatchRepoRef,
} from './assistant-watch.reader.js';
import { isoOf, type OwnerClock } from './owner-clock.js';

export interface AssistantWatchServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly transport: DiscordTransport;
  /** The CONFIGURED owner: frozen configuration, never a stored row. */
  readonly ownerId: string;
  readonly clock: OwnerClock;
  readonly reader: AssistantWatchReader;
  /**
   * Frozen configuration for the real reader: the source's recency-limited poll
   * cycle, and discovery (off unless the operator enabled it and named the
   * account). Absent means a scripted or unavailable reader: every active target
   * is covered and nothing is discovered.
   */
  readonly watchConfig?: AssistantWatchConfig;
  /**
   * Whether the owner's briefing can actually carry the repository digest right now:
   * briefings on, imported preferences in force with the GitHub section, and a DM copy.
   * Absent means no: a digest nobody can receive covers nothing.
   */
  readonly digestDeliverable?: () => boolean;
  /**
   * What the owner's NATIVE paths retain, as `owner/repo` keys of the GitHub feed's selected
   * list (a durable repository identity, active or cancelled) and a count of the distinct
   * ordinary watches whose repository cannot be proven (`unprovenOrdinary`): an ordinary
   * watch is stored by an allowlist slug whose meaning is overwritten every boot, so every
   * retained one counts, whatever it maps to today. Absent means the native side cannot be
   * consulted, and turning monitoring back on is refused rather than guessed.
   */
  readonly nativeWatchedEver?: () => { readonly keys: ReadonlySet<string>; readonly unprovenOrdinary: number };
}

export type SetMonitoringOutcome =
  | { readonly ok: true; readonly changed: boolean; readonly enabled: boolean }
  | {
    readonly ok: false;
    /**
     * `ordinary_overlap`: a feed selection is retained on a repository an active target also
     * watches, OR any ordinary watch row is retained at all (its repository cannot be proven),
     * so a native path may have told the owner what a target's old checkpoint would tell again,
     * and nothing stored says when or about what. `overlap_unverifiable`: the native
     * side could not be consulted. Both refuse; neither resets a checkpoint.
     */
    readonly reason: 'ordinary_overlap' | 'overlap_unverifiable';
    readonly overlapping: number;
  };

export interface AssistantWatchConfig {
  /** The GitHub login that IS the owner, used to classify a repository's relationship. */
  readonly account: string | null;
  /** Whether the source's recency-limited cycle applies. */
  readonly cycle: boolean;
  readonly discovery: boolean;
  /** Which relationships discovery may store; anything else never reaches the database. */
  readonly relationships: ReadonlySet<'owner' | 'organization' | 'collaborator'>;
  readonly includeForks: boolean;
  readonly includeArchived: boolean;
}

export interface AssistantWatchTickResult {
  /** Units (one page of one surface of one target) read to the end of what they could. */
  readonly completed: number;
  /** Units that read a page but whose window is not yet closed. */
  readonly incomplete: number;
  readonly failed: number;
  /** Units set aside because the reader cannot observe their surface. */
  readonly blocked: number;
  readonly callsUsed: number;
  /** True when the tick stopped because the next unit would not fit the budget. */
  readonly budgetStopped: boolean;
  readonly alertsSent: number;
  readonly alertsFailed: number;
}

/** A digest of unread events, and the ids a briefing must settle once it is sent. */
export interface WatchDigest {
  readonly repos: readonly { readonly name: string; readonly lines: readonly string[] }[];
  readonly attention: readonly string[];
  readonly eventIds: readonly string[];
  readonly truncatedRepos: number;
  readonly empty: boolean;
}

const MINUTE = 60_000;

/** Every surface a target is read through; `ci_state` moves with `runs` and has no read of its own. */
const WATCH_SURFACES_OBSERVED: readonly WatchSurface[] = [
  'commits', 'pulls', 'issues', 'runs', 'releases', 'default_branch',
];

/**
 * Which native feed events an imported target's observation already covers, and
 * through which surface.
 *
 * Only a kind whose imported surface sees EVERY instance of it is listed. The
 * imported pulls surface reads every pull request of the repository and the
 * reviews on the open ones, and the issues surface every issue, so a native
 * pull-request, issue or change-request card is a duplicate of what that
 * surface will say.
 *
 * Deliberately absent:
 * - `review_requested`: a search across repositories, not a fact about a watched
 *   one, which nothing imported produces.
 * - `check_failed`: the native feed also reports failing checks and external
 *   statuses on PULL REQUEST heads, and the imported runs surface reads only the
 *   default branch's workflow runs. Suppressing on its behalf would silently
 *   drop a failure that only the native feed ever sees. Until an imported
 *   surface can carry the identity of a failing check exactly, it is not
 *   suppressed.
 *
 * The ORDINARY `github_watches` snapshot DM is trimmed the same way, part by part,
 * in `GitHubWatchService` (ADR 0032).
 */
export const IMPORT_COVER_DELIVERY: Partial<Record<GitHubFeedKind, 'immediate' | 'digest'>> = {
  // A requested change interrupts: an imported alert is sent the moment it is found.
  changes_requested: 'immediate',
  // Everything else an imported surface tells waits for a briefing digest.
  pr_opened: 'digest',
  issue_opened: 'digest',
};

export const IMPORT_COVERS_NATIVE: Partial<Record<GitHubFeedKind, WatchSurface>> = {
  pr_opened: 'pulls',
  issue_opened: 'issues',
  changes_requested: 'pulls',
};

/**
 * The most calls one unit can make, so a unit is only started when it fits.
 *
 * A unit is ONE request, plus at most one more when a commits or runs read has to
 * learn the default branch first. That is far inside the 20-call tick, and it is
 * the point: nothing hides a loop of requests inside a unit.
 */
const worstCaseCalls = (unit: DueCheckpoint): number =>
  (unit.surface === 'commits' || unit.surface === 'runs') && unit.defaultBranch === null ? 2 : 1;

/** Pages one window may span before it is called too deep to prove, by surface. */
const PAGE_CAP: Readonly<Record<'commits' | 'pulls' | 'issues' | 'runs' | 'releases', number>> = {
  commits: GITHUB_FEED_COMMIT_MAX_PAGES,
  pulls: ASSISTANT_WATCH_MAX_PAGES,
  issues: ASSISTANT_WATCH_MAX_PAGES,
  runs: WATCH_RUNS_MAX_PAGES,
  releases: WATCH_RELEASES_MAX_PAGES,
};

/**
 * The most runs a first observation can PROVE it inventoried.
 *
 * The provider says there may be more by page cardinality: a full page might be
 * followed by another. The tenth page (the page cap) is full at exactly this many, so
 * a list of this size cannot be told from a longer one and is refused as
 * `window_exceeded`; 99 is the most that can be proven. `total_count` never ends a
 * window (a stale total would hide items), but it can refuse EARLY: a branch whose
 * total already reaches this is refused on page one instead of after nine more calls.
 */
const RUNS_INVENTORY_CAPACITY = WATCH_RUNS_MAX_PAGES * ASSISTANT_WATCH_PAGE_SIZE;

/** After a rate limit or an authentication failure the whole cycle stops for this long. */
const PAUSE_MS = 10 * MINUTE;

type UnitResult = 'completed' | 'incomplete' | 'failed' | 'blocked';

/**
 * Notification-only watch targets, observed within a budget and delivered to
 * the owner alone (ADR 0030).
 *
 * It rides the coordinator's existing interval and holds no model provider. A
 * target here is NOT an engineering watch: nothing reads `repos`, nothing writes
 * `allow_jobs`, and the ordinary watch's allowlist rules and auto-cancel never
 * apply to it. What it can do is observe a repository read-only and tell the
 * owner.
 *
 * - **A unit is one page of one surface of one target.** It is charged
 *   against 20 calls per tick and 2400 per rolling hour, and only started when
 *   its worst case fits, so a tick can never overspend and a long read costs
 *   many ticks rather than one big one.
 * - **Oldest-due first.** Every served unit moves its own due time forward, so
 *   no target can starve another, and a mass first read waits its turn.
 * - **A cursor moves only when a window is closed.** A page that has not reached
 *   the cursor saves durable progress and HOLDS what it found; nothing is
 *   delivered, and the cursor stays, until a later page closes the window.
 * - **An unreadable or unobservable surface advances nothing.** It is failed
 *   with backoff, or blocked, and says so; it is never baselined by accident.
 * - **Alerts interrupt only for requested changes.** Everything else waits for a
 *   briefing digest, and is settled only after that briefing was sent.
 */
export class AssistantWatchService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;
  private readonly clock: OwnerClock;
  private readonly reader: AssistantWatchReader;
  private readonly cfg: AssistantWatchConfig | undefined;
  private readonly digestDeliverable: () => boolean;
  private readonly nativeWatchedEver: AssistantWatchServiceDeps['nativeWatchedEver'];
  private ticking: Promise<AssistantWatchTickResult> | null = null;
  /** Until when a rate limit or an authentication failure has stopped the cycle. */
  private pausedUntilMs = 0;

  constructor(deps: AssistantWatchServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.clock = deps.clock;
    this.reader = deps.reader;
    this.cfg = deps.watchConfig;
    this.digestDeliverable = deps.digestDeliverable ?? (() => false);
    this.nativeWatchedEver = deps.nativeWatchedEver;
  }

  // ---- the tick ---------------------------------------------------------------

  tick(): Promise<AssistantWatchTickResult> {
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

  private async runTick(): Promise<AssistantWatchTickResult> {
    const out = {
      completed: 0, incomplete: 0, failed: 0, blocked: 0, callsUsed: 0, budgetStopped: false,
      alertsSent: 0, alertsFailed: 0,
    };
    const repo = this.store.assistantWatch;
    const nowMs = this.clock.nowMs();
    let left = this.budgetLeft(nowMs);

    // The source's global switch: off means no read at all. Alerts already owed,
    // the digest and maintenance still run, and nothing about a target changes.
    const watching = repo.monitoringEnabled(this.ownerId);
    while (watching && left > 0 && this.clock.nowMs() >= this.pausedUntilMs) {
      if (await this.discoveryDue()) {
        const used = { n: 0 };
        const result = await this.discoveryStep(used);
        out[result] += 1;
        out.callsUsed += used.n;
        left -= used.n;
        if (used.n > 0) repo.chargeCalls(this.clock.nowIso().slice(0, 16), used.n);
        continue;
      }
      const [unit] = repo.dueCheckpoints(isoOf(this.clock.nowMs()), 1, this.cycle());
      if (!unit) break;
      if (!this.observable(unit.surface)) {
        repo.block(unit.targetId, unit.surface, 'unobservable', this.clock.nowIso());
        out.blocked += 1;
        continue;
      }
      // Strictly oldest-first: if the longest-waiting unit does not fit, the
      // tick ends rather than serving a cheaper, younger one past it.
      if (worstCaseCalls(unit) > left) {
        out.budgetStopped = true;
        break;
      }
      const used = { n: 0 };
      const result = await this.observeUnit(unit, used);
      out[result] += 1;
      out.callsUsed += used.n;
      left -= used.n;
      if (used.n > 0) repo.chargeCalls(this.clock.nowIso().slice(0, 16), used.n);
    }

    const alerts = await this.deliverAlerts();
    out.alertsSent = alerts.sent;
    out.alertsFailed = alerts.failed;
    this.maintain();
    return out;
  }

  /** Calls left this tick: the per-tick ceiling, or what the rolling hour still allows. */
  private budgetLeft(nowMs: number): number {
    const hourAgo = isoOf(nowMs - 60 * MINUTE).slice(0, 16);
    const hourly = ASSISTANT_WATCH_CALLS_PER_HOUR - this.store.assistantWatch.callsSince(hourAgo);
    return Math.max(0, Math.min(ASSISTANT_WATCH_CALLS_PER_TICK, hourly));
  }

  /** A surface is observable when the reader can see every kind of event it produces. */
  private observable(surface: WatchSurface): boolean {
    const have = new Set<string>(this.reader.capabilities.observableKinds);
    const needed = WATCH_EVENT_KINDS.filter(
      (k) => WATCH_EVENT_SURFACE[k] === surface && k !== 'review_pending',
    );
    return needed.length > 0 && needed.every((k) => have.has(k));
  }

  /** Makes a blocked surface eligible again, after a reader gained a capability. */
  unblockObservable(): number {
    return this.store.assistantWatch.unblockAll(this.clock.nowIso());
  }

  // ---- one unit of work ----------------------------------------------------------

  /**
   * One REQUEST's worth of progress on one surface of one target.
   *
   * A surface read is a small state machine whose position lives in the
   * checkpoint (`pendingPage`, `pendingCursor`, and the JSON `ScanState`):
   *
   *   list page  ->  [ review pages of each pull request that needs them ]
   *              ->  (more list pages, until the window closes)
   *              ->  [ one re-read of the last page, when the window spanned pages ]
   *              ->  commit
   *
   * Every arrow is its own unit, so a restart resumes where it stood, a failure
   * costs exactly the request that failed, and the budget is charged per request.
   * Nothing is delivered and no cursor moves until the commit.
   */
  private async observeUnit(unit: DueCheckpoint, used: { n: number }): Promise<UnitResult> {
    const nowMs = this.clock.nowMs();
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      used.n += 1;
      return fn();
    };
    const ref = refOf(unit.display);
    const baseline = unit.cursor === null;
    const timeCursor = unit.surface === 'default_branch' || baseline ? null : unit.cursor;
    const sinceMs = timeCursor === null ? null : Date.parse(timeCursor);
    if (timeCursor !== null && Number.isNaN(sinceMs)) return this.fail(unit, nowMs, 'unreadable_cursor');

    // A NEW runs or releases baseline is frozen at a boundary taken before its first
    // request, and commits exactly that boundary (see ScanState.baseline). A marker
    // belongs to a null cursor only, and a null-cursor read with progress but no marker
    // (state written before the marker existed) starts over rather than guess one.
    let scan = parseScan(unit.pendingState);
    let current = unit;
    let boundaryMs: number | null = null;
    if (baseline && (unit.surface === 'runs' || unit.surface === 'releases')) {
      if (scan.baseline) {
        boundaryMs = scan.baseline.boundaryMs;
      } else {
        boundaryMs = secondBoundaryMs(nowMs);
        scan = { v: 1, baseline: { boundaryMs } };
        // Written BEFORE the first request. A failure on that request (the repository
        // metadata read included) would otherwise leave nothing durable, and the retry
        // would re-anchor later and quietly drop what moved in between. This also
        // discards pending progress that predates the marker. The write moves the
        // checkpoint's version, so every later write of this unit expects the new one.
        const nowIso = isoOf(nowMs);
        const pendingState = serializeScan(scan);
        const saved = this.store.assistantWatch.savePending({
          targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
          pendingCursor: isoOf(boundaryMs), pendingPage: 0, pendingState,
          nextDueAt: unit.nextDueAt, atIso: nowIso,
        });
        if (!saved) return 'incomplete';
        current = {
          ...unit, pendingPage: 0, pendingCursor: isoOf(boundaryMs), pendingState, updatedAt: nowIso,
        };
      }
    } else if (scan.baseline) {
      // A baseline marker on a checkpoint that has a real cursor (an adoption, or state
      // that is not trustworthy) says nothing about where THIS scan stands. Reset the
      // positional progress as well as the marker, so no page is skipped as already read.
      scan = EMPTY_SCAN;
      current = { ...unit, pendingPage: 0, pendingCursor: null, pendingState: null };
    }
    const ctx: UnitCtx = {
      unit: current, ref, call, nowMs, baseline, sinceMs, boundaryMs,
      // Items at the cursor are re-read (and told from known ones by identity) only
      // when Ducky itself processed them; a baseline or a source cursor stays strict.
      inclusive: unit.state === 'ready' && unit.boundaryKnown,
      scan,
    };

    try {
      if (unit.surface === 'default_branch') return await this.observeRepository(ctx);
      if (unit.surface === 'ci_state') return 'incomplete'; // moves with `runs`, never read alone
      if (unit.surface === 'pulls' && (ctx.scan.queue?.length ?? 0) > 0) return await this.reviewStep(ctx);
      if (ctx.scan.verify) return await this.verifyStep(ctx);
      return await this.listStep(ctx);
    } catch (err) {
      return this.failedWith(unit, nowMs, err);
    }
  }

  /** The default branch and the facts a poll cycle filters by, from one repository read. */
  private async observeRepository(ctx: UnitCtx): Promise<UnitResult> {
    const { unit } = ctx;
    const repo = this.store.assistantWatch;
    const nowIso = isoOf(ctx.nowMs);
    const r = await ctx.call(() => this.reader.repository(ctx.ref));
    repo.recordRepositoryFacts(unit.targetId, {
      defaultBranch: r.defaultBranch, pushedAt: r.pushedAt, archived: r.archived, fork: r.fork,
      relationship: this.relationshipOf(ctx.ref.owner),
    }, nowIso);
    const d = deriveDefaultBranch(r.defaultBranch, unit.cursor, nowIso);
    // A target inside the cycle's coverage is re-read every interval; one beyond it
    // only has its metadata refreshed slowly, so its recency can still move it in.
    const cycle = this.cycle();
    const covered = cycle === undefined || repo.inCycle(unit.targetId, cycle);
    const wrote = repo.commitObservation({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      cursor: d.cursor, nextDueAt: covered
        ? this.nextDue(ctx.nowMs)
        : isoOf(ctx.nowMs + ASSISTANT_WATCH_METADATA_INTERVAL_HOURS * 60 * MINUTE),
      atIso: nowIso,
      events: d.events.map((e) => this.write(e)),
    });
    return wrote === undefined ? 'incomplete' : 'completed';
  }

  /** The branch a commits or runs read follows, learned once and then fixed for the whole pass. */
  private async branchFor(ctx: UnitCtx): Promise<string> {
    if (ctx.scan.branch) return ctx.scan.branch;
    if (ctx.unit.defaultBranch) return ctx.unit.defaultBranch;
    const r = await ctx.call(() => this.reader.repository(ctx.ref));
    this.store.assistantWatch.recordRepositoryFacts(ctx.unit.targetId, {
      defaultBranch: r.defaultBranch, pushedAt: r.pushedAt, archived: r.archived, fork: r.fork,
      relationship: this.relationshipOf(ctx.ref.owner),
    }, isoOf(ctx.nowMs));
    return r.defaultBranch;
  }

  /** One list page, with the keys the end-of-window check compares. */
  private async fetchList(ctx: UnitCtx, page: number, branch: string): Promise<ListFetch> {
    const { ref, call } = ctx;
    switch (ctx.unit.surface) {
      case 'commits': {
        const res = await call(() => this.reader.commits(ref, branch, page));
        return { surface: 'commits', res, keys: res.items.map((c) => keyOf({ kind: 'commit', sha: c.sha })) };
      }
      case 'pulls': {
        const res = await call(() => this.reader.pulls(ref, page));
        if (res.items.length > ASSISTANT_WATCH_PAGE_SIZE) throw new WatchReadError('malformed');
        return {
          surface: 'pulls', res,
          keys: res.items.map((p) => keyOf({ kind: 'pull', number: p.number, updatedAt: p.updatedAt })),
        };
      }
      case 'issues': {
        const res = await call(() => this.reader.issues(ref, page));
        return {
          surface: 'issues', res,
          keys: res.items.map((i) => keyOf({ kind: 'issue', number: i.number, updatedAt: i.updatedAt })),
        };
      }
      case 'runs': {
        const res = await call(() => this.reader.runs(ref, branch, page));
        return { surface: 'runs', res, keys: res.items.map((r) => keyOf({ kind: 'run', id: r.id })) };
      }
      case 'releases': {
        const res = await call(() => this.reader.releases(ref, page));
        return { surface: 'releases', res, keys: res.items.map((r) => keyOf({ kind: 'release', id: r.id })) };
      }
      default:
        throw new WatchReadError('not_enabled', 'not a list surface');
    }
  }

  private async listStep(ctx: UnitCtx): Promise<UnitResult> {
    const { unit, sinceMs, inclusive, scan } = ctx;
    const repo = this.store.assistantWatch;
    const page = unit.pendingPage + 1;
    const branch = unit.surface === 'commits' || unit.surface === 'runs' ? await this.branchFor(ctx) : '';
    const f = await this.fetchList(ctx, page, branch);
    const boundaryMs = ctx.boundaryMs;
    const floorMs = unit.scanFloor ? Date.parse(unit.scanFloor) : null;
    // After a multi-page window, lifecycle times count from where THAT window started, so
    // an item that moved between page reads still has its merge, open or close announced.
    const lifeFloorMs = unit.lifecycleFloor ? Date.parse(unit.lifecycleFloor) : null;
    const lifeSinceMs = sinceMs !== null && lifeFloorMs !== null && !Number.isNaN(lifeFloorMs)
      ? Math.min(sinceMs, lifeFloorMs)
      : sinceMs;

    let read: SurfaceRead;
    let hasMore = false;
    let ci: 'failing' | 'passing' | null = null;
    let pageFloorMs: number | null = null;
    let pageCapMs: number | null = null;
    let queue: ScanState['queue'];
    switch (f.surface) {
      case 'commits':
        hasMore = f.res.hasMore;
        read = deriveCommits(f.res.items, sinceMs, branch, inclusive);
        break;
      case 'pulls': {
        hasMore = f.res.hasMore;
        const list = derivePullList(f.res.items, sinceMs, inclusive, lifeSinceMs);
        read = list;
        if (list.reviewTargets.length > 0) queue = list.reviewTargets;
        break;
      }
      case 'issues':
        hasMore = f.res.hasMore;
        read = deriveIssues(f.res.items, sinceMs, inclusive, f.res.windowStamp ?? null, lifeSinceMs);
        break;
      case 'runs': {
        hasMore = f.res.hasMore;
        // A provider total that SHRINKS while the window is being read means rows were
        // deleted above the read point, and one of them may have slid past a page.
        if (scan.total != null && f.res.total != null && f.res.total < scan.total) {
          return this.restart(ctx, 'window_unstable');
        }
        // A first observation of a branch whose runs already fill the inventory is refused on
        // page one: reading nine pages first would only end in the same refusal.
        if (boundaryMs !== null && page === 1 && f.res.total != null && f.res.total >= RUNS_INVENTORY_CAPACITY) {
          repo.block(unit.targetId, unit.surface, 'window_exceeded', isoOf(ctx.nowMs));
          return 'blocked';
        }
        const failing = repo.checkpoint(unit.targetId, 'ci_state')?.cursor === 'failing';
        const runs = deriveRuns(
          f.res.items, sinceMs, failing, inclusive, Number.isNaN(floorMs) ? null : floorMs, boundaryMs,
        );
        read = runs;
        ci = runs.ciState;
        pageFloorMs = minMs(runs.unsettledFloorMs, runs.touchedFloorMs);
        // A run that settles after it was read has a later update than the one read,
        // so the cursor must not be carried past it by something else on the pass.
        pageCapMs = runs.unsettledStampMs === null ? null : runs.unsettledStampMs - 1;
        break;
      }
      case 'releases': {
        hasMore = f.res.hasMore;
        const rel = deriveReleases(
          f.res.items, sinceMs, inclusive, Number.isNaN(floorMs) ? null : floorMs, boundaryMs,
        );
        // A draft with no creation time cannot be placed in a window, so it cannot be
        // tracked: refused visibly, cursor and held events untouched, never skipped.
        if (rel.untrackableDraft) {
          repo.block(unit.targetId, unit.surface, 'draft_untrackable', isoOf(ctx.nowMs));
          return 'blocked';
        }
        read = rel;
        pageFloorMs = minMs(rel.unsettledFloorMs, rel.touchedFloorMs);
        // A draft published after this read is published AFTER this moment. Whole-second
        // stamps mean one published in the read's own second must still count as later.
        pageCapMs = rel.unsettledFloorMs === null ? null : secondBoundaryMs(ctx.nowMs);
        break;
      }
    }

    const priorNewest = unit.pendingCursor === null ? null : Date.parse(unit.pendingCursor);
    // A boundary baseline never ratchets: its pending cursor IS the boundary, and the
    // window is the whole bounded inventory, to the last page.
    const newest = boundaryMs !== null ? boundaryMs : maxMs(priorNewest, read.newestMs);
    const complete = boundaryMs !== null ? !hasMore : ctx.baseline || read.reachedCursor || !hasMore;
    const next: ScanState = {
      v: 1,
      ...(boundaryMs !== null ? { baseline: { boundaryMs } } : {}),
      ...(branch ? { branch } : {}),
      // The last NONEMPTY page: an empty page proves nothing about a boundary, so a
      // window that closes on one is verified against the page before it.
      ...(f.keys.length > 0 ? { last: { page, keys: f.keys } } : scan.last ? { last: scan.last } : {}),
      total: scan.total ?? (f.surface === 'runs' ? f.res.total ?? null : null),
      floorMs: minMs(scan.floorMs ?? null, pageFloorMs),
      capMs: minMs(scan.capMs ?? null, pageCapMs),
      ci: scan.ci ?? ci,
      ...(queue ? { queue } : {}),
      ...(queue ? { closing: complete } : {}),
    };

    if (queue && !(page >= PAGE_CAP.pulls && !complete)) {
      // Reviews are read before the window can commit or move on.
      repo.savePending({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        pendingCursor: isoOf(newest ?? ctx.nowMs), pendingPage: page, pendingState: serializeScan(next),
        nextDueAt: isoOf(ctx.nowMs), atIso: isoOf(ctx.nowMs), events: read.events.map((e) => this.write(e)),
      });
      return 'incomplete';
    }
    return this.advance(ctx, {
      page, complete, newestMs: newest, events: read.events, scan: next, verified: false,
    });
  }

  /**
   * One pull request's reviews, one page of them, then on to the next.
   *
   * Reviews are listed oldest first, so the newest are on the LAST page and a
   * pull request with a great many cannot be read whole inside the page cap: that
   * blocks the surface as `window_exceeded` rather than reading a prefix and
   * calling it the window.
   */
  private async reviewStep(ctx: UnitCtx): Promise<UnitResult> {
    const { unit, scan } = ctx;
    const repo = this.store.assistantWatch;
    const queue = scan.queue ?? [];
    const target = queue[0]!;
    if (ctx.sinceMs === null) return this.restart(ctx, 'review_without_cursor');
    const rvPage = scan.rv?.page ?? 1;
    const res = await ctx.call(() => this.reader.pullReviews(ctx.ref, target.n, rvPage));
    if (res.items.length > ASSISTANT_WATCH_PAGE_SIZE) throw new WatchReadError('malformed');
    const rd = deriveReviews(target, res.items, ctx.sinceMs, ctx.inclusive);
    const changes = (scan.rv?.changes ?? false) || rd.changesRequested;
    const events: DerivedEvent[] = [...rd.events];
    const nowIso = isoOf(ctx.nowMs);
    const pendingCursor = unit.pendingCursor ?? nowIso;

    if (res.hasMore) {
      if (rvPage >= WATCH_API_REVIEWS_MAX_PAGES) {
        repo.block(unit.targetId, unit.surface, 'window_exceeded', nowIso);
        return 'blocked';
      }
      repo.savePending({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        pendingCursor, pendingPage: unit.pendingPage,
        pendingState: serializeScan({ ...scan, rv: { page: rvPage + 1, changes } }),
        nextDueAt: nowIso, atIso: nowIso, events: events.map((e) => this.write(e)),
      });
      return 'incomplete';
    }

    if (changes) events.push(reviewPendingMarker(target));
    const rest = queue.slice(1);
    const { rv: _rv, queue: _q, ...kept } = scan;
    if (rest.length > 0) {
      repo.savePending({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        pendingCursor, pendingPage: unit.pendingPage,
        pendingState: serializeScan({ ...kept, queue: rest }),
        nextDueAt: nowIso, atIso: nowIso, events: events.map((e) => this.write(e)),
      });
      return 'incomplete';
    }
    return this.advance(ctx, {
      page: unit.pendingPage, complete: scan.closing === true, newestMs: Date.parse(pendingCursor),
      events, scan: kept, verified: false,
    });
  }

  /**
   * Re-reads the last page of a window that spanned several, and compares.
   *
   * See `windowHeldStill`. If the page shows the window held still, the pass
   * commits. If not, the pass is thrown away and restarted (with backoff): what
   * was found stays held, because it is real and deduplicates by identity.
   */
  private async verifyStep(ctx: UnitCtx): Promise<UnitResult> {
    const { unit, scan } = ctx;
    const last = scan.last;
    if (!last) return this.restart(ctx, 'window_unstable');
    const branch = unit.surface === 'commits' || unit.surface === 'runs' ? await this.branchFor(ctx) : '';
    const again = await this.fetchList(ctx, last.page, branch);
    if (!windowHeldStill(last.keys, again.keys)) return this.restart(ctx, 'window_unstable');
    return this.advance(ctx, {
      page: last.page, complete: true, newestMs: unit.pendingCursor ? Date.parse(unit.pendingCursor) : null,
      events: [], scan: { ...scan, verify: false }, verified: true,
    });
  }

  /**
   * What happens after a list page (or the last review of one) has been read:
   * save progress, ask for the end-of-window re-read, or commit.
   */
  private advance(ctx: UnitCtx, a: {
    page: number;
    complete: boolean;
    newestMs: number | null;
    events: readonly DerivedEvent[];
    scan: ScanState;
    verified: boolean;
  }): UnitResult {
    const { unit, sinceMs, baseline } = ctx;
    const repo = this.store.assistantWatch;
    const nowIso = isoOf(ctx.nowMs);
    const surface = unit.surface as keyof typeof PAGE_CAP;
    const { queue: _q, rv: _rv, closing: _c, verify: _v, ...scan } = a.scan;

    if (!a.complete) {
      if (a.page >= PAGE_CAP[surface]) {
        // A window this deep is not something to chase: say so and stop, with the
        // cursor and everything found so far left exactly as they were.
        repo.block(unit.targetId, unit.surface, 'window_exceeded', nowIso);
        return 'blocked';
      }
      repo.savePending({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        pendingCursor: isoOf(a.newestMs ?? ctx.nowMs), pendingPage: a.page,
        pendingState: serializeScan(scan),
        // Continue at once: the read is half done, and others still go first
        // because they have been waiting longer.
        nextDueAt: nowIso, atIso: nowIso, events: a.events.map((e) => this.write(e)),
      });
      return 'incomplete';
    }

    // A multi-page boundary baseline proves its window held still like any other.
    if ((!baseline || ctx.boundaryMs !== null) && a.page >= 2 && !a.verified) {
      repo.savePending({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        pendingCursor: isoOf(a.newestMs ?? ctx.nowMs), pendingPage: a.page,
        pendingState: serializeScan({ ...scan, verify: true }),
        nextDueAt: nowIso, atIso: nowIso, events: a.events.map((e) => this.write(e)),
      });
      return 'incomplete';
    }

    // Capped, so something that settles after it was read cannot be jumped over. A
    // baseline is not capped: nothing was announced for it, and re-reading would
    // announce history.
    const cap = baseline ? null : scan.capMs ?? null;
    const newestMs = a.newestMs !== null && cap !== null ? Math.min(a.newestMs, cap) : a.newestMs;
    // A boundary baseline commits exactly its frozen boundary, never the newest time it
    // saw: what moved after the boundary while later pages were read is announced by the
    // next ordinary pass, which the creation floor below makes reach it.
    const cursorMs = ctx.boundaryMs !== null
      ? ctx.boundaryMs
      : Math.max(sinceMs ?? Number.NEGATIVE_INFINITY, newestMs ?? Number.NEGATIVE_INFINITY);
    // The cursor moving to an item newer than the old one means that item went
    // through THIS pass and its events (if any) were recorded: the items at the
    // new cursor are then known. A baseline, or a pass that moved nothing, says
    // nothing new about the boundary.
    const advanced = !baseline && sinceMs !== null && newestMs !== null && newestMs > sinceMs;
    const ci = scan.ci ?? null;
    // No age cutoff: the floor is whatever this window observed still unsettled (or, for
    // a boundary baseline, still unannounced). Settlement or absence releases it.
    const floor = scan.floorMs == null ? null : isoOf(scan.floorMs);
    const committed = repo.commitObservation({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      cursor: isoOf(Number.isFinite(cursorMs) ? cursorMs : ctx.nowMs),
      nextDueAt: this.nextDue(ctx.nowMs), atIso: nowIso,
      events: a.events.map((e) => this.write(e)),
      ...(!baseline && ci !== null ? { alsoSet: { surface: 'ci_state' as const, cursor: ci } } : {}),
      ...(advanced ? { boundaryKnown: true } : baseline ? { boundaryKnown: false } : {}),
      ...(unit.surface === 'runs' || unit.surface === 'releases' ? { scanFloor: floor } : {}),
      // A window that spanned pages hands its starting cursor to the next read; any
      // other read clears it. A baseline has nothing to hand on.
      ...(unit.surface === 'pulls' || unit.surface === 'issues'
        ? { lifecycleFloor: !baseline && sinceMs !== null && a.page >= 2 ? isoOf(Math.min(sinceMs, lifeFloorOf(unit) ?? sinceMs)) : null }
        : {}),
    });
    if (committed !== undefined) repo.touchObserved(unit.targetId, nowIso);
    return 'completed';
  }

  private write(e: DerivedEvent): ObservedEventWrite {
    return {
      id: randomUUID(),
      kind: e.kind,
      identity: e.identity,
      occurredAt: isoOf(Date.parse(e.occurredAt)),
      payloadJson: JSON.stringify(e.payload),
      settled: false,
    };
  }

  private nextDue(nowMs: number): string {
    return isoOf(nowMs + ASSISTANT_WATCH_INTERVAL_MINUTES * MINUTE);
  }

  private backoff(unit: DueCheckpoint, minimumMs = 0): number {
    return Math.max(
      minimumMs,
      Math.min(
        ASSISTANT_WATCH_INTERVAL_MINUTES * MINUTE * 2 ** Math.min(unit.failures, 10),
        ASSISTANT_WATCH_BACKOFF_MAX_MS,
      ),
    );
  }

  /** A failed read: backoff, a short code and nothing else. The cursor is untouched. */
  private fail(unit: DueCheckpoint, nowMs: number, code: string, minimumMs = 0): 'failed' {
    this.store.assistantWatch.recordFailure({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      nextDueAt: isoOf(nowMs + this.backoff(unit, minimumMs)), errorCode: code, atIso: isoOf(nowMs),
    });
    return 'failed';
  }

  /** A read whose window moved while it was being read: start it again, later. */
  private restart(ctx: UnitCtx, code: string): 'failed' {
    const { unit, nowMs } = ctx;
    // A boundary baseline keeps its ORIGINAL boundary and the creation floor seen so far,
    // and drops everything positional (page, last page, total, CI state, cap, queue): the
    // new pass re-reads from page one but anchors where the first attempt began, so
    // nothing that moved since is quietly re-baselined away.
    const keep = ctx.boundaryMs === null
      ? null
      : serializeScan({
        v: 1, baseline: { boundaryMs: ctx.boundaryMs },
        ...(ctx.scan.floorMs != null ? { floorMs: ctx.scan.floorMs } : {}),
      });
    this.store.assistantWatch.restartPass({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      nextDueAt: isoOf(nowMs + this.backoff(unit)), errorCode: code, atIso: isoOf(nowMs),
      pendingState: keep,
    });
    return 'failed';
  }

  /**
   * What a failed request means.
   *
   * A rate limit or an authentication failure stops the WHOLE cycle for ten
   * minutes (the source does the same) and fails only the unit that met it. A
   * window past its cap, or a repository that is no longer the one asked for,
   * blocks rather than retries. A repository the provider no longer shows is
   * unmonitored for good, as the source does. Everything else is a short code and
   * a backoff. Nothing here ever advances a cursor.
   */
  private failedWith(unit: DueCheckpoint, nowMs: number, err: unknown): UnitResult {
    const repo = this.store.assistantWatch;
    const nowIso = isoOf(nowMs);
    if (err instanceof UnreadableTimestamp) return this.fail(unit, nowMs, 'unreadable_timestamp');
    if (err instanceof WatchReadError) {
      switch (err.code) {
        case 'window_exceeded':
          repo.block(unit.targetId, unit.surface, 'window_exceeded', nowIso);
          return 'blocked';
        case 'identity_changed':
          repo.blockTarget(unit.targetId, 'identity_changed', nowIso);
          return 'blocked';
        case 'rate_limited':
        case 'auth':
          this.pausedUntilMs = nowMs + PAUSE_MS;
          return this.fail(unit, nowMs, err.code, PAUSE_MS);
        case 'not_found':
          if (unit.surface === 'default_branch') {
            // One not-found is not a verdict: a private repository without access, a
            // moment of provider trouble and a repository that is really gone answer the
            // same way. Only a SECOND consecutive one, after the backoff, cancels; a
            // success in between resets the count.
            if (unit.lastError === 'not_found' && unit.failures >= 1) {
              repo.cancelBySystem(unit.targetId, 'not_found', nowIso);
              return 'failed';
            }
            return this.fail(unit, nowMs, 'not_found');
          }
          return this.fail(unit, nowMs, 'not_found');
        default:
          return this.fail(unit, nowMs, err.code);
      }
    }
    return this.fail(unit, nowMs, 'read_failed');
  }

  /**
   * Whether an imported target will really TELL the owner about this surface, so a
   * native notification for the same thing can be left out without losing it.
   *
   * A healthy checkpoint on an active target is not delivery. Watching must be on (the
   * global switch), the target must be inside the poll cycle's coverage where one
   * applies, and what the target tells must have somewhere to go: an alert needs
   * nothing more (it is sent as soon as it is found), but a digest-only kind needs a
   * briefing that can carry it. Anything less keeps the native notification.
   */
  covers(repoKey: string, surface: WatchSurface, delivery: 'immediate' | 'digest'): boolean {
    const repo = this.store.assistantWatch;
    if (!repo.monitoringEnabled(this.ownerId)) return false;
    if (delivery === 'digest' && !this.digestDeliverable()) return false;
    return repo.observes(this.ownerId, repoKey, surface, this.cycle());
  }

  // ---- the poll cycle, relationships and discovery -----------------------------------

  /** The source's recency-limited cycle, or undefined when it does not apply. */
  private cycle(): PollCycle | undefined {
    if (!this.cfg?.cycle) return undefined;
    return {
      ownerId: this.ownerId, limit: ASSISTANT_WATCH_CYCLE_TARGETS,
      includeArchived: this.cfg.includeArchived, includeForks: this.cfg.includeForks,
      relationships: [...this.cfg.relationships],
    };
  }

  /** `owner` for the configured account's own repositories; otherwise unknown from the name alone. */
  private relationshipOf(ownerLogin: string): 'owner' | null {
    const account = this.cfg?.account;
    return account && ownerLogin.toLowerCase() === account.toLowerCase() ? 'owner' : null;
  }

  private async discoveryDue(): Promise<boolean> {
    if (!this.cfg?.discovery || !this.reader.capabilities.discovery) return false;
    const row = this.store.assistantWatch.ensureDiscovery(this.ownerId, this.clock.nowIso());
    return row.nextDueAt <= this.clock.nowIso();
  }

  /**
   * One page of repository discovery, one request.
   *
   * The source discovers at first start and every six hours, five pages of a
   * hundred at most. A repository is stored only if its relationship to the
   * configured account is one the frozen configuration allows, so nothing outside
   * the scope ever reaches the database. Pages beyond the fifth are reported as an
   * INCOMPLETE pass, a repository the ceiling cannot hold as a capacity block; both
   * are visible in `/status`, and neither truncates, cancels or drops anything.
   */
  private async discoveryStep(used: { n: number }): Promise<UnitResult> {
    const repo = this.store.assistantWatch;
    const nowMs = this.clock.nowMs();
    const nowIso = isoOf(nowMs);
    const cfg = this.cfg!;
    const row = repo.ensureDiscovery(this.ownerId, nowIso);
    const page = row.pendingPage + 1;
    try {
      used.n += 1;
      const res = await this.reader.discover(page);
      const found: Parameters<typeof repo.commitDiscoveryPage>[0]['found'][number][] = [];
      for (const d of res.items) {
        const [owner, name] = d.fullName.split('/');
        if (!owner || !name || d.fullName.split('/').length !== 2 || !GH_OWNER_RE.test(owner) || !GH_REPO_RE.test(name) || !isPlainRepoName(owner) || !isPlainRepoName(name)) continue;
        const relationship = this.relationshipForDiscovered(d.ownerLogin, d.ownerType);
        if (!cfg.relationships.has(relationship)) continue;
        found.push({
          repoKey: d.fullName.toLowerCase(), display: d.fullName, pushedAt: d.pushedAt, archived: d.archived,
          fork: d.fork, relationship, id: randomUUID(), publicId: this.freshWatchId(),
        });
      }
      const more = res.hasMore;
      const last = !more || page >= WATCH_API_DISCOVERY_MAX_PAGES;
      const committed = repo.commitDiscoveryPage({
        ownerId: this.ownerId, expectedPage: row.pendingPage, found,
        surfaces: WATCH_SURFACES_OBSERVED, maxTargets: ASSISTANT_WATCH_MAX_TARGETS,
        next: last
          ? {
            kind: 'done', incomplete: more,
            nextDueAt: isoOf(nowMs + ASSISTANT_WATCH_DISCOVERY_INTERVAL_HOURS * 60 * MINUTE),
          }
          : { kind: 'page', page },
        atIso: nowIso,
      });
      return committed === undefined ? 'incomplete' : last ? 'completed' : 'incomplete';
    } catch (err) {
      const code = err instanceof WatchReadError ? err.code : 'read_failed';
      if (code === 'rate_limited' || code === 'auth') this.pausedUntilMs = nowMs + PAUSE_MS;
      const delay = Math.min(
        ASSISTANT_WATCH_INTERVAL_MINUTES * MINUTE * 2 ** Math.min(row.failures, 10), ASSISTANT_WATCH_BACKOFF_MAX_MS,
      );
      repo.recordDiscoveryFailure(
        this.ownerId, code, isoOf(nowMs + Math.max(delay, code === 'rate_limited' || code === 'auth' ? PAUSE_MS : 0)), nowIso,
      );
      return 'failed';
    }
  }

  /** The source's rule: the account's own repositories, then organizations, then everything else. */
  private relationshipForDiscovered(
    ownerLogin: string, ownerType: string | null,
  ): 'owner' | 'organization' | 'collaborator' {
    const account = this.cfg?.account;
    if (account && ownerLogin.toLowerCase() === account.toLowerCase()) return 'owner';
    return ownerType?.toLowerCase() === 'organization' ? 'organization' : 'collaborator';
  }

  private freshWatchId(): string {
    for (let i = 0; i < 20; i += 1) {
      const id = newPublicWatchId();
      // One handle names exactly one watch of either kind.
      if (!this.store.githubWatches.publicIdExists(id) && !this.store.assistantWatch.publicIdExists(id)) return id;
    }
    throw new DuckyError('not_found', 'Could not allocate a watch handle.');
  }

  // ---- delivery -------------------------------------------------------------------

  /**
   * Sends requested-changes alerts to the owner's DM, and nowhere else.
   *
   * There is no channel branch: an alert about a repository the owner watches
   * is private, whatever the repository's own visibility, and the shared GitHub
   * feed channel is never a destination for anything here.
   */
  private async deliverAlerts(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const event of this.store.assistantWatch.pendingAlerts(this.ownerId, ASSISTANT_WATCH_EVENT_BATCH)) {
      const at = this.clock.nowIso();
      try {
        await this.transport.send(dmTarget(this.ownerId), assistantWatchAlert(event));
        this.store.assistantWatch.markAlerted(event.id, at);
        sent += 1;
      } catch {
        this.store.assistantWatch.recordAlertFailure(event.id, at, ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS);
        failed += 1;
      }
    }
    return { sent, failed };
  }

  /** Bookkeeping that rides the tick: old budget buckets, settled content, markers. */
  private maintain(): void {
    const repo = this.store.assistantWatch;
    const nowMs = this.clock.nowMs();
    repo.pruneCalls(isoOf(nowMs - 2 * 60 * MINUTE).slice(0, 16));
    repo.settleSilent(isoOf(nowMs));
    repo.scrubSettledPayloads(isoOf(nowMs - ASSISTANT_WATCH_EVENT_KEEP_DAYS * 86_400_000));
  }

  // ---- the briefing digest -----------------------------------------------------------

  /**
   * What a briefing should say about the owner's watched repositories.
   *
   * A pure read: building a digest settles nothing. The briefing that carries it
   * settles it, through `markDigested`, only after that briefing was SENT -- so
   * a failed delivery cannot swallow events, and a pulled preview cannot either.
   */
  digest(): WatchDigest {
    const events = this.store.assistantWatch.undigested(this.ownerId, 400);
    return buildWatchDigest(events);
  }

  markDigested(eventIds: readonly string[]): number {
    return this.store.assistantWatch.markDigested(eventIds, this.clock.nowIso());
  }

  // ---- the owner's controls --------------------------------------------------------------

  list(actor: ActorContext, includeCancelled = false, limit = 20, offset = 0): WatchTargetRow[] {
    this.authz.requireOwner(actor);
    return this.store.assistantWatch.listForOwner(actor.discordUserId, includeCancelled, limit, offset);
  }

  counts(actor: ActorContext): ReturnType<Store['assistantWatch']['counts']> {
    this.authz.requireOwner(actor);
    return this.store.assistantWatch.counts(actor.discordUserId);
  }

  /** Whether this handle names one of the owner's notification targets. */
  owns(actor: ActorContext, publicId: string): boolean {
    this.authz.requireOwner(actor);
    return this.store.assistantWatch.byPublicId(actor.discordUserId, publicId.trim().toLowerCase()) !== undefined;
  }

  cancel(actor: ActorContext, publicId: string): WatchTargetRow {
    this.authz.requireOwner(actor);
    const row = this.store.assistantWatch.byPublicId(actor.discordUserId, publicId.trim().toLowerCase());
    if (!row) throw new DuckyError('not_found', 'No repository watch with that id.');
    if (!this.store.assistantWatch.cancel(actor.discordUserId, row.id, this.clock.nowIso())) {
      throw new DuckyError('invalid_input', 'That watch is already cancelled.');
    }
    return this.store.assistantWatch.byPublicId(actor.discordUserId, row.publicId)!;
  }

  /**
   * The owner's explicit choice of the global monitoring switch (ADR 0032), not a toggle.
   *
   * Saying the state it already has changes nothing: no row, no timestamp, no audit
   * row and no delta. A real change writes the switch and a STRICT audit row in one
   * transaction at the injected time, so a failed audit write undoes the change.
   * Neither direction touches a target, a checkpoint, a pending event or the rate-limit
   * backoff: pausing takes effect at the NEXT tick (the tick in flight read the switch
   * once at its start), and resuming makes every cursor due again exactly where it stood.
   *
   * Turning monitoring back ON is refused wherever a native path could have reported the
   * same repositories, and **the switch is GLOBAL**: one overlap, or any retained ordinary-watch
   * row at all, blocks resuming EVERY target (up to the 1,000-target cap), not just the one that
   * overlaps. While monitoring is off an ordinary snapshot DM or feed card is not trimmed for
   * what a target covers, so it may already have told the owner what a target's untouched
   * checkpoint would tell a second time. Nothing stored proves when a pause really began (an
   * imported pause carries only the import time), what a native path delivered, whether a
   * pending native notification was settled, or what an ordinary watch's allowlist slug named
   * when it ran (the mapping is rewritten at every boot). Exact cross-path reconciliation has no
   * evidence, and resetting a checkpoint would silently baseline away events nobody was told.
   * So the guard, inside the transaction, counts every selected-feed repository (active or
   * cancelled, a durable identity) that an active target also watches, plus every distinct
   * retained ordinary watch, and refuses if there is any. Cancelled targets are not counted
   * (they are not read).
   *
   * The cost is deliberate and owned: with any ordinary-watch history, no target can be resumed
   * until reconciliation exists. Removing a native row is NOT a way round it (that would delete
   * the history the guard honours), and a repeated import preserves the stored switch, so there
   * is no operator-import workaround either. The reply gives a count and no remedy. This is a
   * REQUIRED full-parity and cutover blocker, not an accepted omission.
   */
  setMonitoring(actor: ActorContext, enabled: boolean): SetMonitoringOutcome {
    this.authz.requireOwner(actor);
    const repo = this.store.assistantWatch;
    const owner = actor.discordUserId;
    return withTransaction(this.store.db, () => {
      const current = repo.monitoringSetting(owner);
      const was = current === undefined || current.enabled;
      if (was === enabled) return { ok: true as const, changed: false, enabled };
      if (enabled) {
        if (!this.nativeWatchedEver) {
          return { ok: false as const, reason: 'overlap_unverifiable' as const, overlapping: 0 };
        }
        const native = this.nativeWatchedEver();
        const targets = new Set(repo.activeTargetKeys(owner));
        const overlapping = [...native.keys].filter((k) => targets.has(k)).length + native.unprovenOrdinary;
        if (overlapping > 0) return { ok: false as const, reason: 'ordinary_overlap' as const, overlapping };
      }
      const at = this.clock.nowIso();
      repo.setMonitoring(owner, enabled, at);
      this.store.auditLog.recordStrict({
        at,
        event: 'watch.monitoring_changed',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        subjectKind: 'config',
        subjectRef: 'watch.monitoring',
        outcome: 'ok',
        detail: enabled ? 'off to on' : 'on to off',
      });
      return { ok: true as const, changed: true, enabled };
    });
  }

  /** For `/status`: counts only, never a repository name. */
  statusLine(): string {
    const repo = this.store.assistantWatch;
    const c = repo.counts(this.ownerId);
    if (c.targets === 0 && !this.cfg?.discovery) return 'no notification targets';
    const observing = this.reader.capabilities.observableKinds.length > 0;
    const parts = [
      `${c.active} active of ${c.targets} notification target(s)` +
        (observing ? '' : '; NOT observing (no typed reader in this build)'),
    ];
    if (!repo.monitoringEnabled(this.ownerId)) parts.push('PAUSED (the imported global switch is off)');
    const cycle = this.cycle();
    if (cycle) {
      const v = repo.cycleCoverage(cycle);
      parts.push(
        `${v.covered} covered this cycle, ${v.beyond} beyond it by recency, ${v.unmeasured} awaiting a first metadata read` +
          (v.ineligible > 0 ? `, ${v.ineligible} ineligible (archived or an owned fork)` : ''),
      );
    }
    if (this.cfg?.discovery) {
      const d = repo.discovery(this.ownerId);
      parts.push(
        d === undefined || d.lastCompletedAt === null
          ? 'discovery: not completed yet'
          : `discovery: last pass complete${d.incomplete ? ' EXCEPT repositories beyond the page cap' : ''}` +
            (d.capacityBlocked ? '; at the target ceiling, some repositories NOT stored' : ''),
      );
    }
    const blocked = repo.blockedCounts(this.ownerId);
    if (blocked.systemCancelled > 0) {
      parts.push(`${blocked.systemCancelled} target(s) cancelled because the repository stopped being shown`);
    }
    if (blocked.windowExceeded + blocked.identityChanged > 0) {
      parts.push(
        `blocked: ${blocked.windowExceeded} surface(s) with a window too deep to prove, ` +
          `${blocked.identityChanged} target(s) whose repository was renamed or transferred`,
      );
    }
    return parts.join('; ');
  }
}

/** Everything one unit needs, assembled once. */
interface UnitCtx {
  readonly unit: DueCheckpoint;
  readonly ref: WatchRepoRef;
  readonly call: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly nowMs: number;
  readonly baseline: boolean;
  /** The frozen boundary of a NEW runs or releases baseline, or null for any other read. */
  readonly boundaryMs: number | null;
  readonly sinceMs: number | null;
  readonly inclusive: boolean;
  readonly scan: ScanState;
}

type ListFetch =
  | { readonly surface: 'commits'; readonly res: Page<CommitRecord>; readonly keys: string[] }
  | { readonly surface: 'pulls'; readonly res: Page<PullRecord>; readonly keys: string[] }
  | { readonly surface: 'issues'; readonly res: Page<IssueRecord>; readonly keys: string[] }
  | { readonly surface: 'runs'; readonly res: Page<RunRecord>; readonly keys: string[] }
  | { readonly surface: 'releases'; readonly res: Page<ReleaseRecord>; readonly keys: string[] };

/** The lifecycle floor a unit inherited, in ms, or null. */
const lifeFloorOf = (unit: DueCheckpoint): number | null => {
  if (!unit.lifecycleFloor) return null;
  const ms = Date.parse(unit.lifecycleFloor);
  return Number.isNaN(ms) ? null : ms;
};

const maxMs = (a: number | null, b: number | null): number | null =>
  b === null || Number.isNaN(b) ? a : a === null || Number.isNaN(a) || b > a ? b : a;
const minMs = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

const refOf = (display: string): WatchRepoRef => {
  const [owner, repo] = display.split('/') as [string, string];
  return { owner, repo };
};

// ---- the digest, in words -----------------------------------------------------------------

const titleOf = (e: WatchEventWithTarget): { number?: number; title: string; extra: Record<string, unknown> } => {
  try {
    const p = JSON.parse(e.payloadJson) as Record<string, unknown>;
    return {
      ...(typeof p['number'] === 'number' ? { number: p['number'] } : {}),
      title: scrubText(String(p['title'] ?? p['subject'] ?? ''), 100),
      extra: p,
    };
  } catch {
    return { title: '', extra: {} };
  }
};

const FACT: Partial<Record<WatchEventKind, (n: string, t: string, x: Record<string, unknown>) => string>> = {
  pr_opened: (n, t) => `PR ${n} opened${t ? `: ${t}` : ''}`,
  pr_merged: (n, t) => `PR ${n} merged${t ? `: ${t}` : ''}`,
  pr_closed: (n, t) => `PR ${n} closed${t ? `: ${t}` : ''}`,
  pr_updated: (n, t) => `PR ${n} updated${t ? `: ${t}` : ''}`,
  review_approved: (n) => `PR ${n} was approved`,
  review_commented: (n) => `PR ${n} has new review comments`,
  review_requested_changes: (n) => `PR ${n} has requested changes`,
  issue_opened: (n, t) => `Issue ${n} opened${t ? `: ${t}` : ''}`,
  issue_closed: (n, t) => `Issue ${n} closed${t ? `: ${t}` : ''}`,
  issue_updated: (n, t) => `Issue ${n} updated${t ? `: ${t}` : ''}`,
  release: (_n, _t, x) => `Release ${scrubText(String(x['tag'] ?? ''), 40)}`.trim(),
  ci_failed: (_n, _t, x) => `CI failed: ${scrubText(String(x['workflow'] ?? 'a workflow'), 60)}`,
  ci_recovered: (_n, _t, x) => `CI recovered: ${scrubText(String(x['workflow'] ?? 'a workflow'), 60)}`,
  ci_started: (_n, _t, x) => `CI running: ${scrubText(String(x['workflow'] ?? 'a workflow'), 60)}`,
  default_branch_change: (_n, _t, x) => `Default branch is now ${scrubText(String(x['branch'] ?? ''), 80)}`,
};

/**
 * Turns unread events into a bounded, deterministic digest.
 *
 * Nothing here is generated: every line is a fixed phrase around a scrubbed
 * title, number or name. Commits are counted rather than listed. A repository
 * cut from the rendering, and the lines cut within one, are COUNTED and said so,
 * and every fetched event is returned for settlement either way, so nothing is
 * summarized twice and nothing is silently dropped from view.
 */
export function buildWatchDigest(events: readonly WatchEventWithTarget[]): WatchDigest {
  const byRepo = new Map<string, WatchEventWithTarget[]>();
  for (const e of events) {
    const list = byRepo.get(e.display) ?? [];
    list.push(e);
    byRepo.set(e.display, list);
  }

  const attention: string[] = [];
  const rendered: { name: string; lines: string[]; weight: number }[] = [];
  for (const [display, list] of byRepo) {
    const name = bareRepoName(display);
    const lines: string[] = [];
    const commits = list.filter((e) => e.kind === 'commit').length;
    if (commits > 0) lines.push(`${commits} new commit${commits === 1 ? '' : 's'}`);
    for (const e of list) {
      const fact = FACT[e.kind];
      if (!fact) continue;
      const t = titleOf(e);
      lines.push(fact(t.number === undefined ? '' : `#${t.number}`, t.title, t.extra).replace(/\s+/g, ' ').trim());
    }
    const failed = list.filter((e) => e.kind === 'ci_failed').length;
    const recovered = list.filter((e) => e.kind === 'ci_recovered').length;
    if (failed > recovered) attention.push(`${name} has failing CI.`);
    for (const e of list) {
      if (e.kind === 'review_requested_changes') {
        const t = titleOf(e);
        attention.push(`${name}: PR ${t.number === undefined ? '' : `#${t.number} `}has requested changes.`.replace('  ', ' '));
      }
    }
    if (lines.length === 0) continue;
    const shown = lines.slice(0, ASSISTANT_DIGEST_MAX_LINES_PER_REPO);
    if (lines.length > shown.length) shown.push(`and ${lines.length - shown.length} more`);
    rendered.push({ name, lines: shown, weight: list.length + (failed > 0 ? 100 : 0) });
  }

  rendered.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const kept = rendered.slice(0, ASSISTANT_DIGEST_MAX_REPOS);
  return {
    repos: kept.map(({ name, lines }) => ({ name, lines })),
    attention: [...new Set(attention)],
    eventIds: events.map((e) => e.id),
    truncatedRepos: rendered.length - kept.length,
    empty: rendered.length === 0,
  };
}
