import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../src/db.js';
import { appliedVersions, isUpToDate, pendingMigrations, runMigrations } from '../src/migrate.js';
import { AUDIT_ACTOR_KINDS, AUDIT_EVENTS, AUDIT_SUBJECT_KINDS } from '@ducky/contracts';
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
      slug: 'demo', localPath: '/tmp/demo', allowJobs: true, defaultBranch: 'main', githubOwner: null,
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

/**
 * Migration 11 exists because `EXPLAIN QUERY PLAN` on the live development
 * database reported three full table scans, and `job_transitions` -- the
 * owner's job history AND the source the notification sweep reads every
 * reconcile tick -- had no index at all.
 */
describe('migration 11: query indexes', () => {
  const plan = (db: ReturnType<typeof openDatabase>, sql: string): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');

  it('turns the three confirmed table scans into index searches', () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);

    const transitions = plan(db, "SELECT * FROM job_transitions WHERE job_id = 'x' ORDER BY id");
    expect(transitions).toMatch(/USING (COVERING )?INDEX ix_job_transitions_job/);
    expect(transitions).not.toMatch(/SCAN job_transitions/);

    const owner = plan(
      db,
      "SELECT * FROM jobs WHERE discord_user_id = 'x' ORDER BY created_at DESC LIMIT 10",
    );
    expect(owner).toMatch(/USING (COVERING )?INDEX ix_jobs_owner_created/);
    expect(owner).not.toMatch(/TEMP B-TREE/);

    const channel = plan(
      db,
      "SELECT * FROM jobs WHERE origin_shared_channel_id = 'x' ORDER BY created_at DESC LIMIT 10",
    );
    expect(channel).toMatch(/USING (COVERING )?INDEX ix_jobs_origin_channel/);

    db.close();
  });

  it('indexes the reservation reverse lookup', () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    expect(plan(db, "SELECT * FROM repo_reservations WHERE job_id = 'x'")).toMatch(
      /USING (COVERING )?INDEX ix_repo_reservations_job/,
    );
    db.close();
  });

  it('is index-only: migration 11 creates no table, column or constraint', () => {
    // Asserted against the migration's own SQL rather than the final schema,
    // because later migrations legitimately add tables.
    const eleven = MIGRATIONS.find((m) => m.version === 11);
    expect(eleven?.name).toBe('query_indexes');
    const sql = (eleven?.sql ?? '').toUpperCase();
    for (const forbidden of ['CREATE TABLE', 'ALTER TABLE', 'DROP ', 'REFERENCES', 'CREATE TRIGGER']) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
    expect(sql).toContain('CREATE INDEX');
  });
});

/**
 * `AuditLogRepo.record` never throws, on purpose: bookkeeping must not roll
 * back the work it describes. The cost is that a value the TypeScript enum
 * allows and the CHECK constraint does not is dropped SILENTLY -- the audit log
 * just loses the row.
 *
 * That happened: three new subject kinds were added to the enum and the
 * constraint still listed four. So the enums and the schema are now checked
 * against each other directly.
 */
describe('the audit log can persist everything its vocabulary allows', () => {
  it('accepts every declared subject kind', () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    const store = createStore(db);

    for (const kind of AUDIT_SUBJECT_KINDS) {
      store.auditLog.record({
        event: 'job.created',
        actorKind: 'system',
        subjectKind: kind,
        subjectRef: 'x',
        outcome: 'ok',
      });
    }
    const rows = store.auditLog.recent(100);
    expect(rows).toHaveLength(AUDIT_SUBJECT_KINDS.length);
    expect(new Set(rows.map((r) => r.subjectKind))).toEqual(new Set(AUDIT_SUBJECT_KINDS));
    db.close();
  });

  it('accepts every declared event and actor kind', () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    const store = createStore(db);

    for (const event of AUDIT_EVENTS) {
      for (const actorKind of AUDIT_ACTOR_KINDS) {
        store.auditLog.record({ event, actorKind, outcome: 'ok' });
      }
    }
    expect(store.auditLog.recent(10_000)).toHaveLength(
      AUDIT_EVENTS.length * AUDIT_ACTOR_KINDS.length,
    );
    db.close();
  });

  it('keeps existing rows across the rebuild in migration 13', () => {
    // The rebuild copies rows verbatim; a lost audit row is a lost audit row.
    const db = openDatabase({ location: ':memory:' });
    const upto12 = MIGRATIONS.filter((m) => m.version <= 12);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of upto12) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
        .run(m.version, m.name, new Date().toISOString());
    }
    db.prepare(
      `INSERT INTO audit_log (at, event, actor_kind, subject_kind, subject_ref, outcome, detail)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(new Date().toISOString(), 'job.created', 'system', 'job', 'p1', 'ok', 'historic');

    runMigrations(db);

    const rows = createStore(db).auditLog.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe('historic');
    db.close();
  });
});

describe('migration 20: the dead column', () => {
  /**
   * `repos.absolute_path` could not be dropped.
   *
   * SQLite removes a NOT NULL only by rebuilding the table, and `repos` has
   * three children with foreign keys to it (`jobs`, `repo_reservations`,
   * `github_watches`), so the rebuild fails inside the migration transaction
   * even with `defer_foreign_keys` on. It was replaced by the nullable
   * `local_path` and left behind.
   *
   * A dead column is only harmless while it stays dead. This is the assertion
   * that keeps it that way: nothing may READ it. The single write site is the
   * insert that NOT NULL forces, and it is allowed to name the column exactly
   * once, in a statement that also writes `local_path`.
   */
  it('is written by exactly one INSERT and read by nothing', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const sources = [
      'packages/persistence/src',
      'packages/coordinator/src',
      'packages/executor/src',
      'packages/adapters/src',
    ].flatMap((dir) => walk(path.join(root, dir)));

    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('absolute_path')) continue;
      const rel = path.relative(root, file);
      // The migration DEFINES it; the repos repository writes it once.
      if (rel === 'packages/persistence/src/migrations.ts') continue;
      if (rel === 'packages/persistence/src/repositories/repos.repo.ts') {
        // Allowed only inside the repos INSERT/UPDATE, never in a SELECT.
        for (const line of text.split('\n')) {
          if (!line.includes('absolute_path')) continue;
          if (/SELECT[^;]*absolute_path/i.test(line)) offenders.push(`${rel}: ${line.trim()}`);
        }
        continue;
      }
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('gives placements a home without touching the reservation key', () => {
    const db = fresh();
    const cols = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

    expect(cols('repo_placements')).toEqual(
      expect.arrayContaining(['repo_slug', 'executor_id', 'absolute_path', 'enabled']),
    );
    expect(cols('repos')).toEqual(expect.arrayContaining(['local_path', 'allow_jobs']));
    // The single-writer guarantee: still one reservation row per SLUG, with no
    // executor column that could split it per host.
    expect(cols('repo_reservations')).not.toContain('executor_id');
    db.close();
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
