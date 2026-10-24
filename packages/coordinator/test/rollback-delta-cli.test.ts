import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRuntimeLock, createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { runExportRollbackDeltaCli } from '../src/cli/export-rollback-delta.js';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { OWNER, secret } from './helpers.js';
import { MANILA, importDoc, importEnv, takeLock } from './assistant-import-fixture.js';

/** The export CLI end to end, against real files outside the repository. Invented data only. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DUCKY_PROFILE: 'development',
  OWNER_DISCORD_USER_ID: OWNER,
  CHAT_WHITELIST_USER_IDS: '100000000000000002',
  DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
  DUCKY_REPOS_FILE: 'unused',
  DUCKY_OWNER_TIMEZONE: MANILA,
};

function world(opts: { imported?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ducky-exp-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  const dbPath = path.join(dir, 'live.db');
  const db = openDatabase({ location: dbPath });
  runMigrations(db);
  if (opts.imported !== false) {
    const store = createStore(db);
    const lock = takeLock(store);
    new AssistantImportService({ store, env: importEnv(), nowMs: () => Date.parse('2026-10-13T00:00:00.000Z') })
      .run(importDoc(), { apply: true, lock });
    lock.release();
  }
  db.close();
  chmodSync(dbPath, 0o600);
  const backup = path.join(dir, 'backup.db');
  const makeBackup = (): string => {
    const d = openDatabase({ location: dbPath });
    d.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    d.close();
    chmodSync(backup, 0o600);
    return backup;
  };
  return { dir, dbPath, out: path.join(dir, 'delta.json'), makeBackup };
}

const run = (args: string[], env: NodeJS.ProcessEnv = ENV, repoRoot?: string) => {
  let out = '';
  let err = '';
  const code = runExportRollbackDeltaCli(args, env, { out: (t) => (out += t), err: (t) => (err += t) },
    { now: () => new Date('2026-10-14T00:00:00.000Z'), ...(repoRoot ? { repoRoot } : {}) });
  return { code, out, err };
};

describe('the export CLI refuses before it reads any data', () => {
  it('needs exactly one source and an output', () => {
    const w = world();
    expect(run(['--out', w.out]).code).toBe(2);
    expect(run(['--db', w.dbPath]).code).toBe(2);
    expect(run(['--db', w.dbPath, '--from-backup', w.dbPath, '--out', w.out]).code).toBe(2);
  });

  it('refuses paths inside the repository, including through a symlink', () => {
    const w = world();
    const outside = run(['--db', w.dbPath, '--out', w.out], ENV, w.dir);
    expect(outside.code).toBe(2);
    expect(outside.err).toContain('outside the repository');
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'ducky-link-')), 'l');
    dirs.push(path.dirname(link));
    symlinkSync(w.dir, link);
    expect(run(['--db', w.dbPath, '--out', path.join(link, 'x.json')], ENV, w.dir).code).toBe(2);
  });

  it('refuses a database that is not private, and an output directory that is not', () => {
    const w = world();
    chmodSync(w.dbPath, 0o644);
    expect(run(['--db', w.dbPath, '--out', w.out]).code).toBe(2);
    chmodSync(w.dbPath, 0o600);
    chmodSync(w.dir, 0o755);
    expect(run(['--db', w.dbPath, '--out', w.out]).code).toBe(2);
    chmodSync(w.dir, 0o700);
  });

  it('never overwrites an existing output', () => {
    const w = world();
    writeFileSync(w.out, 'keep', { mode: 0o600 });
    const r = run(['--db', w.dbPath, '--out', w.out]);
    expect(r.code).toBe(2);
    expect(readFileSync(w.out, 'utf8')).toBe('keep');
  });

  it('refuses a database with pending migrations', () => {
    const w = world({ imported: false });
    const db = openDatabase({ location: w.dbPath });
    db.exec('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)');
    db.close();
    expect(run(['--db', w.dbPath, '--out', w.out]).code).toBe(2);
  });

  it('refuses while a live process holds the database', () => {
    const w = world();
    const db = openDatabase({ location: w.dbPath });
    const lock = acquireRuntimeLock(db, 'coordinator', { host: 'other', pid: process.pid, isPidAlive: () => true });
    expect(lock.ok).toBe(true);
    const r = run(['--db', w.dbPath, '--out', w.out]);
    expect(r.code).toBe(4);
    expect(existsSync(w.out)).toBe(false);
    db.close();
  });
});

describe('a complete export', () => {
  it('writes one 0600 file and prints counts only', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--out', w.out]);
    expect(r.code).toBe(0);
    expect(statSync(w.out).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(w.out, 'utf8'));
    expect(body.schema).toBe('ducky-rollback-delta/v3');
    expect(body.complete).toBe(true);
    for (const text of ['Water the plants', 'a loose thought', 'acme', 'Widgets', w.dir]) {
      expect(r.out).not.toContain(text);
      expect(r.err).not.toContain(text);
    }
    expect(JSON.parse(r.out).tasks).toMatchObject({ unchanged: 3, changed: 0, added: 0, deleted: 0 });
  });

  it('releases the lock afterwards', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--out', w.out]).code).toBe(0);
    const db = openDatabase({ location: w.dbPath });
    expect(acquireRuntimeLock(db, 'importer').ok).toBe(true);
    db.close();
  });

  it('reads a verified backup instead, without a lock and without touching it', () => {
    const w = world();
    const backup = w.makeBackup();
    const before = readFileSync(backup);
    const r = run(['--from-backup', backup, '--out', w.out]);
    expect(r.code).toBe(0);
    expect(readFileSync(backup).equals(before)).toBe(true);
    expect(JSON.parse(readFileSync(w.out, 'utf8')).complete).toBe(true);
  });

  it('refuses a backup that is not a usable database', () => {
    const w = world();
    const junk = path.join(w.dir, 'junk.db');
    writeFileSync(junk, 'not a database at all', { mode: 0o600 });
    expect(run(['--from-backup', junk, '--out', w.out]).code).toBe(3);
    expect(existsSync(w.out)).toBe(false);
  });
});

describe('a backup is only read when it is a finished state', () => {
  it('refuses a backup whose writer is still alive', () => {
    const w = world();
    const db = openDatabase({ location: w.dbPath });
    // This very process holds the lock, so a copy of the file carries a LIVE holder.
    expect(acquireRuntimeLock(db, 'coordinator').ok).toBe(true);
    db.close();
    const live = openDatabase({ location: w.dbPath });
    live.exec(`VACUUM INTO '${path.join(w.dir, 'copy.db').replace(/'/g, "''")}'`);
    live.close();
    chmodSync(path.join(w.dir, 'copy.db'), 0o600);
    const r = run(['--from-backup', path.join(w.dir, 'copy.db'), '--out', w.out]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('still writing');
    expect(existsSync(w.out)).toBe(false);
  });

  it('refuses a backup that breaks a foreign key, as incomplete', () => {
    const w = world();
    const db = openDatabase({ location: w.dbPath });
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`INSERT INTO reminder_occurrences (id, reminder_id, occurrence_no, scheduled_for, created_at)
                VALUES ('o-bad','missing',1,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`).run();
    db.close();
    expect(run(['--db', w.dbPath, '--out', w.out]).code).toBe(5);
    expect(existsSync(w.out)).toBe(false);
  });
});

describe('errors and the output never carry a path or a half-written file', () => {
  it('says nothing about the file when the database cannot be opened', () => {
    const w = world();
    const junk = path.join(w.dir, 'junk.db');
    writeFileSync(junk, 'not a database', { mode: 0o600 });
    const r = run(['--db', junk, '--out', w.out]);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain(w.dir);
    expect(existsSync(w.out)).toBe(false);
  });

  it('leaves no temporary file behind and publishes a 0600 file', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--out', w.out]).code).toBe(0);
    expect(existsSync(`${w.out}.tmp-${process.pid}`)).toBe(false);
    expect(statSync(w.out).mode & 0o777).toBe(0o600);
  });
});

describe('an incomplete export cannot be mistaken for success', () => {
  const lose = (w: ReturnType<typeof world>) => {
    const db = openDatabase({ location: w.dbPath });
    db.exec("DELETE FROM captures WHERE content = 'a loose thought'"); // no deletion path: cause unknown
    db.close();
  };

  it('exits 5 and writes nothing by default', () => {
    const w = world();
    lose(w);
    const r = run(['--db', w.dbPath, '--out', w.out]);
    expect(r.code).toBe(5);
    expect(existsSync(w.out)).toBe(false);
    expect(JSON.parse(r.out).incomplete).toContainEqual({ category: 'capture', rule: 'deletion_cause_unknown', count: 1 });
    expect(r.err).toContain('nothing was written');
  });

  it('still exits 5 when asked to keep the file, and the file says it is incomplete', () => {
    const w = world();
    lose(w);
    const r = run(['--db', w.dbPath, '--out', w.out, '--allow-incomplete']);
    expect(r.code).toBe(5);
    const body = JSON.parse(readFileSync(w.out, 'utf8'));
    expect(body.complete).toBe(false);
    expect(body.incomplete.length).toBeGreaterThan(0);
  });
});
