import { fileURLToPath } from 'node:url';
import { blankToUndefined, resolveDuckyProfile, PROFILE_DEFAULT_DB_PATH } from '@ducky/contracts';
import { openDatabase } from '../db.js';
import { appliedVersions, pendingMigrations, runMigrations } from '../migrate.js';

/**
 * DUCKY_DB_PATH always wins when set (and non-blank); otherwise the target is
 * the SELECTED profile's own default -- this must match what the coordinator
 * itself opens at startup, or `--dry` can report a profile's database as
 * up to date while the coordinator is actually reading a different file.
 */
export function resolveMigrateDbPath(env: NodeJS.ProcessEnv): string {
  const profile = resolveDuckyProfile(env['DUCKY_PROFILE']);
  return blankToUndefined(env['DUCKY_DB_PATH']) ?? PROFILE_DEFAULT_DB_PATH[profile];
}

/**
 * Applies pending migrations, or lists them with `--dry`.
 *
 * Forward-only and transactional: each migration commits on its own, so a
 * failure leaves the schema at the last good version rather than half-applied.
 */
function main(): void {
  const dry = process.argv.includes('--dry');
  const location = resolveMigrateDbPath(process.env);
  const db = openDatabase({ location });

  try {
    const pending = pendingMigrations(db);
    if (dry) {
      process.stdout.write(
        pending.length === 0
          ? `${location}: schema is up to date (${appliedVersions(db).length} applied)\n`
          : `${location}: ${pending.length} pending\n${pending
              .map((m) => `  ${String(m.version).padStart(4, '0')} ${m.name}`)
              .join('\n')}\n`,
      );
      return;
    }

    const applied = runMigrations(db);
    process.stdout.write(
      applied.length === 0
        ? `${location}: already up to date\n`
        : `${location}: applied ${applied.length} migration(s): ${applied.join(', ')}\n`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
