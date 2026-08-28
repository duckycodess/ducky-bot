import type {
  DependencyCheckStatus, DependencyState, DependencyType,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import type { DependencyRow } from './types.js';

const map = (r: Record<string, unknown>): DependencyRow => ({
  id: String(r['id']),
  jobId: String(r['job_id']),
  type: String(r['type']) as DependencyType,
  description: String(r['description']),
  externalKey: r['external_key'] == null ? null : String(r['external_key']),
  state: String(r['state']) as DependencyState,
  nextCheckAt: r['next_check_at'] == null ? null : String(r['next_check_at']),
  checksMade: Number(r['checks_made']),
  maxChecks: Number(r['max_checks']),
  deadlineAt: String(r['deadline_at']),
  lastCheckAt: r['last_check_at'] == null ? null : String(r['last_check_at']),
  lastStatus: r['last_status'] == null ? null : (String(r['last_status']) as DependencyCheckStatus),
  lastDetail: r['last_detail'] == null ? null : String(r['last_detail']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  resolvedAt: r['resolved_at'] == null ? null : String(r['resolved_at']),
});

/**
 * What a job is blocked on, and the schedule for finding out whether it still
 * is.
 *
 * The row IS the schedule. `next_check_at` is the only cursor the resolver
 * reads, and advancing it inside the same transaction as the check result is
 * what stops a repeated or overlapping tick from checking the same dependency
 * twice in a row. Both ceilings -- the check count and the wall-clock deadline
 * -- live here too, so a dependency that nobody can resolve still stops on its
 * own rather than holding a repository forever.
 */
export class DependenciesRepo {
  constructor(private readonly db: Db) {}

  insert(row: {
    id: string;
    jobId: string;
    type: DependencyType;
    description: string;
    externalKey: string | null;
    nextCheckAt: string;
    maxChecks: number;
    deadlineAt: string;
    createdAt: string;
  }): DependencyRow {
    this.db
      .prepare(
        `INSERT INTO job_dependencies
           (id, job_id, type, description, external_key, state, next_check_at,
            checks_made, max_checks, deadline_at, created_at, updated_at)
         VALUES (?,?,?,?,?, 'waiting', ?, 0, ?,?,?,?)`,
      )
      .run(
        row.id, row.jobId, row.type, row.description, row.externalKey,
        row.nextCheckAt, row.maxChecks, row.deadlineAt, row.createdAt, row.createdAt,
      );
    return this.byId(row.id)!;
  }

  byId(id: string): DependencyRow | undefined {
    const r = this.db.prepare('SELECT * FROM job_dependencies WHERE id = ?').get(id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  /** The one open dependency for a job, if it has one. */
  openForJob(jobId: string): DependencyRow | undefined {
    const r = this.db
      .prepare(`SELECT * FROM job_dependencies WHERE job_id = ? AND state = 'waiting'`)
      .get(jobId);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  /** Every dependency a job has ever had, newest last. Shown in job detail. */
  forJob(jobId: string): DependencyRow[] {
    return this.db
      .prepare('SELECT * FROM job_dependencies WHERE job_id = ? ORDER BY created_at, id')
      .all(jobId)
      .map((r) => map(r as Record<string, unknown>));
  }

  /**
   * Dependencies whose next check is due, oldest cursor first and BOUNDED by
   * `limit`, so one tick can never fan out without limit however many are
   * outstanding.
   */
  due(nowIso: string, limit: number): DependencyRow[] {
    return this.db
      .prepare(
        `SELECT * FROM job_dependencies
          WHERE state = 'waiting' AND next_check_at IS NOT NULL AND next_check_at <= ?
          ORDER BY next_check_at ASC
          LIMIT ?`,
      )
      .all(nowIso, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  /**
   * Records one check and moves the cursor, together.
   *
   * `expectedChecksMade` is a compare-and-set on the row the resolver read: if
   * anything advanced the dependency in between, nothing is written and this
   * returns false. That is what makes the bounded budget actually bounded --
   * two overlapping ticks cannot each spend a check.
   */
  recordCheck(input: {
    id: string;
    expectedChecksMade: number;
    status: DependencyCheckStatus;
    detail: string | null;
    nextCheckAt: string;
    atIso: string;
  }): boolean {
    const info = this.db
      .prepare(
        `UPDATE job_dependencies
            SET checks_made = checks_made + 1,
                last_check_at = ?, last_status = ?, last_detail = ?,
                next_check_at = ?, updated_at = ?
          WHERE id = ? AND state = 'waiting' AND checks_made = ?`,
      )
      .run(
        input.atIso, input.status, input.detail, input.nextCheckAt, input.atIso,
        input.id, input.expectedChecksMade,
      );
    return Number(info.changes) === 1;
  }

  /**
   * Closes a dependency. The cursor is cleared in the same statement, which
   * the schema requires: a non-waiting row with a next check would be a
   * dependency nothing owns but something would still poll.
   */
  resolve(input: {
    id: string;
    state: Exclude<DependencyState, 'waiting'>;
    detail: string | null;
    atIso: string;
    /** Count this closing observation as a check, when it was one. */
    countCheck?: boolean;
    status?: DependencyCheckStatus;
    /** Optional compare-and-set for a resolver result. */
    expectedChecksMade?: number;
  }): boolean {
    const cas = input.expectedChecksMade === undefined ? '' : ' AND checks_made = ?';
    const args: unknown[] = [
      input.state, input.atIso, input.atIso,
      input.countCheck ? 1 : 0,
      input.countCheck ? 1 : 0, input.atIso,
      input.status ?? null,
      input.detail,
      input.id,
    ];
    if (input.expectedChecksMade !== undefined) args.push(input.expectedChecksMade);
    const info = this.db
      .prepare(
        `UPDATE job_dependencies
            SET state = ?, next_check_at = NULL, resolved_at = ?, updated_at = ?,
                checks_made = checks_made + ?,
                last_check_at = CASE WHEN ? = 1 THEN ? ELSE last_check_at END,
                last_status = COALESCE(?, last_status),
                last_detail = COALESCE(?, last_detail)
          WHERE id = ? AND state = 'waiting'${cas}`,
      )
      .run(...(args as never[]));
    return Number(info.changes) === 1;
  }

  /**
   * Cancels whatever a job is still waiting on. Used when the job itself is
   * cancelled: a dependency with no live job must stop being checked, or the
   * resolver would keep spending budget on work nobody wants.
   */
  cancelOpenForJob(jobId: string, atIso: string): number {
    const info = this.db
      .prepare(
        `UPDATE job_dependencies
            SET state = 'cancelled', next_check_at = NULL, resolved_at = ?, updated_at = ?
          WHERE job_id = ? AND state = 'waiting'`,
      )
      .run(atIso, atIso, jobId);
    return Number(info.changes);
  }

  countByState(state: DependencyState): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM job_dependencies WHERE state = ?')
      .get(state) as { n: number };
    return Number(r.n);
  }
}
