import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { HerdrWorkspaceRow, HerdrWorkspaceState } from './types.js';

const map = (r: Record<string, unknown>): HerdrWorkspaceRow => ({
  workspaceId: String(r['workspace_id']),
  repoSlug: String(r['repo_slug']),
  jobId: String(r['job_id']),
  label: String(r['label']),
  mode: String(r['mode']) as 'worktree' | 'direct',
  agentName: String(r['agent_name']),
  worktreePath: r['worktree_path'] == null ? null : String(r['worktree_path']),
  workspacePath: r['workspace_path'] == null ? null : String(r['workspace_path']),
  state: String(r['state'] ?? 'active') as HerdrWorkspaceState,
  createdAt: String(r['created_at']),
  closedAt: r['closed_at'] == null ? null : String(r['closed_at']),
});

/** The authoritative ownership record for anything Ducky created in Herdr. */
export class HerdrWorkspacesRepo {
  constructor(private readonly db: Db) {}

  /**
   * Idempotent: a retried registration for the same workspace only advances its
   * state and refreshes the timestamp. It never reassigns the workspace to a
   * different job, so a stale executor cannot steal a live workspace.
   *
   * Returns false when the row exists but belongs to another job -- the caller
   * must treat that as a conflict rather than success.
   */
  record(row: Omit<HerdrWorkspaceRow, 'createdAt' | 'closedAt' | 'updatedAt'>): boolean {
    const ts = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO herdr_workspaces (workspace_id, repo_slug, job_id, label, mode, agent_name,
           worktree_path, workspace_path, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           state = excluded.state,
           agent_name = excluded.agent_name,
           workspace_path = COALESCE(excluded.workspace_path, herdr_workspaces.workspace_path),
           worktree_path = COALESCE(excluded.worktree_path, herdr_workspaces.worktree_path),
           updated_at = excluded.updated_at
         WHERE herdr_workspaces.job_id = excluded.job_id`,
      )
      .run(
        row.workspaceId, row.repoSlug, row.jobId, row.label, row.mode, row.agentName,
        row.worktreePath, row.workspacePath, row.state, ts, ts,
      );
    // The guarded upsert is a NO-OP when the workspace belongs to another job.
    // Reporting that lets the caller fail loudly instead of assuming success.
    return Number(res.changes) > 0;
  }

  /** Ownership proof by agent name, used when recovering after a crash. */
  openByAgentName(agentName: string): HerdrWorkspaceRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM herdr_workspaces WHERE agent_name = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get(agentName);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  byWorkspaceId(id: string): HerdrWorkspaceRow | undefined {
    const r = this.db.prepare('SELECT * FROM herdr_workspaces WHERE workspace_id = ?').get(id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  openForJob(jobId: string): HerdrWorkspaceRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM herdr_workspaces WHERE job_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get(jobId);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  openForRepo(repoSlug: string): HerdrWorkspaceRow[] {
    return this.db
      .prepare('SELECT * FROM herdr_workspaces WHERE repo_slug = ? AND closed_at IS NULL')
      .all(repoSlug)
      .map((r) => map(r as Record<string, unknown>));
  }

  markClosed(workspaceId: string): void {
    this.db
      .prepare('UPDATE herdr_workspaces SET closed_at = ? WHERE workspace_id = ?')
      .run(nowIso(), workspaceId);
  }

  /** Ownership is proved by presence here, never by a Herdr label alone. */
  isDuckyOwned(workspaceId: string): boolean {
    return this.byWorkspaceId(workspaceId) !== undefined;
  }

  staleOpen(cutoffIso: string): HerdrWorkspaceRow[] {
    return this.db
      .prepare('SELECT * FROM herdr_workspaces WHERE closed_at IS NULL AND created_at < ?')
      .all(cutoffIso)
      .map((r) => map(r as Record<string, unknown>));
  }
}
