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

export const AUDIT_SUBJECT_KINDS = [
  'job',
  'approval',
  'executor',
  'dependency',
  /** A credential key id. Not secret, and genuinely identifying. */
  'credential',
  /** A retention or deletion pass, referenced by its run id. */
  'retention',
  /** An HTTP route or a Discord command, for a refusal or a rate limit. */
  'route',
  /** A configuration key by NAME. Never its value. */
  'config',
  /** A provider, by its own reported name. */
  'provider',
  /**
   * Stored conversation turns, referenced by scope (`all`, or a thread) and
   * never by content. A deletion record that quoted what it deleted would
   * defeat the deletion.
   */
  'conversation',
  /**
   * One of the owner's own records, deleted by hand: `task:tabc12`,
   * `capture:9f2c…`. The KIND and the id the owner already had -- never the
   * title, the text or the content.
   *
   * Distinct from `conversation` because filing a task under a conversation
   * subject would make the audit trail say something untrue about what was
   * removed, and an audit trail that misdescribes a deletion is worse than a
   * coarse one.
   */
  'record',
] as const;
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

  // ---- security events -----------------------------------------------------
  //
  // Added because the audit log recorded the lifecycle in detail and recorded
  // nothing at all about who was turned away. All four below are influenced by
  // whoever is sending traffic, so each records a CODE and a non-secret
  // reference, never the material that failed: an audit row that quoted a bad
  // bearer token would be the leak it exists to detect.
  //
  // Volume is bounded the same way every other row is -- clamped detail, and
  // the reconciler prunes past `AUDIT_RETENTION_MS`.
  /** Executor authentication failed. Never says WHY, matching the 401. */
  'auth.failed',
  /** A single-use nonce was presented twice. */
  'auth.replay_detected',
  /** A non-owner reached a privileged surface and was refused. */
  'authz.refused',
  /** A bucket or route budget was exhausted. */
  'rate_limit.exceeded',
  /** The runtime credential store reloaded from its file. */
  'credential.reloaded',

  // ---- retention and deletion ---------------------------------------------
  //
  // These two are the audit trail for the only paths in this codebase that
  // remove the owner's data, so they are the rows that matter most. Both record
  // COUNTS, never content: the point of a deletion record is to say that data
  // went, not to keep a copy of it.
  /** A scheduled or manual retention pass finished. */
  'retention.pruned',
  /** The owner deleted one specific entity. */
  'data.deleted',

  // ---- approvals and actions ----------------------------------------------
  //
  // `approval.decided` recorded the owner's answer but nothing recorded that an
  // approval had been ASKED for, or that one lapsed unanswered. An audit trail
  // that shows decisions and not requests cannot answer "what was pending on
  // the day of the incident".
  /** A result proposed consequential actions, so approvals were created. */
  'approval.requested',
  /** A pending approval lapsed unanswered and the job was settled. */
  'approval.expired',

  // ---- integrations and configuration -------------------------------------
  /**
   * A provider refused or failed at the boundary -- a conversation backend, a
   * dependency checker, an extraction provider. Recorded because "the owner got
   * no answer" is otherwise invisible in the trail.
   */
  'provider.failed',
  /**
   * Configuration was rejected. Only reachable where persistence is possible:
   * a startup config error happens before the database exists, so those are
   * logged, not audited. See docs/SECURITY.md.
   */
  'config.rejected',
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
