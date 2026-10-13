import {
  AUDIT_OWNER_REF, FORGET_REFUSAL_MESSAGE, FORGET_TARGET_LABEL,
  DuckyError, type ForgetEntityTarget, type ForgetRefusal,
} from '@ducky/contracts';
import type { ConversationProvider } from '@ducky/adapters';
import { withTransaction, type Store } from '@ducky/persistence';
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
  /**
   * The conversation provider, consulted ONLY for what it says about deleting
   * its own sessions.
   *
   * Nothing here ever calls `reply`. It is here so `/forget` can report the
   * SECOND store honestly (ADR 0024) instead of describing Ducky's own
   * deletion as though it were the whole picture. Omitting it means the reply
   * says a provider transcript may exist and that Ducky did not reach it,
   * which is the conservative truth for an unwired instance.
   */
  readonly conversation?: ConversationProvider;
}

/** What a preview found, or why it found nothing. */
export type ForgetPreview =
  | { found: true; target: ForgetEntityTarget; id: string; describes: string }
  | { found: false; target: ForgetEntityTarget; id: string; message: string };

export interface ForgetEntityResult {
  readonly deleted: boolean;
  readonly target: ForgetEntityTarget;
  readonly id: string;
  readonly rowsDeleted: number;
  readonly message: string;
}

/**
 * What `/forget conversation` did, in BOTH stores.
 *
 * `providerDeletion` is deliberately not a boolean: "we could not" and "we did
 * not have to" are different facts, and collapsing them would let a reply imply
 * completeness it has not got.
 */
export interface ForgetConversationResult {
  readonly message: string;
  readonly turnsDeleted: number;
  readonly providerSessionsRotated: number;
  readonly sharedSessionsRotated: number;
  readonly providerDeletion: 'unsupported' | 'requested';
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
  forgetConversation(actor: ActorContext): ForgetConversationResult {
    this.deps.authz.requireOwner(actor);

    const memory = this.deps.memory;
    if (!memory) {
      // Workflow threads are still removable: they are stored whether or not
      // continuity is configured, so an unwired memory service must not leave
      // them behind.
      const orphaned = this.deps.store.agentThreads.deleteForOwner(actor.discordUserId);
      if (orphaned > 0) this.record('conversation', 'all', orphaned);
      return {
        turnsDeleted: 0,
        providerSessionsRotated: 0,
        sharedSessionsRotated: 0,
        providerDeletion: 'unsupported',
        message:
          'Conversation continuity is not configured on this instance, so no turn is stored. ' +
          (orphaned > 0
            ? `Removed ${orphaned} repository-workflow thread record(s). `
            : '') +
          'No attachment byte has ever been kept either.',
      };
    }

    const outcome = memory.forgetConversationFor(actor);
    const { turnsDeleted, enabled, providerSessionsRotated, sharedSessionsRotated } = outcome;
    /**
     * The repository-workflow threads go with the conversation.
     *
     * A thread's stored grill lines are the owner's own words, written in a
     * conversation, so "forget my conversation" has to mean them too --
     * leaving them behind would make the reply a half-truth. The binding and
     * the card state go with them: they describe that same conversation and
     * none of it is live work.
     *
     * Counted and audited exactly like a turn, and by COUNT only.
     */
    const workflowThreadsDeleted = this.deps.store.agentThreads.deleteForOwner(
      actor.discordUserId,
    );
    this.record('conversation', 'all', turnsDeleted + workflowThreadsDeleted,
      `; sessions rotated ${providerSessionsRotated}+${sharedSessionsRotated}`);
    const provider = this.providerNote(providerSessionsRotated + sharedSessionsRotated);

    const workflowNote =
      workflowThreadsDeleted > 0
        ? ` Also removed ${workflowThreadsDeleted} repository-workflow thread record(s), ` +
          'including the notes you typed during a grill. Any GitHub issue that was already ' +
          'created still exists; deleting a record here does not delete published work.'
        : '';

    if (turnsDeleted === 0 && workflowThreadsDeleted === 0) {
      return {
        ...outcome,
        providerDeletion: 'unsupported',
        message:
          (enabled
            ? 'Nothing to forget: Ducky has stored no conversation turn for you. '
            : 'Nothing to forget: continuity is off, so Ducky stored no turn. ') + provider,
      };
    }
    if (turnsDeleted === 0) {
      return {
        ...outcome,
        providerDeletion: 'unsupported',
        message:
          'Ducky had stored no conversation turn for you.' + workflowNote +
          ' This cannot be undone. ' + provider,
      };
    }
    return {
      ...outcome,
      providerDeletion: 'unsupported',
      message:
        `Deleted ${turnsDeleted} stored conversation turn(s) across every thread.` +
        workflowNote +
        ' This cannot be undone. No attachment byte was ever kept. ' + provider,
    };
  }

  /**
   * What happened in the OTHER store, said plainly.
   *
   * ADR 0024 records that there are two conversation stores and only one of
   * them is Ducky's. The provider's own session transcript is not Ducky's to
   * delete -- no deletion contract has been recorded for it, so claiming a
   * deletion would be the one thing a deletion path must never do.
   *
   * What Ducky CAN do, and now does, is stop using the contaminated session:
   * the session key carries an epoch, and bumping it means the next turn opens
   * a different session. That is ORPHANING, not erasure, and the sentence says
   * so in those words rather than leaving the owner to infer it.
   */
  private providerNote(rotated: number): string {
    const capability = this.deps.conversation?.capabilities.sessionDeletion;
    const why = capability?.reason
      ?? 'no conversation provider is wired here, so nothing is known about its storage';

    if (capability?.supported === true) {
      // Reachable only once a deletion contract has been RECORDED against a
      // provider. Nothing on this host reports one.
      return 'The assistant provider reports that it can delete its own session, and that ' +
        'deletion was requested.';
    }

    const rotation = rotated === 0
      ? 'No provider session had been opened for it yet.'
      : `${rotated} provider session(s) were rotated instead, so no further turn can reuse ` +
        'the old context. The data behind them is ORPHANED, not erased.';

    return 'This is PARTIAL. The assistant provider keeps its own session transcript and ' +
      `Ducky cannot delete it: ${why} ${rotation}`;
  }

  // ---- per-record deletion, for everything that is not a job -------------

  /**
   * What `/forget <kind> <id>` will remove, WITHOUT removing it.
   *
   * Two-step for the same reason a job is: the command shows what will go and
   * hands back a signed control, and only pressing it deletes. This half never
   * writes, so a mistyped id costs nothing.
   *
   * A record that is not the owner's own and a record that does not exist are
   * answered IDENTICALLY -- the reply must not confirm that somebody else has
   * a task with that id.
   */
  previewEntity(
    actor: ActorContext,
    target: ForgetEntityTarget,
    rawId: string,
  ): ForgetPreview {
    this.deps.authz.requireOwner(actor);
    const id = rawId.trim().toLowerCase();
    if (id === '') {
      throw new DuckyError(
        'invalid_input',
        `Which ${FORGET_TARGET_LABEL[target]}? Give the id shown when you listed it.`,
      );
    }
    const owner = actor.discordUserId;
    const store = this.deps.store;

    switch (target) {
      case 'job': {
        const job = store.jobs.byPublicId(id);
        if (!job || job.discordUserId !== owner) return unknown(target, id);
        return { found: true, target, id: job.publicId, describes: `${job.repoSlug} · ${job.state}` };
      }
      case 'task': {
        const row = store.tasks.byPublicId(owner, id);
        if (!row) return unknown(target, id);
        return { found: true, target, id: row.publicId, describes: `${row.status} · ${row.title}` };
      }
      case 'reminder': {
        const row = store.reminders.byPublicId(owner, id);
        if (!row) return unknown(target, id);
        return { found: true, target, id: row.publicId, describes: `${row.status} · ${row.text}` };
      }
      case 'capture': {
        const ids = store.retention.captureIdsByPrefix(owner, id);
        if (ids.length === 0) return unknown(target, id);
        if (ids.length > 1) return ambiguous(target, id);
        const row = store.captures.get(ids[0]!);
        if (!row || row.discordUserId !== owner) return unknown(target, id);
        return { found: true, target, id: row.id, describes: `${row.status} · ${row.content}` };
      }
      case 'schedule': {
        const ids = store.retention.scheduleIdsByPrefix(owner, id);
        if (ids.length === 0) return unknown(target, id);
        if (ids.length > 1) return ambiguous(target, id);
        const row = store.schedules.byIdForOwner(owner, ids[0]!);
        if (!row) return unknown(target, id);
        return { found: true, target, id: row.id, describes: `${row.startsAt} · ${row.title}` };
      }
    }
  }

  /**
   * Deletes one record the owner named, and reports the COUNT.
   *
   * Every statement is owner-scoped in its WHERE clause rather than checked
   * first: a lookup followed by a delete is two statements that can disagree,
   * and the id came from a message. A reminder takes its occurrence outbox with
   * it, child-first, through the same code the scheduled pass uses.
   *
   * Deliberately NOT guarded the way a job is. A job can be live in ways that
   * make deletion destructive -- a held repository, an open workspace holding
   * uncommitted work. A capture, a task, a reminder and a schedule entry cannot:
   * they are the owner's own notes, and deleting one they pointed at is exactly
   * what they asked for.
   */
  forgetEntity(
    actor: ActorContext,
    target: ForgetEntityTarget,
    rawId: string,
  ): ForgetEntityResult {
    this.deps.authz.requireOwner(actor);
    if (target === 'job') {
      const out = this.forgetJob(actor, rawId);
      return {
        deleted: out.deleted,
        target,
        id: out.publicId,
        rowsDeleted: out.rowsDeleted,
        message: out.message,
      };
    }

    const preview = this.previewEntity(actor, target, rawId);
    if (!preview.found) {
      return { deleted: false, target, id: rawId.trim(), rowsDeleted: 0, message: preview.message };
    }

    const owner = actor.discordUserId;
    const store = this.deps.store;
    const rows = withTransaction(store.db, () => {
      switch (target) {
        case 'task': {
          // The task AND the notifications it owns. Counted, so the owner is
          // told how many records went rather than just "one".
          const t = store.retention.deleteTaskByPublicId(owner, preview.id);
          return t.tasks + t.reminders + t.occurrences;
        }
        case 'reminder': {
          const r = store.retention.deleteReminderByPublicId(owner, preview.id);
          return r.reminders + r.occurrences;
        }
        case 'capture':
          return store.retention.deleteCaptureById(owner, preview.id);
        case 'schedule':
          return store.retention.deleteScheduleById(owner, preview.id);
      }
    });

    if (rows === 0) {
      // It was there a moment ago and is not now. Report the truth rather than
      // claiming a deletion that did not happen.
      return {
        deleted: false,
        target,
        id: preview.id,
        rowsDeleted: 0,
        message: FORGET_REFUSAL_MESSAGE.unknown_record,
      };
    }

    this.recordEntity(target, preview.id, rows);
    return {
      deleted: true,
      target,
      id: preview.id,
      rowsDeleted: rows,
      message:
        `Deleted that ${FORGET_TARGET_LABEL[target]} (${rows} row${rows === 1 ? '' : 's'}). ` +
        'This cannot be undone.',
    };
  }

  /**
   * Audits a per-record deletion by COUNT.
   *
   * The subject reference is the kind and the id -- never the title, the text or
   * the content. An id the owner already had is not a disclosure; what they
   * wrote is.
   */
  private recordEntity(target: ForgetEntityTarget, id: string, rows: number): void {
    try {
      this.deps.store.auditLog.record({
        event: 'data.deleted',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        // `record` for anything that is not a job, so the trail says what kind
        // of thing went. Filing a task under `conversation` would make the
        // audit misdescribe the deletion.
        subjectKind: target === 'job' ? 'job' : 'record',
        subjectRef: `${target}:${id}`,
        outcome: 'ok',
        detail: `rows ${rows}`,
      });
    } catch {
      /* a record is never worth failing a deletion the owner asked for */
    }
  }

  /** One audit row per deletion, counts only. Never throws. */
  private record(
    subjectKind: 'conversation',
    subjectRef: string,
    rows: number,
    extra = '',
  ): void {
    try {
      this.deps.store.auditLog.record({
        event: 'data.deleted',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        subjectKind,
        subjectRef,
        outcome: 'ok',
        detail: `rows ${rows}${extra}`,
      });
    } catch {
      /* a record is never worth failing a deletion the owner asked for */
    }
  }
}

const unknown = (target: ForgetEntityTarget, id: string): ForgetPreview => ({
  found: false,
  target,
  id,
  message: FORGET_REFUSAL_MESSAGE.unknown_record,
});

/**
 * A prefix that could mean two records is refused rather than resolved.
 *
 * Guessing which one the owner meant is the one behaviour a deletion path must
 * never have.
 */
const ambiguous = (target: ForgetEntityTarget, id: string): ForgetPreview => ({
  found: false,
  target,
  id,
  message:
    `More than one ${FORGET_TARGET_LABEL[target]} starts with \`${id}\`. ` +
    'Give a few more characters.',
});
