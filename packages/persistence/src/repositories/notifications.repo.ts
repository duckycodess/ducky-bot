import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { PendingNotificationRow } from './types.js';

const mapPending = (r: Record<string, unknown>): PendingNotificationRow => ({
  transitionId: Number(r['transition_id']),
  jobId: String(r['job_id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  repoSlug: String(r['repo_slug']),
  fromState: String(r['from_state']) as PendingNotificationRow['fromState'],
  toState: String(r['to_state']) as PendingNotificationRow['toState'],
  reason: String(r['reason']),
  actor: String(r['actor']),
  createdAt: String(r['created_at']),
});

/**
 * Delivery outbox for owner-facing job lifecycle notifications, backed by the
 * job_transitions ledger that jobs.repo already writes on every state change.
 * There is no separate write path here: a transition becomes "pending" the
 * moment it is recorded, and stays pending until markDelivered records it.
 */
export class NotificationsRepo {
  constructor(private readonly db: Db) {}

  /** Oldest-first, so a long outage drains in the order things actually happened. */
  pending(limit: number): PendingNotificationRow[] {
    return this.db
      .prepare(
        `SELECT t.id AS transition_id, t.job_id, j.public_id, j.discord_user_id, j.repo_slug,
                t.from_state, t.to_state, t.reason, t.actor, t.created_at
         FROM job_transitions t
         JOIN jobs j ON j.id = t.job_id
         LEFT JOIN job_notifications n ON n.transition_id = t.id
         WHERE n.transition_id IS NULL
         ORDER BY t.id ASC
         LIMIT ?`,
      )
      .all(limit)
      .map((r) => mapPending(r as Record<string, unknown>));
  }

  /**
   * Idempotent: the primary key on transition_id means a transition already
   * marked delivered is silently ignored rather than erroring, so a retried
   * sweep can never record (or send) the same notification twice.
   */
  markDelivered(transitionId: number, jobId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO job_notifications (transition_id, job_id, delivered_at) VALUES (?,?,?)`,
      )
      .run(transitionId, jobId, nowIso());
  }
}
