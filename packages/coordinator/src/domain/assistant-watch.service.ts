import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_DIGEST_MAX_LINES_PER_REPO, ASSISTANT_DIGEST_MAX_REPOS, ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS,
  ASSISTANT_WATCH_BACKOFF_MAX_MS, ASSISTANT_WATCH_CALLS_PER_HOUR, ASSISTANT_WATCH_CALLS_PER_TICK,
  ASSISTANT_WATCH_EVENT_BATCH, ASSISTANT_WATCH_EVENT_KEEP_DAYS, ASSISTANT_WATCH_INTERVAL_MINUTES,
  ASSISTANT_WATCH_MAX_PAGES, ASSISTANT_WATCH_PAGE_SIZE, DuckyError, WATCH_EVENT_KINDS,
  WATCH_EVENT_SURFACE, type GitHubFeedKind, type WatchEventKind, type WatchSurface,
} from '@ducky/contracts';
import type {
  DueCheckpoint, ObservedEventWrite, Store, WatchEventWithTarget, WatchTargetRow,
} from '@ducky/persistence';
import { dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { assistantWatchAlert } from '../discord/assistant-presenters.js';
import type { ActorContext, Authorizer } from '../security/authz.js';
import {
  UnreadableTimestamp, bareRepoName, deriveCommits, deriveDefaultBranch, deriveIssues, derivePulls,
  deriveReleases, deriveRuns, pullNeedsReviews, scrubText, type DerivedEvent, type SurfaceRead,
} from './assistant-watch.engine.js';
import type { AssistantWatchReader, ReviewRecord, WatchRepoRef } from './assistant-watch.reader.js';
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
 * through which surface. `review_requested` is absent on purpose: a review
 * requested of the owner is a search across repositories, not a fact about one
 * watched repository, so nothing imported produces it.
 */
export const IMPORT_COVERS_NATIVE: Partial<Record<GitHubFeedKind, WatchSurface>> = {
  pr_opened: 'pulls',
  issue_opened: 'issues',
  changes_requested: 'pulls',
  check_failed: 'runs',
};

/** The most calls one unit can make, so a unit is only started when it fits. */
const worstCaseCalls = (surface: WatchSurface): number =>
  surface === 'pulls' ? 1 + ASSISTANT_WATCH_PAGE_SIZE : 1;

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

    while (left > 0) {
      const [unit] = repo.dueCheckpoints(isoOf(this.clock.nowMs()), 1);
      if (!unit) break;
      if (!this.observable(unit.surface)) {
        repo.block(unit.targetId, unit.surface, 'unobservable', this.clock.nowIso());
        out.blocked += 1;
        continue;
      }
      // Strictly oldest-first: if the longest-waiting unit does not fit, the
      // tick ends rather than serving a cheaper, younger one past it.
      if (worstCaseCalls(unit.surface) > left) {
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

  private async observeUnit(
    unit: DueCheckpoint,
    used: { n: number },
  ): Promise<'completed' | 'incomplete' | 'failed' | 'blocked'> {
    const repo = this.store.assistantWatch;
    const nowMs = this.clock.nowMs();
    const nowIso = isoOf(nowMs);
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      used.n += 1;
      return fn();
    };
    const ref = refOf(unit.display);
    const baseline = unit.cursor === null;
    const timeCursor = unit.surface === 'default_branch' || baseline ? null : unit.cursor;
    const sinceMs = timeCursor === null ? null : Date.parse(timeCursor);
    if (timeCursor !== null && Number.isNaN(sinceMs)) {
      return this.fail(unit, nowMs, 'unreadable_cursor');
    }
    const page = unit.pendingPage + 1;

    try {
      let read: SurfaceRead;
      let hasMore = false;
      let alsoSet: { surface: WatchSurface; cursor: string } | undefined;

      switch (unit.surface) {
        case 'commits': {
          const res = await call(() => this.reader.commits(ref, unit.defaultBranch, page));
          hasMore = res.hasMore;
          read = deriveCommits(res.items, sinceMs, unit.defaultBranch);
          break;
        }
        case 'pulls': {
          const res = await call(() => this.reader.pulls(ref, page));
          if (res.items.length > ASSISTANT_WATCH_PAGE_SIZE) return this.fail(unit, nowMs, 'page_too_large');
          hasMore = res.hasMore;
          const reviews = new Map<number, readonly ReviewRecord[]>();
          for (const p of res.items) {
            if (pullNeedsReviews(p, sinceMs)) {
              reviews.set(p.number, await call(() => this.reader.pullReviews(ref, p.number)));
            }
          }
          read = derivePulls(res.items, sinceMs, reviews);
          break;
        }
        case 'issues': {
          const res = await call(() => this.reader.issues(ref, page));
          hasMore = res.hasMore;
          read = deriveIssues(res.items, sinceMs);
          break;
        }
        case 'runs': {
          const items = await call(() => this.reader.runs(ref, unit.defaultBranch));
          const failing = repo.checkpoint(unit.targetId, 'ci_state')?.cursor === 'failing';
          const runs = deriveRuns(items, sinceMs, failing);
          read = runs;
          if (!baseline && runs.ciState !== null) alsoSet = { surface: 'ci_state', cursor: runs.ciState };
          break;
        }
        case 'releases': {
          const items = await call(() => this.reader.releases(ref));
          read = deriveReleases(items, sinceMs);
          break;
        }
        case 'default_branch': {
          const current = await call(() => this.reader.defaultBranch(ref));
          const d = deriveDefaultBranch(current, unit.cursor, nowIso);
          const wrote = repo.commitObservation({
            targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
            cursor: d.cursor, nextDueAt: this.nextDue(nowMs), atIso: nowIso,
            events: d.events.map((e) => this.write(e)),
          });
          return wrote === undefined ? 'incomplete' : 'completed';
        }
        default:
          // `ci_state` moves with `runs` and is never read on its own.
          return 'incomplete';
      }

      const priorNewest = unit.pendingCursor === null ? null : Date.parse(unit.pendingCursor);
      const newest = [priorNewest, read.newestMs].reduce<number | null>(
        (a, b) => (b === null || Number.isNaN(b) ? a : a === null || b > a ? b : a), null,
      );
      const complete = baseline || read.reachedCursor || !hasMore;

      if (!complete) {
        if (page >= ASSISTANT_WATCH_MAX_PAGES) {
          // A window this deep is not something to chase: say so and stop, with
          // the cursor and everything found so far left exactly as they were.
          repo.block(unit.targetId, unit.surface, 'window_exceeded', nowIso);
          return 'blocked';
        }
        repo.savePending({
          targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
          pendingCursor: isoOf(newest ?? nowMs), pendingPage: page,
          // Continue at once: the read is half done, and others still go first
          // because they have been waiting longer.
          nextDueAt: nowIso, atIso: nowIso, events: read.events.map((e) => this.write(e)),
        });
        return 'incomplete';
      }

      const cursorMs = Math.max(sinceMs ?? Number.NEGATIVE_INFINITY, newest ?? Number.NEGATIVE_INFINITY);
      const committed = repo.commitObservation({
        targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
        cursor: isoOf(Number.isFinite(cursorMs) ? cursorMs : nowMs),
        nextDueAt: this.nextDue(nowMs), atIso: nowIso,
        events: read.events.map((e) => this.write(e)),
        ...(alsoSet ? { alsoSet } : {}),
      });
      if (committed !== undefined) repo.touchObserved(unit.targetId, nowIso);
      return 'completed';
    } catch (err) {
      return this.fail(unit, nowMs, err instanceof UnreadableTimestamp ? 'unreadable_timestamp' : 'read_failed');
    }
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

  /** A failed read: backoff, a short code and nothing else. The cursor is untouched. */
  private fail(unit: DueCheckpoint, nowMs: number, code: string): 'failed' {
    const delay = Math.min(
      ASSISTANT_WATCH_INTERVAL_MINUTES * MINUTE * 2 ** Math.min(unit.failures, 10),
      ASSISTANT_WATCH_BACKOFF_MAX_MS,
    );
    this.store.assistantWatch.recordFailure({
      targetId: unit.targetId, surface: unit.surface, expectedUpdatedAt: unit.updatedAt,
      nextDueAt: isoOf(nowMs + delay), errorCode: code, atIso: isoOf(nowMs),
    });
    return 'failed';
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
