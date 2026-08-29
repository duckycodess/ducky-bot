import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { appliedVersions, runMigrations } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import { createStore } from '../src/index.js';

const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  const store = createStore(db);
  store.repos.upsert({
    slug: 'demo', localPath: '/tmp/demo', allowJobs: true, defaultBranch: 'main', githubOwner: null,
    githubRepo: null, allowWorktree: true, allowBootstrap: false,
    bootstrapAllowedEntries: ['.git'], enabled: true,
  });
  return { db, store };
};

const makeJob = (store: ReturnType<typeof fresh>['store'], id = 'j1') =>
  store.jobs.create({
    id, publicId: `p${id}`, discordUserId: 'owner-1', repoSlug: 'demo',
    task: 't', context: null, bootstrap: false, maxAttempts: 3,
    maxOwnerInputRounds: 3, state: 'queued',
  });

const dep = (
  store: ReturnType<typeof fresh>['store'],
  jobId: string,
  over: Partial<Parameters<typeof store.dependencies.insert>[0]> = {},
) =>
  store.dependencies.insert({
    id: `d-${Math.random()}`,
    jobId,
    type: 'ci_run',
    description: 'upstream build',
    externalKey: 'run-1',
    nextCheckAt: '2026-09-01T09:00:00.000Z',
    maxChecks: 3,
    deadlineAt: '2026-09-02T09:00:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
    ...over,
  });

describe('migration 8', () => {
  it('is forward-only and applies exactly once', () => {
    const db = openDatabase({ location: ':memory:' });
    expect(runMigrations(db)).toHaveLength(MIGRATIONS.length);
    expect(runMigrations(db)).toHaveLength(0);
    expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(appliedVersions(db)).toContain(8);
  });

  it('leaves every existing job with no work phase, which is correct for all of them', () => {
    const { store } = fresh();
    expect(makeJob(store).workPhase).toBeNull();
  });

  it('refuses a work phase that is not on the allowlist', () => {
    const { db, store } = fresh();
    makeJob(store);
    expect(() =>
      db.prepare(`UPDATE jobs SET work_phase = 'deploying' WHERE id = 'j1'`).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`UPDATE jobs SET work_phase = 'reviewing' WHERE id = 'j1'`).run(),
    ).not.toThrow();
  });

  it('keeps the single-writer index keyed on running only', () => {
    const { db, store } = fresh();
    makeJob(store, 'a');
    makeJob(store, 'b');
    db.prepare(`UPDATE jobs SET state = 'running' WHERE id = 'a'`).run();
    // The guarantee Phase 1 shipped is untouched by the new state.
    expect(() => db.prepare(`UPDATE jobs SET state = 'running' WHERE id = 'b'`).run()).toThrow(
      /UNIQUE/,
    );
    // ...and a dependency wait does not compete for it.
    expect(() =>
      db.prepare(`UPDATE jobs SET state = 'waiting_on_dependency' WHERE id = 'b'`).run(),
    ).not.toThrow();
  });
});

describe('the dependency schema', () => {
  it('requires a waiting row to have a cursor and a resolved one not to', () => {
    const { db, store } = fresh();
    const job = makeJob(store);
    expect(() =>
      db
        .prepare(
          `INSERT INTO job_dependencies (id, job_id, type, description, state, next_check_at,
             max_checks, deadline_at, created_at, updated_at)
           VALUES ('x', ?, 'ci_run', 'd', 'waiting', NULL, 1, 'later', 'now', 'now')`,
        )
        .run(job.id),
    ).toThrow(/CHECK/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO job_dependencies (id, job_id, type, description, state, next_check_at,
             max_checks, deadline_at, created_at, updated_at)
           VALUES ('y', ?, 'ci_run', 'd', 'ready', 'soon', 1, 'later', 'now', 'now')`,
        )
        .run(job.id),
    ).toThrow(/CHECK/);
  });

  it('permits only one OPEN dependency per job, but any number of closed ones', () => {
    const { store } = fresh();
    const job = makeJob(store);
    const first = dep(store, job.id);
    expect(() => dep(store, job.id)).toThrow(/UNIQUE/);

    store.dependencies.resolve({ id: first.id, state: 'ready', detail: null, atIso: 'now' });
    expect(() => dep(store, job.id)).not.toThrow();
    expect(store.dependencies.forJob(job.id)).toHaveLength(2);
  });

  it('refuses an unknown type and a zero check budget', () => {
    const { db, store } = fresh();
    const job = makeJob(store);
    const insert = (type: string, maxChecks: number) =>
      db
        .prepare(
          `INSERT INTO job_dependencies (id, job_id, type, description, state, next_check_at,
             max_checks, deadline_at, created_at, updated_at)
           VALUES (?, ?, ?, 'd', 'waiting', 'soon', ?, 'later', 'now', 'now')`,
        )
        .run(`i${Math.random()}`, job.id, type, maxChecks);
    expect(() => insert('deploy_wait', 1)).toThrow(/CHECK/);
    expect(() => insert('ci_run', 0)).toThrow(/CHECK/);
  });
});

describe('DependenciesRepo', () => {
  it('only returns a dependency once its cursor is due, and bounds the batch', () => {
    const { store } = fresh();
    for (const id of ['a', 'b', 'c']) {
      makeJob(store, id);
      dep(store, id, { nextCheckAt: `2026-09-01T09:0${id === 'a' ? 0 : 5}:00.000Z` });
    }
    expect(store.dependencies.due('2026-09-01T08:59:00.000Z', 10)).toHaveLength(0);
    expect(store.dependencies.due('2026-09-01T09:00:00.000Z', 10)).toHaveLength(1);
    expect(store.dependencies.due('2026-09-01T09:05:00.000Z', 10)).toHaveLength(3);
    // The cap is what makes one pass bounded however many are outstanding.
    expect(store.dependencies.due('2026-09-01T09:05:00.000Z', 2)).toHaveLength(2);
  });

  it('spends a check and moves the cursor together, once', () => {
    const { store } = fresh();
    const job = makeJob(store);
    const d = dep(store, job.id);

    const attempt = () =>
      store.dependencies.recordCheck({
        id: d.id,
        // Both passes read 0, exactly as two overlapping ticks would.
        expectedChecksMade: 0,
        status: 'pending',
        detail: 'still building',
        nextCheckAt: '2026-09-01T09:10:00.000Z',
        atIso: '2026-09-01T09:00:01.000Z',
      });
    expect(attempt()).toBe(true);
    expect(attempt()).toBe(false);

    const after = store.dependencies.byId(d.id)!;
    expect(after.checksMade).toBe(1);
    expect(after.nextCheckAt).toBe('2026-09-01T09:10:00.000Z');
    expect(after.lastStatus).toBe('pending');
  });

  it('clears the cursor when it resolves, and refuses to resolve twice', () => {
    const { store } = fresh();
    const job = makeJob(store);
    const d = dep(store, job.id);

    expect(
      store.dependencies.resolve({
        id: d.id, state: 'ready', detail: 'green', atIso: 'now', countCheck: true, status: 'ready',
      }),
    ).toBe(true);
    const after = store.dependencies.byId(d.id)!;
    expect(after.state).toBe('ready');
    expect(after.nextCheckAt).toBeNull();
    expect(after.checksMade).toBe(1);
    expect(after.resolvedAt).toBe('now');
    // Not waiting any more, so nothing polls it.
    expect(store.dependencies.due('2030-01-01T00:00:00.000Z', 10)).toHaveLength(0);
    expect(
      store.dependencies.resolve({ id: d.id, state: 'failed', detail: null, atIso: 'later' }),
    ).toBe(false);
  });

  it('cancels whatever a job was waiting on', () => {
    const { store } = fresh();
    const job = makeJob(store);
    dep(store, job.id);
    expect(store.dependencies.cancelOpenForJob(job.id, 'now')).toBe(1);
    expect(store.dependencies.openForJob(job.id)).toBeUndefined();
    expect(store.dependencies.cancelOpenForJob(job.id, 'now')).toBe(0);
  });
});

describe('AuditLogRepo', () => {
  it('records, reads back, and clamps an over-long detail', () => {
    const { store } = fresh();
    store.auditLog.record({
      event: 'job.created', actorKind: 'owner', actorRef: 'owner',
      subjectKind: 'job', subjectRef: 'pj1', detail: 'x'.repeat(5000),
    });
    const [row] = store.auditLog.recent(10);
    expect(row?.event).toBe('job.created');
    expect(row?.outcome).toBe('ok');
    expect(row?.detail?.length).toBeLessThanOrEqual(300);
    expect(store.auditLog.forSubject('job', 'pj1', 10)).toHaveLength(1);
    expect(store.auditLog.countByEvent('job.created')).toBe(1);
  });

  it('never throws, so bookkeeping cannot break the thing being booked', () => {
    const { store } = fresh();
    expect(() =>
      // A constraint violation on the actor kind would abort the caller's
      // transaction if this were not swallowed.
      store.auditLog.record({
        event: 'job.created',
        actorKind: 'nobody' as never,
        subjectKind: 'job',
        subjectRef: 'pj1',
      }),
    ).not.toThrow();
    expect(store.auditLog.recent(10)).toHaveLength(0);
  });

  it('prunes past the retention window, in bounded batches', () => {
    const { db, store } = fresh();
    for (let i = 0; i < 5; i += 1) {
      db.prepare(
        `INSERT INTO audit_log (at, event, actor_kind, outcome) VALUES ('2020-01-01T00:00:00Z','job.created','system','ok')`,
      ).run();
    }
    store.auditLog.record({ event: 'job.created', actorKind: 'system' });
    expect(store.auditLog.pruneOlderThan('2021-01-01T00:00:00Z', 2)).toBe(2);
    expect(store.auditLog.pruneOlderThan('2021-01-01T00:00:00Z', 100)).toBe(3);
    // The recent row survives.
    expect(store.auditLog.recent(10)).toHaveLength(1);
  });
});

describe('the audit log is a record, not an authority', () => {
  it('is never READ by a repository that decides anything', () => {
    // Structural rather than behavioural. Writing to it is fine and expected --
    // `jobs.repo` records every transition -- but no decision may READ it, so a
    // forged row can never influence one. Anything that selects from it outside
    // the audit repository itself would be exactly that bug.
    const sources = [
      'jobs.repo.ts', 'approvals.repo.ts', 'executors.repo.ts', 'repos.repo.ts',
      'dependencies.repo.ts', 'results.repo.ts', 'notifications.repo.ts',
    ];
    for (const file of sources) {
      const text = readFileSync(new URL(`../src/repositories/${file}`, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/FROM\s+audit_log/i);
    }
    // ...and the one repository that does read it never decides anything: it
    // exposes reads and a prune, and no lifecycle or authorization method.
    const auditSource = readFileSync(
      new URL('../src/repositories/audit-log.repo.ts', import.meta.url),
      'utf8',
    );
    expect(auditSource).toMatch(/FROM audit_log/);
    for (const forbidden of ['UPDATE jobs', 'UPDATE approvals', 'repo_reservations']) {
      expect(auditSource, forbidden).not.toContain(forbidden);
    }
  });
});
