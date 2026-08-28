import {
  RETENTION_FORBIDDEN_TABLES,
  type ForgetRefusal, type RetentionOutcome, type RetentionTrigger,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso, withTransaction } from '../db.js';

/**
 * The ONE place that deletes the owner's data.
 *
 * Both the scheduled retention pass and the owner's `/forget job` go through
 * `deleteJobUnit` below, so there is a single deletion order to get right and a
 * single set of guards to satisfy. Two implementations would eventually
 * disagree about which is authoritative.
 *
 * The order is explicit rather than delegated to `ON DELETE CASCADE`: every
 * foreign key into `jobs` is `NO ACTION` on purpose, so a mis-scoped delete
 * fails loudly at the constraint instead of silently taking half the database
 * with it.
 */

/** Tables this repo will not name, asserted by a test over the source. */
export const FORBIDDEN = RETENTION_FORBIDDEN_TABLES;

export interface JobUnitGuard {
  readonly ok: boolean;
  readonly refusal?: ForgetRefusal;
}

export interface JobUnitDeletion {
  readonly jobsDeleted: number;
  readonly childRowsDeleted: number;
}

export class RetentionRepo {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------- guards ----

  /**
   * Whether a job may be removed at all.
   *
   * Six independent conditions, each of which means something is still LIVE.
   * They are checked as one query set inside the caller's transaction, so a job
   * cannot pass the guard and then acquire a reservation before the delete.
   *
   * A retention pass counts a refusal and moves on; `/forget` reports it to the
   * owner verbatim. Neither ever deletes part of a unit.
   */
  guardJobUnit(jobId: string): JobUnitGuard {
    const job = this.db
      .prepare('SELECT state, finished_at FROM jobs WHERE id = ?')
      .get(jobId) as { state?: string; finished_at?: string | null } | undefined;

    if (!job) return { ok: false, refusal: 'unknown_job' };
    if (!['completed', 'failed', 'cancelled'].includes(String(job.state))) {
      return { ok: false, refusal: 'job_still_running' };
    }
    if (job.finished_at == null) return { ok: false, refusal: 'job_still_running' };

    if (this.exists('SELECT 1 FROM repo_reservations WHERE job_id = ?', jobId)) {
      return { ok: false, refusal: 'reservation_held' };
    }
    if (this.exists('SELECT 1 FROM herdr_workspaces WHERE job_id = ? AND closed_at IS NULL', jobId)) {
      return { ok: false, refusal: 'workspace_open' };
    }
    if (this.exists("SELECT 1 FROM approvals WHERE job_id = ? AND state = 'pending'", jobId)) {
      return { ok: false, refusal: 'approval_pending' };
    }
    if (this.exists('SELECT 1 FROM job_dependencies WHERE job_id = ? AND resolved_at IS NULL', jobId)) {
      return { ok: false, refusal: 'dependency_open' };
    }
    return { ok: true };
  }

  private exists(sql: string, param: string): boolean {
    return this.db.prepare(sql).get(param) !== undefined;
  }

  // ------------------------------------------------------------ deletes ----

  /**
   * Removes one job and everything that references it, child-first.
   *
   * Ordering constraints, all from the live foreign-key graph:
   *   - `approval_executions.approval_id` -> `approvals.id`, so executions go first;
   *   - `job_notification_deliveries.transition_id` -> `job_transitions.id`,
   *     so deliveries go before transitions -- and they go TOGETHER, which is
   *     what stops a pruned transition reappearing as an undelivered
   *     notification on the next sweep;
   *   - everything keyed on `job_id` goes before `jobs`.
   *
   * `repo_reservations` is deliberately absent: a reservation for a terminal job
   * is an inconsistency the guard refuses on, not something to clean up here.
   *
   * Caller supplies the transaction. Both callers wrap the guard and this
   * together, so nothing can change underneath the check.
   */
  deleteJobUnit(jobId: string): JobUnitDeletion {
    let childRowsDeleted = 0;
    const del = (sql: string): void => {
      childRowsDeleted += this.db.prepare(sql).run(jobId).changes as number;
    };

    del('DELETE FROM approval_executions WHERE job_id = ?');
    del('DELETE FROM approvals WHERE job_id = ?');
    del('DELETE FROM job_notification_deliveries WHERE job_id = ?');
    del('DELETE FROM job_transitions WHERE job_id = ?');
    del('DELETE FROM job_events WHERE job_id = ?');
    del('DELETE FROM job_owner_inputs WHERE job_id = ?');
    del('DELETE FROM job_results WHERE job_id = ?');
    del('DELETE FROM job_dependencies WHERE job_id = ?');
    // No foreign key, but the guard has proved every row is closed.
    del('DELETE FROM herdr_workspaces WHERE job_id = ?');

    const jobsDeleted = this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
      .changes as number;
    return { jobsDeleted, childRowsDeleted };
  }

  /** Terminal jobs old enough to consider, oldest first, bounded. */
  terminalJobsBefore(cutoffIso: string, limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM jobs
            WHERE state IN ('completed','failed','cancelled')
              AND finished_at IS NOT NULL
              AND finished_at < ?
            ORDER BY finished_at
            LIMIT ?`,
        )
        .all(cutoffIso, limit) as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * Deletes the DETAILED payload of a terminal job while keeping the job.
   *
   * The two have genuinely different lifetimes. A result snapshot carries the
   * summary, the review notes, the verification output and the changed-file
   * list -- the most detailed thing Ducky stores about a repository -- while the
   * job row and its transitions are the shape of what happened, which is what a
   * later question is usually about. So the payload goes at 30 days and the
   * metadata at 90.
   *
   * Safe because every reader already treats a missing result as normal: a
   * queued job has none, so both `JobsService.detail` and the shared projection
   * were written to handle its absence from the start.
   *
   * Only ever rows of jobs that are terminal AND finished before the cutoff.
   * A live job's result is untouchable here.
   */
  deleteOldJobDetails(cutoffIso: string, limit: number): { results: number; events: number; ownerInputs: number } {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM jobs
            WHERE state IN ('completed','failed','cancelled')
              AND finished_at IS NOT NULL
              AND finished_at < ?
            ORDER BY finished_at
            LIMIT ?`,
        )
        .all(cutoffIso, limit) as { id: string }[]
    ).map((r) => r.id);

    let results = 0;
    let events = 0;
    let ownerInputs = 0;
    const resultStmt = this.db.prepare('DELETE FROM job_results WHERE job_id = ?');
    const eventStmt = this.db.prepare('DELETE FROM job_events WHERE job_id = ?');
    const inputStmt = this.db.prepare('DELETE FROM job_owner_inputs WHERE job_id = ?');
    for (const id of ids) {
      results += resultStmt.run(id).changes as number;
      events += eventStmt.run(id).changes as number;
      ownerInputs += inputStmt.run(id).changes as number;
    }
    return { results, events, ownerInputs };
  }

  /**
   * Prunes the general audit log.
   *
   * Moved here from the reconciler's own fixed 90-day prune so that ONE policy
   * describes every window. The reconciler's prune stays where it is for an
   * instance with retention disabled -- an audit log is bounded whether or not
   * an operator opted into retention.
   */
  deleteOldAuditRows(cutoffIso: string, limit: number): number {
    return this.runLimited(
      'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? LIMIT ?)',
      cutoffIso,
      limit,
    );
  }

  // Each of the following deletes only rows the policy has finished with. The
  // predicates are duplicated in the partial indexes of migration 12, so the
  // planner can satisfy them without a scan.

  deleteClosedCaptures(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM captures WHERE id IN (
         SELECT id FROM captures
          WHERE status IN ('done','archived') AND updated_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  deleteClosedTasks(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM tasks WHERE id IN (
         SELECT id FROM tasks
          WHERE status IN ('done','cancelled') AND closed_at IS NOT NULL
            AND closed_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  /** Cascades `reminder_occurrences` by foreign key, which is why it counts them. */
  deleteClosedReminders(cutoffIso: string, limit: number): { reminders: number; occurrences: number } {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM reminders
            WHERE closed_at IS NOT NULL AND closed_at < ?
            ORDER BY closed_at LIMIT ?`,
        )
        .all(cutoffIso, limit) as { id: string }[]
    ).map((r) => r.id);

    let occurrences = 0;
    let reminders = 0;
    for (const id of ids) {
      occurrences += this.db
        .prepare('DELETE FROM reminder_occurrences WHERE reminder_id = ?')
        .run(id).changes as number;
      reminders += this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id)
        .changes as number;
    }
    return { reminders, occurrences };
  }

  /** Settled occurrences of reminders that are still open. */
  deleteSettledOccurrences(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM reminder_occurrences WHERE id IN (
         SELECT id FROM reminder_occurrences
          WHERE (delivered_at IS NOT NULL OR abandoned_at IS NOT NULL)
            AND created_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  /**
   * Candidate schedules, selected on a REAL INSTANT.
   *
   * `schedules.starts_at` is bare wall-clock text in the owner's zone --
   * `2026-09-01 09:00`, no zone, no offset (ADR 0014). Comparing it lexically to
   * a UTC ISO cutoff, which is what this used to do, is wrong twice: the shapes
   * differ (`T` vs a space, an absent `Z`) and it silently ignores
   * `DUCKY_OWNER_TIMEZONE`, so a same-day row can fall on either side of the
   * boundary depending on the offset.
   *
   * So the SQL filters only on `confirmed_at`, which IS a stored UTC instant,
   * and the caller applies the zone-aware test to `startsAt`. Two conditions
   * have to hold before a schedule goes: it was confirmed long ago AND the event
   * itself is genuinely past in the owner's zone.
   */
  pastScheduleCandidates(
    confirmedBeforeIso: string,
    limit: number,
  ): { id: string; startsAt: string }[] {
    return (
      this.db
        .prepare(
          `SELECT id, starts_at FROM schedules
            WHERE confirmed_at IS NOT NULL AND confirmed_at < ?
            ORDER BY confirmed_at
            LIMIT ?`,
        )
        .all(confirmedBeforeIso, limit) as { id: string; starts_at: string }[]
    ).map((r) => ({ id: r.id, startsAt: r.starts_at }));
  }

  /** Removes exactly the schedules named. No predicate, no window, no wildcard. */
  deleteSchedulesByIds(ids: readonly string[]): number {
    let deleted = 0;
    const stmt = this.db.prepare('DELETE FROM schedules WHERE id = ?');
    for (const id of ids) deleted += stmt.run(id).changes as number;
    return deleted;
  }

  deleteSettledWatchEvents(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM github_watch_events WHERE id IN (
         SELECT id FROM github_watch_events
          WHERE (delivered_at IS NOT NULL OR abandoned_at IS NOT NULL)
            AND created_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  /** Cancelled watches only. An active watch is never touched. */
  deleteCancelledWatches(cutoffIso: string, limit: number): { watches: number; events: number } {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM github_watches
            WHERE cancelled_at IS NOT NULL AND cancelled_at < ?
            ORDER BY cancelled_at LIMIT ?`,
        )
        .all(cutoffIso, limit) as { id: string }[]
    ).map((r) => r.id);

    let events = 0;
    let watches = 0;
    for (const id of ids) {
      events += this.db.prepare('DELETE FROM github_watch_events WHERE watch_id = ?').run(id)
        .changes as number;
      watches += this.db.prepare('DELETE FROM github_watches WHERE id = ?').run(id)
        .changes as number;
    }
    return { watches, events };
  }

  /**
   * Closed workspace rows whose job has already gone (or was never pruned).
   *
   * Scoped to CLOSED rows only. An open row means a live Herdr workspace, and
   * removing its record would strand the workspace with nothing to clean it up.
   */
  deleteClosedWorkspaces(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM herdr_workspaces WHERE workspace_id IN (
         SELECT workspace_id FROM herdr_workspaces
          WHERE closed_at IS NOT NULL AND closed_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  deleteIdempotencyKeys(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM idempotency_keys WHERE key IN (
         SELECT key FROM idempotency_keys WHERE created_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  deleteOldRunLog(cutoffIso: string, limit: number): number {
    return this.runLimited(
      `DELETE FROM retention_runs WHERE id IN (
         SELECT id FROM retention_runs WHERE started_at < ? LIMIT ?)`,
      cutoffIso,
      limit,
    );
  }

  private runLimited(sql: string, cutoffIso: string, limit: number): number {
    return this.db.prepare(sql).run(cutoffIso, limit).changes as number;
  }

  // ----------------------------------------------------------- run log ----

  // ---- per-entity deletion, for the owner's own `/forget` -----------------
  //
  // The SAME delete statements the scheduled pass uses, narrowed to one row and
  // always scoped to the owner. Owner-scoped in the WHERE clause rather than
  // checked beforehand: a lookup then a delete is two statements that can
  // disagree, and the id the owner typed came from a message.
  //
  // Captures and schedule entries have no short public handle -- the surfaces
  // that list them show the first 8 characters of the uuid -- so both accept a
  // PREFIX and refuse an ambiguous one. Everything else takes the public id.

  /** Candidate ids for a prefix, owner-scoped. More than one means ambiguous. */
  private idsByPrefix(table: 'captures' | 'schedules', ownerId: string, prefix: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM ${table} WHERE discord_user_id = ? AND id LIKE ? || '%' LIMIT 5`,
        )
        .all(ownerId, prefix) as { id: string }[]
    ).map((r) => r.id);
  }

  captureIdsByPrefix(ownerId: string, prefix: string): string[] {
    return this.idsByPrefix('captures', ownerId, prefix);
  }

  scheduleIdsByPrefix(ownerId: string, prefix: string): string[] {
    return this.idsByPrefix('schedules', ownerId, prefix);
  }

  deleteCaptureById(ownerId: string, id: string): number {
    return this.db
      .prepare('DELETE FROM captures WHERE id = ? AND discord_user_id = ?')
      .run(id, ownerId).changes as number;
  }

  deleteScheduleById(ownerId: string, id: string): number {
    return this.db
      .prepare('DELETE FROM schedules WHERE id = ? AND discord_user_id = ?')
      .run(id, ownerId).changes as number;
  }

  deleteTaskByPublicId(ownerId: string, publicId: string): number {
    return this.db
      .prepare('DELETE FROM tasks WHERE public_id = ? AND discord_user_id = ?')
      .run(publicId, ownerId).changes as number;
  }

  /**
   * Child-first, in one call: the occurrence outbox goes with its reminder.
   *
   * Same order as `deleteClosedReminders`, because there is one deletion order
   * for this shape and two that could drift apart would be a bug waiting to
   * happen.
   */
  deleteReminderByPublicId(
    ownerId: string,
    publicId: string,
  ): { reminders: number; occurrences: number } {
    const row = this.db
      .prepare('SELECT id FROM reminders WHERE public_id = ? AND discord_user_id = ?')
      .get(publicId, ownerId) as { id: string } | undefined;
    if (!row) return { reminders: 0, occurrences: 0 };

    const occurrences = this.db
      .prepare('DELETE FROM reminder_occurrences WHERE reminder_id = ?')
      .run(row.id).changes as number;
    const reminders = this.db
      .prepare('DELETE FROM reminders WHERE id = ? AND discord_user_id = ?')
      .run(row.id, ownerId).changes as number;
    return { reminders, occurrences };
  }

  startRun(trigger: RetentionTrigger): number {
    const res = this.db
      .prepare('INSERT INTO retention_runs (started_at, trigger, outcome) VALUES (?,?,?)')
      .run(nowIso(), trigger, 'ok');
    return Number(res.lastInsertRowid);
  }

  finishRun(id: number, outcome: RetentionOutcome, counts: unknown): void {
    this.db
      .prepare('UPDATE retention_runs SET finished_at = ?, outcome = ?, counts_json = ? WHERE id = ?')
      .run(nowIso(), outcome, JSON.stringify(counts), id);
  }

  lastRun(): { id: number; startedAt: string; outcome: string; countsJson: string } | undefined {
    const r = this.db
      .prepare('SELECT id, started_at, outcome, counts_json FROM retention_runs ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: Number(r['id']),
      startedAt: String(r['started_at']),
      outcome: String(r['outcome']),
      countsJson: String(r['counts_json']),
    };
  }

  /** Convenience for callers that want the guard and the delete atomically. */
  deleteJobUnitGuarded(jobId: string): { deleted: JobUnitDeletion } | { refusal: ForgetRefusal } {
    return withTransaction(this.db, () => {
      const guard = this.guardJobUnit(jobId);
      if (!guard.ok) return { refusal: guard.refusal ?? 'unknown_job' };
      return { deleted: this.deleteJobUnit(jobId) };
    });
  }
}
