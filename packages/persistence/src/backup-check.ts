import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';

/** Tables whose contents change by themselves and say nothing about the data. */
const VOLATILE = new Set(['runtime_lock', 'assistant_watch_calls']);

export interface BackupComparison {
  readonly ok: boolean;
  /** `integrity_check` said something other than "ok", or the file is not a database. */
  readonly integrity: 'ok' | 'failed';
  /** Names of TABLES whose contents differ or that the backup lacks. Schema names only. */
  readonly mismatched: readonly string[];
}

/** One value, with its storage type, so `1`, `'1'` and `1.0` are three different things. */
const encode = (v: unknown): string => {
  if (v === null || v === undefined) return 'n:';
  if (typeof v === 'bigint') return `i:${v.toString()}`;
  if (typeof v === 'number') return Number.isInteger(v) ? `i:${v}` : `r:${v}`;
  if (typeof v === 'string') return `t:${v}`;
  if (v instanceof Uint8Array) return `b:${Buffer.from(v).toString('hex')}`;
  return `x:${String(v)}`;
};

/**
 * A digest of a table's CONTENT, independent of row order.
 *
 * Every row is hashed over its columns (in name order, each with its storage
 * type), the row hashes are sorted, and the sorted list is hashed. Two tables
 * with the same number of rows but one updated cell therefore differ, which a
 * row count cannot see. The digest exists only to be compared: it is never
 * stored, logged or printed, because a digest of the owner's data is itself
 * something about the owner's data.
 */
function tableDigest(db: Db | DatabaseSync, name: string): string {
  // Table names come from the live schema, never from input.
  const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
  const hashes = rows.map((r) => {
    const h = createHash('sha256');
    for (const col of Object.keys(r).sort()) h.update(`${col}\u0000${encode(r[col])}\u0001`);
    return h.digest('hex');
  });
  hashes.sort();
  const all = createHash('sha256');
  all.update(`${hashes.length}\u0002`);
  for (const h of hashes) all.update(h);
  return all.digest('hex');
}

/**
 * Whether a backup file really is a copy of THIS database, as it stands.
 *
 * "I took a backup" is not evidence, and a backup of some other database, of this
 * one a week ago, or of this one with a single record edited since is not a
 * rollback point for an import about to write. The test is mechanical: the file
 * opens, passes SQLite's own integrity check, and every table has the same
 * CONTENT as the live one right now.
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
      let theirs: string | undefined;
      try {
        theirs = tableDigest(backup, name);
      } catch {
        theirs = undefined;
      }
      if (theirs === undefined || theirs !== tableDigest(live, name)) mismatched.push(name);
    }
    return { ok: mismatched.length === 0, integrity: 'ok', mismatched };
  } finally {
    backup.close();
  }
}
