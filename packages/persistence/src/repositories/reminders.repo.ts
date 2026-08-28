import type { RecurrenceKind, ReminderState } from '@ducky/contracts';
import type { Db } from '../db.js';
import type {
  PendingReminderOccurrenceRow, ReminderOccurrenceRow, ReminderRow,
} from './types.js';

const map = (r: Record<string, unknown>): ReminderRow => ({
  id: String(r['id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  text: String(r['text']),
  recurrenceKind: String(r['recurrence_kind']) as RecurrenceKind,
  intervalMinutes: r['interval_minutes'] == null ? null : Number(r['interval_minutes']),
  maxOccurrences: Number(r['max_occurrences']),
  firedCount: Number(r['fired_count']),
  nextFireAt: r['next_fire_at'] == null ? null : String(r['next_fire_at']),
  status: String(r['status']) as ReminderState,
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  firstFireAt: String(r['first_fire_at']),
  lastFiredAt: r['last_fired_at'] == null ? null : String(r['last_fired_at']),
  closedAt: r['closed_at'] == null ? null : String(r['closed_at']),
});

const mapOccurrence = (r: Record<string, unknown>): ReminderOccurrenceRow => ({
  id: String(r['id']),
  reminderId: String(r['reminder_id']),
  occurrenceNo: Number(r['occurrence_no']),
  scheduledFor: String(r['scheduled_for']),
  missedCount: Number(r['missed_count']),
  createdAt: String(r['created_at']),
  deliveredAt: r['delivered_at'] == null ? null : String(r['delivered_at']),
  attempts: Number(r['attempts']),
  lastAttemptAt: r['last_attempt_at'] == null ? null : String(r['last_attempt_at']),
  abandonedAt: r['abandoned_at'] == null ? null : String(r['abandoned_at']),
});

/**
 * Reminders, and the durable outbox of occurrences they produce.
 *
 * The split is the whole design. A `reminders` row is a SCHEDULE and carries a
 * single cursor, `next_fire_at`. A `reminder_occurrences` row is a DELIVERY
 * and exists from the moment an occurrence becomes due until it has been sent
 * (or abandoned). Materializing one and advancing the cursor happen in the
 * same transaction, so a tick that runs twice -- or two ticks that overlap --
 * cannot produce two messages for one occurrence: the second finds the cursor
 * already moved, and the unique key on (reminder_id, occurrence_no) would
 * refuse the duplicate even if it did not.
 */
export class RemindersRepo {
  constructor(private readonly db: Db) {}

  insert(row: {
    id: string;
    publicId: string;
    discordUserId: string;
    text: string;
    recurrenceKind: RecurrenceKind;
    intervalMinutes: number | null;
    maxOccurrences: number;
    firstFireAt: string;
    createdAt: string;
  }): ReminderRow {
    this.db
      .prepare(
        `INSERT INTO reminders (id, public_id, discord_user_id, text, recurrence_kind,
           interval_minutes, max_occurrences, fired_count, next_fire_at, status,
           created_at, updated_at, first_fire_at)
         VALUES (?,?,?,?,?,?,?,0,?, 'scheduled', ?,?,?)`,
      )
      .run(
        row.id,
        row.publicId,
        row.discordUserId,
        row.text,
        row.recurrenceKind,
        row.intervalMinutes,
        row.maxOccurrences,
        row.firstFireAt,
        row.createdAt,
        row.createdAt,
        row.firstFireAt,
      );
    return {
      ...row,
      firedCount: 0,
      nextFireAt: row.firstFireAt,
      status: 'scheduled',
      updatedAt: row.createdAt,
      lastFiredAt: null,
      closedAt: null,
    };
  }

  publicIdExists(publicId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM reminders WHERE public_id = ?').get(publicId) !== undefined
    );
  }

  byPublicId(ownerId: string, publicId: string): ReminderRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM reminders WHERE discord_user_id = ? AND public_id = ?')
      .get(ownerId, publicId);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  byId(id: string): ReminderRow | undefined {
    const r = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  /**
   * Scheduled reminders sort by when they next fire; finished ones have no
   * cursor and sort by when they were created, so the list never mixes a
   * meaningless NULL into the ordering.
   */
  listForOwner(ownerId: string, status: ReminderState | 'all', limit: number): ReminderRow[] {
    const sql =
      status === 'all'
        ? `SELECT * FROM reminders WHERE discord_user_id = ?
           ORDER BY (next_fire_at IS NULL), next_fire_at ASC, created_at DESC LIMIT ?`
        : `SELECT * FROM reminders WHERE discord_user_id = ? AND status = ?
           ORDER BY (next_fire_at IS NULL), next_fire_at ASC, created_at DESC LIMIT ?`;
    const args = status === 'all' ? [ownerId, limit] : [ownerId, status, limit];
    return this.db
      .prepare(sql)
      .all(...(args as never[]))
      .map((r) => map(r as Record<string, unknown>));
  }

  /** Scheduled reminders whose next occurrence falls inside a range. */
  scheduledBetween(ownerId: string, startIso: string, endIso: string, limit: number): ReminderRow[] {
    return this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE discord_user_id = ? AND status = 'scheduled'
           AND next_fire_at >= ? AND next_fire_at < ?
         ORDER BY next_fire_at ASC LIMIT ?`,
      )
      .all(ownerId, startIso, endIso, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  countScheduled(ownerId: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM reminders WHERE discord_user_id = ? AND status = 'scheduled'`,
      )
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  /**
   * Reminders that are due. Ordered oldest-cursor first so a backlog drains in
   * the order things were actually meant to happen.
   */
  dueForMaterialization(nowIso: string, limit: number): ReminderRow[] {
    return this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'scheduled' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at ASC LIMIT ?`,
      )
      .all(nowIso, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  /**
   * Records one due occurrence and moves the cursor past it, together.
   *
   * `expectedFiredCount` is a compare-and-set on the row the caller read: if
   * anything advanced the reminder in between, nothing is written and this
   * returns false. That, plus the unique key on (reminder_id, occurrence_no),
   * is what makes a repeated tick advance the recurrence exactly once instead
   * of emitting the same occurrence twice.
   */
  materializeOccurrence(input: {
    occurrenceId: string;
    reminderId: string;
    expectedFiredCount: number;
    occurrenceNo: number;
    scheduledFor: string;
    missedCount: number;
    nextFireAt: string | null;
    status: ReminderState;
    atIso: string;
  }): boolean {
    const advanced = this.db
      .prepare(
        `UPDATE reminders
            SET fired_count = ?, next_fire_at = ?, status = ?, last_fired_at = ?,
                updated_at = ?, closed_at = CASE WHEN ? = 'scheduled' THEN NULL ELSE ? END
          WHERE id = ? AND status = 'scheduled' AND fired_count = ?`,
      )
      .run(
        input.occurrenceNo,
        input.nextFireAt,
        input.status,
        input.atIso,
        input.atIso,
        input.status,
        input.atIso,
        input.reminderId,
        input.expectedFiredCount,
      );
    if (Number(advanced.changes) !== 1) return false;

    this.db
      .prepare(
        `INSERT INTO reminder_occurrences
           (id, reminder_id, occurrence_no, scheduled_for, missed_count, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        input.occurrenceId,
        input.reminderId,
        input.occurrenceNo,
        input.scheduledFor,
        input.missedCount,
        input.atIso,
      );
    return true;
  }

  /**
   * Occurrences that are materialized but not yet delivered, joined with the
   * reminder text and owner they belong to. Abandoned rows are excluded: they
   * are a record, not a queue entry.
   */
  pendingOccurrences(limit: number): PendingReminderOccurrenceRow[] {
    return this.db
      .prepare(
        `SELECT o.id, o.reminder_id, o.occurrence_no, o.scheduled_for, o.missed_count,
                o.attempts, r.public_id, r.discord_user_id, r.text,
                r.recurrence_kind, r.max_occurrences, r.next_fire_at
           FROM reminder_occurrences o
           JOIN reminders r ON r.id = o.reminder_id
          WHERE o.delivered_at IS NULL AND o.abandoned_at IS NULL
          ORDER BY o.scheduled_for ASC, o.occurrence_no ASC
          LIMIT ?`,
      )
      .all(limit)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          occurrenceId: String(r['id']),
          reminderId: String(r['reminder_id']),
          publicId: String(r['public_id']),
          discordUserId: String(r['discord_user_id']),
          text: String(r['text']),
          occurrenceNo: Number(r['occurrence_no']),
          scheduledFor: String(r['scheduled_for']),
          missedCount: Number(r['missed_count']),
          attempts: Number(r['attempts']),
          recurrenceKind: String(r['recurrence_kind']) as RecurrenceKind,
          maxOccurrences: Number(r['max_occurrences']),
          nextFireAt: r['next_fire_at'] == null ? null : String(r['next_fire_at']),
        };
      });
  }

  /**
   * Idempotent: the WHERE clause requires the row to still be undelivered, so
   * marking twice is a no-op rather than a second delivery record.
   */
  markOccurrenceDelivered(occurrenceId: string, atIso: string): void {
    this.db
      .prepare(
        `UPDATE reminder_occurrences
            SET delivered_at = ?, attempts = attempts + 1, last_attempt_at = ?
          WHERE id = ? AND delivered_at IS NULL`,
      )
      .run(atIso, atIso, occurrenceId);
  }

  /**
   * Records a failed send and abandons the occurrence once it has been tried
   * too many times. Abandoning is deliberate and visible -- the row keeps its
   * attempt count and an `abandoned_at` -- rather than a silent delete or an
   * infinite retry against a target that is never coming back.
   */
  recordOccurrenceFailure(occurrenceId: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE reminder_occurrences
            SET attempts = attempts + 1,
                last_attempt_at = ?,
                abandoned_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE abandoned_at END
          WHERE id = ? AND delivered_at IS NULL AND abandoned_at IS NULL`,
      )
      .run(atIso, maxAttempts, atIso, occurrenceId);
  }

  occurrencesFor(reminderId: string): ReminderOccurrenceRow[] {
    return this.db
      .prepare('SELECT * FROM reminder_occurrences WHERE reminder_id = ? ORDER BY occurrence_no')
      .all(reminderId)
      .map((r) => mapOccurrence(r as Record<string, unknown>));
  }

  /**
   * Cancels a scheduled reminder and clears its cursor.
   *
   * Occurrences already materialized are NOT withdrawn: they were due before
   * the cancellation, and the ledger is a record of what came due, not a queue
   * that can be rewritten after the fact. Anything still undelivered is
   * abandoned in the same statement so a cancelled reminder cannot go on to
   * send a message.
   */
  cancel(ownerId: string, id: string, atIso: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE reminders
            SET status = 'cancelled', next_fire_at = NULL, closed_at = ?, updated_at = ?
          WHERE id = ? AND discord_user_id = ? AND status = 'scheduled'`,
      )
      .run(atIso, atIso, id, ownerId);
    if (Number(info.changes) !== 1) return false;

    this.db
      .prepare(
        `UPDATE reminder_occurrences SET abandoned_at = ?
          WHERE reminder_id = ? AND delivered_at IS NULL AND abandoned_at IS NULL`,
      )
      .run(atIso, id);
    return true;
  }
}
