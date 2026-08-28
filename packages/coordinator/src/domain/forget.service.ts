import {
  AUDIT_OWNER_REF, FORGET_REFUSAL_MESSAGE,
  DuckyError, type ForgetRefusal,
} from '@ducky/contracts';
import type { Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { ConversationMemoryService } from './conversation-memory.service.js';

export interface ForgetServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  /**
   * Stored conversation turns. OMITTING IT means `/forget conversation` reports
   * that nothing is stored -- which is exactly true of an instance with no
   * memory service wired.
   */
  readonly memory?: ConversationMemoryService;
}

export interface ForgetJobResult {
  readonly deleted: boolean;
  readonly publicId: string;
  readonly refusal?: ForgetRefusal;
  readonly message: string;
  readonly rowsDeleted: number;
}

/**
 * The owner's own deletion controls.
 *
 * Everything about the shape of this class is a refusal to build a wipe-all:
 *
 * - `forgetJob` takes ONE public job id and there is no plural form, no filter
 *   argument and no `all` sentinel. The contract (`FORGET_TARGETS`) cannot
 *   express "everything", so no layer above can accidentally offer it.
 * - The deletion itself is `RetentionRepo.deleteJobUnitGuarded`, the same code
 *   the scheduled pass uses. One deletion order, one set of guards.
 * - A refusal is reported verbatim rather than forced through, because every
 *   refusal means something is still live -- a held reservation, an open
 *   workspace with uncommitted work in it, a pending approval.
 * - The audit row records COUNTS. A deletion record that quoted what it deleted
 *   would defeat the deletion.
 *
 * `requireOwner` is the first statement of every method, not a router concern.
 */
export class ForgetService {
  constructor(private readonly deps: ForgetServiceDeps) {}

  /**
   * Deletes one job and everything hanging off it.
   *
   * Looked up by PUBLIC id, which is what the owner sees, and re-checked
   * against the owner's own rows -- a job belonging to nobody else could exist
   * in a future multi-user world, and this must not become the path that
   * reaches it.
   */
  forgetJob(actor: ActorContext, publicId: string): ForgetJobResult {
    this.deps.authz.requireOwner(actor);

    const trimmed = publicId.trim();
    if (trimmed === '') {
      throw new DuckyError('invalid_input', 'Which job? Give the id from `/jobs`.');
    }

    const job = this.deps.store.jobs.byPublicId(trimmed);
    if (!job || job.discordUserId !== actor.discordUserId) {
      // An unknown id and somebody else's id are answered IDENTICALLY, so this
      // cannot be used to discover that a job exists.
      return {
        deleted: false,
        publicId: trimmed,
        refusal: 'unknown_job',
        message: FORGET_REFUSAL_MESSAGE.unknown_job,
        rowsDeleted: 0,
      };
    }

    const result = this.deps.store.retention.deleteJobUnitGuarded(job.id);

    if ('refusal' in result) {
      this.deps.store.auditLog.record({
        event: 'data.deleted',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        subjectKind: 'job',
        subjectRef: job.publicId,
        outcome: 'refused',
        detail: `refused: ${result.refusal}`,
      });
      return {
        deleted: false,
        publicId: job.publicId,
        refusal: result.refusal,
        message: FORGET_REFUSAL_MESSAGE[result.refusal],
        rowsDeleted: 0,
      };
    }

    const rows = result.deleted.jobsDeleted + result.deleted.childRowsDeleted;
    this.deps.store.auditLog.record({
      event: 'data.deleted',
      actorKind: 'owner',
      actorRef: AUDIT_OWNER_REF,
      subjectKind: 'job',
      subjectRef: job.publicId,
      outcome: 'ok',
      // Counts only. Never the task, the context, the answers or the result.
      detail: `job row ${result.deleted.jobsDeleted}; child rows ${result.deleted.childRowsDeleted}`,
    });

    return {
      deleted: true,
      publicId: job.publicId,
      message:
        `Deleted job \`${job.publicId}\` and ${result.deleted.childRowsDeleted} related ` +
        'row(s): its transitions, events, your answers, the result snapshot, approvals and ' +
        'workspace record. This cannot be undone.',
      rowsDeleted: rows,
    };
  }

  /**
   * Deletes the owner's stored conversation turns -- or says plainly that there
   * are none.
   *
   * This used to be a statement of fact ("nothing is stored"), and it was true.
   * Bounded continuity (ADR 0021) made it a real deletion, and the honest
   * answer now depends on what is actually in the table rather than on what the
   * feature flag says: rows an earlier run stored are deleted even if
   * continuity has since been switched off.
   *
   * Audited by COUNT. A record of a deletion that quoted what it deleted would
   * defeat the deletion.
   *
   * No attachment byte is involved either way: none is ever kept, and none is
   * ever derived, so there is nothing of that kind to remove.
   */
  forgetConversation(actor: ActorContext): { message: string; turnsDeleted: number } {
    this.deps.authz.requireOwner(actor);

    const memory = this.deps.memory;
    if (!memory) {
      return {
        turnsDeleted: 0,
        message:
          'There is nothing to forget: conversation continuity is not configured on this ' +
          'instance, so no turn is stored. No attachment byte has ever been kept either.',
      };
    }

    const { turnsDeleted, enabled } = memory.forgetConversationFor(actor);
    this.record('conversation', 'all', turnsDeleted);

    if (turnsDeleted === 0) {
      return {
        turnsDeleted,
        message: enabled
          ? 'Nothing to forget: no conversation turn is stored for you yet.'
          : 'Nothing to forget: conversation continuity is off, so no turn was stored.',
      };
    }
    return {
      turnsDeleted,
      message:
        `Deleted ${turnsDeleted} stored conversation turn(s) across every thread. ` +
        'This cannot be undone. No attachment byte was ever kept.',
    };
  }

  /** One audit row per deletion, counts only. Never throws. */
  private record(subjectKind: 'conversation', subjectRef: string, rows: number): void {
    try {
      this.deps.store.auditLog.record({
        event: 'data.deleted',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        subjectKind,
        subjectRef,
        outcome: 'ok',
        detail: `rows ${rows}`,
      });
    } catch {
      /* a record is never worth failing a deletion the owner asked for */
    }
  }
}
