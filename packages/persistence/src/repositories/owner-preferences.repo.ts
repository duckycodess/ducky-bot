import type { Db } from '../db.js';

export interface OwnerPreferencesRow {
  readonly discordUserId: string;
  /** Parsed by the service against the contract; the repository stores text. */
  readonly prefsJson: string;
  readonly source: string;
  readonly importedAt: string;
  readonly updatedAt: string;
}

/**
 * Non-authoritative owner preferences.
 *
 * Nothing in the codebase reads this table to decide whether somebody may do
 * something: authorization reads frozen configuration only. It holds
 * presentation and scheduling choices, applied only when the profile selects
 * them.
 */
export class OwnerPreferencesRepo {
  constructor(private readonly db: Db) {}

  get(ownerId: string): OwnerPreferencesRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM owner_preferences WHERE discord_user_id = ?')
      .get(ownerId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      discordUserId: String(r['discord_user_id']),
      prefsJson: String(r['prefs_json']),
      source: String(r['source']),
      importedAt: String(r['imported_at']),
      updatedAt: String(r['updated_at']),
    };
  }

  /** Imports only: never overwrites, because the ledger decides whether to call it. */
  insert(row: { ownerId: string; prefsJson: string; source: string; at: string }): void {
    this.db
      .prepare(
        `INSERT INTO owner_preferences (discord_user_id, prefs_json, source, imported_at, updated_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(row.ownerId, row.prefsJson, row.source, row.at, row.at);
  }
}
