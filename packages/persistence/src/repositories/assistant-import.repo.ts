import type { TaskCategory, TaskPriority, TaskState } from '@ducky/contracts';
import type { Db } from '../db.js';
import type { ReminderPolicy } from './types.js';

export const IDENTITY_CATEGORIES = [
  'task', 'reminder', 'capture', 'schedule_rule', 'schedule_exception', 'preferences',
  'watch_target',
] as const;
export type IdentityCategory = (typeof IDENTITY_CATEGORIES)[number];

export interface IdentityRow {
  readonly namespace: string;
  readonly category: IdentityCategory;
  readonly sourceId: string;
  /** Null exactly when the identity is a tombstone. */
  readonly targetId: string | null;
  readonly state: 'live' | 'tombstone';
  /** Null exactly when the identity is a tombstone. */
  readonly fingerprint: string | null;
  readonly createdAt: string;
  readonly tombstonedAt: string | null;
}

const mapIdentity = (r: Record<string, unknown>): IdentityRow => ({
  namespace: String(r['namespace']),
  category: String(r['category']) as IdentityCategory,
  sourceId: String(r['source_id']),
  targetId: r['target_id'] == null ? null : String(r['target_id']),
  state: String(r['state']) as 'live' | 'tombstone',
  fingerprint: r['fingerprint'] == null ? null : String(r['fingerprint']),
  createdAt: String(r['created_at']),
  tombstonedAt: r['tombstoned_at'] == null ? null : String(r['tombstoned_at']),
});

/** The closed states a task can arrive in. An imported task is never reopened. */
export interface ImportedTaskWrite {
  id: string;
  publicId: string;
  discordUserId: string;
  title: string;
  dueAt: string | null;
  dueAllDay: boolean;
  priority: TaskPriority;
  /** The source's urgent priority, stored beside `priority` (which stays `high`). */
  urgent?: boolean;
  category?: TaskCategory | null;
  status: TaskState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  reminderPolicy: ReminderPolicy | null;
}

export interface ImportedReminderWrite {
  id: string;
  publicId: string;
  discordUserId: string;
  taskId: string;
  text: string;
  /** scheduled: still owed. completed: delivered once. cancelled: never fires. */
  status: 'scheduled' | 'completed' | 'cancelled';
  fireAt: string;
  deliveredAt: string | null;
  createdAt: string;
  /** When a cancelled reminder was cancelled; ignored otherwise. */
  closedAt: string | null;
}

export interface ImportedCaptureWrite {
  id: string;
  discordUserId: string;
  content: string;
  status: 'open' | 'done' | 'archived';
  createdAt: string;
  updatedAt: string;
}

/**
 * Import-specific writes, and the correlation ledger.
 *
 * Deliberately NOT the ordinary insert methods. Those create an OPEN task, a
 * SCHEDULED reminder and a capture stamped "now"; replaying them would reopen
 * closed work, send reminders that were already delivered and rewrite history.
 * These write the state the record already had, and every one is called only
 * from inside the importer's single transaction (ADR 0030).
 *
 * The ledger is the only thing that makes a second run harmless, and it is
 * PERMANENT: a trigger tombstones an identity when its record is deleted, so a
 * record the owner removed is never imported again.
 */
export class AssistantImportRepo {
  constructor(private readonly db: Db) {}

  identity(namespace: string, category: IdentityCategory, sourceId: string): IdentityRow | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM assistant_import_identities
          WHERE namespace = ? AND category = ? AND source_id = ?`,
      )
      .get(namespace, category, sourceId);
    return r ? mapIdentity(r as Record<string, unknown>) : undefined;
  }

  /**
   * Every source namespace the ledger has ever seen. Identities are scoped by
   * namespace, so a mistyped one would look like a brand-new source and import
   * everything a second time; the importer pins to what is already here.
   */
  namespaces(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT namespace FROM assistant_import_identities ORDER BY namespace')
        .all() as { namespace: string }[]
    ).map((r) => r.namespace);
  }

  recordLive(row: {
    namespace: string;
    category: IdentityCategory;
    sourceId: string;
    targetId: string;
    fingerprint: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO assistant_import_identities
           (namespace, category, source_id, target_id, state, fingerprint, created_at)
         VALUES (?,?,?,?, 'live', ?, ?)`,
      )
      .run(row.namespace, row.category, row.sourceId, row.targetId, row.fingerprint, row.at);
  }

  /** Counts only, for verification: how many identities are live or tombstoned. */
  identityCounts(namespace: string): Record<IdentityCategory, { live: number; tombstone: number }> {
    const out = Object.fromEntries(
      IDENTITY_CATEGORIES.map((c) => [c, { live: 0, tombstone: 0 }]),
    ) as Record<IdentityCategory, { live: number; tombstone: number }>;
    const rows = this.db
      .prepare(
        `SELECT category, state, COUNT(*) AS n FROM assistant_import_identities
          WHERE namespace = ? GROUP BY category, state`,
      )
      .all(namespace) as { category: IdentityCategory; state: 'live' | 'tombstone'; n: number }[];
    for (const r of rows) out[r.category][r.state] = Number(r.n);
    return out;
  }

  insertTask(row: ImportedTaskWrite): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, public_id, discord_user_id, title, due_at, due_all_day,
           priority, urgent, category, status, created_at, updated_at, closed_at, reminder_policy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.publicId, row.discordUserId, row.title, row.dueAt, row.dueAllDay ? 1 : 0,
        row.priority, row.urgent ? 1 : 0, row.category ?? null, row.status, row.createdAt, row.updatedAt, row.closedAt,
        row.reminderPolicy ? JSON.stringify(row.reminderPolicy) : null,
      );
  }

  /**
   * A linked reminder in the state it already had.
   *
   * A delivered one is written as COMPLETED with its delivered occurrence, so
   * no later tick can see it as owed. A scheduled one keeps its instant even
   * when that is already past: the audited behavior is that an overdue pending
   * reminder is delivered late, once, and the ledger's catch-up already does
   * exactly that.
   */
  insertReminder(row: ImportedReminderWrite): void {
    const scheduled = row.status === 'scheduled';
    const delivered = row.status === 'completed';
    this.db
      .prepare(
        `INSERT INTO reminders (id, public_id, discord_user_id, text, recurrence_kind,
           interval_minutes, max_occurrences, fired_count, next_fire_at, status,
           created_at, updated_at, first_fire_at, last_fired_at, closed_at, task_id)
         VALUES (?,?,?,?, 'once', NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.publicId, row.discordUserId, row.text,
        delivered ? 1 : 0,
        scheduled ? row.fireAt : null,
        row.status,
        row.createdAt,
        row.deliveredAt ?? row.closedAt ?? row.createdAt,
        row.fireAt,
        row.deliveredAt,
        scheduled ? null : (row.deliveredAt ?? row.closedAt ?? row.createdAt),
        row.taskId,
      );
    if (delivered) {
      this.db
        .prepare(
          `INSERT INTO reminder_occurrences
             (id, reminder_id, occurrence_no, scheduled_for, missed_count, created_at,
              delivered_at, attempts, last_attempt_at)
           VALUES (?,?,1,?,0,?,?,1,?)`,
        )
        .run(`${row.id}:1`, row.id, row.fireAt, row.fireAt, row.deliveredAt, row.deliveredAt);
    }
  }

  insertCapture(row: ImportedCaptureWrite): void {
    this.db
      .prepare(
        `INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.id, row.discordUserId, row.content, row.status, row.createdAt, row.updatedAt);
  }

  /**
   * Records an identity as a tombstone from the start.
   *
   * Used for a record the source had already deleted: there is nothing to
   * import, and the identity must still be remembered so a later export that
   * still carries it cannot bring it back.
   */
  recordTombstone(row: {
    namespace: string;
    category: IdentityCategory;
    sourceId: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO assistant_import_identities
           (namespace, category, source_id, target_id, state, fingerprint, created_at, tombstoned_at)
         VALUES (?,?,?,NULL,'tombstone',NULL,?,?)`,
      )
      .run(row.namespace, row.category, row.sourceId, row.at, row.at);
  }
}
