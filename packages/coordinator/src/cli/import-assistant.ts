import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { GhWatchReader } from '@ducky/adapters';
import { DuckyError } from '@ducky/contracts';
import {
  acquireRuntimeLock, compareBackupToLive, createStore, isUpToDate, openDatabase, type Db,
} from '@ducky/persistence';
import {
  loadEnv, resolveBriefingSchedule, resolveImportedPreferences, resolveOwnerTimeZone, resolveWatchConfig, resolveWeather,
} from '../config.js';
import {
  AssistantImportService, type ImportEnvironment,
} from '../domain/assistant-import.service.js';
import { UnavailableAssistantWatchReader } from '../domain/assistant-watch.reader.js';

/**
 * `pnpm import:assistant` -- the explicit, operator-run, offline import.
 *
 * It is a CLI beside `backup-db.ts` and nothing else: no Discord command, no
 * phone route, no transport. By default it only VALIDATES (a dry run of the very
 * same code that applies). `--verify` compares a document with what is stored.
 * `--apply` writes, and refuses unless ALL of these hold:
 *
 * - the document, the database and the backup are all OUTSIDE the repository, so
 *   private data cannot be committed by accident;
 * - the document is 0600 in a 0700 directory;
 * - the backup passes SQLite's integrity check and has the same row count in
 *   every table as the live database right now (a mechanical check, not a flag);
 * - the shared runtime lock can be taken, which it cannot while a live
 *   coordinator holds the database;
 * - every rule of the importer passes, in one transaction.
 *
 * What it prints is counts and rule names. It never prints a title, an id, a
 * repository, a preference or a path.
 *
 * Exit codes: 0 passed (for `--verify`: nothing missing, nothing changed at the source, nothing
 * drifted, and the native ledger clear); 2 refused before reading anything of the data (usage,
 * paths, configuration, schema); 3 the document or the backup was refused (for `--verify`: a record
 * missing or changed at the source); 4 a live process holds the database; 5 `--verify` found the
 * data present but NOT at parity: a record drifted since the import, or the native ledger is not
 * clear (a withheld event, a held native card, a cursor at or before the ledger cutoff, or an
 * unreadable boundary). Counts only, never a repository.
 */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface CliOptions {
  /** The repository root, so a path inside it is refused. Defaults to this checkout. */
  readonly repoRoot?: string;
  /** Replaces the typed reader's capabilities, for tests only. */
  readonly importEnvironment?: (base: ImportEnvironment) => ImportEnvironment;
}

const flagOf = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (args: readonly string[], name: string): boolean => args.includes(`--${name}`);

const USAGE =
  'usage: pnpm import:assistant --db <db> --file <document.json> [--backup <backup.db>] [--verify | --apply]\n' +
  '  default: validate only (a dry run). --apply needs --backup and a stopped coordinator.\n' +
  '  --verify exits 0 only at parity; 3 when a record is missing or changed at the source; 5 when it is\n' +
  '  present but NOT at parity (drift, or the native ledger is not clear).\n';

/** The path as the filesystem sees it, with every symlink followed. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function insideRepo(repoRoot: string, p: string): boolean {
  const rel = path.relative(real(repoRoot), real(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Whether a file and the directory holding it are private: 0600 and 0700 or tighter. */
function isPrivate(file: string): boolean {
  const fileMode = statSync(file).mode & 0o777;
  const dirMode = statSync(path.dirname(file)).mode & 0o777;
  return (fileMode & 0o077) === 0 && (dirMode & 0o077) === 0;
}

export function runImportCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  opts: CliOptions = {},
): number {
  const repoRoot = path.resolve(opts.repoRoot ?? path.resolve(import.meta.dirname, '..', '..', '..', '..'));
  const dbArg = flagOf(args, 'db');
  const fileArg = flagOf(args, 'file');
  const backupArg = flagOf(args, 'backup');
  const apply = has(args, 'apply');
  const verify = has(args, 'verify');
  if (!dbArg || !fileArg || (apply && verify)) {
    io.err(USAGE);
    return 2;
  }

  // ---- paths: explicit, private, outside the repository --------------------------
  // Every path is resolved through the filesystem first, so a symlink that points
  // into this checkout is judged by where it lands, not by what it is called.
  const dbPath = real(path.resolve(dbArg));
  const filePath = real(path.resolve(fileArg));
  const backupPath = backupArg ? real(path.resolve(backupArg)) : undefined;
  for (const p of [dbPath, filePath, ...(backupPath ? [backupPath] : [])]) {
    if (insideRepo(repoRoot, p)) {
      io.err('refused: the database, the document and the backup must all live outside the repository.\n');
      return 2;
    }
  }
  if (!existsSync(filePath) || !existsSync(dbPath)) {
    io.err('refused: the document or the database does not exist.\n');
    return 2;
  }
  // The document, the database and the backup all hold the owner's data, so each
  // must be 0600 in a directory that is 0700.
  const private_ = [filePath, dbPath, ...(backupPath && existsSync(backupPath) ? [backupPath] : [])];
  if (!private_.every(isPrivate)) {
    io.err('refused: the document, the database and the backup must each be mode 0600 in a directory that is mode 0700.\n');
    return 2;
  }

  // ---- configuration: frozen, compared, never written ------------------------------
  let base: ImportEnvironment;
  try {
    const e = loadEnv(env);
    const schedule = resolveBriefingSchedule(e);
    base = {
      profile: e.DUCKY_PROFILE,
      ownerId: e.OWNER_DISCORD_USER_ID,
      timeZone: resolveOwnerTimeZone(e),
      importedPreferencesSelected: resolveImportedPreferences(e),
      briefing: {
        enabled: schedule.enabled, morningAt: schedule.morningAt, eveningAt: schedule.eveningAt,
        morningExplicit: schedule.morningExplicit, eveningExplicit: schedule.eveningExplicit,
        delivery: schedule.delivery,
      },
      weatherConfigured: resolveWeather(e) !== undefined,
      watchCapabilities: resolveWatchConfig(e).readerEnabled
        ? new GhWatchReader({ discovery: resolveWatchConfig(e).discovery }).capabilities
        : new UnavailableAssistantWatchReader().capabilities,
    };
  } catch (err) {
    io.err(`refused: configuration is not usable (${err instanceof DuckyError ? err.code : 'invalid'}).\n`);
    return 2;
  }
  const importEnv = opts.importEnvironment ? opts.importEnvironment(base) : base;

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    io.err('refused: the document is not valid JSON.\n');
    return 3;
  }

  const db: Db = openDatabase({ location: dbPath });
  try {
    if (!isUpToDate(db)) {
      io.err('refused: the database has pending migrations. Run `pnpm migrate` first.\n');
      return 2;
    }
    const store = createStore(db);
    const svc = new AssistantImportService({ store, env: importEnv });
    const print = (report: unknown): void => io.out(`${JSON.stringify(report, null, 2)}\n`);

    if (verify) {
      // Read only, and reads nothing the coordinator cannot be writing safely.
      const report = svc.verify(doc);
      print(report);
      // Present but not at parity is its own code: a gate that exits 0 on a withheld event or a
      // drifted record would be read as a pass (ADR 0034).
      return !report.ok ? 3 : report.parity ? 0 : 5;
    }

    // A dry run and an apply both take the shared lock first. A dry run against a
    // database a live coordinator is writing would answer for a state that is
    // already gone; and an apply must hold the lock before it compares the backup,
    // so nothing can change between the comparison and the write.
    const lock = acquireRuntimeLock(db, 'importer');
    if (!lock.ok) {
      io.err(`refused: a live ${lock.heldBy} holds this database. Stop it first.\n`);
      return 4;
    }
    try {
      if (!apply) {
        const report = svc.run(doc, { apply: false, lock: lock.handle });
        print(report);
        return report.ok ? 0 : 3;
      }
      if (!backupPath) {
        io.err('refused: --apply needs --backup, a copy of this database taken just now.\n');
        return 3;
      }
      const cmp = compareBackupToLive(db, backupPath);
      if (!cmp.ok) {
        io.err(
          cmp.integrity === 'failed'
            ? 'refused: the backup is not a usable database.\n'
            : `refused: the backup is not a copy of this database as it stands (differs in ${cmp.mismatched.length} table(s)).\n`,
        );
        return 3;
      }
      const report = svc.run(doc, { apply: true, lock: lock.handle });
      print(report);
      return report.ok ? 0 : 3;
    } finally {
      lock.handle.release();
    }
  } finally {
    db.close();
  }
}
