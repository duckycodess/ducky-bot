import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { compareBackupToLive } from '../src/backup-check.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'ducky-bkp-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const live = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return db;
};
const snapshot = (db: ReturnType<typeof live>, file: string): void => {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
};
const addCapture = (db: ReturnType<typeof live>, id: string): void => {
  db.prepare(
    `INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at)
     VALUES (?, 'u', 'x', 'open', 'now', 'now')`,
  ).run(id);
};

describe('a backup is a copy of THIS database as it stands', () => {
  it('passes for a fresh copy', () => {
    const db = live();
    addCapture(db, 'a');
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    expect(compareBackupToLive(db, file)).toEqual({ ok: true, integrity: 'ok', mismatched: [] });
  });

  it('names the tables that changed since the copy was taken, and nothing about their contents', () => {
    const db = live();
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    addCapture(db, 'newer');
    expect(compareBackupToLive(db, file)).toEqual({ ok: false, integrity: 'ok', mismatched: ['captures'] });
  });

  it('is not fooled by a copy of some other database', () => {
    const db = live();
    const other = live();
    addCapture(other, 'x');
    const file = path.join(tmp(), 'other.db');
    snapshot(other, file);
    expect(compareBackupToLive(db, file).ok).toBe(false);
  });

  it('refuses a file that is not a database at all', () => {
    const db = live();
    const file = path.join(tmp(), 'junk.db');
    writeFileSync(file, 'not a database, just text');
    expect(compareBackupToLive(db, file)).toEqual({ ok: false, integrity: 'failed', mismatched: [] });
    expect(compareBackupToLive(db, path.join(tmp(), 'absent.db')).ok).toBe(false);
  });

  it('ignores tables that change by themselves', () => {
    const db = live();
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    db.prepare(`INSERT INTO assistant_watch_calls (minute, calls) VALUES ('2026-10-01T00:00', 3)`).run();
    expect(compareBackupToLive(db, file).ok).toBe(true);
  });
});

describe('a backup has the same CONTENT, not just the same number of rows', () => {
  const edit = (db: ReturnType<typeof live>, sql: string): void => {
    db.prepare(sql).run();
  };

  it('catches a record edited after the copy was taken, with an unchanged row count', () => {
    const db = live();
    addCapture(db, 'a');
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    expect(compareBackupToLive(db, file).ok).toBe(true);
    edit(db, `UPDATE captures SET content = 'changed' WHERE id = 'a'`);
    expect(compareBackupToLive(db, file)).toEqual({ ok: false, integrity: 'ok', mismatched: ['captures'] });
  });

  it('catches a swapped row: same count, different record', () => {
    const db = live();
    addCapture(db, 'a');
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    edit(db, `DELETE FROM captures WHERE id = 'a'`);
    addCapture(db, 'b');
    expect(compareBackupToLive(db, file).mismatched).toEqual(['captures']);
  });

  it('is not fooled by the same text stored as a different type', () => {
    const db = live();
    db.exec(`CREATE TABLE probe_t (k TEXT, v)`);
    db.prepare(`INSERT INTO probe_t VALUES ('x', 1)`).run();
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    edit(db, `UPDATE probe_t SET v = '1'`);
    expect(compareBackupToLive(db, file).mismatched).toEqual(['probe_t']);
  });

  it('is independent of row order, and passes for an identical copy with many rows', () => {
    const db = live();
    for (let i = 0; i < 200; i += 1) addCapture(db, `id-${i}`);
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    expect(compareBackupToLive(db, file)).toEqual({ ok: true, integrity: 'ok', mismatched: [] });
  });

  it('never reports a digest or any content', () => {
    const db = live();
    addCapture(db, 'PERSONAL-MARKER');
    const file = path.join(tmp(), 'b.db');
    snapshot(db, file);
    edit(db, `UPDATE captures SET content = 'SECOND-MARKER'`);
    const out = JSON.stringify(compareBackupToLive(db, file));
    expect(out).not.toMatch(/MARKER|[0-9a-f]{32}/);
  });
});
