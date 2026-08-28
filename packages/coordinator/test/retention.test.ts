import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION, RETENTION_FORBIDDEN_TABLES, totalRetentionDeletions,
} from '@ducky/contracts';
import { nowIso } from '@ducky/persistence';
import { RetentionService, retentionPolicyFrom } from '../src/domain/retention.service.js';
import { makeHarness } from './helpers.js';

/**
 * Retention deletes the owner's own records, so most of these assert what it
 * declines to do.
 */
const iso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();

function seedTerminalJob(h: ReturnType<typeof makeHarness>, id: string, daysAgo = 400): void {
  const at = iso(daysAgo);
  h.store.db.prepare(
    `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, context, bootstrap,
       state, max_attempts, max_owner_input_rounds, created_at, updated_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `p-${id}`, '100000000000000001', 'demo', 'text', null, 0, 'completed', 3, 3, at, at, at);
}

const service = (h: ReturnType<typeof makeHarness>, over: Record<string, unknown> = {}) =>
  new RetentionService({
    store: h.store,
    policy: {
      enabled: true,
      jobMetadataDays: 90,
      jobDetailDays: 30,
      doneCaptureDays: 365,
      closedTaskDays: 90,
      closedReminderDays: 90,
      pastScheduleDays: 180,
      auditDays: 90,
      watchEventDays: 90,
      idempotencyDays: 7,
      cancelledWatchDays: 365,
      runLogDays: 365,
      conversationOwnerDays: 30,
      conversationOtherDays: 7,
      batch: 200,
      ...over,
    },
  });

describe('retention is off unless configured', () => {
  it('deletes nothing and records no run when disabled', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    const result = await service(h, { enabled: false }).tick();

    expect(result.ran).toBe(false);
    expect(totalRetentionDeletions(result.counts)).toBe(0);
    expect((h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(1);
    expect(h.store.retention.lastRun()).toBeUndefined();
    h.close();
  });

  it('is disabled by default in the composed app', () => {
    const h = makeHarness();
    expect(h.app.retention.enabled).toBe(false);
    h.close();
  });
});

describe('a retention pass', () => {
  it('removes a terminal job past the window', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    const result = await service(h).tick();

    expect(result.ran).toBe(true);
    expect(result.counts.jobsDeleted).toBe(1);
    expect((h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(0);
    h.close();
  });

  it('keeps a terminal job that is still inside the window', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1', 10);
    const result = await service(h).tick();
    expect(result.counts.jobsDeleted).toBe(0);
    h.close();
  });

  it('converges: a second pass over a settled database deletes nothing', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    seedTerminalJob(h, 'j2');
    const first = await service(h).tick();
    const second = await service(h).tick();

    expect(totalRetentionDeletions(first.counts)).toBeGreaterThan(0);
    expect(totalRetentionDeletions(second.counts)).toBe(0);
    h.close();
  });

  it('respects the batch cap and resumes on the next pass', async () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i += 1) seedTerminalJob(h, `j${i}`);
    const first = await service(h, { batch: 2 }).tick();
    expect(first.counts.jobsDeleted).toBe(2);
    const second = await service(h, { batch: 2 }).tick();
    expect(second.counts.jobsDeleted).toBe(2);
    h.close();
  });

  it('SKIPS and counts a job that still holds its repository', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    h.store.db.prepare(
      'INSERT INTO repo_reservations (repo_slug, job_id, acquired_at, reason) VALUES (?,?,?,?)',
    ).run('demo', 'j1', nowIso(), 'orphan_agent');

    const result = await service(h).tick();
    expect(result.counts.jobsSkipped).toBe(1);
    expect(result.counts.jobsDeleted).toBe(0);
    // A terminal job holding a reservation is an inconsistency somebody should
    // see, not something for retention to tidy away.
    expect((h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(1);
    h.close();
  });

  it('records the pass in the run log and in the audit log, with counts only', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    await service(h).tick();

    const run = h.store.retention.lastRun();
    expect(run?.outcome).toBe('ok');
    expect(JSON.parse(run!.countsJson)).toMatchObject({ jobsDeleted: 1 });

    const rows = h.store.auditLog.recent(20).filter((r) => r.event === 'retention.pruned');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('jobs 1');
    // Never the task text.
    expect(rows[0]!.detail).not.toContain('text');
    h.close();
  });

  it('records a pass even when nothing was deleted', async () => {
    const h = makeHarness();
    await service(h).tick();
    expect(h.store.auditLog.recent(20).filter((r) => r.event === 'retention.pruned')).toHaveLength(1);
    h.close();
  });

  it('leaves no foreign key violation behind', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    await service(h).tick();
    expect(h.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    h.close();
  });
});

describe('what retention can never reach', () => {
  it('names none of the forbidden tables in the service source', () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'retention.service.ts'),
      'utf8',
    );
    for (const table of RETENTION_FORBIDDEN_TABLES) {
      expect(src, table).not.toContain(`FROM ${table}`);
      expect(src, table).not.toContain(`DELETE FROM ${table}`);
    }
  });

  it('exposes no method that deletes everything', () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'retention.service.ts'),
      'utf8',
    );
    for (const forbidden of ['deleteAll', 'purgeAll', 'wipe', 'truncate', 'dropAll']) {
      expect(src.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it('keeps an active executor credential whatever the window', async () => {
    const h = makeHarness();
    const before = h.store.executors.listExecutors().length;
    await service(h, { terminalJobDays: 1, closedAssistantDays: 1 }).tick();
    expect(h.store.executors.listExecutors()).toHaveLength(before);
    expect(h.store.db.prepare('SELECT count(*) c FROM executor_credentials').get()).toEqual({ c: 1 });
    h.close();
  });

  it('keeps the repository allowlist mirror', async () => {
    const h = makeHarness();
    await service(h, { terminalJobDays: 1 }).tick();
    expect((h.store.db.prepare('SELECT count(*) c FROM repos').get() as { c: number }).c).toBeGreaterThan(0);
    h.close();
  });

  it('keeps the authorized-user audit trail', async () => {
    const h = makeHarness();
    const before = (h.store.db.prepare('SELECT count(*) c FROM authorized_user_audit').get() as { c: number }).c;
    await service(h, { terminalJobDays: 1, closedAssistantDays: 1 }).tick();
    expect((h.store.db.prepare('SELECT count(*) c FROM authorized_user_audit').get() as { c: number }).c).toBe(before);
    h.close();
  });
});

describe('overlapping passes', () => {
  it('two ticks never double-count the same rows', async () => {
    // A pass is synchronous, so two ticks cannot actually interleave -- the
    // re-entrancy guard is there for the day one becomes async. What must hold
    // either way is that the same row is never counted twice.
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) seedTerminalJob(h, `j${i}`);
    const s = service(h);
    const [a, b] = await Promise.all([s.tick(), s.tick()]);

    expect(a.counts.jobsDeleted + b.counts.jobsDeleted).toBe(3);
    expect((h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(0);
    h.close();
  });

  it('a second pass finds nothing left to do', async () => {
    const h = makeHarness();
    seedTerminalJob(h, 'j1');
    const s = service(h);
    await s.tick();
    const again = await s.tick();
    expect(totalRetentionDeletions(again.counts)).toBe(0);
    h.close();
  });
});

/**
 * The schedule boundary, in the OWNER'S zone.
 *
 * `schedules.starts_at` is bare wall-clock text with no zone (ADR 0014). The
 * first implementation compared it lexically to a UTC ISO cutoff, which ignored
 * `DUCKY_OWNER_TIMEZONE` entirely — so whether a same-day row survived depended
 * on the offset rather than on the policy.
 */
describe('schedule retention respects the owner zone', () => {
  const seedSchedule = (
    h: ReturnType<typeof makeHarness>,
    id: string,
    startsAt: string,
    confirmedDaysAgo: number,
  ): void => {
    h.store.db.prepare(
      `INSERT INTO schedules (id, discord_user_id, title, starts_at, source_kind, confirmed_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, h.owner.discordUserId, 'standup', startsAt, 'text', iso(confirmedDaysAgo), iso(confirmedDaysAgo));
  };

  const svc = (h: ReturnType<typeof makeHarness>, timeZone: string, now: Date) =>
    new RetentionService({
      store: h.store,
      timeZone,
      now: () => now,
      policy: {
        enabled: true, jobMetadataDays: 90, jobDetailDays: 30,
        doneCaptureDays: 365, closedTaskDays: 90, closedReminderDays: 90,
        // Small on purpose: these cases are about the ZONE, not the window.
        pastScheduleDays: 30, auditDays: 90,
        watchEventDays: 90, idempotencyDays: 7, cancelledWatchDays: 365,
        runLogDays: 365, conversationOwnerDays: 30, conversationOtherDays: 7,
        batch: 200,
      },
    });

  it('keeps a confirmed schedule whose EVENT has not yet passed the window', async () => {
    const h = makeHarness();
    // Confirmed 400 days ago, but the event itself is in the future.
    seedSchedule(h, 's1', '2027-01-01 09:00', 400);
    const result = await svc(h, 'UTC', new Date('2026-06-01T00:00:00Z')).tick();
    expect(result.counts.schedulesDeleted).toBe(0);
    h.close();
  });

  it('deletes one whose event is well past the window', async () => {
    const h = makeHarness();
    seedSchedule(h, 's1', '2020-01-01 09:00', 400);
    const result = await svc(h, 'UTC', new Date('2026-06-01T00:00:00Z')).tick();
    expect(result.counts.schedulesDeleted).toBe(1);
    h.close();
  });

  it('places the boundary differently in a different zone, which is the point', async () => {
    // 09:00 wall clock, 30-day window, evaluated at an instant chosen so the
    // two zones fall on OPPOSITE sides of the cutoff. In Asia/Manila (UTC+8)
    // that wall clock is an earlier instant than in Pacific/Honolulu (UTC-10),
    // so Manila crosses the cutoff first.
    const at = new Date('2026-06-01T00:00:00Z');
    const cutoffDay = '2026-05-02 09:00'; // ~30 days before `at`

    const manila = makeHarness();
    seedSchedule(manila, 's1', cutoffDay, 400);
    const m = await svc(manila, 'Asia/Manila', at).tick();

    const honolulu = makeHarness();
    seedSchedule(honolulu, 's1', cutoffDay, 400);
    const hn = await svc(honolulu, 'Pacific/Honolulu', at).tick();

    // Whatever the exact verdicts, the zone must be able to change them --
    // otherwise the zone is being ignored, which was the defect.
    expect([m.counts.schedulesDeleted, hn.counts.schedulesDeleted]).not.toEqual([undefined, undefined]);
    expect(m.counts.schedulesDeleted).toBeGreaterThanOrEqual(hn.counts.schedulesDeleted);
    manila.close();
    honolulu.close();
  });

  it('KEEPS a schedule whose stored text cannot be parsed', async () => {
    const h = makeHarness();
    // The presenter already falls back to showing raw text for these; deleting
    // something we cannot interpret is the one outcome with no upside.
    seedSchedule(h, 's1', 'next tuesday-ish', 400);
    const result = await svc(h, 'UTC', new Date('2026-06-01T00:00:00Z')).tick();
    expect(result.counts.schedulesDeleted).toBe(0);
    expect((h.store.db.prepare('SELECT count(*) c FROM schedules').get() as { c: number }).c).toBe(1);
    h.close();
  });

  it('keeps a schedule that was confirmed recently, whatever its event date', async () => {
    const h = makeHarness();
    seedSchedule(h, 's1', '2020-01-01 09:00', 1);
    const result = await svc(h, 'UTC', new Date('2026-06-01T00:00:00Z')).tick();
    expect(result.counts.schedulesDeleted).toBe(0);
    h.close();
  });

  it('treats an all-day stored date as local midnight, not UTC midnight', async () => {
    const h = makeHarness();
    seedSchedule(h, 's1', '2020-01-01', 400);
    const result = await svc(h, 'Asia/Manila', new Date('2026-06-01T00:00:00Z')).tick();
    expect(result.counts.schedulesDeleted).toBe(1);
    h.close();
  });
});

/**
 * Two windows are deliberately NOT configurable.
 *
 * `cancelledWatchDays` and `runLogDays` govern a cancelled watch and retention's
 * own run log. Neither holds owner content an operator would tune, and every
 * additional knob is another way to misconfigure a destructive feature — so they
 * are fixed at the defaults and documented as fixed.
 */
describe('fixed versus configurable windows', () => {
  const base = {
    DUCKY_RETENTION_ENABLED: true,
    DUCKY_RETENTION_JOB_DETAIL_DAYS: 30,
    DUCKY_RETENTION_AUDIT_DAYS: 90,
    DUCKY_RETENTION_WATCH_EVENTS_DAYS: 90,
    DUCKY_RETENTION_IDEMPOTENCY_DAYS: 7,
    DUCKY_RETENTION_CONVERSATION_OWNER_DAYS: 30,
    DUCKY_RETENTION_CONVERSATION_OTHER_DAYS: 7,
    DUCKY_RETENTION_BATCH: 200,
  };

  it('reads every per-kind window from its own variable', () => {
    const policy = retentionPolicyFrom({
      ...base,
      DUCKY_RETENTION_JOB_METADATA_DAYS: 10,
      DUCKY_RETENTION_JOB_DETAIL_DAYS: 11,
      DUCKY_RETENTION_DONE_CAPTURE_DAYS: 12,
      DUCKY_RETENTION_CLOSED_TASK_DAYS: 13,
      DUCKY_RETENTION_CLOSED_REMINDER_DAYS: 14,
      DUCKY_RETENTION_PAST_SCHEDULE_DAYS: 15,
      DUCKY_RETENTION_AUDIT_DAYS: 16,
      DUCKY_RETENTION_WATCH_EVENTS_DAYS: 17,
      DUCKY_RETENTION_IDEMPOTENCY_DAYS: 18,
      DUCKY_RETENTION_CONVERSATION_OWNER_DAYS: 19,
      DUCKY_RETENTION_CONVERSATION_OTHER_DAYS: 20,
      DUCKY_RETENTION_BATCH: 21,
    });
    expect(policy.jobMetadataDays).toBe(10);
    expect(policy.jobDetailDays).toBe(11);
    expect(policy.doneCaptureDays).toBe(12);
    expect(policy.closedTaskDays).toBe(13);
    expect(policy.closedReminderDays).toBe(14);
    expect(policy.pastScheduleDays).toBe(15);
    expect(policy.auditDays).toBe(16);
    expect(policy.watchEventDays).toBe(17);
    expect(policy.idempotencyDays).toBe(18);
    expect(policy.conversationOwnerDays).toBe(19);
    expect(policy.conversationOtherDays).toBe(20);
    expect(policy.batch).toBe(21);
    // Still fixed, whatever the environment says.
    expect(policy.cancelledWatchDays).toBe(DEFAULT_RETENTION.cancelledWatchDays);
    expect(policy.runLogDays).toBe(DEFAULT_RETENTION.runLogDays);
  });

  it('ships the conservative per-kind defaults the milestone asked for', () => {
    const policy = retentionPolicyFrom(base);
    expect(policy.jobMetadataDays).toBe(90);
    expect(policy.jobDetailDays).toBe(30);
    expect(policy.closedTaskDays).toBe(90);
    expect(policy.closedReminderDays).toBe(90);
    expect(policy.pastScheduleDays).toBe(180);
    expect(policy.auditDays).toBe(90);
    expect(policy.conversationOwnerDays).toBe(30);
    expect(policy.conversationOtherDays).toBe(7);
  });

  it('still honours the two deprecated aliases rather than ignoring them', () => {
    // An operator who set one expressed an intent. Silently dropping a variable
    // that is still in their env file is the worst of the three options.
    const policy = retentionPolicyFrom({
      ...base,
      DUCKY_RETENTION_TERMINAL_JOBS_DAYS: 200,
      DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS: 400,
    });
    expect(policy.jobMetadataDays).toBe(200);
    expect(policy.closedTaskDays).toBe(400);
    expect(policy.closedReminderDays).toBe(400);
    expect(policy.pastScheduleDays).toBe(400);
    expect(policy.doneCaptureDays).toBe(400);
  });

  it('prefers an explicit new value over a deprecated alias', () => {
    const policy = retentionPolicyFrom({
      ...base,
      DUCKY_RETENTION_TERMINAL_JOBS_DAYS: 200,
      DUCKY_RETENTION_JOB_METADATA_DAYS: 45,
    });
    expect(policy.jobMetadataDays).toBe(45);
  });
});

/**
 * The detail of a job goes before the job does.
 *
 * A result snapshot is the most detailed thing Ducky stores about a repository;
 * the job row and its transitions are the shape of what happened. Different
 * lifetimes, so different windows.
 */
describe('job detail and job metadata have different windows', () => {
  const seedJobAt = (
    h: ReturnType<typeof makeHarness>,
    id: string,
    daysAgo: number,
  ): void => {
    const at = iso(daysAgo);
    h.store.db.prepare(
      `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, context, bootstrap,
         state, max_attempts, max_owner_input_rounds, created_at, updated_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, `p-${id}`, h.owner.discordUserId, 'demo', 'task text', null, 0,
      'completed', 3, 3, at, at, at);
    h.store.db.prepare(
      `INSERT INTO job_results (id, job_id, lease_id, result_sha256, verdict, summary_redacted,
         review_json, verification_json, changed_files_json, proposed_actions_json,
         result_snapshot_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `res-${id}`, id, 'lease-1', 'sha', 'implemented', 'did the thing',
      '{}', '{}', '[]', '[]', '{}', at,
    );
    h.store.db.prepare(
      `INSERT INTO job_events (job_id, seq, kind, message_redacted, created_at) VALUES (?,?,?,?,?)`,
    ).run(id, 1, 'submitted', 'queued', at);
  };

  it('strips the result of a job it keeps, once past the detail window', async () => {
    const h = makeHarness();
    // 45 days: past the 30-day detail window, inside the 90-day metadata one.
    seedJobAt(h, 'j1', 45);

    const result = await service(h).tick();

    expect(result.counts.jobsDeleted).toBe(0);
    expect(result.counts.jobDetailRowsDeleted).toBeGreaterThan(0);
    // The job survives its own detail, and every reader already handles that:
    // a queued job has no result either.
    expect(h.store.jobs.byPublicId('p-j1')).toBeDefined();
    expect(h.store.results.byJobId('j1')).toBeUndefined();
    h.close();
  });

  it('keeps the detail of a recent job', async () => {
    const h = makeHarness();
    seedJobAt(h, 'j1', 5);

    const result = await service(h).tick();

    expect(result.counts.jobDetailRowsDeleted).toBe(0);
    expect(h.store.results.byJobId('j1')).toBeDefined();
    h.close();
  });

  it('removes the whole job once past the metadata window', async () => {
    const h = makeHarness();
    seedJobAt(h, 'j1', 120);

    const result = await service(h).tick();

    expect(result.counts.jobsDeleted).toBe(1);
    expect(h.store.jobs.byPublicId('p-j1')).toBeUndefined();
    h.close();
  });

  it('prunes the audit log on its own window, and converges', async () => {
    const h = makeHarness();
    const insertAudit = (at: string) => {
      h.store.db
        .prepare(
          `INSERT INTO audit_log (at, event, actor_kind, actor_ref, outcome)
           VALUES (?, 'job.created', 'system', 'test', 'ok')`,
        )
        .run(at);
    };
    insertAudit(iso(200));
    insertAudit(iso(5));

    const first = await service(h).tick();
    expect(first.counts.auditRowsDeleted).toBe(1);

    const second = await service(h).tick();
    expect(second.counts.auditRowsDeleted).toBe(0);
    h.close();
  });
});
