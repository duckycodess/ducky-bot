import type { CaptureState } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { CaptureRow } from './types.js';

const map = (r: Record<string, unknown>): CaptureRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  content: String(r['content']),
  status: String(r['status']) as CaptureState,
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
});

export class CapturesRepo {
  constructor(private readonly db: Db) {}

  insert(row: { id: string; discordUserId: string; content: string }): CaptureRow {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at)
         VALUES (?,?,?,'open',?,?)`,
      )
      .run(row.id, row.discordUserId, row.content, ts, ts);
    return { ...row, status: 'open', createdAt: ts, updatedAt: ts };
  }

  get(id: string): CaptureRow | undefined {
    const r = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  listForOwner(ownerId: string, status: CaptureState | 'all', limit: number, offset = 0): CaptureRow[] {
    const sql =
      status === 'all'
        ? 'SELECT * FROM captures WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
        : 'SELECT * FROM captures WHERE discord_user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const args =
      status === 'all' ? [ownerId, limit, offset] : [ownerId, status, limit, offset];
    return this.db
      .prepare(sql)
      .all(...(args as never[]))
      .map((r) => map(r as Record<string, unknown>));
  }

  countForOwner(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM captures WHERE discord_user_id = ?')
      .get(ownerId) as { n: number };
    return Number(r.n);
  }

  setStatus(id: string, status: CaptureState): void {
    this.db
      .prepare('UPDATE captures SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM captures WHERE id = ?').run(id);
  }
}
