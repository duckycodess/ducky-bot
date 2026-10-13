import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DuckyError } from '@ducky/contracts';
import {
  acquireRuntimeLock, compareBackupToLive, createStore, isUpToDate, openDatabase, type Db,
} from '@ducky/persistence';
import {
  loadEnv, resolveBriefingSchedule, resolveImportedPreferences, resolveOwnerTimeZone, resolveWeather,
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
 * Exit codes: 0 passed; 2 refused before reading anything of the data (usage,
 * paths, configuration, schema); 3 the document or the backup was refused; 4 a
 * live process holds the database.
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
  '  default: validate only (a dry run). --apply needs --backup and a stopped coordinator.\n';

function insideRepo(repoRoot: string, p: string): boolean {
  const rel = path.relative(repoRoot, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
  const dbPath = path.resolve(dbArg);
  const filePath = path.resolve(fileArg);
  const backupPath = backupArg ? path.resolve(backupArg) : undefined;
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
  const fileMode = statSync(filePath).mode & 0o777;
  const dirMode = statSync(path.dirname(filePath)).mode & 0o777;
  if ((fileMode & 0o077) !== 0 || (dirMode & 0o077) !== 0) {
    io.err('refused: the document must be mode 0600 in a directory that is mode 0700.\n');
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
      watchCapabilities: new UnavailableAssistantWatchReader().capabilities,
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
      const report = svc.verify(doc);
      print(report);
      return report.ok ? 0 : 3;
    }
    if (!apply) {
      const report = svc.run(doc, { apply: false });
      print(report);
      return report.ok ? 0 : 3;
    }

    // ---- apply ----
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
    const lock = acquireRuntimeLock(db, 'importer');
    if (!lock.ok) {
      io.err(`refused: a live ${lock.heldBy} holds this database. Stop it first.\n`);
      return 4;
    }
    try {
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
