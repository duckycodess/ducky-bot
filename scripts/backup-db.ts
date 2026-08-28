#!/usr/bin/env -S node --experimental-strip-types
/**
 * Takes a consistent backup of one profile's SQLite database, WITHOUT stopping
 * the coordinator.
 *
 * `node:sqlite` exposes the SQLite online backup API, which copies pages under a
 * read lock and retries the ones that change underneath it. That matters more
 * here than it looks: the database runs in WAL mode, so `cp` of the `.db` file
 * alone can miss committed transactions that still live in the `-wal`, and a
 * "backup" that quietly drops the last hour of work is worse than none.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - **It never touches the credential file.** That file is the trust root, and
 *   a backup that carried it would put a bearer token wherever the backup goes.
 *   Back it up separately, deliberately, somewhere else. `docs/DEPLOYMENT.md`
 *   and the runbook both say so.
 * - **It never uploads anything.** The destination is a local path. Sending a
 *   database off this host is a decision with its own consequences and is not
 *   one a script makes on somebody's behalf.
 * - **It never deletes an older backup.** Rotation that runs unattended is how
 *   the only good copy disappears. `--keep` REPORTS what is prunable; removing
 *   it is the operator's own command.
 *
 * Usage:
 *   pnpm backup                       # development profile, ./data/backups
 *   pnpm backup --profile production  # production profile
 *   pnpm backup --out /var/backups/ducky
 *   pnpm backup --keep 7              # report which files are beyond the last 7
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
// Relative, like every other script here: the repository root has no dependency
// on the workspace packages, so a bare specifier would not resolve.
import { PROFILE_DEFAULT_DB_PATH, resolveDuckyProfile } from '../packages/contracts/src/index.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const profile = resolveDuckyProfile(flag('profile') ?? process.env['DUCKY_PROFILE']);
const dbPath = path.resolve(
  flag('db') ?? process.env['DUCKY_DB_PATH'] ?? PROFILE_DEFAULT_DB_PATH[profile],
);
const outDir = path.resolve(flag('out') ?? './data/backups');
const keep = Number(flag('keep') ?? '0');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, `ducky-${profile}-${stamp}.db`);

async function main(): Promise<void> {
  if (!existsSync(dbPath)) {
    process.stderr.write(`no database at ${dbPath}; nothing to back up.\n`);
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  // Opened read-only in spirit: the backup API only reads the source, and this
  // process never writes to it. A live coordinator keeps running throughout.
  const source = new DatabaseSync(dbPath);
  try {
    let lastRemaining = -1;
    await backup(source, target, {
      rate: 100,
      progress: ({ totalPages, remainingPages }) => {
        // Reported, not just spun on: a backup that appears to hang on a busy
        // database is the moment somebody kills it half-written.
        if (remainingPages !== lastRemaining) {
          lastRemaining = remainingPages;
          process.stdout.write(`\rcopying: ${totalPages - remainingPages}/${totalPages} pages`);
        }
      },
    });
    process.stdout.write('\n');
  } finally {
    source.close();
  }

  // The database holds the owner's personal data. A world-readable backup of it
  // would undo the 0600 the live file is given.
  chmodSync(target, 0o600);

  const size = statSync(target).size;
  process.stdout.write(`backup written: ${target} (${(size / 1024).toFixed(0)} KiB, mode 0600)\n`);
  process.stdout.write(
    'The executor credential file is NOT included. Back it up separately, and never into the\n' +
      'same artifact: it is the trust root.\n',
  );

  process.stdout.write(`verify it with: pnpm backup:verify --file ${target}\n`);

  if (keep > 0) {
    const existing = readdirSync(outDir)
      .filter((f) => f.startsWith(`ducky-${profile}-`) && f.endsWith('.db'))
      .sort()
      .reverse();
    const prunable = existing.slice(keep);
    if (prunable.length > 0) {
      // REPORTED, never removed. Unattended rotation is how the only good copy
      // disappears, and this script has no way to know which copy that is.
      process.stdout.write(
        `\nbeyond the last ${keep}, and prunable BY YOU:\n` +
          prunable.map((f) => `  ${path.join(outDir, f)}`).join('\n') +
          '\nNothing was deleted.\n',
      );
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`backup failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
