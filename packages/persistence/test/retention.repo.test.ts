import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RETENTION_FORBIDDEN_TABLES } from '@ducky/contracts';
import { openDatabase, nowIso } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * Retention is the only code in this repository that removes the owner's data,
 * so the tests are about what it REFUSES to do at least as much as what it does.
 */
let store: Store;
let db: ReturnType<typeof openDatabase>;

const iso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();

const seedRepo = (): void => {
  store.repos.upsert({
    slug: 'demo', localPath: '/tmp/demo', allowJobs: true, defaultBranch: 'main',
    githubOwner: null, githubRepo: null, allowWorktree: true, allowBootstrap: false,
    bootstrapAllowedEntries: ['.git'], enabled: true,
  });
};

/** A terminal job with a full set of child rows, aged as requested. */
function seedJob(id: string, opts: { state?: string; finishedDaysAgo?: number } = {}): string {
  const finished = iso(opts.finishedDaysAgo ?? 400);
  db.prepare(
    `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, context, bootstrap,
       state, max_attempts, max_owner_input_rounds, created_at, updated_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `p-${id}`, '1', 'demo', 'task text', null, 0, opts.state ?? 'completed', 3, 3, finished, finished, finished);

  db.prepare(
    `INSERT INTO job_transitions (job_id, from_state, to_state, reason, actor, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, 'running', opts.state ?? 'completed', 'done', 'executor:e1', finished);
  const t = db.prepare('SELECT id FROM job_transitions WHERE job_id = ?').get(id) as { id: number };
  db.prepare(
    `INSERT INTO job_notification_deliveries (transition_id, target, job_id, delivered_at)
     VALUES (?,?,?,?)`,
  ).run(t.id, 'owner_dm', id, finished);
  db.prepare(
    'INSERT INTO job_events (job_id, seq, kind, message_redacted, created_at) VALUES (?,?,?,?,?)',
  ).run(id, 1, 'submitted', 'queued', finished);
  db.prepare(
    `INSERT INTO job_owner_inputs (id, job_id, round, question_redacted, answer, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(`oi-${id}`, id, 0, 'which db?', 'the main one', finished);
  db.prepare(
    `INSERT INTO job_results (id, job_id, lease_id, result_sha256, verdict, summary_redacted,
       review_json, verification_json, changed_files_json, proposed_actions_json,
       result_snapshot_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`r-${id}`, id, 'l1', 'a'.repeat(64), 'implemented', 's', '{}', '{}', '[]', '[]', '{}', finished);
  return id;
}

beforeEach(() => {
  db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  store = createStore(db);
  seedRepo();
});

describe('the job-unit guard', () => {
  it('refuses a job that is not terminal', () => {
    seedJob('j1', { state: 'running' });
    expect(store.retention.guardJobUnit('j1')).toEqual({ ok: false, refusal: 'job_still_running' });
  });

  it('refuses an unknown job identically to one that never existed', () => {
    expect(store.retention.guardJobUnit('nope')).toEqual({ ok: false, refusal: 'unknown_job' });
  });

  it('refuses a job that still holds its repository', () => {
    seedJob('j1');
    db.prepare('INSERT INTO repo_reservations (repo_slug, job_id, acquired_at, reason) VALUES (?,?,?,?)')
      .run('demo', 'j1', nowIso(), 'orphan_agent');
    expect(store.retention.guardJobUnit('j1').refusal).toBe('reservation_held');
  });

  it('refuses a job with an OPEN workspace, which may hold uncommitted work', () => {
    seedJob('j1');
    db.prepare(
      `INSERT INTO herdr_workspaces (workspace_id, repo_slug, job_id, label, mode, agent_name, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('w1', 'demo', 'j1', 'ducky-mgd:demo', 'worktree', 'ducky-pi-demo', nowIso());
    expect(store.retention.guardJobUnit('j1').refusal).toBe('workspace_open');
  });

  it('allows a job whose workspace is closed', () => {
    seedJob('j1');
    db.prepare(
      `INSERT INTO herdr_workspaces (workspace_id, repo_slug, job_id, label, mode, agent_name, created_at, closed_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('w1', 'demo', 'j1', 'ducky-mgd:demo', 'worktree', 'ducky-pi-demo', nowIso(), nowIso());
    expect(store.retention.guardJobUnit('j1').ok).toBe(true);
  });

  it('refuses a job with a pending approval', () => {
    seedJob('j1');
    db.prepare(
      `INSERT INTO approvals (id, job_id, action_index, action_kind, description, details_json,
         state, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('a1', 'j1', 0, 'commit', 'commit it', '{}', 'pending', nowIso(), nowIso());
    expect(store.retention.guardJobUnit('j1').refusal).toBe('approval_pending');
  });

  it('refuses a job with an open dependency', () => {
    seedJob('j1');
    db.prepare(
      `INSERT INTO job_dependencies (id, job_id, type, description, state, next_check_at,
         checks_made, max_checks, deadline_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('d1', 'j1', 'ci_run', 'ci', 'waiting', nowIso(), 0, 5, nowIso(), nowIso(), nowIso());
    expect(store.retention.guardJobUnit('j1').refusal).toBe('dependency_open');
  });
});

describe('deleting a job unit', () => {
  it('removes the job and every child row, child-first', () => {
    seedJob('j1');
    const out = store.retention.deleteJobUnitGuarded('j1');
    expect('deleted' in out).toBe(true);
    if (!('deleted' in out)) return;
    expect(out.deleted.jobsDeleted).toBe(1);
    expect(out.deleted.childRowsDeleted).toBeGreaterThanOrEqual(5);

    for (const t of ['jobs', 'job_transitions', 'job_events', 'job_owner_inputs',
                     'job_results', 'job_notification_deliveries']) {
      const n = db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number };
      expect(n.c, t).toBe(0);
    }
  });

  it('leaves foreign keys satisfied, so nothing is orphaned', () => {
    seedJob('j1');
    store.retention.deleteJobUnitGuarded('j1');
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    expect(violations).toEqual([]);
  });

  it('deletes nothing at all when the guard refuses', () => {
    seedJob('j1', { state: 'running' });
    const before = (db.prepare('SELECT count(*) c FROM job_transitions').get() as { c: number }).c;
    const out = store.retention.deleteJobUnitGuarded('j1');
    expect('refusal' in out).toBe(true);
    expect((db.prepare('SELECT count(*) c FROM job_transitions').get() as { c: number }).c).toBe(before);
    expect((db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(1);
  });

  it('removes the delivery row together with its transition', () => {
    // If a transition were pruned while its delivery row survived, or vice
    // versa, the notification sweep would resurface a historical transition as
    // undelivered and DM the owner about a job that no longer exists.
    seedJob('j1');
    store.retention.deleteJobUnitGuarded('j1');
    const t = db.prepare('SELECT count(*) c FROM job_transitions').get() as { c: number };
    const d = db.prepare('SELECT count(*) c FROM job_notification_deliveries').get() as { c: number };
    expect(t.c).toBe(0);
    expect(d.c).toBe(0);
  });

  it('never touches a reservation row', () => {
    seedJob('j1');
    seedJob('j2');
    db.prepare('INSERT INTO repo_reservations (repo_slug, job_id, acquired_at, reason) VALUES (?,?,?,?)')
      .run('demo', 'j2', nowIso(), 'active_job');
    store.retention.deleteJobUnitGuarded('j1');
    expect((db.prepare('SELECT count(*) c FROM repo_reservations').get() as { c: number }).c).toBe(1);
  });
});

describe('selection windows', () => {
  it('offers only terminal jobs older than the cutoff, oldest first', () => {
    seedJob('old', { finishedDaysAgo: 400 });
    seedJob('older', { finishedDaysAgo: 500 });
    seedJob('recent', { finishedDaysAgo: 1 });
    seedJob('live', { state: 'running', finishedDaysAgo: 400 });

    const ids = store.retention.terminalJobsBefore(iso(180), 10);
    expect(ids).toEqual(['older', 'old']);
  });

  it('respects the batch cap', () => {
    for (let i = 0; i < 5; i += 1) seedJob(`j${i}`, { finishedDaysAgo: 400 });
    expect(store.retention.terminalJobsBefore(iso(180), 2)).toHaveLength(2);
  });

  it('keeps an OPEN capture, task and reminder however old', () => {
    db.prepare('INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('c1', '1', 'thought', 'open', iso(900), iso(900));
    db.prepare('INSERT INTO tasks (id, public_id, discord_user_id, title, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('t1', 'pt1', '1', 'do it', 'normal', 'open', iso(900), iso(900));

    expect(store.retention.deleteClosedCaptures(iso(365), 100)).toBe(0);
    expect(store.retention.deleteClosedTasks(iso(365), 100)).toBe(0);
  });

  it('removes a closed capture and a closed task past the window', () => {
    db.prepare('INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('c1', '1', 'thought', 'done', iso(900), iso(900));
    db.prepare('INSERT INTO tasks (id, public_id, discord_user_id, title, priority, status, created_at, updated_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('t1', 'pt1', '1', 'do it', 'normal', 'done', iso(900), iso(900), iso(900));

    expect(store.retention.deleteClosedCaptures(iso(365), 100)).toBe(1);
    expect(store.retention.deleteClosedTasks(iso(365), 100)).toBe(1);
  });

  it('keeps an undelivered reminder occurrence', () => {
    db.prepare(`INSERT INTO reminders (id, public_id, discord_user_id, text, recurrence_kind,
        max_occurrences, fired_count, next_fire_at, status, created_at, updated_at, first_fire_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('r1', 'pr1', '1', 'ping', 'once', 1, 0, iso(-1), 'scheduled', iso(900), iso(900), iso(-1));
    db.prepare(`INSERT INTO reminder_occurrences (id, reminder_id, occurrence_no, scheduled_for, created_at)
      VALUES (?,?,?,?,?)`).run('o1', 'r1', 1, iso(900), iso(900));

    expect(store.retention.deleteSettledOccurrences(iso(365), 100)).toBe(0);
  });
});

describe('what retention may never name', () => {
  it('mentions none of the forbidden tables anywhere in its source', () => {
    // A tripwire, not the real guarantee -- but it catches somebody adding a
    // convenient `DELETE FROM executors` in a hurry.
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'repositories', 'retention.repo.ts'),
      'utf8',
    );
    const deletes = [...src.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]);
    for (const table of RETENTION_FORBIDDEN_TABLES) {
      expect(deletes, table).not.toContain(table);
    }
  });

  it('deletes from repo_reservations nowhere, since a reservation means live', () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'repositories', 'retention.repo.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/DELETE FROM repo_reservations/);
  });
});

/**
 * `schedules.starts_at` is bare WALL-CLOCK text in the owner's zone — no zone,
 * no offset (ADR 0014). The first implementation compared it lexically to a UTC
 * ISO cutoff, which is not a valid comparison: the shapes differ and the zone is
 * ignored entirely, so a same-day row landed on either side of the boundary
 * depending on the offset. Selection is now on `confirmed_at`, a real instant.
 */
describe('schedule selection is on a real instant', () => {
  const seedSchedule = (id: string, startsAt: string, confirmedDaysAgo: number): void => {
    db.prepare(
      `INSERT INTO schedules (id, discord_user_id, title, starts_at, source_kind, confirmed_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, '1', 'standup', startsAt, 'text', iso(confirmedDaysAgo), iso(confirmedDaysAgo));
  };

  it('offers candidates by confirmed_at, not by the wall-clock text', () => {
    seedSchedule('old', '2026-09-01 09:00', 400);
    seedSchedule('recent', '2020-01-01 09:00', 1);

    const got = store.retention.pastScheduleCandidates(iso(365), 10);
    // `recent` is excluded despite an ancient event date, because it was only
    // just confirmed. `old` is offered despite a FUTURE event date -- the caller
    // applies the zone-aware event test.
    expect(got.map((c) => c.id)).toEqual(['old']);
    expect(got[0]!.startsAt).toBe('2026-09-01 09:00');
  });

  it('returns the stored text verbatim, so the caller can parse it in the zone', () => {
    seedSchedule('a', '2026-09-01', 400);
    expect(store.retention.pastScheduleCandidates(iso(365), 10)[0]!.startsAt).toBe('2026-09-01');
  });

  it('deletes exactly the ids named and nothing else', () => {
    seedSchedule('a', '2020-01-01 09:00', 400);
    seedSchedule('b', '2020-01-02 09:00', 400);

    expect(store.retention.deleteSchedulesByIds(['a'])).toBe(1);
    const left = db.prepare('SELECT id FROM schedules').all() as { id: string }[];
    expect(left.map((r) => r.id)).toEqual(['b']);
  });

  it('deletes nothing when given an empty list', () => {
    seedSchedule('a', '2020-01-01 09:00', 400);
    expect(store.retention.deleteSchedulesByIds([])).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM schedules').get() as { c: number }).c).toBe(1);
  });

  it('respects the candidate batch cap', () => {
    for (let i = 0; i < 5; i += 1) seedSchedule(`s${i}`, '2020-01-01 09:00', 400);
    expect(store.retention.pastScheduleCandidates(iso(365), 2)).toHaveLength(2);
  });
});
