#!/usr/bin/env -S node --experimental-strip-types
/**
 * The private, offline, read-only rollback-delta export. See
 * `packages/coordinator/src/cli/export-rollback-delta.ts` and ADR 0033.
 *
 *   pnpm export:rollback-delta --db <db> --out <delta.json>
 *   pnpm export:rollback-delta --from-backup <backup.db> --out <delta.json>
 *
 * It writes one file, outside this repository, 0600, never over an existing one,
 * and prints counts only. A replay of the delta in a test proves the export is
 * complete and idempotent; it is not a source bridge.
 */
import { runExportRollbackDeltaCli } from '../packages/coordinator/src/cli/export-rollback-delta.js';

process.exit(
  runExportRollbackDeltaCli(process.argv.slice(2), process.env, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  }),
);
