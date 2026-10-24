import type { Db } from './db.js';
import { nowIso, withTransaction } from './db.js';
import { MIGRATIONS, type Migration } from './migrations.js';

const ensureTable = (db: Db): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
};

export function appliedVersions(db: Db): number[] {
  ensureTable(db);
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((r) => Number((r as { version: number }).version));
}

export function pendingMigrations(db: Db): readonly Migration[] {
  const applied = new Set(appliedVersions(db));
  return MIGRATIONS.filter((m) => !applied.has(m.version));
}

/** Forward-only. Each migration is its own transaction. */
export function runMigrations(db: Db, opts: { readonly upTo?: number; readonly now?: () => string } = {}): number[] {
  ensureTable(db);
  const done: number[] = [];
  // A database is FRESH when nothing had been applied before this run began; it has no
  // history a later migration has to account for. Only the run itself can know that.
  const fresh = appliedVersions(db).length === 0;
  const clock = opts.now ?? nowIso;
  for (const m of pendingMigrations(db)) {
    if (opts.upTo !== undefined && m.version > opts.upTo) break;
    withTransaction(db, () => {
      db.exec(m.sql);
      const at = clock();
      m.after?.(db, { fresh, at });
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        at,
      );
    });
    done.push(m.version);
  }
  return done;
}

export const isUpToDate = (db: Db): boolean => pendingMigrations(db).length === 0;
