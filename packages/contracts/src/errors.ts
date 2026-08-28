export type DuckyErrorCode =
  | 'unauthorized'
  | 'repo_not_allowed'
  | 'repo_not_initialized'
  | 'repo_already_initialized'
  | 'bootstrap_directory_not_empty'
  | 'base_ref_not_found'
  | 'branch_already_exists'
  | 'invalid_transition'
  | 'lease_mismatch'
  | 'result_conflict'
  | 'replay_detected'
  | 'credential_unavailable'
  | 'integration_not_verified'
  | 'result_rejected'
  | 'attachment_rejected'
  | 'extraction_expired'
  | 'not_found'
  | 'rate_limited'
  | 'herdr_unavailable'
  /**
   * `herdr agent prompt --wait` observed no lifecycle change within its own
   * stall window. The agent and the Herdr server are both fine, so this is
   * deliberately NOT an outage: treating it as one would release a repository
   * whose pane may still hold a live writer.
   */
  | 'herdr_prompt_stalled'
  /**
   * A worktree checkout still holds modified or untracked files, so Herdr
   * refuses to remove it without `--force`.
   *
   * Ducky deliberately does NOT force. A completed job's implementation lives
   * in that checkout and nothing has committed it -- the brief forbids
   * committing -- so forcing the removal would delete the very work the job
   * was asked to do.
   */
  | 'herdr_worktree_dirty'
  /**
   * `agent start` returned, but the agent could not accept input yet.
   *
   * Herdr documents `agent start` as returning once the agent "is ready for
   * input", and it usually is -- but observed live on this host, a resumed Pi
   * session printed enough banner output that detection succeeded seconds
   * before the input surface was usable, and the prompt three seconds later
   * was refused with `agent_not_ready`. Transient, and retryable.
   */
  | 'herdr_agent_not_ready'
  | 'foreign_agent_conflict'
  | 'orphan_agent'
  | 'not_enabled_in_phase1'
  | 'invalid_input';

export class DuckyError extends Error {
  readonly code: DuckyErrorCode;
  /** Safe to show the owner. Never contains secrets or absolute host paths. */
  readonly ownerMessage: string;
  readonly details?: Record<string, unknown>;

  constructor(code: DuckyErrorCode, ownerMessage: string, details?: Record<string, unknown>) {
    super(`${code}: ${ownerMessage}`);
    this.name = 'DuckyError';
    this.code = code;
    this.ownerMessage = ownerMessage;
    if (details) this.details = details;
  }
}

export const isDuckyError = (e: unknown): e is DuckyError => e instanceof DuckyError;

export const unauthorized = () => new DuckyError('unauthorized', 'You are not authorized to do that.');
