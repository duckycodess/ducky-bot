import type { Db } from '../db.js';
import { nowIso } from '../db.js';

/**
 * AUDIT ONLY. Nothing in this table is ever consulted to make an authorization
 * decision -- frozen env config is the single authority. A row here granting
 * `owner` to an arbitrary id confers nothing.
 */
export class AuthorizedUserAuditRepo {
  constructor(private readonly db: Db) {}

  observe(discordUserId: string, role: 'owner' | 'chat'): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO authorized_user_audit (discord_user_id, role, source, first_seen_at, last_seen_at)
         VALUES (?,?,'config',?,?)
         ON CONFLICT(discord_user_id) DO UPDATE SET
           role = excluded.role, last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
      )
      .run(discordUserId, role, ts, ts);
  }

  /** Marks anyone no longer present in config, so the trail shows the change. */
  revokeMissing(currentIds: readonly string[]): number {
    const placeholders = currentIds.map(() => '?').join(',') || "''";
    const res = this.db
      .prepare(
        `UPDATE authorized_user_audit SET revoked_at = ?
         WHERE revoked_at IS NULL AND discord_user_id NOT IN (${placeholders})`,
      )
      .run(nowIso(), ...(currentIds as never[]));
    return Number(res.changes);
  }

  all(): { discordUserId: string; role: string; revokedAt: string | null }[] {
    return this.db
      .prepare('SELECT * FROM authorized_user_audit ORDER BY discord_user_id')
      .all()
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          discordUserId: String(r['discord_user_id']),
          role: String(r['role']),
          revokedAt: r['revoked_at'] == null ? null : String(r['revoked_at']),
        };
      });
  }
}
