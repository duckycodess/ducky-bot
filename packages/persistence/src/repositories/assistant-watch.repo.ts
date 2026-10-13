import {
  WATCH_ALERT_KINDS, type WatchEventKind, type WatchSurface,
} from '@ducky/contracts';
import type { Db } from '../db.js';

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
}

export interface WatchCheckpointRow {
  readonly targetId: string;
  readonly surface: WatchSurface;
  readonly state: WatchCheckpointState;
  readonly cursor: string | null;
  readonly pendingCursor: string | null;
  readonly pendingPage: number;
  readonly nextDueAt: string;
  readonly failures: number;
  readonly lastError: string | null;
  readonly blockedReason: string | null;
  readonly updatedAt: string;
}

export interface WatchEventRow {
  readonly id: string;
  readonly targetId: string;
  readonly kind: WatchEventKind;
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
});

const mapCheckpoint = (r: Record<string, unknown>): WatchCheckpointRow => ({
  targetId: String(r['target_id']),
  surface: String(r['surface']) as WatchSurface,
  state: String(r['state']) as WatchCheckpointState,
  cursor: r['cursor'] == null ? null : String(r['cursor']),
  pendingCursor: r['pending_cursor'] == null ? null : String(r['pending_cursor']),
  pendingPage: Number(r['pending_page']),
  nextDueAt: String(r['next_due_at']),
  failures: Number(r['failures']),
  lastError: r['last_error'] == null ? null : String(r['last_error']),
  blockedReason: r['blocked_reason'] == null ? null : String(r['blocked_reason']),
  updatedAt: String(r['updated_at']),
});

const mapEvent = (r: Record<string, unknown>): WatchEventRow => ({
  id: String(r['id']),
  targetId: String(r['target_id']),
  kind: String(r['kind']) as WatchEventKind,
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO assistant_watch_targets
           (id, public_id, discord_user_id, repo_key, display, default_branch, state,
            last_observed_at, created_at, updated_at, cancelled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.publicId, row.discordUserId, row.repoKey, row.display, row.defaultBranch,
        row.state, row.lastObservedAt, row.createdAt, row.createdAt, row.cancelledAt,
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
  dueCheckpoints(nowIso: string, limit: number): DueCheckpoint[] {
    return this.db
      .prepare(
        `SELECT c.*, t.repo_key, t.display, t.default_branch
           FROM assistant_watch_checkpoints c
           JOIN assistant_watch_targets t ON t.id = c.target_id
          WHERE t.state = 'active' AND c.blocked_reason IS NULL AND c.next_due_at <= ?
          ORDER BY c.next_due_at ASC, c.target_id ASC, c.surface ASC
          LIMIT ?`,
      )
      .all(nowIso, limit)
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

  /**
   * Commits one finished surface read: the cursor moves, the state becomes
   * 'ready', pending progress clears, and the new events are recorded -- all
   * under a compare-and-set on what the caller read. If anything else moved the
   * checkpoint in between nothing is written and this returns undefined.
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
    events: readonly {
      id: string;
      kind: WatchEventKind;
      identity: string;
      occurredAt: string;
      payloadJson: string;
      /** Settled at birth: an event that is already known must not be announced. */
      settled: boolean;
    }[];
  }): number | undefined {
    const moved = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET state = 'ready', cursor = ?, pending_cursor = NULL, pending_page = 0,
                next_due_at = ?, failures = 0, last_error = NULL, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(input.cursor, input.nextDueAt, input.atIso, input.targetId, input.surface, input.expectedUpdatedAt);
    if (Number(moved.changes) !== 1) return undefined;
    let inserted = 0;
    for (const e of input.events) {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO assistant_watch_events
             (id, target_id, kind, identity, occurred_at, payload_json, origin,
              alerted_at, digested_at, created_at)
           VALUES (?,?,?,?,?,?, 'observed', ?, ?, ?)`,
        )
        .run(
          e.id, input.targetId, e.kind, e.identity, e.occurredAt, e.payloadJson,
          e.settled ? input.atIso : null, e.settled ? input.atIso : null, input.atIso,
        );
      inserted += Number(res.changes);
    }
    return inserted;
  }

  /** Durable progress through a multi-page read; the committed cursor stays put. */
  savePending(input: {
    targetId: string;
    surface: WatchSurface;
    expectedUpdatedAt: string;
    pendingCursor: string;
    pendingPage: number;
    nextDueAt: string;
    atIso: string;
  }): boolean {
    const info = this.db
      .prepare(
        `UPDATE assistant_watch_checkpoints
            SET pending_cursor = ?, pending_page = ?, next_due_at = ?, updated_at = ?
          WHERE target_id = ? AND surface = ? AND updated_at = ?`,
      )
      .run(
        input.pendingCursor, input.pendingPage, input.nextDueAt, input.atIso,
        input.targetId, input.surface, input.expectedUpdatedAt,
      );
    return Number(info.changes) === 1;
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
           (id, target_id, kind, identity, occurred_at, payload_json, origin,
            alerted_at, digested_at, created_at)
         VALUES (?,?,?,?,?,?, 'imported', ?, ?, ?)`,
      )
      .run(
        row.id, row.targetId, row.kind, row.identity, row.occurredAt, row.payloadJson,
        row.alertedAt, row.digestedAt, row.createdAt,
      );
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
  pendingAlerts(limit: number): WatchEventWithTarget[] {
    return this.db
      .prepare(
        `SELECT e.*, t.display, t.discord_user_id
           FROM assistant_watch_events e
           JOIN assistant_watch_targets t ON t.id = e.target_id
          WHERE t.state = 'active' AND e.kind IN (${ALERT_LIST})
            AND e.alerted_at IS NULL AND e.alert_abandoned_at IS NULL
          ORDER BY e.occurred_at ASC, e.id ASC LIMIT ?`,
      )
      .all(limit)
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
  undigested(limit: number): WatchEventWithTarget[] {
    return this.db
      .prepare(
        `SELECT e.*, t.display, t.discord_user_id
           FROM assistant_watch_events e
           JOIN assistant_watch_targets t ON t.id = e.target_id
          WHERE t.state = 'active' AND e.digested_at IS NULL AND e.kind != 'review_pending'
            AND NOT (e.kind IN (${ALERT_LIST}) AND e.alerted_at IS NULL AND e.alert_abandoned_at IS NULL)
          ORDER BY t.display ASC, e.occurred_at ASC, e.id ASC LIMIT ?`,
      )
      .all(limit)
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
   * Empties the CONTENT of settled events and keeps their identity.
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
            WHERE digested_at IS NOT NULL AND digested_at < ? AND payload_json != '{}'`,
        )
        .run(beforeIso).changes,
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
