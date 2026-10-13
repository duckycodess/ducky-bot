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
