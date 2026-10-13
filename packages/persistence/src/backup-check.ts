import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';

/** Tables whose contents change by themselves and say nothing about the data. */
const VOLATILE = new Set(['runtime_lock', 'assistant_watch_calls', 'schema_migrations']);

export interface BackupComparison {
  readonly ok: boolean;
  /** `integrity_check` said something other than "ok", or the file is not a database. */
  readonly integrity: 'ok' | 'failed';
  /** Names of TABLES whose row counts differ or that the backup lacks. Schema names only. */
  readonly mismatched: readonly string[];
}

/**
 * Whether a backup file really is a copy of THIS database, as it stands.
 *
 * "I took a backup" is not evidence, and a backup of some other database, or of
 * this one a week ago, is not a rollback point for an import about to write. The
 * test is mechanical: the file opens, passes SQLite's own integrity check, and
 * every table has the same number of rows as the live one right now.
 *
 * It reads both files and writes neither, and reports table NAMES and nothing
 * about their contents.
 */
export function compareBackupToLive(live: Db, backupPath: string): BackupComparison {
  let backup: DatabaseSync;
  try {
    backup = new DatabaseSync(backupPath, { readOnly: true });
  } catch {
    return { ok: false, integrity: 'failed', mismatched: [] };
  }
  try {
    let verdict = 'failed';
    try {
      const row = backup.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
      verdict = String(Object.values(row)[0] ?? '');
    } catch {
      verdict = 'failed';
    }
    if (verdict !== 'ok') return { ok: false, integrity: 'failed', mismatched: [] };

    const tables = (live.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[]).map((r) => r.name).filter((n) => !VOLATILE.has(n));

    const mismatched: string[] = [];
    for (const name of tables) {
      // Table names come from the live schema, never from input.
      const q = `SELECT COUNT(*) AS n FROM "${name}"`;
      let theirs: number | undefined;
      try {
        theirs = Number((backup.prepare(q).get() as { n: number }).n);
      } catch {
        theirs = undefined;
      }
      const ours = Number((live.prepare(q).get() as { n: number }).n);
      if (theirs === undefined || theirs !== ours) mismatched.push(name);
    }
    return { ok: mismatched.length === 0, integrity: 'ok', mismatched };
  } finally {
    backup.close();
  }
}
