import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_DIGEST_MAX_LINES_PER_REPO, ASSISTANT_DIGEST_MAX_REPOS, ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS,
  ASSISTANT_WATCH_BACKOFF_MAX_MS, ASSISTANT_WATCH_CALLS_PER_HOUR, ASSISTANT_WATCH_CALLS_PER_TICK,
  ASSISTANT_WATCH_EVENT_BATCH, ASSISTANT_WATCH_EVENT_KEEP_DAYS, ASSISTANT_WATCH_INTERVAL_MINUTES,
  ASSISTANT_WATCH_MAX_PAGES, ASSISTANT_WATCH_PAGE_SIZE, DuckyError, GITHUB_FEED_COMMIT_MAX_PAGES,
  WATCH_API_REVIEWS_MAX_PAGES, WATCH_EVENT_KINDS, WATCH_EVENT_SURFACE, WATCH_RELEASES_MAX_PAGES,
  WATCH_RUNS_MAX_PAGES, type GitHubFeedKind, type WatchEventKind, type WatchSurface,
} from '@ducky/contracts';
import type {
  DueCheckpoint, ObservedEventWrite, Store, WatchEventWithTarget, WatchTargetRow,
} from '@ducky/persistence';
import { dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { assistantWatchAlert } from '../discord/assistant-presenters.js';
import type { ActorContext, Authorizer } from '../security/authz.js';
import {
  DRAFT_TRACK_MAX_AGE_MS, RUN_TRACK_MAX_AGE_MS, UnreadableTimestamp, bareRepoName, deriveCommits,
  deriveDefaultBranch, deriveIssues, derivePullList, deriveReleases, deriveReviews, deriveRuns,
  reviewPendingMarker, scrubText, type DerivedEvent, type SurfaceRead,
} from './assistant-watch.engine.js';
import {
  EMPTY_SCAN, keyOf, parseScan, serializeScan, windowHeldStill, type ScanState,
} from './assistant-watch.scan.js';
import {
  WatchReadError, type AssistantWatchReader, type Page, type WatchRepoRef,
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
 * Overlap with the ORDINARY `github_watches` snapshot DM is not suppressed
 * either. That is a required parity blocker, recorded in
 * `docs/CURRENT_STATE.md`, not an accepted exclusion.
 */
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

    while (left > 0 && this.clock.nowMs() >= this.pausedUntilMs) {
      const [unit] = repo.dueCheckpoints(isoOf(this.clock.nowMs()), 1);
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
    const ctx: UnitCtx = {
      unit, ref, call, nowMs, baseline, sinceMs,
      // Items at the cursor are re-read (and told from known ones by identity) only
      // when Ducky itself processed them; a baseline or a source cursor stays strict.
      inclusive: unit.state === 'ready' && unit.boundaryKnown,
      scan: parseScan(unit.pendingState),
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
      relationship: null,
    }, nowIso);
    const d = deriveDefaultBranch(r.defaultBranch, unit.cursor, nowIso);
    const wrote = repo.commitObservation({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      cursor: d.cursor, nextDueAt: this.nextDue(ctx.nowMs), atIso: nowIso,
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
      relationship: null,
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
    const floorMs = unit.scanFloor ? Date.parse(unit.scanFloor) : null;

    let read: SurfaceRead;
    let hasMore = false;
    let ci: 'failing' | 'passing' | null = null;
    let pageFloorMs: number | null = null;
    let queue: ScanState['queue'];
    switch (f.surface) {
      case 'commits':
        hasMore = f.res.hasMore;
        read = deriveCommits(f.res.items, sinceMs, branch, inclusive);
        break;
      case 'pulls': {
        hasMore = f.res.hasMore;
        const list = derivePullList(f.res.items, sinceMs, inclusive);
        read = list;
        if (list.reviewTargets.length > 0) queue = list.reviewTargets;
        break;
      }
      case 'issues':
        hasMore = f.res.hasMore;
        read = deriveIssues(f.res.items, sinceMs, inclusive, f.res.windowStamp ?? null);
        break;
      case 'runs': {
        hasMore = f.res.hasMore;
        // A provider total that SHRINKS while the window is being read means rows were
        // deleted above the read point, and one of them may have slid past a page.
        if (scan.total != null && f.res.total != null && f.res.total < scan.total) {
          return this.restart(unit, ctx.nowMs, 'window_unstable');
        }
        const failing = repo.checkpoint(unit.targetId, 'ci_state')?.cursor === 'failing';
        const runs = deriveRuns(f.res.items, sinceMs, failing, inclusive, Number.isNaN(floorMs) ? null : floorMs);
        read = runs;
        ci = runs.ciState;
        pageFloorMs = runs.unsettledFloorMs;
        break;
      }
      case 'releases': {
        hasMore = f.res.hasMore;
        const rel = deriveReleases(f.res.items, sinceMs, inclusive, Number.isNaN(floorMs) ? null : floorMs);
        read = rel;
        pageFloorMs = rel.unsettledFloorMs;
        break;
      }
    }

    const priorNewest = unit.pendingCursor === null ? null : Date.parse(unit.pendingCursor);
    const newest = maxMs(priorNewest, read.newestMs);
    const complete = ctx.baseline || read.reachedCursor || !hasMore;
    const next: ScanState = {
      v: 1,
      ...(branch ? { branch } : {}),
      last: { page, keys: f.keys },
      total: scan.total ?? (f.surface === 'runs' ? f.res.total ?? null : null),
      floorMs: minMs(scan.floorMs ?? null, pageFloorMs),
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
    if (ctx.sinceMs === null) return this.restart(unit, ctx.nowMs, 'review_without_cursor');
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
    if (!last) return this.restart(unit, ctx.nowMs, 'window_unstable');
    const branch = unit.surface === 'commits' || unit.surface === 'runs' ? await this.branchFor(ctx) : '';
    const again = await this.fetchList(ctx, last.page, branch);
    if (!windowHeldStill(last.keys, again.keys)) return this.restart(unit, ctx.nowMs, 'window_unstable');
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

    if (!baseline && a.page >= 2 && !a.verified) {
      repo.savePending({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        pendingCursor: isoOf(a.newestMs ?? ctx.nowMs), pendingPage: a.page,
        pendingState: serializeScan({ ...scan, verify: true }),
        nextDueAt: nowIso, atIso: nowIso, events: a.events.map((e) => this.write(e)),
      });
      return 'incomplete';
    }

    const cursorMs = Math.max(sinceMs ?? Number.NEGATIVE_INFINITY, a.newestMs ?? Number.NEGATIVE_INFINITY);
    // The cursor moving to an item newer than the old one means that item went
    // through THIS pass and its events (if any) were recorded: the items at the
    // new cursor are then known. A baseline, or a pass that moved nothing, says
    // nothing new about the boundary.
    const advanced = !baseline && sinceMs !== null && a.newestMs !== null && a.newestMs > sinceMs;
    const ci = scan.ci ?? null;
    const floor = this.trackedFloor(unit.surface, scan.floorMs ?? null, ctx.nowMs);
    const committed = repo.commitObservation({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      cursor: isoOf(Number.isFinite(cursorMs) ? cursorMs : ctx.nowMs),
      nextDueAt: this.nextDue(ctx.nowMs), atIso: nowIso,
      events: a.events.map((e) => this.write(e)),
      ...(!baseline && ci !== null ? { alsoSet: { surface: 'ci_state' as const, cursor: ci } } : {}),
      ...(advanced ? { boundaryKnown: true } : baseline ? { boundaryKnown: false } : {}),
      ...(unit.surface === 'runs' || unit.surface === 'releases' ? { scanFloor: floor } : {}),
    });
    if (committed !== undefined) repo.touchObserved(unit.targetId, nowIso);
    return 'completed';
  }

  /**
   * The creation time the NEXT window must reach back to, or null.
   *
   * Only an item young enough to be tracked counts: a run queued for a day, or a
   * draft untouched for a month, is treated as abandoned, so one stuck item cannot
   * hold a window open without bound. What settles after that is the named
   * residual of this scheme, not something it claims to see.
   */
  private trackedFloor(surface: WatchSurface, floorMs: number | null, nowMs: number): string | null {
    if (floorMs === null) return null;
    const maxAge = surface === 'runs' ? RUN_TRACK_MAX_AGE_MS : DRAFT_TRACK_MAX_AGE_MS;
    return nowMs - floorMs > maxAge ? null : isoOf(floorMs);
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
  private restart(unit: DueCheckpoint, nowMs: number, code: string): 'failed' {
    this.store.assistantWatch.restartPass({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      nextDueAt: isoOf(nowMs + this.backoff(unit)), errorCode: code, atIso: isoOf(nowMs),
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
            repo.cancelBySystem(unit.targetId, 'not_found', nowIso);
            return 'failed';
          }
          return this.fail(unit, nowMs, 'not_found');
        default:
          return this.fail(unit, nowMs, err.code);
      }
    }
    return this.fail(unit, nowMs, 'read_failed');
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

  /** For `/status`: counts only, never a repository name. */
  statusLine(): string {
    const c = this.store.assistantWatch.counts(this.ownerId);
    if (c.targets === 0) return 'no notification targets';
    const observing = this.reader.capabilities.observableKinds.length > 0;
    return `${c.active} active of ${c.targets} notification target(s)` +
      (observing ? '' : '; NOT observing (no typed reader in this build)');
  }
}

/** Everything one unit needs, assembled once. */
interface UnitCtx {
  readonly unit: DueCheckpoint;
  readonly ref: WatchRepoRef;
  readonly call: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly nowMs: number;
  readonly baseline: boolean;
  readonly sinceMs: number | null;
  readonly inclusive: boolean;
  readonly scan: ScanState;
}

type ListFetch =
  | { readonly surface: 'commits'; readonly res: Page<import('./assistant-watch.reader.js').CommitRecord>; readonly keys: string[] }
  | { readonly surface: 'pulls'; readonly res: Page<import('./assistant-watch.reader.js').PullRecord>; readonly keys: string[] }
  | { readonly surface: 'issues'; readonly res: Page<import('./assistant-watch.reader.js').IssueRecord>; readonly keys: string[] }
  | { readonly surface: 'runs'; readonly res: Page<import('./assistant-watch.reader.js').RunRecord>; readonly keys: string[] }
  | { readonly surface: 'releases'; readonly res: Page<import('./assistant-watch.reader.js').ReleaseRecord>; readonly keys: string[] };

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
