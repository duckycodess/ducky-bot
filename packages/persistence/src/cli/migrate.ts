import { openDatabase } from '../db.js';
import { appliedVersions, pendingMigrations, runMigrations } from '../migrate.js';

/**
 * Applies pending migrations, or lists them with `--dry`.
 *
 * Forward-only and transactional: each migration commits on its own, so a
 * failure leaves the schema at the last good version rather than half-applied.
 */
function main(): void {
  const dry = process.argv.includes('--dry');
  const location = process.env['DUCKY_DB_PATH'] ?? './data/ducky.db';
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

main();
