import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore, openDatabase, runMigrations } from '../src/index.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

/**
 * The backup and verify scripts, exercised end to end.
 *
 * A backup nobody has restored is a hope. These run the real scripts against a
 * real (temporary) database, on the live SQLite backup API, and then assert the
 * verifier can tell a good copy from a bad one — because a verifier that passes
 * everything is worth nothing.
 */
const run = (script: string, args: string[]): { code: number; out: string } => {
  try {
    const out = execFileSync(TSX, [path.join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

function seededDb(dir: string): string {
  const dbPath = path.join(dir, 'source.db');
  const db = openDatabase({ location: dbPath });
  runMigrations(db);
  const store = createStore(db);
  store.repos.upsert({
    slug: 'demo', localPath: '/tmp/demo', allowJobs: true, defaultBranch: 'main',
    githubOwner: null, githubRepo: null, allowWorktree: true, allowBootstrap: false,
    bootstrapAllowedEntries: ['.git'], enabled: true,
  });
  store.captures.insert({ id: 'cap-1', discordUserId: 'owner', content: 'a private note' });
  db.close();
  return dbPath;
}

describe('backup and verify', () => {
  it('copies a live database and the copy verifies', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const dbPath = seededDb(dir);
    const outDir = path.join(dir, 'backups');

    const backup = run('backup-db.ts', ['--db', dbPath, '--out', outDir]);
    expect(backup.code, backup.out).toBe(0);

    const files = readdirSync(outDir).filter((f) => f.endsWith('.db'));
    expect(files).toHaveLength(1);
    const copy = path.join(outDir, files[0]!);

    // The owner's personal data: a world-readable copy would undo the live
    // file's own permissions.
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    // And the trust root is not in it.
    expect(backup.out).toMatch(/credential file is NOT included/);

    const verified = run('verify-backup.ts', ['--file', copy]);
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toMatch(/integrity: ok/);
    expect(verified.out).toMatch(/captures=1/);
    // The engineering slot is part of what a current-schema backup must carry.
    expect(verified.out).toMatch(/engineering_admission=0/);
    // ...and so is the durable pause delivery ledger (schema 29).
    expect(verified.out).toMatch(/job_lease_expiries=0/);
    expect(verified.out).toMatch(/job_pause_receipts=0/);
    // ...and the shared admission pin and release outbox (schema 30).
    expect(verified.out).toMatch(/shared_admission_binding=0/);
    expect(verified.out).toMatch(/shared_release_outbox=0/);
  });

  for (const table of ['shared_admission_binding', 'shared_release_outbox']) {
    it(`refuses a current-schema copy that lost ${table}`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
      const dbPath = seededDb(dir);
      const db = openDatabase({ location: dbPath });
      db.exec(`DROP TABLE ${table}`);
      db.close();

      const verified = run('verify-backup.ts', ['--file', dbPath]);
      expect(verified.code).toBe(3);
      expect(verified.out).toMatch(new RegExp(`table ${table} is missing`));
    });
  }

  for (const column of ['shared_fence', 'shared_ledger_id']) {
    it(`refuses a current-schema copy whose slot lost ${column}`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
      const dbPath = seededDb(dir);
      const db = openDatabase({ location: dbPath });
      db.exec(`ALTER TABLE engineering_admission DROP COLUMN ${column}`);
      db.close();

      const verified = run('verify-backup.ts', ['--file', dbPath]);
      expect(verified.code).toBe(3);
      expect(verified.out).toMatch(new RegExp(`column engineering_admission\\.${column} is missing`));
    });
  }

  for (const table of ['job_lease_expiries', 'job_pause_receipts']) {
    it(`refuses a current-schema copy that lost ${table}`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
      const dbPath = seededDb(dir);
      const db = openDatabase({ location: dbPath });
      db.exec(`DROP TABLE ${table}`);
      db.close();

      const verified = run('verify-backup.ts', ['--file', dbPath]);
      expect(verified.code).toBe(3);
      expect(verified.out).toMatch(new RegExp(`table ${table} is missing`));
    });
  }

  it('refuses a current-schema copy whose jobs lost the negotiated-protocol column', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const dbPath = seededDb(dir);
    const db = openDatabase({ location: dbPath });
    db.exec('ALTER TABLE jobs RENAME COLUMN delivery_protocol TO delivery_protocol_lost');
    db.close();

    const verified = run('verify-backup.ts', ['--file', dbPath]);
    expect(verified.code).toBe(3);
    expect(verified.out).toMatch(/column jobs\.delivery_protocol is missing/);
  });

  it('refuses a current-schema copy that lost the engineering slot', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const dbPath = seededDb(dir);
    const db = openDatabase({ location: dbPath });
    db.exec('DROP TABLE engineering_admission');
    db.close();

    const verified = run('verify-backup.ts', ['--file', dbPath]);
    expect(verified.code).toBe(3);
    expect(verified.out).toMatch(/table engineering_admission is missing/);
  });

  it('refuses a file that is not a Ducky database, rather than passing everything', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const empty = path.join(dir, 'empty.db');
    openDatabase({ location: empty }).close();

    const verified = run('verify-backup.ts', ['--file', empty]);

    expect(verified.code).toBe(3);
    expect(verified.out).toMatch(/not a usable backup/i);
  });

  it('refuses a corrupt file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const junk = path.join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database');

    const verified = run('verify-backup.ts', ['--file', junk]);

    expect(verified.code).not.toBe(0);
  });

  it('says nothing to back up rather than writing an empty file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const missing = run('backup-db.ts', ['--db', path.join(dir, 'absent.db'), '--out', dir]);

    expect(missing.code).toBe(2);
    expect(readdirSync(dir).filter((f) => f.endsWith('.db'))).toHaveLength(0);
  });

  it('reports prunable copies and deletes nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-backup-'));
    const dbPath = seededDb(dir);
    const outDir = path.join(dir, 'backups');

    run('backup-db.ts', ['--db', dbPath, '--out', outDir]);
    run('backup-db.ts', ['--db', dbPath, '--out', outDir]);
    const third = run('backup-db.ts', ['--db', dbPath, '--out', outDir, '--keep', '1']);

    // Unattended rotation is how the only good copy disappears.
    expect(third.out).toMatch(/Nothing was deleted/);
    expect(readdirSync(outDir).filter((f) => f.endsWith('.db')).length).toBeGreaterThanOrEqual(2);
  });
});
