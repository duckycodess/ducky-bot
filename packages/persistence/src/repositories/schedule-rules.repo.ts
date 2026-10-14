import type { ScheduleExceptionInput, ScheduleExceptionKind, ScheduleRuleInput } from '@ducky/contracts';
import type { Db } from '../db.js';
import { atomically } from '../db.js';

export interface ScheduleRuleRow extends ScheduleRuleInput {
  readonly discordUserId: string;
  readonly batchKey: string;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface ScheduleExceptionRow extends ScheduleExceptionInput {
  readonly discordUserId: string;
  readonly createdAt: string;
}

const mapRule = (r: Record<string, unknown>): ScheduleRuleRow => {
  let uncertain: string[] = [];
  try {
    const v = JSON.parse(String(r['uncertain'] ?? '[]')) as unknown;
    if (Array.isArray(v)) uncertain = v.filter((x): x is string => typeof x === 'string');
  } catch {
    uncertain = [];
  }
  return {
    id: String(r['id']),
    discordUserId: String(r['discord_user_id']),
    batchKey: String(r['batch_key']),
    active: Number(r['active']) === 1,
    weekday: Number(r['weekday']),
    startTime: String(r['start_time']),
    endTime: String(r['end_time']),
    label: String(r['label']),
    courseCode: r['course_code'] == null ? null : String(r['course_code']),
    section: r['section'] == null ? null : String(r['section']),
    room: r['room'] == null ? null : String(r['room']),
    uncertain,
    effectiveFrom: r['effective_from'] == null ? null : String(r['effective_from']),
    effectiveUntil: r['effective_until'] == null ? null : String(r['effective_until']),
    createdAt: String(r['created_at']),
  };
};

const mapException = (r: Record<string, unknown>): ScheduleExceptionRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  date: String(r['local_date']),
  courseCode: r['course_code'] == null ? null : String(r['course_code']),
  label: r['label'] == null ? null : String(r['label']),
  kind: String(r['kind']) as ScheduleExceptionKind,
  note: r['note'] == null ? null : String(r['note']),
  createdAt: String(r['created_at']),
});

/** What kind of schedule record a handle named. */
export type ScheduleRecordKind = 'rule' | 'exception';

/**
 * Indefinite weekly rules and their dated exceptions.
 *
 * Every read is scoped to the owner in SQL. Only ACTIVE rules are ever returned
 * to a reader that wants behavior; a replaced batch is kept as inert data and
 * is reachable only through the explicit `listAllForOwner`, which exists so the
 * owner can see and delete it.
 */
export class ScheduleRulesRepo {
  constructor(private readonly db: Db) {}

  insertRule(row: {
    id: string;
    discordUserId: string;
    batchKey: string;
    active: boolean;
    weekday: number;
    startTime: string;
    endTime: string;
    label: string;
    courseCode: string | null;
    section: string | null;
    room: string | null;
    uncertain: readonly string[];
    effectiveFrom: string | null;
    effectiveUntil: string | null;
    createdAt: string;
    /** When a replaced batch was replaced; null for an active rule or an unknown order. */
    replacedAt?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO schedule_rules (id, discord_user_id, batch_key, active, weekday, start_time,
           end_time, label, course_code, section, room, uncertain, effective_from,
           effective_until, created_at, replaced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.discordUserId, row.batchKey, row.active ? 1 : 0, row.weekday, row.startTime,
        row.endTime, row.label, row.courseCode, row.section, row.room,
        JSON.stringify(row.uncertain), row.effectiveFrom, row.effectiveUntil, row.createdAt,
        row.active ? null : row.replacedAt ?? null,
      );
  }

  /**
   * Flips the schedule back one batch, deleting nothing.
   *
   * The batch that is active becomes replaced (stamped `atIso`), and the most
   * recently replaced batch with a KNOWN replacement time becomes active. A
   * replaced batch whose order is unknown is never chosen: guessing which one the
   * owner meant would swap in a schedule nobody asked for. Returns what happened as
   * counts only, never a label.
   */
  rollbackBatch(ownerId: string, atIso: string):
    | { readonly ok: true; readonly restoredRules: number; readonly replacedRules: number }
    | { readonly ok: false; readonly reason: 'nothing_to_restore' | 'order_unknown' } {
    return atomically(this.db, () => {
      const target = this.db
        .prepare(
          `SELECT batch_key AS k, MAX(replaced_at) AS at FROM schedule_rules
            WHERE discord_user_id = ? AND active = 0 AND replaced_at IS NOT NULL
            GROUP BY batch_key ORDER BY MAX(replaced_at) DESC, batch_key ASC LIMIT 2`,
        )
        .all(ownerId) as { k: string; at: string }[];
      if (target.length === 0) {
        const unknown = this.db
          .prepare('SELECT COUNT(*) AS n FROM schedule_rules WHERE discord_user_id = ? AND active = 0')
          .get(ownerId) as { n: number };
        return { ok: false as const, reason: Number(unknown.n) > 0 ? ('order_unknown' as const) : ('nothing_to_restore' as const) };
      }
      // Two batches stamped the same instant: which is "most recent" is not known.
      if (target.length === 2 && target[0]!.at === target[1]!.at) {
        return { ok: false as const, reason: 'order_unknown' as const };
      }
      const restore = target[0]!.k;
      const replaced = this.db
        .prepare(
          `UPDATE schedule_rules SET active = 0, replaced_at = ?
            WHERE discord_user_id = ? AND active = 1`,
        )
        .run(atIso, ownerId);
      const restored = this.db
        .prepare(
          `UPDATE schedule_rules SET active = 1, replaced_at = NULL
            WHERE discord_user_id = ? AND batch_key = ? AND active = 0`,
        )
        .run(ownerId, restore);
      return { ok: true as const, restoredRules: Number(restored.changes), replacedRules: Number(replaced.changes) };
    });
  }

  insertException(row: {
    id: string;
    discordUserId: string;
    date: string;
    courseCode: string | null;
    label: string | null;
    kind: ScheduleExceptionKind;
    note: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO schedule_exceptions (id, discord_user_id, local_date, course_code, label,
           kind, note, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(row.id, row.discordUserId, row.date, row.courseCode, row.label, row.kind, row.note, row.createdAt);
  }

  /** The rules that drive behavior. Inactive batches are never in here. */
  activeRules(ownerId: string): ScheduleRuleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM schedule_rules WHERE discord_user_id = ? AND active = 1
          ORDER BY weekday, start_time, id`,
      )
      .all(ownerId)
      .map((r) => mapRule(r as Record<string, unknown>));
  }

  exceptionsBetween(ownerId: string, startDate: string, endDateExclusive: string): ScheduleExceptionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM schedule_exceptions
          WHERE discord_user_id = ? AND local_date >= ? AND local_date < ?
          ORDER BY local_date, id`,
      )
      .all(ownerId, startDate, endDateExclusive)
      .map((r) => mapException(r as Record<string, unknown>));
  }

  /** Active AND inactive, so the owner can see and delete what is inert. */
  listAllRulesForOwner(ownerId: string, limit: number): ScheduleRuleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM schedule_rules WHERE discord_user_id = ?
          ORDER BY active DESC, weekday, start_time, id LIMIT ?`,
      )
      .all(ownerId, limit)
      .map((r) => mapRule(r as Record<string, unknown>));
  }

  listExceptionsForOwner(ownerId: string, limit: number): ScheduleExceptionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM schedule_exceptions WHERE discord_user_id = ?
          ORDER BY local_date, id LIMIT ?`,
      )
      .all(ownerId, limit)
      .map((r) => mapException(r as Record<string, unknown>));
  }

  countRules(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM schedule_rules WHERE discord_user_id = ?')
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  countExceptions(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM schedule_exceptions WHERE discord_user_id = ?')
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  /**
   * Every rule and exception whose id starts with the handle the owner typed,
   * across BOTH tables, so a prefix that fits two records is reported as
   * ambiguous rather than guessed at. Scoped to the owner in SQL.
   */
  idsByPrefix(ownerId: string, prefix: string): { kind: ScheduleRecordKind; id: string }[] {
    // LIKE with an escaped prefix: the handle came from a message.
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rules = this.db
      .prepare(`SELECT id FROM schedule_rules WHERE discord_user_id = ? AND id LIKE ? ESCAPE '\\' LIMIT 3`)
      .all(ownerId, like) as { id: string }[];
    const exceptions = this.db
      .prepare(`SELECT id FROM schedule_exceptions WHERE discord_user_id = ? AND id LIKE ? ESCAPE '\\' LIMIT 3`)
      .all(ownerId, like) as { id: string }[];
    return [
      ...rules.map((r) => ({ kind: 'rule' as const, id: String(r.id) })),
      ...exceptions.map((r) => ({ kind: 'exception' as const, id: String(r.id) })),
    ];
  }

  ruleByIdForOwner(ownerId: string, id: string): ScheduleRuleRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM schedule_rules WHERE id = ? AND discord_user_id = ?')
      .get(id, ownerId);
    return r ? mapRule(r as Record<string, unknown>) : undefined;
  }

  exceptionByIdForOwner(ownerId: string, id: string): ScheduleExceptionRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM schedule_exceptions WHERE id = ? AND discord_user_id = ?')
      .get(id, ownerId);
    return r ? mapException(r as Record<string, unknown>) : undefined;
  }

  /** Owner-scoped in the WHERE clause. A trigger tombstones an imported identity. */
  deleteRule(ownerId: string, id: string): number {
    return Number(
      this.db.prepare('DELETE FROM schedule_rules WHERE id = ? AND discord_user_id = ?').run(id, ownerId).changes,
    );
  }

  deleteException(ownerId: string, id: string): number {
    return Number(
      this.db.prepare('DELETE FROM schedule_exceptions WHERE id = ? AND discord_user_id = ?').run(id, ownerId).changes,
    );
  }
}
