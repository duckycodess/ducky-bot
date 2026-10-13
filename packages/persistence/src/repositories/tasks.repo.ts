import type { TaskPriority, TaskState } from '@ducky/contracts';
import type { Db } from '../db.js';
import { fromBool, toBool, type ReminderPolicy, type TaskRow } from './types.js';

const parsePolicy = (raw: unknown): ReminderPolicy | null => {
  if (raw == null) return null;
  try {
    const v = JSON.parse(String(raw)) as { enabled?: unknown; offsetsMinutes?: unknown };
    if (typeof v.enabled !== 'boolean') return null;
    const offsets =
      Array.isArray(v.offsetsMinutes) && v.offsetsMinutes.every((n) => Number.isInteger(n) && n > 0)
        ? (v.offsetsMinutes as number[])
        : null;
    return { enabled: v.enabled, offsetsMinutes: offsets };
  } catch {
    // A policy nobody can read is the native default, never a task that
    // silently stops reminding.
    return null;
  }
};

const map = (r: Record<string, unknown>): TaskRow => ({
  id: String(r['id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  title: String(r['title']),
  dueAt: r['due_at'] == null ? null : String(r['due_at']),
  dueAllDay: toBool(r['due_all_day']),
  priority: String(r['priority']) as TaskPriority,
  status: String(r['status']) as TaskState,
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  closedAt: r['closed_at'] == null ? null : String(r['closed_at']),
  reminderPolicy: parsePolicy(r['reminder_policy']),
});

/**
 * The stable order for every owner-facing list: soonest due first, undated
 * last, then high priority ahead of low, then oldest first.
 *
 * Written once and reused by every query so two views of the same tasks can
 * never disagree about their order -- a briefing and `/task list` showing the
 * same rows in different sequences would read as two different sets.
 */
const ORDER = `ORDER BY (due_at IS NULL), due_at ASC,
  CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
  created_at ASC`;

/**
 * Tasks are owner-only personal data. Every read here is scoped by
 * `discord_user_id` in SQL rather than filtered afterwards, so there is no
 * unscoped query for a later change to reach for.
 */
export class TasksRepo {
  constructor(private readonly db: Db) {}

  insert(row: {
    id: string;
    publicId: string;
    discordUserId: string;
    title: string;
    dueAt: string | null;
    dueAllDay: boolean;
    priority: TaskPriority;
    createdAt: string;
    /** Omitted means the native defaults. */
    reminderPolicy?: ReminderPolicy | null;
  }): TaskRow {
    this.db
      .prepare(
        `INSERT INTO tasks (id, public_id, discord_user_id, title, due_at, due_all_day,
           priority, status, created_at, updated_at, reminder_policy)
         VALUES (?,?,?,?,?,?,?,'open',?,?,?)`,
      )
      .run(
        row.id,
        row.publicId,
        row.discordUserId,
        row.title,
        row.dueAt,
        fromBool(row.dueAllDay),
        row.priority,
        row.createdAt,
        row.createdAt,
        row.reminderPolicy ? JSON.stringify(row.reminderPolicy) : null,
      );
    return {
      ...row,
      reminderPolicy: row.reminderPolicy ?? null,
      status: 'open',
      updatedAt: row.createdAt,
      closedAt: null,
    };
  }

  publicIdExists(publicId: string): boolean {
    return this.db.prepare('SELECT 1 FROM tasks WHERE public_id = ?').get(publicId) !== undefined;
  }

  /** Scoped to the owner: another account's task reads as absent, not as denied. */
  byPublicId(ownerId: string, publicId: string): TaskRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM tasks WHERE discord_user_id = ? AND public_id = ?')
      .get(ownerId, publicId);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  listForOwner(ownerId: string, status: TaskState | 'all', limit: number): TaskRow[] {
    const sql =
      status === 'all'
        ? `SELECT * FROM tasks WHERE discord_user_id = ? ${ORDER} LIMIT ?`
        : `SELECT * FROM tasks WHERE discord_user_id = ? AND status = ? ${ORDER} LIMIT ?`;
    const args = status === 'all' ? [ownerId, limit] : [ownerId, status, limit];
    return this.db
      .prepare(sql)
      .all(...(args as never[]))
      .map((r) => map(r as Record<string, unknown>));
  }

  /** Open tasks due inside a half-open instant range. Used by the briefing. */
  dueBetween(ownerId: string, startIso: string, endIso: string, limit: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE discord_user_id = ? AND status = 'open'
           AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?
         ${ORDER} LIMIT ?`,
      )
      .all(ownerId, startIso, endIso, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  /**
   * Open tasks that are genuinely late, and the two halves of "late".
   *
   * A TIMED deadline is late once its instant has passed: a 09:00 task is
   * overdue at 17:00, and saying otherwise would be wrong.
   *
   * A DATE-ONLY deadline is not. It is stored as that day's midnight because
   * that is where the civil day begins, but the owner typed a date and meant
   * the whole of it -- so comparing it to `now` marked every task due TODAY as
   * overdue from one second past midnight. It is late once the day it names
   * has ended, which is why the caller passes the start of the current local
   * day as well: computing that in SQL would need a timezone SQLite does not
   * have, and would be wrong across a DST boundary.
   */
  private static readonly OVERDUE_PREDICATE = `due_at IS NOT NULL AND (
       (due_all_day = 0 AND due_at < :now)
    OR (due_all_day = 1 AND due_at < :dayStart)
  )`;

  overdue(ownerId: string, nowIso: string, dayStartIso: string, limit: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE discord_user_id = :owner AND status = 'open'
           AND ${TasksRepo.OVERDUE_PREDICATE}
         ${ORDER} LIMIT :limit`,
      )
      .all({ owner: ownerId, now: nowIso, dayStart: dayStartIso, limit })
      .map((r) => map(r as Record<string, unknown>));
  }

  countOverdue(ownerId: string, nowIso: string, dayStartIso: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE discord_user_id = :owner AND status = 'open'
           AND ${TasksRepo.OVERDUE_PREDICATE}`,
      )
      .get({ owner: ownerId, now: nowIso, dayStart: dayStartIso }) as { n: number };
    return Number(r.n);
  }

  /** Scoped to the owner, like every other read here. */
  byId(ownerId: string, id: string): TaskRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM tasks WHERE discord_user_id = ? AND id = ?')
      .get(ownerId, id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  /**
   * Moves an OPEN task's deadline, and only its owner's.
   *
   * Returns whether a row changed, so a caller can tell "already closed" from
   * "not yours" without a second read -- the same shape `close` uses. The
   * linked reminders are resynchronized by the service, in the same
   * transaction: a deadline that moved without its notifications moving would
   * be worse than one that did not move at all.
   */
  updateDue(
    ownerId: string,
    id: string,
    dueAt: string | null,
    dueAllDay: boolean,
    atIso: string,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE tasks SET due_at = ?, due_all_day = ?, updated_at = ?
         WHERE id = ? AND discord_user_id = ? AND status = 'open'`,
      )
      .run(dueAt, fromBool(dueAllDay), atIso, id, ownerId);
    return Number(info.changes) === 1;
  }

  /**
   * Inserts one task inside a caller's transaction, used by the bulk save.
   *
   * Deliberately the SAME statement `insert` runs rather than a second
   * multi-row one: a batch that validated differently from a single add would
   * be a second way to write a task, and the bounds would eventually drift.
   */
  insertMany(rows: Parameters<TasksRepo['insert']>[0][]): TaskRow[] {
    return rows.map((row) => this.insert(row));
  }

  /** Tasks closed into a given state inside a range. The evening briefing's "done today". */
  closedBetween(
    ownerId: string,
    status: Exclude<TaskState, 'open'>,
    startIso: string,
    endIso: string,
    limit: number,
  ): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE discord_user_id = ? AND status = ?
           AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?
         ORDER BY closed_at ASC LIMIT ?`,
      )
      .all(ownerId, status, startIso, endIso, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  countOpen(ownerId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE discord_user_id = ? AND status = 'open'`)
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  /**
   * Only ever moves an OPEN task, and only for its own owner. Returns whether
   * a row actually changed, so the caller can tell "already done" from "not
   * yours" without a second read.
   */
  close(
    ownerId: string,
    id: string,
    status: Exclude<TaskState, 'open'>,
    atIso: string,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE tasks SET status = ?, closed_at = ?, updated_at = ?
         WHERE id = ? AND discord_user_id = ? AND status = 'open'`,
      )
      .run(status, atIso, atIso, id, ownerId);
    return Number(info.changes) === 1;
  }
}
