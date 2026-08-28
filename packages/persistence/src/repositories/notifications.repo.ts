import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import { toBool, type NotificationTarget, type PendingNotificationRow } from './types.js';

const mapPending = (r: Record<string, unknown>): PendingNotificationRow => ({
  transitionId: Number(r['transition_id']),
  jobId: String(r['job_id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  repoSlug: String(r['repo_slug']),
  originSharedChannelId:
    r['origin_shared_channel_id'] == null ? null : String(r['origin_shared_channel_id']),
  fromState: String(r['from_state']) as PendingNotificationRow['fromState'],
  toState: String(r['to_state']) as PendingNotificationRow['toState'],
  reason: String(r['reason']),
  actor: String(r['actor']),
  createdAt: String(r['created_at']),
  ownerDelivered: toBool(r['owner_done']),
  sharedDelivered: toBool(r['shared_done']),
});

/**
 * Delivery outbox for job lifecycle notifications, backed by the
 * job_transitions ledger that jobs.repo already writes on every state change.
 * There is no separate write path here: a transition becomes "pending" the
 * moment it is recorded, and stays pending for a given TARGET until
 * markDelivered records that target.
 *
 * A transition can owe a message to two independent places -- the owner's DM
 * and the shared channel the job was submitted from. They are tracked
 * separately because they fail separately: a Discord outage on one must not
 * re-send or strand the other.
 */
export class NotificationsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Transitions with at least one target still undelivered, oldest first, so
   * a long outage drains in the order things actually happened.
   *
   * A job with no originating shared channel reports `sharedDelivered: true`
   * rather than a target waiting to be skipped. That target does not exist
   * for such a job, and manufacturing one would mean writing a ledger row per
   * transition for every DM-submitted job just to record "nowhere to send
   * this" -- pure churn, and it would make the sweep's `skipped` counter
   * meaningless.
   *
   * The two EXISTS subqueries are selected as columns AND repeated in the
   * WHERE clause rather than referenced by alias: SQLite permits the alias
   * form as an extension, but relying on it would make this query silently
   * portable-looking and fragile.
   */
  pending(limit: number): PendingNotificationRow[] {
    return this.db
      .prepare(
        `SELECT t.id AS transition_id, t.job_id, j.public_id, j.discord_user_id, j.repo_slug,
                j.origin_shared_channel_id,
                t.from_state, t.to_state, t.reason, t.actor, t.created_at,
                EXISTS (SELECT 1 FROM job_notification_deliveries d
                        WHERE d.transition_id = t.id AND d.target = 'owner_dm')      AS owner_done,
                CASE WHEN j.origin_shared_channel_id IS NULL THEN 1 ELSE
                  EXISTS (SELECT 1 FROM job_notification_deliveries d
                          WHERE d.transition_id = t.id AND d.target = 'shared_channel')
                END AS shared_done
         FROM job_transitions t
         JOIN jobs j ON j.id = t.job_id
         WHERE NOT EXISTS (SELECT 1 FROM job_notification_deliveries d
                           WHERE d.transition_id = t.id AND d.target = 'owner_dm')
            OR (j.origin_shared_channel_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM job_notification_deliveries d
                                WHERE d.transition_id = t.id AND d.target = 'shared_channel'))
         ORDER BY t.id ASC
         LIMIT ?`,
      )
      .all(limit)
      .map((r) => mapPending(r as Record<string, unknown>));
  }

  /**
   * Idempotent: the (transition_id, target) primary key means a target
   * already marked delivered is silently ignored rather than erroring, so a
   * retried sweep can never record -- or send -- the same notification twice
   * to the same place.
   */
  markDelivered(transitionId: number, jobId: string, target: NotificationTarget): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO job_notification_deliveries
           (transition_id, target, job_id, delivered_at)
         VALUES (?,?,?,?)`,
      )
      .run(transitionId, target, jobId, nowIso());
  }
}
