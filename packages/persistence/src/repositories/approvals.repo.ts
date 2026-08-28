import type {
  ApprovalExecutionState, ApprovalState, ProposedAction,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { ApprovalExecutionRow, ApprovalRow } from './types.js';

const map = (r: Record<string, unknown>): ApprovalRow => ({
  id: String(r['id']),
  jobId: String(r['job_id']),
  actionIndex: Number(r['action_index']),
  actionKind: String(r['action_kind']),
  description: String(r['description']),
  detailsJson: String(r['details_json']),
  state: String(r['state']) as ApprovalState,
  expiresAt: String(r['expires_at']),
  decidedBy: r['decided_by'] == null ? null : String(r['decided_by']),
  decidedAt: r['decided_at'] == null ? null : String(r['decided_at']),
  decisionReason: r['decision_reason'] == null ? null : String(r['decision_reason']),
});

const mapExecution = (r: Record<string, unknown>): ApprovalExecutionRow => ({
  approvalId: String(r['approval_id']),
  jobId: String(r['job_id']),
  state: String(r['state']) as ApprovalExecutionState,
  startedAt: String(r['started_at']),
  finishedAt: r['finished_at'] == null ? null : String(r['finished_at']),
  error: r['error'] == null ? null : String(r['error']),
});

export class ApprovalsRepo {
  constructor(private readonly db: Db) {}

  /** Called only from inside the result-intake transaction. */
  insertMany(jobId: string, actions: readonly ProposedAction[], expiresAt: string, ids: readonly string[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO approvals (id, job_id, action_index, action_kind, description, details_json,
         state, expires_at, created_at) VALUES (?,?,?,?,?,?,'pending',?,?)`,
    );
    const ts = nowIso();
    actions.forEach((a, i) => {
      stmt.run(ids[i]!, jobId, i, a.kind, a.description, JSON.stringify(a.details), expiresAt, ts);
    });
  }

  forJob(jobId: string): ApprovalRow[] {
    return this.db
      .prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY action_index')
      .all(jobId)
      .map((r) => map(r as Record<string, unknown>));
  }

  byId(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  /** Single-use: only a `pending` row can be decided. Returns false if already decided. */
  decide(id: string, state: Exclude<ApprovalState, 'pending'>, by: string, reason: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, decision_reason = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(state, by, nowIso(), reason, id);
    return Number(res.changes) === 1;
  }

  rejectAllPending(jobId: string, by: string, reason: string): number {
    const res = this.db
      .prepare(
        `UPDATE approvals SET state = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ?
         WHERE job_id = ? AND state = 'pending'`,
      )
      .run(by, nowIso(), reason, jobId);
    return Number(res.changes);
  }

  expireAllPending(jobId: string, reason: string): number {
    const res = this.db
      .prepare(
        `UPDATE approvals SET state = 'expired', decided_at = ?, decision_reason = ?
         WHERE job_id = ? AND state = 'pending'`,
      )
      .run(nowIso(), reason, jobId);
    return Number(res.changes);
  }

  pendingCount(jobId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE job_id = ? AND state = 'pending'`)
      .get(jobId) as { n: number };
    return Number(r.n);
  }

  expiredPending(now = nowIso()): ApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE state = 'pending' AND expires_at < ?`)
      .all(now)
      .map((r) => map(r as Record<string, unknown>));
  }

  /** The execution ledger is separate from the approval decision itself. */
  executionByApproval(approvalId: string): ApprovalExecutionRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM approval_executions WHERE approval_id = ?')
      .get(approvalId);
    return r ? mapExecution(r as Record<string, unknown>) : undefined;
  }

  /**
   * Claims the one execution slot. A second process gets false rather than
   * running the same approved Git action twice after a retry.
   */
  beginExecution(approvalId: string, jobId: string, startedAt = nowIso()): boolean {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO approval_executions
             (approval_id, job_id, state, started_at)
           VALUES (?, ?, 'running', ?)`,
        )
        .run(approvalId, jobId, startedAt);
      return Number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  finishExecution(
    approvalId: string,
    state: Exclude<ApprovalExecutionState, 'running'>,
    finishedAt: string,
    error: string | null = null,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approval_executions
            SET state = ?, finished_at = ?, error = ?
          WHERE approval_id = ? AND state = 'running'`,
      )
      .run(state, finishedAt, error, approvalId);
    return Number(result.changes) === 1;
  }
}
