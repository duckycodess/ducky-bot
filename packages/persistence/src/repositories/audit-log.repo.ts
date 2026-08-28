import {
  AUDIT_DETAIL_MAX, AUDIT_SUBJECT_REF_MAX,
  type AuditActorKind, type AuditEvent, type AuditOutcome, type AuditSubjectKind,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { AuditLogRow } from './types.js';

const map = (r: Record<string, unknown>): AuditLogRow => ({
  id: Number(r['id']),
  at: String(r['at']),
  event: String(r['event']) as AuditEvent,
  actorKind: String(r['actor_kind']) as AuditActorKind,
  actorRef: r['actor_ref'] == null ? null : String(r['actor_ref']),
  subjectKind: r['subject_kind'] == null ? null : (String(r['subject_kind']) as AuditSubjectKind),
  subjectRef: r['subject_ref'] == null ? null : String(r['subject_ref']),
  outcome: String(r['outcome']) as AuditOutcome,
  detail: r['detail'] == null ? null : String(r['detail']),
});

export interface AuditRecordInput {
  readonly event: AuditEvent;
  readonly actorKind: AuditActorKind;
  readonly actorRef?: string | null;
  readonly subjectKind?: AuditSubjectKind | null;
  readonly subjectRef?: string | null;
  readonly outcome?: AuditOutcome;
  /** MUST already be redacted by the caller. Clamped again here. */
  readonly detail?: string | null;
}

const clamp = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/**
 * The structured record of what happened.
 *
 * Deliberately append-only in practice and never consulted by any decision:
 * authorization reads frozen environment configuration and the lifecycle reads
 * the `jobs` table, so a row here confers nothing. That is the same rule
 * `authorized_user_audit` follows, and it is what keeps the table safe to
 * write to liberally.
 *
 * `record` NEVER throws. An audit failure must not be able to abort the thing
 * it was recording: a job that ran correctly but could not be written down is
 * a bookkeeping problem, whereas a job rolled back because bookkeeping failed
 * is a correctness one. Callers therefore do not need to guard it, and a
 * caller inside a transaction still gets the row on commit.
 */
export class AuditLogRepo {
  constructor(private readonly db: Db) {}

  record(input: AuditRecordInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO audit_log (at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          nowIso(),
          input.event,
          input.actorKind,
          input.actorRef == null ? null : clamp(input.actorRef, AUDIT_SUBJECT_REF_MAX),
          input.subjectKind ?? null,
          input.subjectRef == null ? null : clamp(input.subjectRef, AUDIT_SUBJECT_REF_MAX),
          input.outcome ?? 'ok',
          input.detail == null ? null : clamp(input.detail, AUDIT_DETAIL_MAX),
        );
    } catch {
      /* Bookkeeping must never break the thing being booked. */
    }
  }

  recent(limit: number): AuditLogRow[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  forSubject(kind: AuditSubjectKind, ref: string, limit: number): AuditLogRow[] {
    return this.db
      .prepare(
        'SELECT * FROM audit_log WHERE subject_kind = ? AND subject_ref = ? ORDER BY id DESC LIMIT ?',
      )
      .all(kind, ref, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  countByEvent(event: AuditEvent): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE event = ?')
      .get(event) as { n: number };
    return Number(r.n);
  }

  /**
   * Bounded retention. Without this the table is the one structure in the
   * system that grows for as long as it runs; with it, an audit trail is a
   * window rather than an archive, which is the honest trade for a personal
   * assistant on a workstation.
   */
  pruneOlderThan(cutoffIso: string, limit: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM audit_log WHERE id IN (
           SELECT id FROM audit_log WHERE at < ? ORDER BY id ASC LIMIT ?
         )`,
      )
      .run(cutoffIso, limit);
    return Number(info.changes);
  }
}
