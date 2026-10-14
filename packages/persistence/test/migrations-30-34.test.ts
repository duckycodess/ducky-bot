import { describe, expect, it } from 'vitest';
import { nowIso, openDatabase, withTransaction } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import { createStore } from '../src/index.js';

/**
 * Migrations 30 to 34 are additive: a database that already holds records at 29 keeps
 * every one of them, with the new columns at their neutral defaults, and the tombstone
 * triggers keep working.
 */
const upTo = (version: number) => {
  const db = openDatabase({ location: ':memory:' });
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
    withTransaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(m.version, m.name, nowIso());
    });
  }
  return db;
};

describe('upgrading a database that already holds assistant records', () => {
  it('keeps every row and fills the new columns with neutral defaults', () => {
    const db = upTo(29);
    const at = '2026-10-01T00:00:00.000Z';
    db.prepare(`INSERT INTO tasks (id, public_id, discord_user_id, title, due_at, due_all_day, priority, status, created_at, updated_at)
                VALUES ('t1','tabcde','u1','Old task',NULL,0,'high','open',?,?)`).run(at, at);
    db.prepare(`INSERT INTO schedule_rules (id, discord_user_id, batch_key, active, weekday, start_time, end_time, label, created_at)
                VALUES ('r1','u1','b1',0,1,'09:00','10:00','Old class',?)`).run(at);
    db.prepare(`INSERT INTO assistant_watch_targets (id, public_id, discord_user_id, repo_key, display, state, created_at, updated_at)
                VALUES ('w1','wabcde','u1','a/b','a/b','active',?,?)`).run(at, at);
    db.prepare(`INSERT INTO assistant_watch_checkpoints (target_id, surface, state, cursor, next_due_at, updated_at)
                VALUES ('w1','issues','ready',?,?,?)`).run(at, at, at);

    expect(runMigrations(db)).toEqual([30, 31, 32, 33, 34]);

    const task = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as Record<string, unknown>;
    expect(task).toMatchObject({ title: 'Old task', priority: 'high', urgent: 0, category: null });
    expect(db.prepare("SELECT replaced_at FROM schedule_rules WHERE id = 'r1'").get()).toEqual({ replaced_at: null });
    expect(db.prepare("SELECT origin, pushed_at, archived, fork, cancel_reason FROM assistant_watch_targets").get())
      .toEqual({ origin: 'imported', pushed_at: null, archived: 0, fork: 0, cancel_reason: null });
    expect(db.prepare('SELECT pending_state, scan_floor FROM assistant_watch_checkpoints').get())
      .toEqual({ pending_state: null, scan_floor: null });
    db.close();
  });

  it('records an unknown cause for an identity tombstoned after the upgrade with no deletion path, and the named one with', () => {
    const db = upTo(29);
    const at = '2026-10-01T00:00:00.000Z';
    for (const id of ['c1', 'c2']) {
      db.prepare(`INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run(id, 'u1', 'x', 'open', at, at);
      db.prepare(`INSERT INTO assistant_import_identities (namespace, category, source_id, target_id, state, fingerprint, created_at)
                  VALUES ('ns','capture',?,?, 'live', 'f', ?)`).run(`s-${id}`, id, at);
    }
    runMigrations(db);
    const store = createStore(db);
    db.prepare("DELETE FROM captures WHERE id = 'c1'").run();
    store.withDeletionCause('forget', () => db.prepare("DELETE FROM captures WHERE id = 'c2'").run());
    const rows = db.prepare('SELECT source_id, tombstone_cause, stored_hash FROM assistant_import_identities ORDER BY source_id').all();
    expect(rows).toEqual([
      { source_id: 's-c1', tombstone_cause: 'unknown', stored_hash: null },
      { source_id: 's-c2', tombstone_cause: 'forget', stored_hash: null },
    ]);
    // The context is gone afterwards: it never leaks into a later deletion.
    expect(db.prepare('SELECT COUNT(*) AS n FROM deletion_context').get()).toEqual({ n: 0 });
    db.close();
  });

  it('nests deletion causes: the outermost wins', () => {
    const db = upTo(34);
    const store = createStore(db);
    const seen: string[] = [];
    store.withDeletionCause('retention', () => {
      store.withDeletionCause('forget', () => {
        seen.push(String((db.prepare('SELECT cause FROM deletion_context').get() as { cause: string }).cause));
      });
    });
    expect(seen).toEqual(['retention']);
    db.close();
  });
});
