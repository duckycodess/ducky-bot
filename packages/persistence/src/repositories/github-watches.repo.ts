import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { GitHubWatchEventRow, GitHubWatchRow } from './types.js';

const mapWatch = (r: Record<string, unknown>): GitHubWatchRow => ({
  id: String(r['id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  repoSlug: String(r['repo_slug']),
  intervalMinutes: Number(r['interval_minutes']),
  nextCheckAt: r['next_check_at'] == null ? null : String(r['next_check_at']),
  state: String(r['state']) as GitHubWatchRow['state'],
  snapshotHash: r['snapshot_hash'] == null ? null : String(r['snapshot_hash']),
  snapshotJson: r['snapshot_json'] == null ? null : String(r['snapshot_json']),
  lastError: r['last_error'] == null ? null : String(r['last_error']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  cancelledAt: r['cancelled_at'] == null ? null : String(r['cancelled_at']),
});

const mapEvent = (r: Record<string, unknown>): GitHubWatchEventRow => ({
  id: String(r['id']),
  watchId: String(r['watch_id']),
  publicWatchId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  repoSlug: String(r['repo_slug']),
  fingerprint: String(r['fingerprint']),
  summary: String(r['summary']),
  createdAt: String(r['created_at']),
  deliveredAt: r['delivered_at'] == null ? null : String(r['delivered_at']),
  attempts: Number(r['attempts']),
  lastAttemptAt: r['last_attempt_at'] == null ? null : String(r['last_attempt_at']),
  abandonedAt: r['abandoned_at'] == null ? null : String(r['abandoned_at']),
});

/**
 * Durable owner-configured GitHub watches and their notification outbox.
 *
 * A watch is a bounded periodic observation, not an autonomous job loop. The
 * coordinator checks at most the requested interval, with a fixed batch per
 * tick. A normalized snapshot and its hash are stored, never the raw GitHub
 * response, so an unchanged repository produces no new event.
 */
export class GitHubWatchesRepo {
  constructor(private readonly db: Db) {}

  insert(row: {
    id: string;
    publicId: string;
    discordUserId: string;
    repoSlug: string;
    intervalMinutes: number;
    nextCheckAt: string;
    createdAt: string;
  }): GitHubWatchRow {
    this.db
      .prepare(
        `INSERT INTO github_watches
           (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at,
            state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        row.id, row.publicId, row.discordUserId, row.repoSlug, row.intervalMinutes,
        row.nextCheckAt, row.createdAt, row.createdAt,
      );
    return this.byId(row.id)!;
  }

  publicIdExists(publicId: string): boolean {
    return this.db.prepare('SELECT 1 FROM github_watches WHERE public_id = ?').get(publicId) !== undefined;
  }

  byId(id: string): GitHubWatchRow | undefined {
    const r = this.db.prepare('SELECT * FROM github_watches WHERE id = ?').get(id);
    return r ? mapWatch(r as Record<string, unknown>) : undefined;
  }

  byPublicId(ownerId: string, publicId: string): GitHubWatchRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM github_watches WHERE discord_user_id = ? AND public_id = ?')
      .get(ownerId, publicId);
    return r ? mapWatch(r as Record<string, unknown>) : undefined;
  }

  listForOwner(ownerId: string, includeCancelled: boolean, limit: number): GitHubWatchRow[] {
    const sql = includeCancelled
      ? 'SELECT * FROM github_watches WHERE discord_user_id = ? ORDER BY state, created_at DESC LIMIT ?'
      : `SELECT * FROM github_watches WHERE discord_user_id = ? AND state = 'active'
         ORDER BY next_check_at ASC, created_at DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(ownerId, limit)
      .map((r) => mapWatch(r as Record<string, unknown>));
  }

  countActive(ownerId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM github_watches WHERE discord_user_id = ? AND state = 'active'")
      .get(ownerId) as { n: number };
    return Number(row.n);
  }

  due(now: string, limit: number): GitHubWatchRow[] {
    return this.db
      .prepare(
        `SELECT * FROM github_watches
          WHERE state = 'active' AND next_check_at IS NOT NULL AND next_check_at <= ?
          ORDER BY next_check_at ASC LIMIT ?`,
      )
      .all(now, limit)
      .map((r) => mapWatch(r as Record<string, unknown>));
  }

  /**
   * Advances a due watch exactly once. The expected cursor is a CAS so two
   * coordinator ticks cannot both emit an event for the same observation.
   */
  observe(input: {
    id: string;
    expectedNextCheckAt: string;
    snapshotHash: string;
    snapshotJson: string;
    nextCheckAt: string;
    atIso: string;
    changed: boolean;
    event?: { id: string; fingerprint: string; summary: string };
  }): boolean {
    const updated = this.db
      .prepare(
        `UPDATE github_watches
            SET snapshot_hash = ?, snapshot_json = ?, next_check_at = ?,
                last_error = NULL, updated_at = ?
          WHERE id = ? AND state = 'active' AND next_check_at = ?`,
      )
      .run(
        input.snapshotHash, input.snapshotJson, input.nextCheckAt, input.atIso,
        input.id, input.expectedNextCheckAt,
      );
    if (Number(updated.changes) !== 1) return false;

    if (input.changed && input.event) {
      this.db
        .prepare(
          `INSERT INTO github_watch_events
             (id, watch_id, fingerprint, summary, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.event.id, input.id, input.event.fingerprint, input.event.summary, input.atIso);
    }
    return true;
  }

  /** Advances a failed observation without changing the last good snapshot. */
  recordFailure(id: string, expectedNextCheckAt: string, nextCheckAt: string, error: string, atIso = nowIso()): boolean {
    const result = this.db
      .prepare(
        `UPDATE github_watches
            SET next_check_at = ?, last_error = ?, updated_at = ?
          WHERE id = ? AND state = 'active' AND next_check_at = ?`,
      )
      .run(nextCheckAt, error, atIso, id, expectedNextCheckAt);
    return Number(result.changes) === 1;
  }

  /** Cancels a watch and retires any event that has not yet been delivered. */
  cancel(ownerId: string, id: string, atIso = nowIso()): boolean {
    const result = this.db
      .prepare(
        `UPDATE github_watches
            SET state = 'cancelled', next_check_at = NULL, cancelled_at = ?, updated_at = ?
          WHERE id = ? AND discord_user_id = ? AND state = 'active'`,
      )
      .run(atIso, atIso, id, ownerId);
    if (Number(result.changes) !== 1) return false;
    this.db
      .prepare(
        `UPDATE github_watch_events
            SET abandoned_at = ?
          WHERE watch_id = ? AND delivered_at IS NULL AND abandoned_at IS NULL`,
      )
      .run(atIso, id);
    return true;
  }

  pendingEvents(limit: number): GitHubWatchEventRow[] {
    return this.db
      .prepare(
        `SELECT e.id, e.watch_id, w.public_id, w.discord_user_id, w.repo_slug,
                e.fingerprint, e.summary, e.created_at, e.delivered_at,
                e.attempts, e.last_attempt_at, e.abandoned_at
           FROM github_watch_events e
           JOIN github_watches w ON w.id = e.watch_id
          WHERE e.delivered_at IS NULL AND e.abandoned_at IS NULL
          ORDER BY e.created_at ASC LIMIT ?`,
      )
      .all(limit)
      .map((r) => mapEvent(r as Record<string, unknown>));
  }

  markEventDelivered(id: string, atIso = nowIso()): void {
    this.db
      .prepare(
        `UPDATE github_watch_events
            SET delivered_at = ?, attempts = attempts + 1, last_attempt_at = ?
          WHERE id = ? AND delivered_at IS NULL AND abandoned_at IS NULL`,
      )
      .run(atIso, atIso, id);
  }

  recordEventFailure(id: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE github_watch_events
            SET attempts = attempts + 1, last_attempt_at = ?,
                abandoned_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE abandoned_at END
          WHERE id = ? AND delivered_at IS NULL AND abandoned_at IS NULL`,
      )
      .run(atIso, maxAttempts, atIso, id);
  }
}
