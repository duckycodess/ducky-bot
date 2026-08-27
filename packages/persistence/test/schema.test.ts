import { describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../src/db.js';
import { appliedVersions, isUpToDate, pendingMigrations, runMigrations } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import { createStore } from '../src/index.js';

const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return db;
};

describe('migrations', () => {
  it('applies every migration exactly once and is idempotent', () => {
    const db = openDatabase({ location: ':memory:' });
    expect(pendingMigrations(db)).toHaveLength(MIGRATIONS.length);
    const first = runMigrations(db);
    expect(first).toHaveLength(MIGRATIONS.length);
    expect(runMigrations(db)).toHaveLength(0);
    expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(isUpToDate(db)).toBe(true);
  });

  it('enforces foreign keys', () => {
    const db = fresh();
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, state, created_at, updated_at)
         VALUES ('j','p','u','missing-repo','t','queued','now','now')`,
      ).run(),
    ).toThrow();
  });

  it('has no column that could hold a plaintext executor secret', () => {
    const db = fresh();
    const cols = db.prepare(`PRAGMA table_info(executor_credentials)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('bearer_verifier');
    expect(names).toContain('hmac_key_fingerprint');
    expect(names).not.toContain('bearer_token');
    expect(names).not.toContain('hmac_secret');
  });

  it('has no schedule_extractions table: nothing is stored before confirmation', () => {
    const db = fresh();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).not.toContain('schedule_extractions');
    expect(tables).toContain('schedules');
  });
});

describe('invariants enforced by the schema', () => {
  const seed = (db: ReturnType<typeof fresh>) => {
    const store = createStore(db);
    store.repos.upsert({
      slug: 'demo', absolutePath: '/tmp/demo', defaultBranch: 'main', githubOwner: null,
      githubRepo: null, allowWorktree: true, allowBootstrap: false,
      bootstrapAllowedEntries: ['.git'], enabled: true,
    });
    return store;
  };

  it('permits only one running job per repository', () => {
    const db = fresh();
    const store = seed(db);
    const mk = (id: string, state: string) =>
      db.prepare(
        `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, `p${id}`, 'u', 'demo', 't', state, 'now', 'now');
    mk('a', 'running');
    mk('b', 'queued');
    expect(() => mk('c', 'running')).toThrow(/UNIQUE/);
    expect(store.jobs.byId('a')?.state).toBe('running');
  });

  it('permits only one reservation per repository', () => {
    const db = fresh();
    const store = seed(db);
    db.prepare(
      `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, state, created_at, updated_at)
       VALUES ('a','pa','u','demo','t','queued','now','now'), ('b','pb','u','demo','t','queued','now','now')`,
    ).run();

    expect(store.jobs.acquireReservation('demo', 'a', null)).toBe(true);
    // the guarded upsert refuses to move a reservation to a different job
    expect(store.jobs.acquireReservation('demo', 'b', null)).toBe(false);
    expect(store.jobs.reservation('demo')?.jobId).toBe('a');
    // extending our own reservation is fine
    expect(store.jobs.acquireReservation('demo', 'a', '2099-01-01T00:00:00.000Z')).toBe(true);
  });

  it('makes a recorded result snapshot immutable', () => {
    const db = fresh();
    const store = seed(db);
    db.prepare(
      `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, state, created_at, updated_at)
       VALUES ('a','pa','u','demo','t','running','now','now')`,
    ).run();
    withTransaction(db, () => {
      store.results.insert({
        id: 'r1',
        jobId: 'a',
        leaseId: 'lease-1',
        resultSha256: 'abc',
        result: {
          schemaVersion: 1,
          verdict: 'failed',
          summary: 's',
          changedFiles: [],
          review: { performed: false, independent: false, verdict: 'skipped', notes: '' },
          verification: { commands: [], passed: false },
          proposedActions: [],
        },
      });
    });
    expect(() => db.prepare(`UPDATE job_results SET summary_redacted='x' WHERE id='r1'`).run()).toThrow(
      /immutable/,
    );
  });

  it('treats a duplicate nonce as a replay', () => {
    const db = fresh();
    const store = createStore(db);
    expect(store.executors.consumeNonce('n1', 'e', '2099-01-01T00:00:00.000Z')).toBe(true);
    expect(store.executors.consumeNonce('n1', 'e', '2099-01-01T00:00:00.000Z')).toBe(false);
  });
});
