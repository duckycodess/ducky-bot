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

/** Whether a pull request needs its reviews read: open, and touched after the cursor. */
export const pullNeedsReviews = (p: PullRecord, sinceMs: number | null): boolean =>
  sinceMs !== null && p.state === 'open' && at(p.updatedAt) > sinceMs;
// Reviews are read only for a pull request touched strictly AFTER the cursor, and a
// review at the cursor is skipped, in every mode: a late equal-time REVIEW is not
// reconciled, which is recorded as a residual parity risk rather than guessed at.

export function derivePulls(
  items: readonly PullRecord[],
  sinceMs: number | null,
  reviews: ReadonlyMap<number, readonly ReviewRecord[]>,
  inclusive = false,
): SurfaceRead {
  const at_ = edges(sinceMs, inclusive);
  let newest: number | null = null;
  let reached = false;
  const events: DerivedEvent[] = [];
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
    if (at_.fresh(created)) {
      events.push({ kind: 'pr_opened', identity: `${p.number}:opened`, occurredAt: p.createdAt, payload: base });
    }
    if (p.mergedAt && at_.fresh(at(p.mergedAt))) {
      events.push({ kind: 'pr_merged', identity: `${p.number}:merged`, occurredAt: p.mergedAt, payload: base });
    }
    if (p.closedAt && !p.mergedAt && at_.fresh(at(p.closedAt))) {
      events.push({ kind: 'pr_closed', identity: `${p.number}:closed`, occurredAt: p.closedAt, payload: base });
    }
    if (p.state === 'open' && !at_.fresh(created)) {
      events.push({
        kind: 'pr_updated', identity: `${p.number}:updated:${p.updatedAt}`,
        occurredAt: p.updatedAt, payload: base,
      });
    }
    if (p.state === 'open') {
      let changesRequested = false;
      for (const r of reviews.get(p.number) ?? []) {
        const kind = reviewKind(r.state);
        // The pending marker is judged over EVERY review, before the cursor cut.
        if (kind === 'review_requested_changes') changesRequested = true;
        if (r.submittedAt && at(r.submittedAt) <= sinceMs) continue;
        if (!kind) continue;
        events.push({
          kind,
          identity: `${p.number}:review:${r.id}`,
          occurredAt: r.submittedAt ?? p.updatedAt,
          payload: { ...base, ...(r.body ? { summary: scrubText(r.body, 600) } : {}) },
        });
      }
      if (changesRequested) {
        events.push({ kind: 'review_pending', identity: `${p.number}:pending`, occurredAt: p.updatedAt, payload: base });
      }
    }
  }
  return { events, newestMs: newest, reachedCursor: reached };
}

// ---- issues -----------------------------------------------------------------

export function deriveIssues(
  items: readonly IssueRecord[],
  sinceMs: number | null,
  inclusive = false,
): SurfaceRead {
  const at_ = edges(sinceMs, inclusive);
  let newest: number | null = null;
  let reached = false;
  const events: DerivedEvent[] = [];
  for (const i of items) {
    const updated = at(i.updatedAt);
    newest = maxOf(newest, updated);
    if (sinceMs === null) continue;
    if (at_.old(updated)) {
      reached = true;
      continue;
    }
    // One classification per issue per pass.
    let kind: 'issue_opened' | 'issue_closed' | 'issue_updated';
    let when: string;
    if (at_.fresh(at(i.createdAt))) {
      kind = 'issue_opened';
      when = i.createdAt;
    } else if (i.closedAt && at_.fresh(at(i.closedAt))) {
      kind = 'issue_closed';
      when = i.closedAt;
    } else {
      kind = 'issue_updated';
      when = i.updatedAt;
    }
    events.push({
      kind, identity: `${i.number}:${kind}:${when}`, occurredAt: when,
      payload: { number: i.number, title: scrubText(i.title, 140) },
    });
  }
  return { events, newestMs: newest, reachedCursor: reached };
}

// ---- workflow runs -----------------------------------------------------------

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

export interface RunsRead extends SurfaceRead {
  /** What the newest NEW conclusion says, or null when no new run concluded. */
  readonly ciState: 'failing' | 'passing' | null;
}

export function deriveRuns(
  items: readonly RunRecord[],
  sinceMs: number | null,
  previouslyFailing: boolean,
  inclusive = false,
): RunsRead {
  const at_ = edges(sinceMs, inclusive);
  let newest: number | null = null;
  let newestConclusion: string | null = null;
  const events: DerivedEvent[] = [];
  for (const r of items) {
    const stamp = r.updatedAt ?? r.createdAt;
    const ms = at(stamp);
    newest = maxOf(newest, ms);
    if (sinceMs === null || at_.old(ms)) continue;
    const status = r.status.toLowerCase();
    const conclusion = (r.conclusion ?? '').toLowerCase();
    let kind: WatchEventKind | undefined;
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
    events, newestMs: newest, reachedCursor: true,
    ciState: newestConclusion === null ? null : FAILED.has(newestConclusion) ? 'failing' : 'passing',
  };
}

// ---- releases ---------------------------------------------------------------

export function deriveReleases(
  items: readonly ReleaseRecord[],
  sinceMs: number | null,
  inclusive = false,
): SurfaceRead {
  const at_ = edges(sinceMs, inclusive);
  let newest: number | null = null;
  const events: DerivedEvent[] = [];
  for (const r of items) {
    const stamp = r.publishedAt ?? r.createdAt;
    if (!stamp) continue;
    const ms = at(stamp);
    newest = maxOf(newest, ms);
    if (sinceMs === null || at_.old(ms)) continue;
    events.push({
      kind: 'release', identity: `release:${r.id}`, occurredAt: stamp,
      payload: { tag: scrubText(r.tag, 40), name: scrubText(r.name, 100) },
    });
  }
  return { events, newestMs: newest, reachedCursor: true };
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
