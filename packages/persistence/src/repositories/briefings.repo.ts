import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type {
  BriefingDeliveryRow, BriefingDeliveryStatus, BriefingSlotKind, BriefingTarget,
} from './types.js';

const map = (r: Record<string, unknown>): BriefingDeliveryRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  kind: String(r['kind']) as BriefingSlotKind,
  dayKey: String(r['day_key']),
  target: String(r['target']) as BriefingTarget,
  dueAt: String(r['due_at']),
  status: String(r['status']) as BriefingDeliveryStatus,
  attempts: Number(r['attempts'] ?? 0),
  lastErrorAt: r['last_error_at'] == null ? null : String(r['last_error_at']),
  deliveredAt: r['delivered_at'] == null ? null : String(r['delivered_at']),
  createdAt: String(r['created_at']),
});

/**
 * The outbox for proactive briefings.
 *
 * Deliberately the same shape as `reminder_occurrences`: a durable row from the
 * moment a slot comes due, a unique key that makes recording a delivery
 * idempotent, bounded attempts, and a terminal state that is a RECORD rather
 * than a deletion. What it is not is a second scheduler.
 */
export class BriefingsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Records that a slot has come due, or does nothing if it already was.
   *
   * The `(user, kind, day_key, TARGET)` unique index is what makes this
   * idempotent: a repeated tick, two overlapping passes and a restart all
   * collide on it rather than producing a second briefing for the same
   * morning. The target is part of the key so a DM copy and a channel copy of
   * the same slot are two independent rows -- otherwise delivering one would
   * mark the slot done and the other would never be sent.
   *
   * Returns true only when THIS call created the row.
   */
  claimSlot(input: {
    id: string;
    discordUserId: string;
    kind: BriefingSlotKind;
    dayKey: string;
    target: BriefingTarget;
    dueAt: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO briefing_deliveries
           (id, discord_user_id, kind, day_key, target, due_at, status, attempts, created_at)
         VALUES (?,?,?,?,?,?, 'pending', 0, ?)`,
      )
      .run(
        input.id, input.discordUserId, input.kind, input.dayKey, input.target,
        input.dueAt, nowIso(),
      );
    return Number(res.changes ?? 0) > 0;
  }

  pending(limit: number): BriefingDeliveryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM briefing_deliveries
          WHERE status = 'pending'
          ORDER BY due_at
          LIMIT ?`,
      )
      .all(limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  markDelivered(id: string, atIso: string): void {
    this.db
      .prepare(
        `UPDATE briefing_deliveries
            SET status = 'delivered', delivered_at = ?, attempts = attempts + 1
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, id);
  }

  /**
   * Records a failure, and abandons the row once it has failed enough times.
   *
   * Abandoned rather than deleted: "Ducky tried five times and gave up" is a
   * fact the owner may need, and a deleted row would silently become "there was
   * never a briefing".
   */
  recordFailure(id: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE briefing_deliveries
            SET attempts = attempts + 1,
                last_error_at = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'abandoned' ELSE 'pending' END
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, maxAttempts, id);
  }

  /**
   * Retires a slot nobody should be sent.
   *
   * Used for a briefing that came due during a long outage and is now stale: a
   * summary OF A DAY delivered the next afternoon describes a day that has
   * already happened. `skipped` keeps the record without pretending it was
   * delivered.
   */
  markSkipped(id: string, atIso: string): void {
    this.db
      .prepare(
        `UPDATE briefing_deliveries
            SET status = 'skipped', last_error_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, id);
  }

  bySlot(
    discordUserId: string,
    kind: BriefingSlotKind,
    dayKey: string,
    target: BriefingTarget = 'owner_dm',
  ): BriefingDeliveryRow | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM briefing_deliveries
          WHERE discord_user_id = ? AND kind = ? AND day_key = ? AND target = ?`,
      )
      .get(discordUserId, kind, dayKey, target);
    return r ? map(r as Record<string, unknown>) : undefined;
  }
}
