import type { TaskPriority, TaskState } from '@ducky/contracts';
import type { Db } from '../db.js';
import { fromBool, toBool, type TaskRow } from './types.js';

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
  }): TaskRow {
    this.db
      .prepare(
        `INSERT INTO tasks (id, public_id, discord_user_id, title, due_at, due_all_day,
           priority, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'open',?,?)`,
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
      );
    return {
      ...row,
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

  /** Open tasks whose due instant has already passed. */
  overdue(ownerId: string, beforeIso: string, limit: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE discord_user_id = ? AND status = 'open'
           AND due_at IS NOT NULL AND due_at < ?
         ${ORDER} LIMIT ?`,
      )
      .all(ownerId, beforeIso, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  countOverdue(ownerId: string, beforeIso: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE discord_user_id = ? AND status = 'open'
           AND due_at IS NOT NULL AND due_at < ?`,
      )
      .get(ownerId, beforeIso) as { n: number };
    return Number(r.n);
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
