import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { acquireRuntimeLock, createStore, isUpToDate, openDatabase, type Db } from '@ducky/persistence';
import { loadEnv } from '../config.js';
import { buildRollbackDelta, deltaCounts } from '../domain/rollback-delta.service.js';
import type { CliIo, CliOptions } from './import-assistant.js';

/**
 * `pnpm export:rollback-delta` -- the private, offline, READ-ONLY rollback-delta
 * export (ADR 0033).
 *
 * It reads one consistent state and writes ONE file, the delta, which holds the
 * owner's data. So:
 *
 * - the database (or backup), and the output file, must live OUTSIDE the
 *   repository, in a directory that is 0700, and the output is created 0600 and is
 *   never overwritten;
 * - consistency is mechanical, not asserted: either the shared runtime lock is
 *   taken (which it cannot be while a live coordinator holds the database), or the
 *   source is a BACKUP file, opened read-only, that passes SQLite's integrity
 *   check and carries a fully migrated Ducky schema;
 * - the terminal gets counts and rule names only, never a title, an id, a
 *   repository, a preference or a path.
 *
 * An incomplete export (an unknown baseline, a deletion whose cause was not
 * recorded, a table past its read cap) exits 5 and writes NOTHING unless
 * `--allow-incomplete` is given; even then the exit stays 5 and the file says
 * `complete: false`. It never pretends lost history can be reconstructed.
 *
 * Exit codes: 0 complete; 2 refused before reading any data (usage, paths,
 * configuration, schema); 3 the backup was refused; 4 a live process holds the
 * database; 5 incomplete.
 */
const flagOf = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (args: readonly string[], name: string): boolean => args.includes(`--${name}`);

const USAGE =
  'usage: pnpm export:rollback-delta (--db <db> | --from-backup <backup.db>) --out <delta.json> [--allow-incomplete]\n' +
  '  --db needs a stopped coordinator (it takes the shared lock). --from-backup reads a verified backup.\n';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const insideRepo = (repoRoot: string, p: string): boolean => {
  const rel = path.relative(real(repoRoot), real(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const privateFile = (file: string): boolean => (statSync(file).mode & 0o077) === 0;
const privateDir = (dir: string): boolean => existsSync(dir) && (statSync(dir).mode & 0o077) === 0;

export function runExportRollbackDeltaCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  opts: CliOptions & { readonly now?: () => Date } = {},
): number {
  const repoRoot = path.resolve(opts.repoRoot ?? path.resolve(import.meta.dirname, '..', '..', '..', '..'));
  const dbArg = flagOf(args, 'db');
  const backupArg = flagOf(args, 'from-backup');
  const outArg = flagOf(args, 'out');
  const allowIncomplete = has(args, 'allow-incomplete');
  if ((!dbArg === !backupArg) || !outArg) {
    io.err(USAGE);
    return 2;
  }

  const sourcePath = real(path.resolve((dbArg ?? backupArg)!));
  const outPath = path.resolve(real(path.dirname(path.resolve(outArg))), path.basename(outArg));
  for (const p of [sourcePath, outPath]) {
    if (insideRepo(repoRoot, p)) {
      io.err('refused: the database (or backup) and the output must live outside the repository.\n');
      return 2;
    }
  }
  if (!existsSync(sourcePath)) {
    io.err('refused: the database or backup does not exist.\n');
    return 2;
  }
  if (existsSync(outPath)) {
    io.err('refused: the output already exists; an export is never overwritten.\n');
    return 2;
  }
  if (!privateFile(sourcePath) || !privateDir(path.dirname(sourcePath)) || !privateDir(path.dirname(outPath))) {
    io.err('refused: the source must be 0600 and both directories 0700; they hold the owner\'s data.\n');
    return 2;
  }

  let ownerId: string;
  let profile: string;
  try {
    const e = loadEnv(env);
    ownerId = e.OWNER_DISCORD_USER_ID;
    profile = e.DUCKY_PROFILE;
  } catch {
    io.err('refused: configuration is not usable.\n');
    return 2;
  }

  let db: Db | DatabaseSync;
  let release: (() => void) | undefined;
  if (backupArg) {
    // A backup is read through a handle that cannot write.
    try {
      db = new DatabaseSync(sourcePath, { readOnly: true });
      const integrity = (db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)['integrity_check'];
      if (integrity !== 'ok') {
        db.close();
        io.err('refused: the backup is not a usable database.\n');
        return 3;
      }
    } catch {
      io.err('refused: the backup is not a usable database.\n');
      return 3;
    }
    if (!isUpToDate(db as Db)) {
      (db as DatabaseSync).close();
      io.err('refused: the backup has pending migrations; export from a current backup.\n');
      return 3;
    }
  } else {
    db = openDatabase({ location: sourcePath });
    if (!isUpToDate(db)) {
      db.close();
      io.err('refused: the database has pending migrations. Run `pnpm migrate` first.\n');
      return 2;
    }
    const lock = acquireRuntimeLock(db, 'importer');
    if (!lock.ok) {
      db.close();
      io.err(`refused: a live ${lock.heldBy} holds this database. Stop it first.\n`);
      return 4;
    }
    release = () => lock.handle.release();
  }

  try {
    const store = createStore(db as Db);
    const delta = buildRollbackDelta({
      store, ownerId, profile, nowIso: (opts.now?.() ?? new Date()).toISOString(),
    });
    const counts = JSON.stringify(deltaCounts(delta), null, 2);
    if (!delta.complete && !allowIncomplete) {
      io.out(`${counts}\n`);
      io.err('incomplete: nothing was written. Re-run with --allow-incomplete to keep a file that says what is missing.\n');
      return 5;
    }
    writeFileSync(outPath, `${JSON.stringify(delta, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    io.out(`${counts}\n`);
    return delta.complete ? 0 : 5;
  } finally {
    release?.();
    (db as DatabaseSync).close();
  }
}
