/**
 * The structured audit log's vocabulary.
 *
 * Two rules govern everything here, and they are the reason the table exists
 * at all rather than "just log it":
 *
 * 1. **The audit log is a RECORD, never an authority.** Nothing reads it to
 *    decide anything. Authorization is frozen environment configuration
 *    (ADR 0009) and the job state machine is the database; a row here grants
 *    nothing and blocks nothing, exactly as `authorized_user_audit` already
 *    does not.
 * 2. **It holds no secret, no raw authentication material, no terminal
 *    output, no environment, and no more identity than it needs.** Every
 *    free-text field is redacted and clamped before it is written. The actor
 *    is a ROLE plus a non-secret reference (an executor id), never a bearer
 *    token, never a signature, never a Discord user id.
 */

export const AUDIT_ACTOR_KINDS = ['owner', 'executor', 'system', 'reconciler'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_SUBJECT_KINDS = ['job', 'approval', 'executor', 'dependency'] as const;
export type AuditSubjectKind = (typeof AUDIT_SUBJECT_KINDS)[number];

export const AUDIT_OUTCOMES = ['ok', 'refused', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * The complete set of auditable events.
 *
 * Closed on purpose: an open string would make the table impossible to query
 * and impossible to reason about, and would let a caller invent an event name
 * carrying data that belongs nowhere near an audit row.
 */
export const AUDIT_EVENTS = [
  'job.created',
  'job.claimed',
  'job.transitioned',
  'job.phase_changed',
  'job.cancel_requested',
  'job.cancelled',
  'job.failed',
  'approval.decided',
  'approval.execution_started',
  'approval.execution_succeeded',
  'approval.execution_failed',
  'executor.connected',
  'executor.offline',
  'dependency.recorded',
  'dependency.checked',
  'dependency.resolved',
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/**
 * The literal actor reference used for the owner.
 *
 * Deliberately NOT the Discord user id. There is exactly one owner, frozen in
 * configuration, so the id adds no information an auditor could use and would
 * be unnecessary personal data sitting in a long-lived table.
 */
export const AUDIT_OWNER_REF = 'owner' as const;

/**
 * Field names a detail string must never contain, asserted by a test.
 *
 * The real guarantee is that details are constructed from fixed strings and
 * already-redacted values; this is the tripwire that catches somebody passing
 * a whole object through in a hurry.
 */
export const AUDIT_FORBIDDEN_SUBSTRINGS = [
  'authorization',
  'bearer ',
  'x-ducky-signature',
  'hmac',
  'secret',
  'password',
  'token',
  'private key',
] as const;
