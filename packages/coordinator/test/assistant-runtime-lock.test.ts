import { describe, expect, it } from 'vitest';
import { acquireRuntimeLock, openDatabase, runMigrations } from '@ducky/persistence';
import { takeCoordinatorLock } from '../src/runtime-lock.js';

/** The coordinator and the importer share one lock, and neither can take it from a live holder. */
const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return db;
};

describe('the coordinator and the importer share one lock', () => {
  it('lets a coordinator in, and refuses a second one on the same database', () => {
    const db = fresh();
    const first = takeCoordinatorLock(db);
    expect(first.held()).toBe(true);
    expect(() => takeCoordinatorLock(db)).toThrow(/live coordinator is already writing/);
    // The first is untouched by the refused attempt.
    expect(first.held()).toBe(true);
  });

  it('refuses the importer while a live coordinator is running', () => {
    const db = fresh();
    takeCoordinatorLock(db);
    expect(acquireRuntimeLock(db, 'importer')).toEqual({ ok: false, heldBy: 'coordinator' });
  });

  it('refuses a coordinator while an import is in progress', () => {
    const db = fresh();
    const imp = acquireRuntimeLock(db, 'importer');
    expect(imp.ok).toBe(true);
    expect(() => takeCoordinatorLock(db)).toThrow(/live importer is already writing/);
  });

  it('lets the importer in after a clean shutdown, and the coordinator after the import', () => {
    const db = fresh();
    takeCoordinatorLock(db).release();
    const imp = acquireRuntimeLock(db, 'importer');
    expect(imp.ok).toBe(true);
    if (imp.ok) imp.handle.release();
    expect(takeCoordinatorLock(db).held()).toBe(true);
  });

  it('reports a heartbeat that fails once the lock has been taken over', () => {
    const db = fresh();
    const mine = takeCoordinatorLock(db);
    // Another host takes over after this holder's heartbeat went stale.
    db.prepare(`UPDATE runtime_lock SET host = 'elsewhere', heartbeat_at = '2000-01-01T00:00:00.000Z'`).run();
    const theirs = acquireRuntimeLock(db, 'importer', { host: 'h2', pid: 7 });
    expect(theirs.ok).toBe(true);
    expect(mine.heartbeat()).toBe(false);
  });
});
