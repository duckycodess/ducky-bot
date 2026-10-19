import type { WatchEventKind, WatchEventPayload } from '@ducky/contracts';
import type {
  CommitRecord, IssueRecord, PullRecord, ReleaseRecord, ReviewRecord, RunRecord,
} from './assistant-watch.reader.js';

/**
 * What a surface read means: the pure part of notification-only watching.
 *
 * Nothing here touches the database, the clock or the network. A function takes
 * what was read and the committed cursor and answers which events it contains,
 * and how far the cursor may move. That is what makes the audited boundary
 * rules testable one at a time: an item at EXACTLY the cursor is old, a window
 * that never reached the cursor is not finished, and an unreadable timestamp is
 * a failure rather than a guess.
 *
 * The rules were derived from a private read-only behavioral audit of the
 * source and are written here independently, in this codebase's own terms.
 */

export interface DerivedEvent {
  readonly kind: WatchEventKind;
  readonly identity: string;
  readonly occurredAt: string;
  readonly payload: WatchEventPayload;
}

export interface SurfaceRead {
  readonly events: readonly DerivedEvent[];
  /** The newest time seen, in ms, or null when the read saw nothing dated. */
  readonly newestMs: number | null;
  /** True once an item at or before the cursor was seen: the window is closed. */
  readonly reachedCursor: boolean;
}

/** A timestamp that cannot be read blocks the unit; it is never replaced by a guess. */
export class UnreadableTimestamp extends Error {
  constructor() {
    super('unreadable timestamp');
  }
}

const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new UnreadableTimestamp();
  return ms;
};
const maxOf = (a: number | null, b: number): number => (a === null || b > a ? b : a);

/**
 * Where an item stands against the cursor.
 *
 * STRICT (the default, and the only mode for a cursor that came from the source
 * or from a baseline): an item AT the cursor is old. INCLUSIVE: an item at the
 * cursor is read again and told from one already announced by its IDENTITY, so an
 * event that reached GitHub late with the same timestamp as the cursor is still
 * announced exactly once. Inclusive is only used when the items at the cursor are
 * known to have been processed here (`boundary_known`); otherwise re-reading them
 * would announce history the source had already announced.
 */
const edges = (sinceMs: number | null, inclusive: boolean) => ({
  /** At or before the cursor: nothing to announce, and the window may close. */
  old: (ms: number): boolean => sinceMs !== null && (inclusive ? ms < sinceMs : ms <= sinceMs),
  /** After the cursor, or at it in inclusive mode. */
  fresh: (ms: number): boolean => sinceMs !== null && (inclusive ? ms >= sinceMs : ms > sinceMs),
});

/** The bare repository name. The owner segment is a name, and no line here needs it. */
export const bareRepoName = (display: string): string => display.split('/')[1] ?? display;

// ---- text that leaves the system -------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const GH_HOST_RE = /\b(?:api\.)?github(?:usercontent)?\.com\/[^\s<>"')\]]*/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const MENTION_RE = /(?<![\w/])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\b/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/**
 * Text taken from a repository, cleaned for the owner's private surfaces.
 *
 * No link, address or @mention survives, because a person's name can appear in
 * a title and none of these messages exists to name a person. The cut is
 * conservative and the transport's own sanitizer runs after it; neither is the
 * only line of defence.
 */
export function scrubText(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const cleaned = text
    .replace(URL_RE, '')
    .replace(GH_HOST_RE, '')
    .replace(EMAIL_RE, '')
    .replace(MENTION_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/** The first line of a commit message, scrubbed. */
const subjectOf = (message: string): string => scrubText(message.split('\n', 1)[0], 140);

// ---- commits ----------------------------------------------------------------

export function deriveCommits(
  items: readonly CommitRecord[],
  sinceMs: number | null,
  branch: string | null,
  inclusive = false,
): SurfaceRead {
  const at_ = edges(sinceMs, inclusive);
  let newest: number | null = null;
  let reached = false;
  const events: DerivedEvent[] = [];
  for (const c of items) {
    const ms = at(c.committedAt);
    newest = maxOf(newest, ms);
    if (sinceMs === null) continue;
    if (at_.old(ms)) {
      reached = true;
      continue;
    }
    events.push({
      kind: 'commit',
      identity: c.sha,
      occurredAt: c.committedAt,
      payload: { subject: subjectOf(c.subject), ...(branch ? { branch } : {}) },
    });
  }
  return { events, newestMs: newest, reachedCursor: reached };
}

// ---- pull requests and their reviews -----------------------------------------

const reviewKind = (state: string): WatchEventKind | undefined => {
  switch (state.toUpperCase()) {
    case 'CHANGES_REQUESTED':
      return 'review_requested_changes';
    case 'APPROVED':
      return 'review_approved';
    case 'COMMENTED':
    case 'DISMISSED':
      return 'review_commented';
    default:
      // A verdict word this build does not know is not an event.
      return undefined;
  }
};

/**
 * Whether a pull request needs its reviews read: open, and touched after the cursor.
 *
 * Inclusive mode also reads one touched AT the cursor. A review that reached
 * GitHub late, stamped with the very second the cursor sits on, is on exactly
 * such a pull request, and its identity (the review id) is what tells it from a
 * review already announced. Strict mode (a baseline, or a cursor that came from
 * the source) never re-reads the boundary, because it cannot tell what the source
 * already announced.
 */
export const pullNeedsReviews = (p: PullRecord, sinceMs: number | null, inclusive = false): boolean =>
  sinceMs !== null && p.state === 'open' && (inclusive ? at(p.updatedAt) >= sinceMs : at(p.updatedAt) > sinceMs);

/** One pull request whose reviews remain to be read, with what its events carry. */
export interface ReviewTarget {
  readonly n: number;
  /** The scrubbed title, so a later unit can build the event without re-reading the list. */
  readonly t: string;
  /** The pull request's last update, the time of its pending-review marker. */
  readonly u: string;
}

export interface PullListRead extends SurfaceRead {
  /** Pull requests, in list order, whose reviews must be read before the window can commit. */
  readonly reviewTargets: readonly ReviewTarget[];
}

/**
 * What a page of the pull request list says, WITHOUT the reviews.
 *
 * Reviews are their own surface of requests (a pull request can have many pages
 * of them), so they are read by later units and turned into events by
 * `deriveReviews`. The list sorts on the update time and events here use it, so a
 * page whose last item is at or before the cursor has closed the window.
 */
export function derivePullList(
  items: readonly PullRecord[],
  sinceMs: number | null,
  inclusive = false,
  /** Lifecycle times (opened, merged, closed) count from here; at or before `sinceMs`. */
  lifeSinceMs: number | null = sinceMs,
): PullListRead {
  const at_ = edges(sinceMs, inclusive);
  const life = edges(lifeSinceMs, inclusive);
  let newest: number | null = null;
  let reached = false;
  const events: DerivedEvent[] = [];
  const reviewTargets: ReviewTarget[] = [];
  for (const p of items) {
    const updated = at(p.updatedAt);
    newest = maxOf(newest, updated);
    if (sinceMs === null) continue;
    if (at_.old(updated)) {
      reached = true;
      continue;
    }
    const base = { number: p.number, title: scrubText(p.title, 140) };
    const created = at(p.createdAt);
    if (life.fresh(created)) {
      events.push({ kind: 'pr_opened', identity: `${p.number}:opened`, occurredAt: p.createdAt, payload: base });
    }
    if (p.mergedAt && life.fresh(at(p.mergedAt))) {
      events.push({ kind: 'pr_merged', identity: `${p.number}:merged`, occurredAt: p.mergedAt, payload: base });
    }
    if (p.closedAt && !p.mergedAt && life.fresh(at(p.closedAt))) {
      events.push({ kind: 'pr_closed', identity: `${p.number}:closed`, occurredAt: p.closedAt, payload: base });
    }
    // An item AT the cursor, re-read in inclusive mode, was already told by the pass that
    // moved the cursor onto it (as opened, merged, closed or updated). Calling it
    // "updated" again would be a new identity for the same instant, so it is only the
    // lifecycle kinds, which have stable identities, that a re-read may announce.
    const atBoundary = inclusive && sinceMs !== null && updated === sinceMs;
    // Judged against the REAL cursor, never the lower lifecycle floor: a comment-only touch
    // after an opening the last window already told is an update, whatever the floor says.
    if (p.state === 'open' && !at_.fresh(created) && !atBoundary) {
      events.push({
        kind: 'pr_updated', identity: `${p.number}:updated:${p.updatedAt}`,
        occurredAt: p.updatedAt, payload: base,
      });
    }
    if (pullNeedsReviews(p, sinceMs, inclusive)) {
      reviewTargets.push({ n: p.number, t: base.title, u: p.updatedAt });
    }
  }
  return { events, newestMs: newest, reachedCursor: reached, reviewTargets };
}

export interface ReviewsRead {
  readonly events: readonly DerivedEvent[];
  /** Whether any review on this page asked for changes (judged over EVERY review, cut or not). */
  readonly changesRequested: boolean;
}

/**
 * What one page of one pull request's reviews says.
 *
 * The pending marker is judged over every review, before the cursor cut, and is
 * emitted by `reviewPendingMarker` once the LAST page has been read. A review
 * submitted at or before the cursor is skipped in strict mode; in inclusive mode
 * one AT the cursor is read again and told from an announced one by its id.
 */
export function deriveReviews(
  target: ReviewTarget,
  reviews: readonly ReviewRecord[],
  sinceMs: number,
  inclusive = false,
): ReviewsRead {
  const events: DerivedEvent[] = [];
  let changesRequested = false;
  const base = { number: target.n, title: target.t };
  for (const r of reviews) {
    const kind = reviewKind(r.state);
    if (kind === 'review_requested_changes') changesRequested = true;
    if (r.submittedAt) {
      const submitted = at(r.submittedAt);
      if (inclusive ? submitted < sinceMs : submitted <= sinceMs) continue;
    }
    if (!kind) continue;
    events.push({
      kind,
      identity: `${target.n}:review:${r.id}`,
      occurredAt: r.submittedAt ?? target.u,
      payload: { ...base, ...(r.body ? { summary: scrubText(r.body, 600) } : {}) },
    });
  }
  return { events, changesRequested };
}

/** The marker that says a pull request still has requested changes. It exists to dedupe. */
export const reviewPendingMarker = (target: ReviewTarget): DerivedEvent => ({
  kind: 'review_pending',
  identity: `${target.n}:pending`,
  occurredAt: target.u,
  payload: { number: target.n, title: target.t },
});

// ---- issues -----------------------------------------------------------------

export function deriveIssues(
  items: readonly IssueRecord[],
  sinceMs: number | null,
  inclusive = false,
  windowStamp: string | null = null,
  /** Lifecycle times (opened, closed) count from here; at or before `sinceMs`. */
  lifeSinceMs: number | null = sinceMs,
): SurfaceRead {
  const at_ = edges(sinceMs, inclusive);
  const life = edges(lifeSinceMs, inclusive);
  let newest: number | null = null;
  // The listing mixes issues with pull requests and sorts them on ONE key, so the
  // last raw item's time proves how far down this page reached even when that
  // item was a pull request that is not in `items`.
  let reached = sinceMs !== null && windowStamp !== null && at_.old(at(windowStamp));
  const events: DerivedEvent[] = [];
  for (const i of items) {
    const updated = at(i.updatedAt);
    newest = maxOf(newest, updated);
    if (sinceMs === null) continue;
    if (at_.old(updated)) {
      reached = true;
      continue;
    }
    // ONE classification per issue per pass, with the audited precedence, judged against
    // the REAL committed cursor only: opened if it was created after the cursor, else
    // closed if it was closed after it, else updated. The lower lifecycle floor never
    // replaces or suppresses that current classification (a comment-only touch after an
    // opening the last window told is an update, and a close in this window beats a
    // replayed opening).
    const base = { number: i.number, title: scrubText(i.title, 140) };
    const push = (kind: 'issue_opened' | 'issue_closed' | 'issue_updated', when: string): void => {
      events.push({ kind, identity: `${i.number}:${kind}:${when}`, occurredAt: when, payload: base });
    };
    if (at_.fresh(at(i.createdAt))) {
      push('issue_opened', i.createdAt);
    } else if (i.closedAt && at_.fresh(at(i.closedAt))) {
      push('issue_closed', i.closedAt);
    } else if (!(inclusive && sinceMs !== null && updated === sinceMs)) {
      // See derivePullList: an item AT the cursor was already told by the pass that moved
      // the cursor onto it, and "updated" has no stable identity to dedupe by.
      push('issue_updated', i.updatedAt);
    }
    // Reconciliation of an EARLIER multi-page read that may have missed a lifecycle
    // transition (an item moved between page reads): it only ADDS a transition that
    // belongs to the window before this one, with the same precedence, and identities
    // deduplicate whatever was already told. It is not a second classification of this
    // window, so it never fires for a transition the current cursor already covers.
    const old = (ms: number): boolean => life.fresh(ms) && !at_.fresh(ms);
    if (old(at(i.createdAt))) push('issue_opened', i.createdAt);
    else if (i.closedAt && old(at(i.closedAt)) && !at_.fresh(at(i.createdAt))) push('issue_closed', i.closedAt);
  }
  return { events, newestMs: newest, reachedCursor: reached };
}

// ---- workflow runs -----------------------------------------------------------

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const UNSETTLED_RUN = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export interface RunsRead extends SurfaceRead {
  /** What the newest NEW conclusion says, or null when no new run concluded. */
  readonly ciState: 'failing' | 'passing' | null;
  /** The oldest creation time (ms) of a run seen unsettled on this page, or null. */
  readonly unsettledFloorMs: number | null;
  /** The oldest last-update time (ms) of a run seen unsettled on this page, or null. */
  readonly unsettledStampMs: number | null;
  /**
   * The oldest creation time (ms) of a run whose last update is AFTER the baseline
   * boundary, or null. Only a baseline read (`boundaryMs`) computes it: such a run
   * moved while the baseline was being read and nothing has announced it yet.
   */
  readonly touchedFloorMs: number | null;
  /**
   * Ids of runs that were ALREADY queued or running at the baseline boundary (created at
   * or before it). Their start is history; the baseline records each as an identity
   * marker settled at birth, so a later update never announces it. Empty outside a baseline.
   */
  readonly underwayIds: readonly string[];
}

/**
 * The start of the second `ms` falls in, less one millisecond.
 *
 * GitHub stamps whole seconds. A time taken from the local clock in the middle of a
 * second would otherwise sit AFTER an event stamped at the start of that same second,
 * and a strict "after" comparison would call that event history. One millisecond
 * before the second begins keeps every event of the current second (and any later
 * one) on the announced side. It leaks at most the events of that one second; clock
 * skew beyond it is NOT covered (ADR 0031).
 */
export const secondBoundaryMs = (ms: number): number => ms - (ms % 1000) - 1;

/**
 * The creation time a window must reach before it is closed.
 *
 * Runs and releases are listed newest-CREATED first, but their events carry a
 * later time (a run's last update, a release's publication). Reaching an item
 * updated at the cursor proves nothing, because an older-created item can still
 * be updated after it. What does close the window is reaching an item CREATED
 * STRICTLY BEFORE both the cursor and the creation time of the oldest item that was
 * still unsettled (running, or a draft) when the last window closed: every item
 * created earlier than that was settled then, and a settled run or a published
 * release does not change again. Strictly, because items created in the same second
 * can span a page boundary and the one that matters may sit on the next page.
 */
export const windowThresholdMs = (sinceMs: number | null, floorMs: number | null): number | null =>
  sinceMs === null ? null : floorMs === null ? sinceMs : Math.min(sinceMs, floorMs);

export function deriveRuns(
  items: readonly RunRecord[],
  sinceMs: number | null,
  previouslyFailing: boolean,
  inclusive = false,
  floorMs: number | null = null,
  /** A baseline read's frozen boundary: runs updated after it are `touchedFloorMs`. */
  boundaryMs: number | null = null,
): RunsRead {
  const at_ = edges(sinceMs, inclusive);
  const threshold = windowThresholdMs(sinceMs, floorMs);
  let newest: number | null = null;
  let newestConclusion: string | null = null;
  let reached = false;
  let unsettledFloor: number | null = null;
  let unsettledStamp: number | null = null;
  let touchedFloor: number | null = null;
  const underway: string[] = [];
  const events: DerivedEvent[] = [];
  for (const r of items) {
    const stamp = r.updatedAt ?? r.createdAt;
    const ms = at(stamp);
    const created = at(r.createdAt);
    newest = maxOf(newest, ms);
    const status = r.status.toLowerCase();
    // No age cutoff: a run that is still unsettled is tracked for as long as it is. Only
    // its settlement, or its absence from a window that reached its creation time,
    // releases it.
    if (UNSETTLED_RUN.has(status)) {
      unsettledFloor = unsettledFloor === null || created < unsettledFloor ? created : unsettledFloor;
      unsettledStamp = unsettledStamp === null || ms < unsettledStamp ? ms : unsettledStamp;
    }
    if (boundaryMs !== null && ms > boundaryMs) {
      touchedFloor = touchedFloor === null || created < touchedFloor ? created : touchedFloor;
    }
    if (boundaryMs !== null && (status === 'queued' || status === 'in_progress') && created <= boundaryMs) {
      underway.push(r.id);
    }
    // STRICTLY before: items created in the same second as the threshold can span a page
    // boundary, and the one that matters may sit on the next page.
    if (threshold !== null && created < threshold) reached = true;
    if (sinceMs === null || at_.old(ms)) continue;
    const conclusion = (r.conclusion ?? '').toLowerCase();
    let kind: WatchEventKind | undefined;
    // A start is announced from an UPDATE after the cursor, whenever the run is seen queued
    // or running. Judging it by creation against a moving cursor loses it (a run inserted
    // late, with an older run's conclusion carrying the cursor past its creation); a run
    // already underway at a baseline is silenced by identity marker instead (`underwayIds`).
    if (status === 'queued' || status === 'in_progress') kind = 'ci_started';
    else if (FAILED.has(conclusion)) kind = 'ci_failed';
    else if (conclusion === 'success') kind = previouslyFailing ? 'ci_recovered' : undefined;
    if (newestConclusion === null && conclusion) newestConclusion = conclusion;
    if (kind) {
      events.push({
        kind, identity: `${r.id}:${kind}`, occurredAt: stamp,
        payload: { workflow: scrubText(r.name, 60), branch: scrubText(r.branch, 80) },
      });
    }
  }
  return {
    events, newestMs: newest, reachedCursor: reached, unsettledFloorMs: unsettledFloor,
    unsettledStampMs: unsettledStamp, touchedFloorMs: touchedFloor, underwayIds: underway,
    ciState: newestConclusion === null ? null : FAILED.has(newestConclusion) ? 'failing' : 'passing',
  };
}

// ---- releases ---------------------------------------------------------------

export interface ReleasesRead extends SurfaceRead {
  /** The oldest creation time (ms) of a draft seen on this page, or null. */
  readonly unsettledFloorMs: number | null;
  /** The oldest creation time (ms) of a release published AFTER the baseline boundary, or null. */
  readonly touchedFloorMs: number | null;
  /**
   * A release whose position in a creation-sorted window is unknown and matters: a draft
   * with no usable creation time, or (in a baseline) a published release with none whose
   * publication is after the boundary. Neither can be floored, so the next window could
   * close before reaching it; the surface is refused instead.
   */
  readonly untrackable: boolean;
}

export function deriveReleases(
  items: readonly ReleaseRecord[],
  sinceMs: number | null,
  inclusive = false,
  floorMs: number | null = null,
  /** A baseline read's frozen boundary: releases published after it are `touchedFloorMs`. */
  boundaryMs: number | null = null,
): ReleasesRead {
  const at_ = edges(sinceMs, inclusive);
  const threshold = windowThresholdMs(sinceMs, floorMs);
  let newest: number | null = null;
  let reached = false;
  let unsettledFloor: number | null = null;
  let touchedFloor: number | null = null;
  let untrackable = false;
  const events: DerivedEvent[] = [];
  for (const r of items) {
    const created = r.createdAt ? at(r.createdAt) : null;
    if (created !== null && threshold !== null && created < threshold) reached = true;
    // A draft is not a publication. It is tracked, so that when it is published
    // the window reaches back to where it sits, and it announces nothing now.
    // There is no age cutoff, and a draft that cannot be placed is refused, not ignored.
    if (r.draft) {
      if (created === null) untrackable = true;
      else unsettledFloor = unsettledFloor === null || created < unsettledFloor ? created : unsettledFloor;
      continue;
    }
    const stamp = r.publishedAt ?? r.createdAt;
    if (!stamp) continue;
    const ms = at(stamp);
    newest = maxOf(newest, ms);
    if (boundaryMs !== null && ms > boundaryMs) {
      if (created === null) untrackable = true;
      else touchedFloor = touchedFloor === null || created < touchedFloor ? created : touchedFloor;
    }
    if (sinceMs === null || at_.old(ms)) continue;
    events.push({
      kind: 'release', identity: `release:${r.id}`, occurredAt: stamp,
      payload: { tag: scrubText(r.tag, 40), name: scrubText(r.name, 100) },
    });
  }
  return {
    events, newestMs: newest, reachedCursor: reached, unsettledFloorMs: unsettledFloor,
    touchedFloorMs: touchedFloor, untrackable,
  };
}

// ---- the default branch ------------------------------------------------------

export function deriveDefaultBranch(
  current: string,
  stored: string | null,
  nowIso: string,
): { events: readonly DerivedEvent[]; cursor: string } {
  if (stored === null || stored === current) return { events: [], cursor: current };
  return {
    cursor: current,
    events: [{
      kind: 'default_branch_change', identity: `default:${stored}->${current}`, occurredAt: nowIso,
      payload: { branch: scrubText(current, 255) },
    }],
  };
}
