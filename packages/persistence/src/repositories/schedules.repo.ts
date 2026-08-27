import type { ScheduleEntry } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';

export interface ScheduleRow extends ScheduleEntry {
  id: string;
  discordUserId: string;
  sourceKind: 'text' | 'file';
  confirmedAt: string;
}

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
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          id: String(r['id']),
          discordUserId: String(r['discord_user_id']),
          title: String(r['title']),
          startsAt: String(r['starts_at']),
          endsAt: r['ends_at'] == null ? null : String(r['ends_at']),
          location: r['location'] == null ? null : String(r['location']),
          notes: r['notes'] == null ? null : String(r['notes']),
          sourceKind: String(r['source_kind']) as 'text' | 'file',
          confirmedAt: String(r['confirmed_at']),
        };
      });
  }

  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as { n: number };
    return Number(r.n);
  }
}
