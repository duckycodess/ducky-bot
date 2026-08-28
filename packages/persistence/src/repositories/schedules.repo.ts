import type { ScheduleEntry } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';

export interface ScheduleRow extends ScheduleEntry {
  id: string;
  discordUserId: string;
  sourceKind: 'text' | 'file';
  confirmedAt: string;
}

const mapRow = (r: Record<string, unknown>): ScheduleRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  title: String(r['title']),
  startsAt: String(r['starts_at']),
  endsAt: r['ends_at'] == null ? null : String(r['ends_at']),
  location: r['location'] == null ? null : String(r['location']),
  notes: r['notes'] == null ? null : String(r['notes']),
  sourceKind: String(r['source_kind']) as 'text' | 'file',
  confirmedAt: String(r['confirmed_at']),
});

export class SchedulesRepo {
  constructor(private readonly db: Db) {}

  /**
   * Called only from inside the confirmation transaction. Nothing about a
   * schedule reaches any table before the owner confirms.
   */
  insertMany(
    ownerId: string,
    entries: readonly ScheduleEntry[],
    sourceKind: 'text' | 'file',
    ids: readonly string[],
  ): number {
    const ts = nowIso();
    const stmt = this.db.prepare(
      `INSERT INTO schedules (id, discord_user_id, title, starts_at, ends_at, location, notes,
         source_kind, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    entries.forEach((e, i) => {
      stmt.run(ids[i]!, ownerId, e.title, e.startsAt, e.endsAt, e.location, e.notes, sourceKind, ts, ts);
    });
    return entries.length;
  }

  listForOwner(ownerId: string, limit = 25): ScheduleRow[] {
    return this.db
      .prepare('SELECT * FROM schedules WHERE discord_user_id = ? ORDER BY starts_at LIMIT ?')
      .all(ownerId, limit)
      .map((raw) => mapRow(raw as Record<string, unknown>));
  }

  /**
   * Schedule entries whose stored DATE falls in `[startDate, endDateExclusive)`.
   *
   * Both bounds are `YYYY-MM-DD` strings in the owner's own zone, and the
   * comparison is against the first ten characters of `starts_at`, because
   * that column holds the wall-clock text the owner typed rather than a UTC
   * instant. Matching on the date prefix therefore needs no conversion, cannot
   * be thrown off by a timezone change, and never rewrites a stored row.
   */
  listForOwnerBetweenDates(
    ownerId: string,
    startDate: string,
    endDateExclusive: string,
    limit = 25,
  ): ScheduleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM schedules
          WHERE discord_user_id = ?
            AND substr(starts_at, 1, 10) >= ?
            AND substr(starts_at, 1, 10) < ?
          ORDER BY starts_at ASC LIMIT ?`,
      )
      .all(ownerId, startDate, endDateExclusive, limit)
      .map((raw) => mapRow(raw as Record<string, unknown>));
  }

  /**
   * One row, owner-scoped.
   *
   * Owner-scoped in the WHERE clause rather than checked afterwards: the only
   * caller is the owner's own deletion path, and a lookup that could return
   * somebody else's row would be the wrong shape to hand it.
   */
  byIdForOwner(ownerId: string, id: string): ScheduleRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM schedules WHERE id = ? AND discord_user_id = ?')
      .get(id, ownerId);
    return r ? mapRow(r as Record<string, unknown>) : undefined;
  }

  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as { n: number };
    return Number(r.n);
  }
}
