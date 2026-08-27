import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

export interface OpenDatabaseOptions {
  /** ':memory:' for tests, otherwise a filesystem path. */
  readonly location: string;
}

export function openDatabase({ location }: OpenDatabaseOptions): Db {
  if (location !== ':memory:') mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (location !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}

/**
 * BEGIN IMMEDIATE so a write transaction takes its lock up front rather than
 * failing on upgrade. Every multi-row invariant in this codebase runs in here.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error is the interesting one */
    }
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();
export const isoPlus = (ms: number, from: Date = new Date()): string =>
  new Date(from.getTime() + ms).toISOString();
