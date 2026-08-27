import type { JobResultFile } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';

export interface JobResultRow {
  id: string;
  jobId: string;
  leaseId: string;
  resultSha256: string;
  verdict: string;
  summaryRedacted: string;
  proposedActions: JobResultFile['proposedActions'];
  snapshot: JobResultFile;
  createdAt: string;
}

export class ResultsRepo {
  constructor(private readonly db: Db) {}

  /** Insert-only: an AFTER-UPDATE trigger aborts any attempt to mutate a snapshot. */
  insert(row: {
    id: string;
    jobId: string;
    leaseId: string;
    resultSha256: string;
    result: JobResultFile;
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_results (id, job_id, lease_id, result_sha256, verdict, summary_redacted,
           review_json, verification_json, changed_files_json, proposed_actions_json,
           result_snapshot_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.jobId,
        row.leaseId,
        row.resultSha256,
        row.result.verdict,
        row.result.summary,
        JSON.stringify(row.result.review),
        JSON.stringify(row.result.verification),
        JSON.stringify(row.result.changedFiles),
        JSON.stringify(row.result.proposedActions),
        JSON.stringify(row.result),
        nowIso(),
      );
  }

  /** The most recent turn's result. */
  byJobId(jobId: string): JobResultRow | undefined {
    return this.map(
      this.db
        .prepare('SELECT * FROM job_results WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .get(jobId),
    );
  }

  /** The result recorded for one specific executor turn. */
  byLease(jobId: string, leaseId: string): JobResultRow | undefined {
    return this.map(
      this.db.prepare('SELECT * FROM job_results WHERE job_id = ? AND lease_id = ?').get(jobId, leaseId),
    );
  }

  countForJob(jobId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?').get(jobId) as {
      n: number;
    };
    return Number(r.n);
  }

  private map(raw: unknown): JobResultRow | undefined {
    if (!raw) return undefined;
    const r = raw as Record<string, unknown>;
    return {
      id: String(r['id']),
      jobId: String(r['job_id']),
      leaseId: String(r['lease_id']),
      resultSha256: String(r['result_sha256']),
      verdict: String(r['verdict']),
      summaryRedacted: String(r['summary_redacted']),
      proposedActions: JSON.parse(String(r['proposed_actions_json'])),
      snapshot: JSON.parse(String(r['result_snapshot_json'])) as JobResultFile,
      createdAt: String(r['created_at']),
    };
  }
}
