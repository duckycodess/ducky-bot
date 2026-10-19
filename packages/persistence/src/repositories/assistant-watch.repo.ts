import {
  TIME_CURSOR_SURFACES, WATCH_ALERT_KINDS, WATCH_EVENT_SURFACE, type WatchEventKind, type WatchSurface,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import { atomically } from '../db.js';

export type WatchCheckpointState = 'unbaselined' | 'imported' | 'ready';

export interface WatchTargetRow {
  readonly id: string;
  readonly publicId: string;
  readonly discordUserId: string;
  readonly repoKey: string;
  readonly display: string;
  readonly defaultBranch: string | null;
  readonly state: 'active' | 'cancelled';
  readonly lastObservedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  /** The provider's last-push time for the repository, the recency a poll cycle orders by. */
  readonly pushedAt: string | null;
  readonly relationship: 'owner' | 'organization' | 'collaborator' | null;
  readonly archived: boolean;
  readonly fork: boolean;
  /** Set when the SYSTEM cancelled the target (never when the owner did). */
  readonly cancelReason: string | null;
  readonly origin: 'imported' | 'discovered';
}

export interface WatchCheckpointRow {
  readonly targetId: string;
  readonly surface: WatchSurface;
  readonly state: WatchCheckpointState;
  readonly cursor: string | null;
  readonly pendingCursor: string | null;
  readonly pendingPage: number;
  /** Whether items exactly at the cursor were processed here; see the migration. */
  readonly boundaryKnown: boolean;
  readonly nextDueAt: string;
  readonly failures: number;
  readonly lastError: string | null;
  readonly blockedReason: string | null;
  /** The service's JSON position inside a multi-request read; null between reads. */
  readonly pendingState: string | null;
  /** Creation time of the oldest item still unsettled when the last window closed. */
  readonly scanFloor: string | null;
  /** Where lifecycle times count from for one more read after a multi-page window. */
  readonly lifecycleFloor: string | null;
  readonly updatedAt: string;
}

export interface WatchEventRow {
  readonly id: string;
  readonly targetId: string;
  readonly kind: WatchEventKind;
  readonly surface: WatchSurface;
  readonly held: boolean;
  readonly identity: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
  readonly origin: 'imported' | 'observed';
  readonly alertedAt: string | null;
  readonly alertAttempts: number;
  readonly alertAbandonedAt: string | null;
  readonly digestedAt: string | null;
  readonly createdAt: string;
}

/** An event with the target it belongs to, for rendering. */
export interface WatchEventWithTarget extends WatchEventRow {
  readonly display: string;
  readonly discordUserId: string;
}

/**
 * The source's recency-limited poll cycle (ADR 0031): at most `limit` ELIGIBLE
 * active targets, most recently pushed first, have their surfaces read each cycle.
 * Eligibility is not archived (unless included) and not a fork the account owns
 * (unless included). A target whose recency is not yet known is not covered; its
 * metadata surface runs first and fills the recency in.
 */
export interface PollCycle {
  readonly ownerId: string;
  readonly limit: number;
  readonly includeArchived: boolean;
  readonly includeForks: boolean;
  /** Relationships whose targets may occupy a slot; a target outside them never does. */
  readonly relationships?: readonly ('owner' | 'organization' | 'collaborator')[];
}

export interface DiscoveryRow {
  readonly ownerId: string;
  readonly pendingPage: number;
  readonly passCapacityBlocked: boolean;
  readonly nextDueAt: string;
  readonly lastCompletedAt: string | null;
  readonly incomplete: boolean;
  readonly capacityBlocked: boolean;
  readonly failures: number;
  readonly lastError: string | null;
}

/** What a discovered repository did to the target list. */
export type DiscoveredOutcome = 'created' | 'updated' | 'tombstoned' | 'over_capacity';

/** A checkpoint that is due, with the target it belongs to. */
export interface DueCheckpoint extends WatchCheckpointRow {
  readonly repoKey: string;
  readonly display: string;
  readonly defaultBranch: string | null;
}

const mapTarget = (r: Record<string, unknown>): WatchTargetRow => ({
  id: String(r['id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  repoKey: String(r['repo_key']),
  display: String(r['display']),
  defaultBranch: r['default_branch'] == null ? null : String(r['default_branch']),
  state: String(r['state']) as 'active' | 'cancelled',
  lastObservedAt: r['last_observed_at'] == null ? null : String(r['last_observed_at']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  cancelledAt: r['cancelled_at'] == null ? null : String(r['cancelled_at']),
  pushedAt: r['pushed_at'] == null ? null : String(r['pushed_at']),
  relationship: r['relationship'] == null ? null : (String(r['relationship']) as 'owner' | 'organization' | 'collaborator'),
  archived: Number(r['archived'] ?? 0) === 1,
  fork: Number(r['fork'] ?? 0) === 1,
  cancelReason: r['cancel_reason'] == null ? null : String(r['cancel_reason']),
  origin: String(r['origin'] ?? 'imported') as 'imported' | 'discovered',
});

const mapCheckpoint = (r: Record<string, unknown>): WatchCheckpointRow => ({
  targetId: String(r['target_id']),
  surface: String(r['surface']) as WatchSurface,
  state: String(r['state']) as WatchCheckpointState,
  cursor: r['cursor'] == null ? null : String(r['cursor']),
  pendingCursor: r['pending_cursor'] == null ? null : String(r['pending_cursor']),
  pendingPage: Number(r['pending_page']),
  boundaryKnown: Number(r['boundary_known']) === 1,
  nextDueAt: String(r['next_due_at']),
  failures: Number(r['failures']),
  lastError: r['last_error'] == null ? null : String(r['last_error']),
  blockedReason: r['blocked_reason'] == null ? null : String(r['blocked_reason']),
  pendingState: r['pending_state'] == null ? null : String(r['pending_state']),
  scanFloor: r['scan_floor'] == null ? null : String(r['scan_floor']),
  lifecycleFloor: r['lifecycle_floor'] == null ? null : String(r['lifecycle_floor']),
  updatedAt: String(r['updated_at']),
});

const mapEvent = (r: Record<string, unknown>): WatchEventRow => ({
  id: String(r['id']),
  targetId: String(r['target_id']),
  kind: String(r['kind']) as WatchEventKind,
  surface: String(r['surface']) as WatchSurface,
  held: Number(r['held']) === 1,
  identity: String(r['identity']),
  occurredAt: String(r['occurred_at']),
  payloadJson: String(r['payload_json']),
  origin: String(r['origin']) as 'imported' | 'observed',
  alertedAt: r['alerted_at'] == null ? null : String(r['alerted_at']),
  alertAttempts: Number(r['alert_attempts']),
  alertAbandonedAt: r['alert_abandoned_at'] == null ? null : String(r['alert_abandoned_at']),
  digestedAt: r['digested_at'] == null ? null : String(r['digested_at']),
  createdAt: String(r['created_at']),
});

/** An event the engine observed, ready to be recorded. */
export interface ObservedEventWrite {
  readonly id: string;
  readonly kind: WatchEventKind;
  readonly identity: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
  /** Settled at birth: an event that is already known must not be announced. */
  readonly settled: boolean;
}

/**
 * The eligibility the source applies before it polls: not muted or unmonitored
 * (a cancelled target), not archived unless included, and a fork excluded ONLY
 * when the account owns it, unless forks are included. A fork in an organization
 * or owned by a collaborator stays eligible, because those are assignment
 * repositories.
 */
const ELIGIBLE_SQL = `t.discord_user_id = :owner AND t.state = 'active'
  AND (t.archived = 0 OR :includeArchived = 1)
  AND NOT (t.fork = 1 AND t.relationship = 'owner' AND :includeForks = 0)
  AND (t.relationship IS NULL OR t.relationship IN (:relA, :relB, :relC))
  AND NOT EXISTS (SELECT 1 FROM assistant_watch_checkpoints b
                   WHERE b.target_id = t.id AND b.blocked_reason = 'identity_changed')`;
const CYCLE_SQL = `SELECT t.id AS id FROM assistant_watch_targets t
  WHERE ${ELIGIBLE_SQL} AND t.pushed_at IS NOT NULL
  ORDER BY t.pushed_at DESC, t.repo_key ASC LIMIT :cycleLimit`;
const eligibleParams = (c: PollCycle) => {
  const rel = c.relationships ?? ['owner', 'organization', 'collaborator'];
  return {
    owner: c.ownerId, includeArchived: c.includeArchived ? 1 : 0, includeForks: c.includeForks ? 1 : 0,
    relA: rel[0] ?? '', relB: rel[1] ?? '', relC: rel[2] ?? '',
  };
};
const cycleParams = (c: PollCycle) => ({ ...eligibleParams(c), cycleLimit: c.limit });

const ALERT_LIST = WATCH_ALERT_KINDS.map((k) => `'${k}'`).join(',');

/**
 * Notification-only watch targets, their typed checkpoints and their events.
 *
 * Nothing here references `repos` or `allow_jobs`, and nothing reads
 * `github_watches`. A row in this repository grants no job, no model and no
 * owner role; it only says "tell the owner about this repository".
 */
export class AssistantWatchRepo {
  constructor(private readonly db: Db) {}

  // ---- targets ------------------------------------------------------------

  insertTarget(row: {
    id: string;
    publicId: string;
    discordUserId: string;
    repoKey: string;
    display: string;
    defaultBranch: string | null;
    state: 'active' | 'cancelled';
    lastObservedAt: string | null;
    createdAt: string;
    cancelledAt: string | null;
    origin?: 'imported' | 'discovered';
    pushedAt?: string | null;
    relationship?: 'owner' | 'organization' | 'collaborator' | null;
    archived?: boolean;
    fork?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO assistant_watch_targets
           (id, public_id, discord_user_id, repo_key, display, default_branch, state,
            last_observed_at, created_at, updated_at, cancelled_at,
            origin, pushed_at, relationship, archived, fork)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.publicId, row.discordUserId, row.repoKey, row.display, row.defaultBranch,
        row.state, row.lastObservedAt, row.createdAt, row.createdAt, row.cancelledAt,
        row.origin ?? 'imported', row.pushedAt ?? null, row.relationship ?? null,
        row.archived ? 1 : 0, row.fork ? 1 : 0,
      );
  }

  publicIdExists(publicId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM assistant_watch_targets WHERE public_id = ?').get(publicId) !==
      undefined
    );
  }

  byPublicId(ownerId: string, publicId: string): WatchTargetRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM assistant_watch_targets WHERE discord_user_id = ? AND public_id = ?')
      .get(ownerId, publicId);
    return r ? mapTarget(r as Record<string, unknown>) : undefined;
  }

  byRepoKey(ownerId: string, repoKey: string): WatchTargetRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM assistant_watch_targets WHERE discord_user_id = ? AND repo_key = ?')
      .get(ownerId, repoKey);
    return r ? mapTarget(r as Record<string, unknown>) : undefined;
  }

  listForOwner(ownerId: string, includeCancelled: boolean, limit: number, offset = 0): WatchTargetRow[] {
    const sql = includeCancelled
      ? `SELECT * FROM assistant_watch_targets WHERE discord_user_id = ?
          ORDER BY state, repo_key LIMIT ? OFFSET ?`
      : `SELECT * FROM assistant_watch_targets WHERE discord_user_id = ? AND state = 'active'
          ORDER BY repo_key LIMIT ? OFFSET ?`;
    return this.db
      .prepare(sql)
      .all(ownerId, limit, offset)
      .map((r) => mapTarget(r as Record<string, unknown>));
  }

  countActive(ownerId: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM assistant_watch_targets
          WHERE discord_user_id = ? AND state = 'active'`,
      )
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  /** Every target, cancelled or not: the ceiling counts them all. */
  countAll(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM assistant_watch_targets WHERE discord_user_id = ?')
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  /**
   * Cancels a target and abandons any alert that has not been sent.
   *
   * Cancelled is a preserved state, not a deletion: re-importing the same
   * export finds the identity live and leaves it cancelled.
   */
  cancel(ownerId: string, id: string, atIso: string): boolean {
    return atomically(this.db, () => this.cancelInner(ownerId, id, atIso));
  }

  private cancelInner(ownerId: string, id: string, atIso: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_targets
            SET state = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE id = ? AND discord_user_id = ? AND state = 'active'`,
      )
      .run(atIso, atIso, id, ownerId);
    if (Number(info.changes) !== 1) return false;
    this.db
      .prepare(
        `UPDATE assistant_watch_events SET alert_abandoned_at = ?
          WHERE target_id = ? AND alerted_at IS NULL AND alert_abandoned_at IS NULL`,
      )
      .run(atIso, id);
    return true;
  }

  /**
   * What a repository metadata read established about a target: its default
   * branch, its last-push time and the eligibility facts the poll cycle filters by.
   * `relationship` is only ever set, never cleared: it comes from the configured
   * account and discovery, and a later read without them must not forget it.
   */
  recordRepositoryFacts(id: string, facts: {
    defaultBranch: string;
    pushedAt: string | null;
    archived: boolean;
    fork: boolean;
    relationship: 'owner' | 'organization' | 'collaborator' | null;
  }, atIso: string): void {
    this.db
      .prepare(
        `UPDATE assistant_watch_targets
            SET default_branch = ?, pushed_at = COALESCE(?, pushed_at), archived = ?, fork = ?,
                relationship = COALESCE(?, relationship), updated_at = ?
          WHERE id = ?`,
      )
      .run(facts.defaultBranch, facts.pushedAt, facts.archived ? 1 : 0, facts.fork ? 1 : 0, facts.relationship, atIso, id);
  }

  /**
   * Stops observing a target the provider no longer shows under its name.
   *
   * The source unmonitors a repository that answers not-found, permanently, and
   * this does the same, as a cancellation with a SYSTEM reason: the row, its
   * checkpoints and its events stay, so repeating an import cannot resurrect it
   * and the owner can still list and Forget it.
   */
  cancelBySystem(id: string, reason: string, atIso: string): boolean {
    return atomically(this.db, () => {
      const info = this.db
        .prepare(
          `UPDATE assistant_watch_targets
              SET state = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
            WHERE id = ? AND state = 'active'`,
        )
        .run(atIso, reason, atIso, id);
      if (Number(info.changes) !== 1) return false;
      this.db
        .prepare(
          `UPDATE assistant_watch_events SET alert_abandoned_at = ?
            WHERE target_id = ? AND alerted_at IS NULL AND alert_abandoned_at IS NULL`,
        )
        .run(atIso, id);
      return true;
    });
  }

  /** Every surface of one target, stopped for one reason (a renamed or transferred repository). */
  blockTarget(targetId: string, reason: string, atIso: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE assistant_watch_checkpoints SET blocked_reason = ?, updated_at = ?
            WHERE target_id = ? AND blocked_reason IS NULL`,
        )
        .run(reason, atIso, targetId).changes,
    );
  }

  touchObserved(id: string, atIso: string): void {
    this.db
      .prepare('UPDATE assistant_watch_targets SET last_observed_at = ?, updated_at = ? WHERE id = ?')
      .run(atIso, atIso, id);
  }

  // ---- checkpoints --------------------------------------------------------

  insertCheckpoint(row: {
    targetId: string;
    surface: WatchSurface;
    state: WatchCheckpointState;
    cursor: string | null;
    nextDueAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO assistant_watch_checkpoints
           (target_id, surface, state, cursor, next_due_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.targetId, row.surface, row.state, row.cursor, row.nextDueAt, row.updatedAt);
  }

  checkpointsFor(targetId: string): WatchCheckpointRow[] {
    return this.db
      .prepare('SELECT * FROM assistant_watch_checkpoints WHERE target_id = ? ORDER BY surface')
      .all(targetId)
      .map((r) => mapCheckpoint(r as Record<string, unknown>));
  }

  checkpoint(targetId: string, surface: WatchSurface): WatchCheckpointRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM assistant_watch_checkpoints WHERE target_id = ? AND surface = ?')
      .get(targetId, surface);
    return r ? mapCheckpoint(r as Record<string, unknown>) : undefined;
  }

  /**
   * Due checkpoints, oldest first, across ACTIVE targets only.
   *
   * Oldest-due-first is the fairness rule: a target that has waited longest is
   * served next, and because every serve moves its due time forward, no target
   * can be starved by a busier one. A blocked surface is never due.
   */
  dueCheckpoints(nowIso: string, limit: number, cycle?: PollCycle): DueCheckpoint[] {
    // Without a cycle every active target is covered (the scripted-reader default).
    // With one, a surface other than the metadata read is only served for a target
    // inside the cycle's coverage.
    const covered = cycle
      ? `AND (c.surface = 'default_branch' OR c.target_id IN (${CYCLE_SQL}))`
      : '';
    return this.db
      .prepare(
        `SELECT c.*, t.repo_key, t.display, t.default_branch
           FROM assistant_watch_checkpoints c
           JOIN assistant_watch_targets t ON t.id = c.target_id
          WHERE t.state = 'active' AND c.blocked_reason IS NULL AND c.next_due_at <= :now
            AND c.surface != 'ci_state' ${covered}
          ORDER BY c.next_due_at ASC, c.target_id ASC, c.surface ASC
          LIMIT :limit`,
      )
      .all({ now: nowIso, limit, ...(cycle ? cycleParams(cycle) : {}) })
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          ...mapCheckpoint(r),
          repoKey: String(r['repo_key']),
          display: String(r['display']),
          defaultBranch: r['default_branch'] == null ? null : String(r['default_branch']),
        };
      });
  }

  /** Whether a target is inside the cycle's coverage right now. */
  inCycle(targetId: string, cycle: PollCycle): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM (${CYCLE_SQL}) WHERE id = :target`)
        .get({ ...cycleParams(cycle), target: targetId }) !== undefined
    );
  }

  /** Counts of blocked surfaces by reason: never a repository name. */
  blockedCounts(ownerId: string): { windowExceeded: number; identityChanged: number; systemCancelled: number } {
    const one = (reason: string): number =>
      Number(
        (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM assistant_watch_checkpoints c
               JOIN assistant_watch_targets t ON t.id = c.target_id
              WHERE t.discord_user_id = ? AND c.blocked_reason = ?`,
          )
          .get(ownerId, reason) as { n: number }).n,
      );
    const systemCancelled = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM assistant_watch_targets
            WHERE discord_user_id = ? AND state = 'cancelled' AND cancel_reason IS NOT NULL`,
        )
        .get(ownerId) as { n: number }).n,
    );
    return { windowExceeded: one('window_exceeded'), identityChanged: one('identity_changed'), systemCancelled };
  }

  /** Counts only: covered by this cycle, beyond it by recency, and not yet measured. */
  cycleCoverage(cycle: PollCycle): { covered: number; beyond: number; unmeasured: number; ineligible: number } {
    const one = (sql: string, withLimit = false): number =>
      Number(
        (this.db.prepare(sql).get(withLimit ? cycleParams(cycle) : eligibleParams(cycle)) as { n: number }).n,
      );
    const covered = one(`SELECT COUNT(*) AS n FROM (${CYCLE_SQL})`, true);
    const eligible = one(`SELECT COUNT(*) AS n FROM assistant_watch_targets t WHERE ${ELIGIBLE_SQL}`);
    const unmeasured = one(
      `SELECT COUNT(*) AS n FROM assistant_watch_targets t WHERE ${ELIGIBLE_SQL} AND t.pushed_at IS NULL`,
    );
    const active = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM assistant_watch_targets t
            WHERE t.discord_user_id = ? AND t.state = 'active'`,
        )
        .get(cycle.ownerId) as { n: number }).n,
    );
    return {
      covered, unmeasured, ineligible: active - eligible,
      beyond: Math.max(0, eligible - unmeasured - covered),
    };
  }

  /**
   * Commits one finished surface read: the cursor moves, the state becomes
   * 'ready', pending progress clears, the new events are recorded and every event
   * HELD by this read's earlier pages is released -- all under a compare-and-set
   * on what the caller read. If anything else moved the checkpoint in between,
   * nothing is written and this returns undefined.
   *
   * `OR IGNORE` on the event key IS the deduplication: an identity seen twice is
   * recorded once, whichever pass saw it first.
   */
  commitObservation(input: {
    targetId: string;
    surface: WatchSurface;
    expectedUpdatedAt: string;
    cursor: string;
    nextDueAt: string;
    atIso: string;
    events: readonly ObservedEventWrite[];
    /** A second checkpoint that moves with this one (CI state moves with runs). */
    alsoSet?: { surface: WatchSurface; cursor: string };
    /** The new boundary flag. Omitted leaves it as it was (the cursor did not move). */
    boundaryKnown?: boolean;
    /**
     * The new scan floor. Omitted LEAVES it; null clears it. Runs and releases set it
     * on every commit, because "nothing was unsettled" is itself something to record.
     */
    scanFloor?: string | null;
    /** The lifecycle floor for the NEXT read. Omitted leaves it; null clears it. */
    lifecycleFloor?: string | null;
  }): number | undefined {
    // The cursor, the state, the events, the released holds and the second
    // checkpoint change together or not at all: a failure anywhere leaves the
    // checkpoint exactly as it was, so a crash can never advance a cursor past
    // events that were not recorded.
    return atomically(this.db, () => this.commitObservationInner(input));
  }

  private commitObservationInner(input: Parameters<AssistantWatchRepo['commitObservation']>[0]): number | undefined {
    const moved = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET state = 'ready', cursor = ?, pending_cursor = NULL, pending_page = 0,
                pending_state = NULL,
                boundary_known = COALESCE(?, boundary_known),
                scan_floor = CASE WHEN ? = 1 THEN ? ELSE scan_floor END,
                lifecycle_floor = CASE WHEN ? = 1 THEN ? ELSE lifecycle_floor END,
                next_due_at = ?, failures = 0, last_error = NULL, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(
        input.cursor,
        input.boundaryKnown === undefined ? null : input.boundaryKnown ? 1 : 0,
        input.scanFloor === undefined ? 0 : 1, input.scanFloor ?? null,
        input.lifecycleFloor === undefined ? 0 : 1, input.lifecycleFloor ?? null,
        input.nextDueAt, input.atIso, input.targetId, input.surface, input.expectedUpdatedAt,
      );
    if (Number(moved.changes) !== 1) return undefined;
    const inserted = this.insertObserved(input.targetId, input.events, input.atIso, false);
    this.db
      .prepare(
        `UPDATE assistant_watch_events SET held = 0
          WHERE target_id = ? AND surface = ? AND held = 1`,
      )
      .run(input.targetId, input.surface);
    if (input.alsoSet) {
      this.db
        .prepare(
          `INSERT INTO assistant_watch_checkpoints
             (target_id, surface, state, cursor, next_due_at, updated_at)
           VALUES (?, ?, 'ready', ?, ?, ?)
           ON CONFLICT(target_id, surface) DO UPDATE SET
             state = 'ready', cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(input.targetId, input.alsoSet.surface, input.alsoSet.cursor, input.nextDueAt, input.atIso);
    }
    return inserted;
  }

  /**
   * Durable progress through a multi-page read; the committed cursor stays put.
   *
   * Events found so far are recorded HELD, so they survive a restart without
   * being announced before the read is complete.
   */
  savePending(input: {
    targetId: string;
    surface: WatchSurface;
    expectedUpdatedAt: string;
    pendingCursor: string;
    pendingPage: number;
    /** The service's JSON position inside this read, or null for none. */
    pendingState?: string | null;
    nextDueAt: string;
    atIso: string;
    events?: readonly ObservedEventWrite[];
  }): boolean {
    return atomically(this.db, () => this.savePendingInner(input));
  }

  private savePendingInner(input: Parameters<AssistantWatchRepo['savePending']>[0]): boolean {
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET pending_cursor = ?, pending_page = ?, pending_state = ?, next_due_at = ?, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(
        input.pendingCursor, input.pendingPage, input.pendingState ?? null, input.nextDueAt, input.atIso,
        input.targetId, input.surface, input.expectedUpdatedAt,
      );
    if (Number(info.changes) !== 1) return false;
    this.insertObserved(input.targetId, input.events ?? [], input.atIso, true);
    return true;
  }

  private insertObserved(
    targetId: string,
    events: readonly ObservedEventWrite[],
    atIso: string,
    held: boolean,
  ): number {
    let inserted = 0;
    for (const e of events) {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO assistant_watch_events
             (id, target_id, kind, surface, held, identity, occurred_at, payload_json, origin,
              alerted_at, digested_at, created_at)
           VALUES (?,?,?,?,?,?,?,?, 'observed', ?, ?, ?)`,
        )
        .run(
          e.id, targetId, e.kind, WATCH_EVENT_SURFACE[e.kind], held ? 1 : 0, e.identity, e.occurredAt,
          e.payloadJson, e.settled ? atIso : null, e.settled ? atIso : null, atIso,
        );
      inserted += Number(res.changes);
    }
    return inserted;
  }

  /**
   * Whether an ACTIVE imported target is observing a surface for a repository,
   * so a native proactive event the same observation would produce can be
   * suppressed. A surface that is unbaselined or blocked is not observing, and
   * suppressing on its behalf would lose the notification. So is one whose last
   * read FAILED: while it is failing it observes nothing, however healthy it was.
   */
  observes(ownerId: string, repoKey: string, surface: WatchSurface, cycle?: PollCycle): boolean {
    // Under the source's poll cycle a target outside its coverage is not being read at
    // all, however healthy its last read was, so it observes nothing.
    const covered = cycle ? `AND t.id IN (${CYCLE_SQL})` : '';
    return (
      this.db
        .prepare(
          `SELECT 1 FROM assistant_watch_targets t
             JOIN assistant_watch_checkpoints c ON c.target_id = t.id
            WHERE t.discord_user_id = :owner AND t.repo_key = :repoKey AND t.state = 'active'
              AND c.surface = :surface AND c.blocked_reason IS NULL AND c.failures = 0
              AND c.state IN ('imported','ready') ${covered}
            LIMIT 1`,
        )
        .get({ owner: ownerId, repoKey, surface, ...(cycle ? cycleParams(cycle) : {}) }) !== undefined
    );
  }

  /** A failed read. The cursor and the pending progress are untouched. */
  recordFailure(input: {
    targetId: string;
    surface: WatchSurface;
    expectedUpdatedAt: string;
    nextDueAt: string;
    errorCode: string;
    atIso: string;
  }): boolean {
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET failures = failures + 1, last_error = ?, next_due_at = ?, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(input.errorCode, input.nextDueAt, input.atIso, input.targetId, input.surface, input.expectedUpdatedAt);
    return Number(info.changes) === 1;
  }

  /**
   * Throws a read away and starts it again from its first page, because the
   * window did not hold still while it was being read. The committed cursor is
   * untouched, events already found stay HELD (they are real and deduplicate by
   * identity), and the restart is a FAILURE for backoff purposes, so a window
   * that keeps moving is retried with growing delay rather than in a loop.
   * The caller may keep one position across it (`pendingState`): a baseline's boundary.
   */
  restartPass(input: {
    targetId: string;
    surface: WatchSurface;
    expectedUpdatedAt: string;
    nextDueAt: string;
    errorCode: string;
    atIso: string;
    /** The only position kept across the restart (a baseline's boundary), or none. */
    pendingState?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET pending_cursor = NULL, pending_page = 0, pending_state = ?,
                failures = failures + 1, last_error = ?, next_due_at = ?, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(input.pendingState ?? null, input.errorCode, input.nextDueAt, input.atIso, input.targetId, input.surface, input.expectedUpdatedAt);
    return Number(info.changes) === 1;
  }

  /** Marks a surface the reader cannot observe. Never advanced, never delivered. */
  block(targetId: string, surface: WatchSurface, reason: string, atIso: string): void {
    this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints SET blocked_reason = ?, updated_at = ?
          WHERE target_id = ? AND surface = ? AND blocked_reason IS NULL`,
      )
      .run(reason, atIso, targetId, surface);
  }

  unblockAll(atIso: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE assistant_watch_checkpoints SET blocked_reason = NULL, updated_at = ?
            WHERE blocked_reason IS NOT NULL`,
        )
        .run(atIso).changes,
    );
  }

  // ---- the global monitoring switch ---------------------------------------

  /** Whether the owner's watching is on. Absent means on, as in the source. */
  monitoringEnabled(ownerId: string): boolean {
    const r = this.db
      .prepare('SELECT monitoring_enabled AS m FROM assistant_watch_settings WHERE discord_user_id = ?')
      .get(ownerId) as { m: number } | undefined;
    return r === undefined || Number(r.m) === 1;
  }

  /**
   * The stored switch and when it last changed, or undefined when none was ever stored
   * (which means on). `updatedAt` of an OFF row is the earliest moment the owner's
   * native paths could have been reporting what the targets were not.
   */
  monitoringSetting(ownerId: string): { enabled: boolean; updatedAt: string } | undefined {
    const r = this.db
      .prepare('SELECT monitoring_enabled AS m, updated_at AS u FROM assistant_watch_settings WHERE discord_user_id = ?')
      .get(ownerId) as { m: number; u: string } | undefined;
    return r === undefined ? undefined : { enabled: Number(r.m) === 1, updatedAt: String(r.u) };
  }

  /** The keys of the owner's ACTIVE notification targets (at most the 1,000-target cap). */
  activeTargetKeys(ownerId: string): string[] {
    return (
      this.db
        .prepare("SELECT repo_key AS k FROM assistant_watch_targets WHERE discord_user_id = ? AND state = 'active'")
        .all(ownerId) as { k: string }[]
    ).map((r) => String(r.k));
  }

  setMonitoring(ownerId: string, enabled: boolean, atIso: string): void {
    this.db
      .prepare(
        `INSERT INTO assistant_watch_settings (discord_user_id, monitoring_enabled, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET
           monitoring_enabled = excluded.monitoring_enabled, updated_at = excluded.updated_at`,
      )
      .run(ownerId, enabled ? 1 : 0, atIso);
  }

  // ---- discovery ---------------------------------------------------------

  private mapDiscovery(r: Record<string, unknown>): DiscoveryRow {
    return {
      ownerId: String(r['discord_user_id']),
      pendingPage: Number(r['pending_page']),
      passCapacityBlocked: Number(r['pass_capacity_blocked']) === 1,
      nextDueAt: String(r['next_due_at']),
      lastCompletedAt: r['last_completed_at'] == null ? null : String(r['last_completed_at']),
      incomplete: Number(r['incomplete']) === 1,
      capacityBlocked: Number(r['capacity_blocked']) === 1,
      failures: Number(r['failures']),
      lastError: r['last_error'] == null ? null : String(r['last_error']),
    };
  }

  /** The owner's discovery row, created due-now the first time discovery is enabled. */
  ensureDiscovery(ownerId: string, atIso: string): DiscoveryRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO assistant_watch_discovery (discord_user_id, next_due_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(ownerId, atIso, atIso);
    return this.mapDiscovery(
      this.db.prepare('SELECT * FROM assistant_watch_discovery WHERE discord_user_id = ?').get(ownerId) as Record<string, unknown>,
    );
  }

  discovery(ownerId: string): DiscoveryRow | undefined {
    const r = this.db.prepare('SELECT * FROM assistant_watch_discovery WHERE discord_user_id = ?').get(ownerId);
    return r ? this.mapDiscovery(r as Record<string, unknown>) : undefined;
  }

  discoveryTombstoned(ownerId: string, repoKey: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM assistant_watch_discovery_tombstones WHERE discord_user_id = ? AND repo_key = ?')
        .get(ownerId, repoKey) !== undefined
    );
  }

  /**
   * Stores what one discovery page found, and moves the pass on, in one
   * transaction.
   *
   * A repository that is already a target has its FACTS refreshed (recency,
   * archived, fork, relationship) and nothing else: its state, its mute, its
   * checkpoints and its events are the owner's and are never reset by discovery. A
   * repository whose reference was deleted stays deleted (the tombstone). A new one
   * is created active with silent, unbaselined checkpoints, unless the ceiling is
   * reached, in which case it is NOT stored and the pass says so; nothing already
   * stored is ever cancelled or dropped to make room.
   */
  commitDiscoveryPage(input: {
    ownerId: string;
    expectedPage: number;
    found: readonly {
      repoKey: string;
      display: string;
      pushedAt: string | null;
      archived: boolean;
      fork: boolean;
      relationship: 'owner' | 'organization' | 'collaborator';
      id: string;
      publicId: string;
    }[];
    surfaces: readonly WatchSurface[];
    maxTargets: number;
    /** What the pass does next: the next page, or finished. */
    next: { kind: 'page'; page: number } | { kind: 'done'; incomplete: boolean; nextDueAt: string };
    atIso: string;
  }): { outcomes: Record<DiscoveredOutcome, number> } | undefined {
    return atomically(this.db, () => {
      const row = this.discovery(input.ownerId);
      if (!row || row.pendingPage !== input.expectedPage) return undefined;
      const outcomes: Record<DiscoveredOutcome, number> = { created: 0, updated: 0, tombstoned: 0, over_capacity: 0 };
      let blocked = row.passCapacityBlocked;
      let total = this.countAll(input.ownerId);
      for (const f of input.found) {
        if (this.discoveryTombstoned(input.ownerId, f.repoKey)) {
          outcomes.tombstoned += 1;
          continue;
        }
        const existing = this.byRepoKey(input.ownerId, f.repoKey);
        if (existing) {
          this.db
            .prepare(
              `UPDATE assistant_watch_targets
                  SET pushed_at = COALESCE(?, pushed_at), archived = ?, fork = ?,
                      relationship = COALESCE(?, relationship), updated_at = ?
                WHERE id = ?`,
            )
            .run(f.pushedAt, f.archived ? 1 : 0, f.fork ? 1 : 0, f.relationship, input.atIso, existing.id);
          outcomes.updated += 1;
          continue;
        }
        if (total >= input.maxTargets) {
          outcomes.over_capacity += 1;
          blocked = true;
          continue;
        }
        this.insertTarget({
          id: f.id, publicId: f.publicId, discordUserId: input.ownerId, repoKey: f.repoKey, display: f.display,
          defaultBranch: null, state: 'active', lastObservedAt: null, createdAt: input.atIso, cancelledAt: null,
          origin: 'discovered', pushedAt: f.pushedAt, relationship: f.relationship,
          archived: f.archived, fork: f.fork,
        });
        for (const surface of input.surfaces) {
          this.insertCheckpoint({
            targetId: f.id, surface, state: 'unbaselined', cursor: null, nextDueAt: input.atIso, updatedAt: input.atIso,
          });
        }
        total += 1;
        outcomes.created += 1;
      }
      if (input.next.kind === 'page') {
        this.db
          .prepare(
            `UPDATE assistant_watch_discovery
                SET pending_page = ?, pass_capacity_blocked = ?, next_due_at = ?, failures = 0,
                    last_error = NULL, updated_at = ?
              WHERE discord_user_id = ?`,
          )
          .run(input.next.page, blocked ? 1 : 0, input.atIso, input.atIso, input.ownerId);
      } else {
        this.db
          .prepare(
            `UPDATE assistant_watch_discovery
                SET pending_page = 0, pass_capacity_blocked = 0, capacity_blocked = ?, incomplete = ?,
                    last_completed_at = ?, next_due_at = ?, failures = 0, last_error = NULL, updated_at = ?
              WHERE discord_user_id = ?`,
          )
          .run(blocked ? 1 : 0, input.next.incomplete ? 1 : 0, input.atIso, input.next.nextDueAt, input.atIso, input.ownerId);
      }
      return { outcomes };
    });
  }

  /** A failed discovery page: backoff and a short code. What was stored stays. */
  recordDiscoveryFailure(ownerId: string, errorCode: string, nextDueAt: string, atIso: string): void {
    this.db
      .prepare(
        `UPDATE assistant_watch_discovery
            SET failures = failures + 1, last_error = ?, next_due_at = ?, updated_at = ?
          WHERE discord_user_id = ?`,
      )
      .run(errorCode, nextDueAt, atIso, ownerId);
  }

  // ---- events -------------------------------------------------------------

  insertImportedEvent(row: {
    id: string;
    targetId: string;
    kind: WatchEventKind;
    identity: string;
    occurredAt: string;
    payloadJson: string;
    alertedAt: string | null;
    digestedAt: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO assistant_watch_events
           (id, target_id, kind, surface, identity, occurred_at, payload_json, origin,
            alerted_at, digested_at, created_at)
         VALUES (?,?,?,?,?,?,?, 'imported', ?, ?, ?)`,
      )
      .run(
        row.id, row.targetId, row.kind, WATCH_EVENT_SURFACE[row.kind], row.identity, row.occurredAt,
        row.payloadJson, row.alertedAt, row.digestedAt, row.createdAt,
      );
  }

  /**
   * Makes a discovered target an imported one. The source's mute wins (a cancelled
   * source state cancels it; an active one leaves Ducky's own state alone, so a mute the
   * owner already made here is never undone), and the default branch is filled only if
   * unknown.
   */
  adoptDiscovered(
    id: string, defaultBranch: string | null, cancelAtIso: string | null, lastObservedAt: string | null, atIso: string,
  ): void {
    this.db
      .prepare(
        `UPDATE assistant_watch_targets
            SET origin = 'imported', default_branch = COALESCE(default_branch, ?),
                last_observed_at = COALESCE(last_observed_at, ?), updated_at = ?
          WHERE id = ?`,
      )
      .run(defaultBranch, lastObservedAt, atIso, id);
    if (cancelAtIso !== null) {
      this.db
        .prepare(
          `UPDATE assistant_watch_targets SET state = 'cancelled', cancelled_at = ?, updated_at = ?
            WHERE id = ? AND state = 'active'`,
        )
        .run(cancelAtIso, atIso, id);
      this.db
        .prepare(
          `UPDATE assistant_watch_events SET alert_abandoned_at = ?
            WHERE target_id = ? AND alerted_at IS NULL AND alert_abandoned_at IS NULL`,
        )
        .run(atIso, id);
    }
  }

  /**
   * Gives an adopted target the source's cursor, reconciling it with what Ducky has
   * already read.
   *
   * A surface Ducky has not read takes the source's cursor outright. One it HAS read
   * (discovery baselined it silently, announcing nothing) takes the EARLIER of the two,
   * so what happened between the source's cursor and Ducky's baseline is read and told
   * rather than skipped; the boundary becomes strict (it cannot tell what the source
   * already announced), identities deduplicate, and any read in progress is dropped
   * because its cursor just moved. A non-time surface (the default branch, the CI state)
   * keeps Ducky's own value. A missing one (the ci_state companion) is created. Returns
   * whether the checkpoint changed.
   */
  adoptCheckpoint(targetId: string, surface: WatchSurface, cursor: string, atIso: string, nextDueAt: string): boolean {
    const existing = this.checkpoint(targetId, surface);
    if (!existing) {
      this.insertCheckpoint({
        targetId, surface, state: surface === 'ci_state' ? 'ready' : 'imported', cursor, nextDueAt, updatedAt: atIso,
      });
      return true;
    }
    if (existing.state === 'unbaselined') {
      const info = this.db
        .prepare(
          `UPDATE assistant_watch_checkpoints
              SET state = 'imported', cursor = ?, boundary_known = 0,
                  pending_cursor = NULL, pending_page = 0, pending_state = NULL, updated_at = ?
            WHERE target_id = ? AND surface = ? AND state = 'unbaselined'`,
        )
        .run(cursor, atIso, targetId, surface);
      return Number(info.changes) === 1;
    }
    if (!TIME_CURSOR_SURFACES.includes(surface as (typeof TIME_CURSOR_SURFACES)[number])) return false;
    const mine = existing.cursor === null ? Number.NaN : Date.parse(existing.cursor);
    const theirs = Date.parse(cursor);
    if (Number.isNaN(mine) || Number.isNaN(theirs) || theirs >= mine) return false;
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET cursor = ?, boundary_known = 0, pending_cursor = NULL, pending_page = 0,
                pending_state = NULL,
                next_due_at = ?, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(cursor, atIso, atIso, targetId, surface, existing.updatedAt);
    return Number(info.changes) === 1;
  }

  /** An imported event, unless the target already knows that identity. */
  insertImportedEventIfNew(row: Parameters<AssistantWatchRepo['insertImportedEvent']>[0]): boolean {
    if (this.eventExists(row.targetId, row.kind, row.identity)) {
      // Known on both sides: the source's settlement fills what Ducky has not settled, and
      // never clears one Ducky has. An event the source already alerted or digested is
      // therefore never told again.
      this.db
        .prepare(
          `UPDATE assistant_watch_events
              SET alerted_at = COALESCE(alerted_at, ?), digested_at = COALESCE(digested_at, ?)
            WHERE target_id = ? AND kind = ? AND identity = ?`,
        )
        .run(row.alertedAt, row.digestedAt, row.targetId, row.kind, row.identity);
      return false;
    }
    this.insertImportedEvent(row);
    return true;
  }

  eventExists(targetId: string, kind: WatchEventKind, identity: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM assistant_watch_events WHERE target_id = ? AND kind = ? AND identity = ?')
        .get(targetId, kind, identity) !== undefined
    );
  }

  eventsFor(targetId: string): WatchEventRow[] {
    return this.db
      .prepare('SELECT * FROM assistant_watch_events WHERE target_id = ? ORDER BY occurred_at, id')
      .all(targetId)
      .map((r) => mapEvent(r as Record<string, unknown>));
  }

  /** Alerts not yet sent, for ACTIVE targets, oldest first. */
  pendingAlerts(ownerId: string, limit: number): WatchEventWithTarget[] {
    return this.db
      .prepare(
        `SELECT e.*, t.display, t.discord_user_id
           FROM assistant_watch_events e
           JOIN assistant_watch_targets t ON t.id = e.target_id
          WHERE t.discord_user_id = ? AND t.state = 'active' AND e.held = 0
            AND e.kind IN (${ALERT_LIST})
            AND e.alerted_at IS NULL AND e.alert_abandoned_at IS NULL
          ORDER BY e.occurred_at ASC, e.id ASC LIMIT ?`,
      )
      .all(ownerId, limit)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return { ...mapEvent(r), display: String(r['display']), discordUserId: String(r['discord_user_id']) };
      });
  }

  markAlerted(id: string, atIso: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_events SET alerted_at = ?, alert_attempts = alert_attempts + 1
          WHERE id = ? AND alerted_at IS NULL AND alert_abandoned_at IS NULL`,
      )
      .run(atIso, id);
    return Number(info.changes) === 1;
  }

  /**
   * A failed alert. After enough failures the alert is ABANDONED as an alert,
   * and the event is left for the digest instead: an interrupting message that
   * cannot be delivered must not be retried forever, and must not be lost.
   */
  recordAlertFailure(id: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE assistant_watch_events
            SET alert_attempts = alert_attempts + 1,
                alert_abandoned_at = CASE WHEN alert_attempts + 1 >= ? THEN ? ELSE alert_abandoned_at END
          WHERE id = ? AND alerted_at IS NULL AND alert_abandoned_at IS NULL`,
      )
      .run(maxAttempts, atIso, id);
  }

  /**
   * Events a briefing digest should carry: not digested, on an ACTIVE target,
   * and not an alert that is still waiting to interrupt (that one is on its way
   * as an alert and must not appear twice). An alert that was sent, or whose
   * alert was abandoned, is digest-eligible: the digest is the safety net.
   */
  undigested(ownerId: string, limit: number): WatchEventWithTarget[] {
    return this.db
      .prepare(
        `SELECT e.*, t.display, t.discord_user_id
           FROM assistant_watch_events e
           JOIN assistant_watch_targets t ON t.id = e.target_id
          WHERE t.discord_user_id = ? AND t.state = 'active' AND e.held = 0
            AND e.digested_at IS NULL AND e.kind != 'review_pending'
            AND NOT (e.kind IN (${ALERT_LIST}) AND e.alerted_at IS NULL AND e.alert_abandoned_at IS NULL)
          ORDER BY t.display ASC, e.occurred_at ASC, e.id ASC LIMIT ?`,
      )
      .all(ownerId, limit)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return { ...mapEvent(r), display: String(r['display']), discordUserId: String(r['discord_user_id']) };
      });
  }

  /** Silent markers settle themselves: they exist to dedupe, never to be read. */
  settleSilent(atIso: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE assistant_watch_events SET digested_at = ?, alerted_at = COALESCE(alerted_at, ?)
            WHERE kind = 'review_pending' AND digested_at IS NULL`,
        )
        .run(atIso, atIso).changes,
    );
  }

  markDigested(ids: readonly string[], atIso: string): number {
    let n = 0;
    const stmt = this.db.prepare(
      'UPDATE assistant_watch_events SET digested_at = ? WHERE id = ? AND digested_at IS NULL',
    );
    for (const id of ids) n += Number(stmt.run(atIso, id).changes);
    return n;
  }

  /**
   * Empties the CONTENT of events that will never be shown, and keeps their
   * identity: settled ones, ones held by a read that never closed, and ones
   * belonging to a target cancelled long ago.
   *
   * Deleting the row would make the identity forgettable and let the same event
   * be announced again; keeping the identity and dropping the text keeps the
   * dedupe and the owner's privacy.
   */
  scrubSettledPayloads(beforeIso: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE assistant_watch_events SET payload_json = '{}'
            WHERE payload_json != '{}' AND (
              (digested_at IS NOT NULL AND digested_at < :before)
              OR (held = 1 AND created_at < :before)
              OR target_id IN (SELECT id FROM assistant_watch_targets
                                WHERE state = 'cancelled' AND cancelled_at < :before))`,
        )
        .run({ before: beforeIso }).changes,
    );
  }

  // ---- the call budget ----------------------------------------------------

  chargeCalls(minuteIso: string, n: number): void {
    this.db
      .prepare(
        `INSERT INTO assistant_watch_calls (minute, calls) VALUES (?, ?)
         ON CONFLICT(minute) DO UPDATE SET calls = calls + excluded.calls`,
      )
      .run(minuteIso, n);
  }

  callsSince(sinceMinuteIso: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM assistant_watch_calls WHERE minute >= ?')
      .get(sinceMinuteIso) as { n: number };
    return Number(r.n);
  }

  pruneCalls(beforeMinuteIso: string): number {
    return Number(
      this.db.prepare('DELETE FROM assistant_watch_calls WHERE minute < ?').run(beforeMinuteIso).changes,
    );
  }

  // ---- verification (counts only) ------------------------------------------

  /** Counts for the importer's report: never a repository name or an event. */
  counts(ownerId: string): {
    targets: number;
    active: number;
    cancelled: number;
    checkpoints: number;
    events: number;
    undigested: number;
  } {
    const one = (sql: string, ...args: string[]): number =>
      Number((this.db.prepare(sql).get(...args) as { n: number }).n);
    return {
      targets: one('SELECT COUNT(*) AS n FROM assistant_watch_targets WHERE discord_user_id = ?', ownerId),
      active: one(
        `SELECT COUNT(*) AS n FROM assistant_watch_targets WHERE discord_user_id = ? AND state = 'active'`,
        ownerId,
      ),
      cancelled: one(
        `SELECT COUNT(*) AS n FROM assistant_watch_targets WHERE discord_user_id = ? AND state = 'cancelled'`,
        ownerId,
      ),
      checkpoints: one(
        `SELECT COUNT(*) AS n FROM assistant_watch_checkpoints c
           JOIN assistant_watch_targets t ON t.id = c.target_id WHERE t.discord_user_id = ?`,
        ownerId,
      ),
      events: one(
        `SELECT COUNT(*) AS n FROM assistant_watch_events e
           JOIN assistant_watch_targets t ON t.id = e.target_id WHERE t.discord_user_id = ?`,
        ownerId,
      ),
      undigested: one(
        `SELECT COUNT(*) AS n FROM assistant_watch_events e
           JOIN assistant_watch_targets t ON t.id = e.target_id
          WHERE t.discord_user_id = ? AND e.digested_at IS NULL`,
        ownerId,
      ),
    };
  }
}
