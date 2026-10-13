import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WATCH_EVENT_KINDS } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { runImportCli } from '../src/cli/import-assistant.js';
import { OWNER, secret } from './helpers.js';
import { MANILA, importDoc, rowCounts } from './assistant-import-fixture.js';

/** The operator CLI, end to end, against real files outside the repository. Invented data only. */
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
  DUCKY_IMPORTED_PREFERENCES: 'true',
  DUCKY_BRIEFING_ENABLED: 'true',
  DUCKY_WEATHER_LATITUDE: '14.6',
  DUCKY_WEATHER_LONGITUDE: '121.0',
  DUCKY_WEATHER_LOCATION: 'Somewhere',
};

/** A private directory (0700) holding a migrated database, a 0600 document and optionally a backup. */
function world(doc: unknown = importDoc(), opts: { migrate?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ducky-imp-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  const dbPath = path.join(dir, 'target.db');
  const db = openDatabase({ location: dbPath });
  if (opts.migrate !== false) runMigrations(db);
  db.close();
  const file = path.join(dir, 'doc.json');
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode: 0o600 });
  chmodSync(file, 0o600);
  const backup = path.join(dir, 'backup.db');
  const makeBackup = (): void => {
    const d = openDatabase({ location: dbPath });
    d.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    d.close();
  };
  const counts = () => {
    const d = openDatabase({ location: dbPath });
    try {
      return rowCounts(createStore(d));
    } finally {
      d.close();
    }
  };
  return { dir, dbPath, file, backup, makeBackup, counts };
}

/** What a test reader that can see every kind would declare. The shipped one declares none. */
const sees = (base: { watchCapabilities: unknown }) => ({
  ...base,
  watchCapabilities: { observableKinds: [...WATCH_EVENT_KINDS], discovery: false },
}) as never;

const run = (args: string[], opts: Parameters<typeof runImportCli>[3] = {}, env = ENV) => {
  let out = '';
  let err = '';
  const code = runImportCli(args, env, { out: (t) => (out += t), err: (t) => (err += t) }, {
    repoRoot: path.join(tmpdir(), 'not-this-repo'), ...opts,
  });
  return { code, out, err };
};

describe('what it refuses before touching any data', () => {
  it('needs an explicit database and document, and not both modes at once', () => {
    expect(run([]).code).toBe(2);
    const w = world();
    expect(run(['--db', w.dbPath]).code).toBe(2);
    expect(run(['--db', w.dbPath, '--file', w.file, '--apply', '--verify']).code).toBe(2);
  });

  it('refuses a database, document or backup inside the repository', () => {
    const w = world();
    const inside = run(['--db', w.dbPath, '--file', w.file], { repoRoot: w.dir });
    expect(inside.code).toBe(2);
    expect(inside.err).toContain('outside the repository');
    // The same files are fine from outside.
    expect(run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees }).code).toBe(0);
  });

  it('refuses a document that other users could read', () => {
    const w = world();
    chmodSync(w.file, 0o644);
    expect(run(['--db', w.dbPath, '--file', w.file]).code).toBe(2);
    chmodSync(w.file, 0o600);
    chmodSync(w.dir, 0o755);
    expect(run(['--db', w.dbPath, '--file', w.file]).code).toBe(2);
    chmodSync(w.dir, 0o700);
  });

  it('refuses a missing file and a database with pending migrations', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--file', path.join(w.dir, 'nope.json')]).code).toBe(2);
    const unmigrated = world(importDoc(), { migrate: false });
    const r = run(['--db', unmigrated.dbPath, '--file', unmigrated.file]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('pending migrations');
  });

  it('refuses an unusable configuration without echoing it', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--file', w.file], {}, { ...ENV, DUCKY_WEATHER_LATITUDE: '14.6', DUCKY_WEATHER_LONGITUDE: undefined, DUCKY_WEATHER_LOCATION: undefined });
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('14.6');
  });

  it('does not echo a document that is not JSON', () => {
    const w = world('PERSONAL-MARKER { not json');
    const r = run(['--db', w.dbPath, '--file', w.file]);
    expect(r.code).toBe(3);
    expect(r.err + r.out).not.toContain('PERSONAL-MARKER');
  });
});

describe('the default is a dry run', () => {
  it('validates and reports counts, and writes nothing', () => {
    const w = world();
    const before = w.counts();
    const r = run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ mode: 'dry_run', ok: true });
    expect(report.counts.tasks.created).toBe(3);
    expect(w.counts()).toEqual(before);
  });

  it('fails closed on watch targets with the SHIPPED reader, which observes nothing', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--file', w.file]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).issues).toContainEqual({ category: 'watch', rule: 'reader_cannot_observe', count: 16 });
    expect(w.counts().tasks).toBe(0);
  });

  it('prints counts and rule names, never a title, an id, a repository or a path', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees });
    const text = r.out + r.err;
    for (const secret of ['Water the plants', 'Pay the invoice', 'Widgets', 'a loose thought', 'Algebra', w.dir]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('--apply', () => {
  it('needs a backup, and the backup must be a copy of this database as it stands', () => {
    const w = world();
    const noBackup = run(['--db', w.dbPath, '--file', w.file, '--apply'], { importEnvironment: sees });
    expect(noBackup.code).toBe(3);
    expect(w.counts().tasks).toBe(0);

    // A backup that does not match (the database changed after it was taken).
    w.makeBackup();
    const d = openDatabase({ location: w.dbPath });
    d.prepare(`INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES ('c','u','x','open','n','n')`).run();
    d.close();
    const stale = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(stale.code).toBe(3);
    expect(stale.err).toContain('not a copy of this database as it stands');
    expect(w.counts().tasks).toBe(0);

    // A file that is not a database at all.
    writeFileSync(w.backup, 'junk');
    expect(run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees }).code).toBe(3);
  });

  it('writes everything against a matching backup, and releases the lock', () => {
    const w = world();
    w.makeBackup();
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ mode: 'applied', ok: true });
    const c = w.counts();
    expect(c.tasks).toBe(3);
    expect(c.assistant_watch_targets).toBe(2);
    const d = openDatabase({ location: w.dbPath });
    expect((d.prepare('SELECT COUNT(*) n FROM runtime_lock').get() as { n: number }).n).toBe(0);
    d.close();
  });

  it('is repeatable: a second run against a fresh backup adds nothing', () => {
    const w = world();
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const after = w.counts();
    rmSync(w.backup);
    w.makeBackup();
    const again = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(again.code).toBe(0);
    expect(w.counts()).toEqual(after);
  });

  it('cannot run while a live process holds the database, whatever the operator says', () => {
    const w = world();
    w.makeBackup();
    const d = openDatabase({ location: w.dbPath });
    d.prepare(
      `INSERT INTO runtime_lock (id, holder, pid, host, token, acquired_at, heartbeat_at)
       VALUES (1,'coordinator',?,?, 't', 'n', 'n')`,
    ).run(process.pid, hostname());
    d.close();
    // The lock row changes nothing the backup compares.
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(4);
    expect(r.err).toContain('live coordinator');
    expect(w.counts().tasks).toBe(0);
  });

  it('writes nothing for a foreign owner or any other refused document', () => {
    const doc = importDoc();
    doc['ownerId'] = '100000000000000099';
    const w = world(doc);
    w.makeBackup();
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).issues).toContainEqual({ category: 'document', rule: 'owner_mismatch', count: 1 });
    expect(w.counts().tasks).toBe(0);
  });
});

describe('--verify', () => {
  it('fails before the import and passes after it', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees }).code).toBe(3);
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out)).toMatchObject({ ok: true, parity: true });
    expect(existsSync(w.file)).toBe(true);
  });
});
