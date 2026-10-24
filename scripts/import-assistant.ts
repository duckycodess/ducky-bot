#!/usr/bin/env -S node --experimental-strip-types
/**
 * The explicit, operator-run, offline migration import. See
 * `packages/coordinator/src/cli/import-assistant.ts` and ADR 0030.
 *
 *   pnpm import:assistant --db <db> --file <document.json>            # validate only
 *   pnpm import:assistant --db <db> --file <document.json> --verify   # counts-only comparison
 *   pnpm import:assistant --db <db> --file <document.json> --backup <backup.db> --apply
 *
 * It writes only with --apply, only to an explicit database outside this
 * repository, only against a verified backup, and only while no coordinator
 * holds the database.
 */
import { runImportCli } from '../packages/coordinator/src/cli/import-assistant.js';

process.exit(
  runImportCli(process.argv.slice(2), process.env, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  }),
);
