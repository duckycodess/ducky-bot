#!/usr/bin/env -S node --experimental-strip-types
/**
 * Proves a backup file is actually restorable, WITHOUT restoring it.
 *
 * A backup nobody has opened is a hope, not a backup. This opens the copy,
 * checks SQLite's own integrity, confirms the schema is at a migration version
 * the code understands, and counts a few rows so an empty-but-valid file cannot
 * pass as a good one.
 *
 * It never writes to the file, never touches the live database, and never
 * restores anything: restoring is a decision with downtime attached, and the
 * runbook spells it out as an operator step.
 *
 * Exit codes:
 *   0  the file opens, passes integrity, and carries a known schema
 *   2  no such file
 *   3  the file is not a usable Ducky database (the reason is printed)
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// Relative, like every other script here. Importing MIGRATIONS from the source
// is the point: "a schema this build knows" must mean THIS build.
import { MIGRATIONS } from '../packages/persistence/src/migrations.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const file = flag('file');
if (!file) {
  process.stderr.write('usage: pnpm backup:verify --file <path to a backup .db>\n');
  process.exit(2);
}
const target = path.resolve(file);
if (!existsSync(target)) {
  process.stderr.write(`no such file: ${target}\n`);
  process.exit(2);
}

const problems: string[] = [];
const db = new DatabaseSync(target, { readOnly: true });

try {
  const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
  const verdict = String(Object.values(integrity)[0] ?? '');
  if (verdict !== 'ok') problems.push(`integrity_check said: ${verdict}`);

  // A file with no `schema_migrations` at all is the commonest "not a Ducky
  // database": an empty SQLite file, or somebody else's. It must be REPORTED as
  // unusable, not crash the verifier -- a crash and a refusal look the same to a
  // cron job, and only one of them is trustworthy.
  let version = 0;
  try {
    const applied = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
      | { v: number | null }
      | undefined;
    version = Number(applied?.v ?? 0);
  } catch {
    problems.push('there is no schema_migrations table: this is not a Ducky database');
  }
  const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;

  if (version === 0) problems.push('no migrations are recorded: this is not a Ducky database');
  // AHEAD of this build is as much a problem as behind: restoring a database
  // written by a newer schema into an older binary is how a "successful"
  // restore silently loses a column.
  if (version > latest) {
    problems.push(`schema version ${version} is NEWER than this build knows (${latest})`);
  }

  // The engineering slot arrived in migration 28. An older backup legitimately
  // lacks it and migrates forward, so it is required only from that version on:
  // a current-schema file without it is a damaged one, and a backup that
  // silently dropped the slot would restore as "nothing holds engineering".
  const ENGINEERING_ADMISSION_VERSION = 28;
  // Durable pause delivery arrived in migration 29: the expiry ledger, the pause
  // receipts and the job's negotiated-protocol column. A current-schema file
  // without them is a damaged one, and a backup that silently dropped them would
  // restore a deferred expiry as an ordinary, already-charged one (or lose the
  // receipt that makes a replayed report idempotent).
  const PAUSE_DELIVERY_VERSION = 29;
  // Shared engineering admission arrived in migration 30: the exact shared fence
  // on the local slot, the pinned ledger identity and the release outbox. A
  // current-schema file without them is a damaged one. Losing the outbox would
  // restore a database that forgot a shared hold it still owed to the ledger, and
  // losing the pin would let a restore adopt whatever ledger it finds.
  const SHARED_ADMISSION_VERSION = 30;
  const tables = ['jobs', 'repos', 'tasks', 'reminders', 'schedules', 'captures'];
  if (version >= ENGINEERING_ADMISSION_VERSION) tables.push('engineering_admission');
  if (version >= PAUSE_DELIVERY_VERSION) tables.push('job_lease_expiries', 'job_pause_receipts');
  if (version >= SHARED_ADMISSION_VERSION) tables.push('shared_admission_binding', 'shared_release_outbox');
  const counts = tables.map((table) => {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return `${table}=${Number(row.n)}`;
    } catch {
      problems.push(`table ${table} is missing`);
      return `${table}=?`;
    }
  });

  if (version >= PAUSE_DELIVERY_VERSION) {
    try {
      const cols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('delivery_protocol')) problems.push('column jobs.delivery_protocol is missing');
    } catch {
      problems.push('column jobs.delivery_protocol could not be checked');
    }
  }

  if (version >= SHARED_ADMISSION_VERSION) {
    try {
      const cols = (db.prepare('PRAGMA table_info(engineering_admission)').all() as { name: string }[]).map((c) => c.name);
      for (const col of ['shared_ledger_id', 'shared_fence']) {
        if (!cols.includes(col)) problems.push(`column engineering_admission.${col} is missing`);
      }
    } catch {
      problems.push('columns of engineering_admission could not be checked');
    }
  }

  process.stdout.write(`file:      ${target}\n`);
  process.stdout.write(`integrity: ${verdict}\n`);
  process.stdout.write(`schema:    ${version} (this build: ${latest})\n`);
  process.stdout.write(`rows:      ${counts.join(' ')}\n`);
  if (version < latest) {
    // Not a problem: an older backup migrates forward on the next boot. Said
    // out loud so nobody reads the number as a failure.
    process.stdout.write(
      `note:      ${latest - version} migration(s) would be applied on restore, which is normal ` +
        'for an older backup.\n',
    );
  }
} finally {
  db.close();
}

if (problems.length > 0) {
  process.stderr.write(`\nNOT a usable backup:\n${problems.map((p) => `  * ${p}`).join('\n')}\n`);
  process.exit(3);
}
process.stdout.write('\nverified: this file opens, passes integrity, and carries a known schema.\n');
