import { GAP_CLASSES, GAP_REASONS, GAP_SHOWN, type GapClass, type GapReason, type GapShown } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { GitHubGapMarkerRow, GitHubHeldReviewRow, GitHubWatchEventRow, GitHubWatchRow } from './types.js';

/** A per-author line segment a summary rendered without exact review identity, before it is known to be delivered. */
export interface PendingGapMarker {
  readonly pr: number;
  readonly cls: GapClass;
  readonly reason: GapReason;
  readonly shown: GapShown;
}

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
  repoKey: r['repo_key'] == null ? null : String(r['repo_key']),
  cancelReason: r['cancel_reason'] == null ? null : (String(r['cancel_reason']) as 'identity_mismatch'),
  readBoundaryAt: r['read_boundary_at'] == null ? null : String(r['read_boundary_at']),
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
  repoKey: r['repo_key'] == null ? null : String(r['repo_key']),
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
    /** The canonical repository the slug names RIGHT NOW, recorded as the identity of every observation. */
    repoKey: string | null;
  }): GitHubWatchRow {
    this.db
      .prepare(
        `INSERT INTO github_watches
           (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at,
            state, created_at, updated_at, repo_key)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        row.id, row.publicId, row.discordUserId, row.repoSlug, row.intervalMinutes,
        row.nextCheckAt, row.createdAt, row.createdAt, row.repoKey,
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
    /** What the row held when the observation began (NULL for an unbound legacy watch). */
    expectedRepoKey: string | null;
    /** The repository this observation queried, fixed BEFORE its awaited reads. */
    repoKey: string;
    snapshotHash: string;
    snapshotJson: string;
    nextCheckAt: string;
    atIso: string;
    changed: boolean;
    /**
     * Zero or more events to enqueue in the SAME transaction as the cursor move.
     *
     * Plural since the final milestone: one observation can produce both a
     * snapshot summary and a follow-up proposal, and enqueuing them separately
     * would let a crash keep the cursor while losing the proposal.
     */
    events?: readonly {
      id: string; fingerprint: string; summary: string;
      /**
       * Per-author line segments this summary rendered while the exact review list could not identify them. PENDING
       * evidence only: a marker becomes durable only when the summary is actually delivered.
       */
      gapMarkers?: readonly PendingGapMarker[];
    }[];
    /**
     * The host instant BEFORE the read this snapshot came from STARTED, committed with the snapshot under the
     * same compare-and-set. Never later than the read it describes.
     */
    readBoundaryAt: string;
    /**
     * Requested-changes facts that cannot be told from one the target delivered. Each becomes its own HELD row
     * in the same transaction as the snapshot: unique per watch and exact transition (a repeat is ignored),
     * never sent, never receipted, no attempt charged.
     */
    held?: readonly { id: string; heldKey: string; summary: string; providerAt: string | null }[];
  }): boolean {
    const updated = this.db
      .prepare(
        `UPDATE github_watches
            SET snapshot_hash = ?, snapshot_json = ?, next_check_at = ?,
                last_error = NULL, updated_at = ?, repo_key = ?, read_boundary_at = ?
          WHERE id = ? AND state = 'active' AND next_check_at = ? AND repo_key IS ?`,
      )
      .run(
        input.snapshotHash, input.snapshotJson, input.nextCheckAt, input.atIso, input.repoKey, input.readBoundaryAt,
        input.id, input.expectedNextCheckAt, input.expectedRepoKey,
      );
    if (Number(updated.changes) !== 1) return false;

    for (const h of input.held ?? []) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO github_watch_events
             (id, watch_id, fingerprint, summary, created_at, repo_key, held_reason, held_key, provider_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ambiguous_review', ?, ?)`,
        )
        .run(h.id, input.id, `held:${h.heldKey}`, h.summary, input.atIso, input.repoKey, h.heldKey, h.providerAt);
    }

    for (const event of input.events ?? []) {
      this.db
        .prepare(
          // OR IGNORE, because `(watch_id, fingerprint)` is unique and that
          // uniqueness IS the deduplication: the same requested-change review
          // observed on two passes must produce one proposal, not an error.
          `INSERT OR IGNORE INTO github_watch_events
             (id, watch_id, fingerprint, summary, created_at, repo_key, gap_markers)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id, input.id, event.fingerprint, event.summary, input.atIso, input.repoKey,
          event.gapMarkers && event.gapMarkers.length > 0 ? JSON.stringify(event.gapMarkers) : null,
        );
    }
    return true;
  }

  /**
   * Advances a failed observation without changing the last good snapshot. The read boundary is invalidated:
   * a failed read is a gap, and uninterrupted coverage since the last good read is never assumed.
   */
  recordFailure(id: string, expectedNextCheckAt: string, nextCheckAt: string, error: string, atIso = nowIso()): boolean {
    const result = this.db
      .prepare(
        `UPDATE github_watches
            SET next_check_at = ?, last_error = ?, updated_at = ?, read_boundary_at = NULL
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
          WHERE watch_id = ? AND delivered_at IS NULL AND abandoned_at IS NULL AND held_reason IS NULL`,
      )
      .run(atIso, id);
    // A HELD fact is undelivered work, not a pending send: cancelling the watch neither abandons nor frees it.
    return true;
  }

  /**
   * Stops a watch whose slug now names another repository than the one it queried. Unlike the
   * owner's cancel it abandons NOTHING: the snapshot and every outbox event stay exactly as they
   * were (a pending event is still a true statement about the repository it was observed on).
   */
  cancelForIdentity(id: string, atIso: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE github_watches
            SET state = 'cancelled', next_check_at = NULL, cancelled_at = ?, updated_at = ?,
                cancel_reason = 'identity_mismatch'
          WHERE id = ? AND state = 'active'`,
      )
      .run(atIso, atIso, id);
    return Number(result.changes) === 1;
  }

  /** How many of the owner's watches the system stopped for an identity mismatch (counts only). */
  identityStoppedCount(ownerId: string): number {
    return Number(
      (this.db
        .prepare(`SELECT COUNT(*) AS n FROM github_watches WHERE discord_user_id = ? AND cancel_reason = 'identity_mismatch'`)
        .get(ownerId) as { n: number }).n,
    );
  }

  pendingEvents(limit: number): GitHubWatchEventRow[] {
    return this.db
      .prepare(
        `SELECT e.id, e.watch_id, w.public_id, w.discord_user_id, w.repo_slug,
                e.fingerprint, e.summary, e.created_at, e.delivered_at,
                e.attempts, e.last_attempt_at, e.abandoned_at, e.repo_key
           FROM github_watch_events e
           JOIN github_watches w ON w.id = e.watch_id
          WHERE e.delivered_at IS NULL AND e.abandoned_at IS NULL AND e.held_reason IS NULL
          ORDER BY e.created_at ASC LIMIT ?`,
      )
      .all(limit)
      .map((r) => mapEvent(r as Record<string, unknown>));
  }

  /**
   * Makes the pending per-author gap markers of ONE DELIVERED outbox row durable, in the caller's transaction (the
   * one that settles the row and turns its reservations into receipts). It reads the row, so a row that was not
   * delivered (queued, failed, abandoned, retired) promotes nothing, and it is idempotent. The durable rows live in
   * their own owner-scoped table: retention deletes delivered events and whole cancelled watches, and this
   * evidence must outlive both. Nothing here ever clears a row.
   */
  promoteGapMarkers(eventId: string): number {
    const row = this.db
      .prepare(
        `SELECT e.id, e.gap_markers, e.delivered_at, e.watch_id, e.repo_key, w.discord_user_id
           FROM github_watch_events e JOIN github_watches w ON w.id = e.watch_id
          WHERE e.id = ? AND e.delivered_at IS NOT NULL AND e.gap_markers IS NOT NULL`,
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) return 0;
    let markers: unknown;
    try {
      markers = JSON.parse(String(row['gap_markers']));
    } catch {
      return 0;
    }
    if (!Array.isArray(markers)) return 0;
    let promoted = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO github_watch_gap_markers
         (owner_id, watch_id, repo_key, pr_number, review_class, reason, shown, outbox_ref, delivered_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const m of markers as PendingGapMarker[]) {
      if (!GAP_CLASSES.includes(m.cls) || !GAP_REASONS.includes(m.reason) || !GAP_SHOWN.includes(m.shown)) continue;
      if (!Number.isInteger(m.pr) || m.pr < 1) continue;
      promoted += Number(
        insert.run(
          String(row['discord_user_id']), String(row['watch_id']), row['repo_key'] == null ? null : String(row['repo_key']),
          m.pr, m.cls, m.reason, m.shown, String(row['id']), String(row['delivered_at']),
        ).changes,
      );
    }
    return promoted;
  }

  /** The owner's durable gap markers, counted by how provably they were shown. Counts only. */
  gapMarkerCounts(ownerId: string): { shown: number; notProvablyShown: number } {
    const n = (shown: string): number =>
      Number(
        (this.db
          .prepare('SELECT COUNT(*) AS n FROM github_watch_gap_markers WHERE owner_id = ? AND shown = ?')
          .get(ownerId, shown) as { n: number }).n,
      );
    return { shown: n('shown'), notProvablyShown: n('delivered_not_provably_shown') };
  }

  /** The owner's durable gap markers for the export: identifiers and reasons only, never a title or a body. */
  gapMarkers(ownerId: string, limit: number): GitHubGapMarkerRow[] {
    return this.db
      .prepare(
        `SELECT m.id, m.owner_id, m.watch_id, m.repo_key, m.pr_number, m.review_class, m.reason, m.shown, m.outbox_ref,
                m.delivered_at, w.public_id
           FROM github_watch_gap_markers m LEFT JOIN github_watches w ON w.id = m.watch_id
          WHERE m.owner_id = ? ORDER BY m.id ASC LIMIT ?`,
      )
      .all(ownerId, limit)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          id: Number(r['id']), ownerId: String(r['owner_id']), watchId: String(r['watch_id']),
          publicWatchId: r['public_id'] == null ? null : String(r['public_id']),
          repoKey: r['repo_key'] == null ? null : String(r['repo_key']),
          pr: Number(r['pr_number']), reviewClass: String(r['review_class']) as GapClass,
          reason: String(r['reason']) as GapReason, shown: String(r['shown']) as GapShown,
          outboxRef: String(r['outbox_ref']), deliveredAt: String(r['delivered_at']),
        };
      });
  }

  markEventDelivered(id: string, atIso = nowIso()): void {
    this.db
      .prepare(
        `UPDATE github_watch_events
            SET delivered_at = ?, attempts = attempts + 1, last_attempt_at = ?
          WHERE id = ? AND delivered_at IS NULL AND abandoned_at IS NULL AND held_reason IS NULL`,
      )
      .run(atIso, atIso, id);
  }

  recordEventFailure(id: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE github_watch_events
            SET attempts = attempts + 1, last_attempt_at = ?,
                abandoned_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE abandoned_at END
          WHERE id = ? AND delivered_at IS NULL AND abandoned_at IS NULL AND held_reason IS NULL`,
      )
      .run(atIso, maxAttempts, atIso, id);
  }

  /** How many of the owner's requested-changes facts are held (neither sent, abandoned nor receipted). Counts only. */
  heldCount(ownerId: string): number {
    return Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM github_watch_events e JOIN github_watches w ON w.id = e.watch_id
            WHERE w.discord_user_id = ? AND e.held_reason IS NOT NULL`,
        )
        .get(ownerId) as { n: number }).n,
    );
  }

  /** The held facts, identifiers only (a hash of the review id, never the id), for the export. */
  heldReviews(limit: number): GitHubHeldReviewRow[] {
    return this.db
      .prepare(
        `SELECT e.id, e.watch_id, w.public_id, e.repo_key, e.held_key, e.provider_at, e.created_at, w.state
           FROM github_watch_events e JOIN github_watches w ON w.id = e.watch_id
          WHERE e.held_reason IS NOT NULL ORDER BY e.created_at ASC, e.id ASC LIMIT ?`,
      )
      .all(limit)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          id: String(r['id']), watchId: String(r['watch_id']), publicWatchId: String(r['public_id']),
          repoKey: r['repo_key'] == null ? null : String(r['repo_key']),
          heldKey: String(r['held_key']),
          providerAt: r['provider_at'] == null ? null : String(r['provider_at']),
          createdAt: String(r['created_at']),
          watchState: String(r['state']) as 'active' | 'cancelled',
        };
      });
  }
}
