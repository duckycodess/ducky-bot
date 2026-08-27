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
