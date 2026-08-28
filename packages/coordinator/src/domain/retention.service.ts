import {
  AUDIT_OWNER_REF, DEFAULT_OWNER_TIMEZONE, DEFAULT_RETENTION, EMPTY_RETENTION_COUNTS,
  parseStoredWallClock, totalRetentionDeletions,
  type RetentionCounts, type RetentionOutcome, type RetentionPolicy, type RetentionTrigger,
} from '@ducky/contracts';
import { withTransaction, type Store } from '@ducky/persistence';

export interface RetentionServiceDeps {
  readonly store: Store;
  readonly policy: RetentionPolicy;
  /**
   * The owner's zone, because `schedules.starts_at` is wall-clock text in it.
   * Defaults to UTC, which is also the configuration default.
   */
  readonly timeZone?: string;
  /**
   * The owner's Discord id, from frozen configuration.
   *
   * Needed only to tell the owner's stored conversation turns from a guest's,
   * which have different windows. Omitting it skips conversation pruning
   * entirely rather than guessing -- the same fail-closed direction every other
   * missing dependency takes here.
   */
  readonly ownerId?: string;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface RetentionPassResult {
  readonly ran: boolean;
  readonly outcome: RetentionOutcome;
  readonly counts: RetentionCounts;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Bounded, idempotent deletion of finished records.
 *
 * Three properties do the work here, and each is a deliberate refusal of an
 * easier design:
 *
 * - **Off by default.** This removes the owner's own data. `enabled: false`
 *   means no window is consulted and nothing is deleted, so an operator has to
 *   choose retention rather than inherit it.
 * - **Only finished things.** Every policy names a column that exists solely
 *   because the record is closed (`finished_at`, `closed_at`, `delivered_at`).
 *   For jobs that is not enough on its own, so the repository's guard also
 *   refuses a job holding a reservation, an open workspace, a pending approval
 *   or an open dependency -- a skip is COUNTED, not swallowed, because a
 *   terminal job still holding a reservation is an inconsistency somebody
 *   should see.
 * - **Bounded per pass.** Every table is capped at `policy.batch`, so a tick is
 *   short and a pass that hits the cap simply resumes on the next one. That is
 *   also what makes the whole thing idempotent: run it twice on a settled
 *   database and the second run deletes nothing.
 *
 * There is deliberately NO method here that deletes everything, and no
 * parameter that widens the scope. `RETENTION_FORBIDDEN_TABLES` names what this
 * service must never touch, and a test asserts the compiled source does not
 * mention any of them.
 */
export class RetentionService {
  private readonly store: Store;
  private readonly policy: RetentionPolicy;
  private readonly timeZone: string;
  private readonly ownerId: string | undefined;
  private readonly now: () => Date;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  #running = false;

  constructor(deps: RetentionServiceDeps) {
    this.store = deps.store;
    this.policy = deps.policy;
    this.timeZone = deps.timeZone ?? DEFAULT_OWNER_TIMEZONE;
    this.ownerId = deps.ownerId;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((): void => {});
  }

  get enabled(): boolean {
    return this.policy.enabled;
  }

  /** Rides the existing coordinator interval. No second scheduler. */
  async tick(): Promise<RetentionPassResult> {
    return this.run('scheduled');
  }

  /**
   * One pass.
   *
   * Re-entrancy guarded: two overlapping ticks would double-count and could
   * interleave a guard with another pass's delete.
   */
  async run(trigger: RetentionTrigger): Promise<RetentionPassResult> {
    if (!this.policy.enabled) {
      return { ran: false, outcome: 'ok', counts: EMPTY_RETENTION_COUNTS };
    }
    if (this.#running) {
      return { ran: false, outcome: 'ok', counts: EMPTY_RETENTION_COUNTS };
    }
    this.#running = true;

    const runId = this.store.retention.startRun(trigger);
    let counts = { ...EMPTY_RETENTION_COUNTS };
    let outcome: RetentionOutcome = 'ok';

    try {
      counts = this.pass();
    } catch (err) {
      outcome = 'failed';
      this.log('retention.failed', { err });
    } finally {
      this.#running = false;
    }

    this.store.retention.finishRun(runId, outcome, counts);

    // Recorded even when nothing was deleted: "retention ran and found nothing"
    // is the state an auditor most needs to be able to confirm.
    this.recordAudit(runId, outcome, counts);
    this.log('retention.pass', { runId, outcome, deleted: totalRetentionDeletions(counts) });

    return { ran: true, outcome, counts };
  }

  // --------------------------------------------------------------------------

  private pass(): RetentionCounts {
    const at = this.now();
    const cutoff = (days: number): string => new Date(at.getTime() - days * DAY_MS).toISOString();
    const p = this.policy;
    const r = this.store.retention;
    const c = { ...EMPTY_RETENTION_COUNTS } as {
      -readonly [K in keyof RetentionCounts]: RetentionCounts[K];
    };

    // Jobs are a UNIT: the job row plus every row that references it, removed
    // child-first in one transaction each. Per job rather than per batch so one
    // refused job never blocks the rest.
    for (const jobId of r.terminalJobsBefore(cutoff(p.jobMetadataDays), p.batch)) {
      const result = r.deleteJobUnitGuarded(jobId);
      if ('refusal' in result) {
        c.jobsSkipped += 1;
        continue;
      }
      c.jobsDeleted += result.deleted.jobsDeleted;
      c.jobChildRowsDeleted += result.deleted.childRowsDeleted;
    }

    // The DETAIL of jobs that are still kept. Runs after the unit pass, so a
    // job old enough to go entirely is not first stripped of its result: it is
    // already gone, and this then finds nothing for it.
    withTransaction(this.store.db, () => {
      const d = r.deleteOldJobDetails(cutoff(p.jobDetailDays), p.batch);
      c.jobDetailRowsDeleted = d.results + d.events + d.ownerInputs;
    });

    // The assistant's own records, each with its OWN window: a finished task and
    // a past schedule entry are not the same kind of thing, and one number for
    // both meant choosing which of them to get wrong. Independently transacted
    // so a failure in one table cannot roll back another's progress.
    withTransaction(this.store.db, () => {
      c.capturesDeleted = r.deleteClosedCaptures(cutoff(p.doneCaptureDays), p.batch);
      c.tasksDeleted = r.deleteClosedTasks(cutoff(p.closedTaskDays), p.batch);
      const rem = r.deleteClosedReminders(cutoff(p.closedReminderDays), p.batch);
      c.remindersDeleted = rem.reminders;
      c.reminderOccurrencesDeleted = rem.occurrences;
      // Occurrences of a reminder that is still OPEN, once they are settled.
      c.reminderOccurrencesDeleted += r.deleteSettledOccurrences(
        cutoff(p.closedReminderDays),
        p.batch,
      );
      c.schedulesDeleted = this.prunePastSchedules(cutoff(p.pastScheduleDays), at, p.batch);
    });

    // The audit log. Bounded here so ONE policy describes every window; the
    // reconciler keeps its own prune for an instance with retention disabled,
    // because a record that grows forever is not acceptable either way.
    withTransaction(this.store.db, () => {
      c.auditRowsDeleted = r.deleteOldAuditRows(cutoff(p.auditDays), p.batch);
    });

    withTransaction(this.store.db, () => {
      c.watchEventsDeleted = r.deleteSettledWatchEvents(cutoff(p.watchEventDays), p.batch);
      const w = r.deleteCancelledWatches(cutoff(p.cancelledWatchDays), p.batch);
      c.watchesDeleted = w.watches;
      c.watchEventsDeleted += w.events;
    });

    // Conversation turns, split by who said them: the owner's own history and a
    // whitelist guest's are not the same thing. Requires an owner id, which the
    // service is given rather than reading from the database -- authorization
    // and identity never come from SQLite.
    if (this.ownerId !== undefined) {
      withTransaction(this.store.db, () => {
        c.conversationTurnsDeleted = this.store.conversations.pruneOlderThan({
          ownerId: this.ownerId!,
          ownerCutoffIso: cutoff(p.conversationOwnerDays),
          otherCutoffIso: cutoff(p.conversationOtherDays),
          batch: p.batch,
        });
      });
    }

    withTransaction(this.store.db, () => {
      c.workspacesDeleted = r.deleteClosedWorkspaces(cutoff(p.jobMetadataDays), p.batch);
      c.idempotencyKeysDeleted = r.deleteIdempotencyKeys(cutoff(p.idempotencyDays), p.batch);
      c.runLogRowsDeleted = r.deleteOldRunLog(cutoff(p.runLogDays), p.batch);
    });

    return c;
  }

  /**
   * Deletes a confirmed schedule only when its EVENT is also genuinely past.
   *
   * `starts_at` is wall-clock text in the owner's zone, so the comparison has to
   * happen after parsing it in that zone -- not in SQL against a UTC string. A
   * row whose stored text cannot be parsed is KEPT: the presenter already falls
   * back to showing the raw text for those, and deleting something we cannot
   * interpret is the one outcome with no upside.
   */
  private prunePastSchedules(confirmedBeforeIso: string, at: Date, limit: number): number {
    const candidates = this.store.retention.pastScheduleCandidates(confirmedBeforeIso, limit);
    const eventCutoffMs = at.getTime() - this.policy.pastScheduleDays * DAY_MS;

    const doomed: string[] = [];
    for (const c of candidates) {
      const parsed = parseStoredWallClock(c.startsAt, this.timeZone);
      // Unparseable, or the event has not yet passed the window: keep it.
      if (parsed === undefined) continue;
      if (parsed.atMs >= eventCutoffMs) continue;
      doomed.push(c.id);
    }
    return this.store.retention.deleteSchedulesByIds(doomed);
  }

  /**
   * Counts only.
   *
   * A deletion record that quoted what it deleted would defeat the deletion, so
   * the detail is assembled from fixed strings and numbers -- nothing here can
   * carry a task title, a capture or an id other than the run's own.
   */
  private recordAudit(runId: number, outcome: RetentionOutcome, counts: RetentionCounts): void {
    this.store.auditLog.record({
      event: 'retention.pruned',
      actorKind: 'system',
      actorRef: 'retention',
      subjectKind: 'retention',
      subjectRef: String(runId),
      outcome: outcome === 'failed' ? 'failed' : 'ok',
      detail:
        `jobs ${counts.jobsDeleted} (+${counts.jobChildRowsDeleted} child rows, ` +
        `${counts.jobsSkipped} skipped); captures ${counts.capturesDeleted}; ` +
        `tasks ${counts.tasksDeleted}; reminders ${counts.remindersDeleted}; ` +
        `occurrences ${counts.reminderOccurrencesDeleted}; ` +
        `schedules ${counts.schedulesDeleted}; watches ${counts.watchesDeleted}; ` +
        `watch events ${counts.watchEventsDeleted}; ` +
        `workspaces ${counts.workspacesDeleted}; ` +
        `idempotency ${counts.idempotencyKeysDeleted}; run log ${counts.runLogRowsDeleted}; ` +
        `conversation turns ${counts.conversationTurnsDeleted}; ` +
        `job detail rows ${counts.jobDetailRowsDeleted}; audit ${counts.auditRowsDeleted}`,
    });
  }
}

/**
 * Reads the policy from validated configuration.
 *
 * The two Phase-2 names -- `TERMINAL_JOBS_DAYS` and `CLOSED_ASSISTANT_DAYS` --
 * are kept as DEPRECATED ALIASES rather than dropped. An operator who set them
 * expressed an intent, and silently ignoring a variable that is still in their
 * env file is worse than either honouring it or refusing it. Each maps onto the
 * window that replaced it, and an explicit new value always wins.
 */
export function retentionPolicyFrom(env: {
  DUCKY_RETENTION_ENABLED: boolean;
  DUCKY_RETENTION_JOB_METADATA_DAYS?: number | undefined;
  DUCKY_RETENTION_JOB_DETAIL_DAYS: number;
  DUCKY_RETENTION_DONE_CAPTURE_DAYS?: number | undefined;
  DUCKY_RETENTION_CLOSED_TASK_DAYS?: number | undefined;
  DUCKY_RETENTION_CLOSED_REMINDER_DAYS?: number | undefined;
  DUCKY_RETENTION_PAST_SCHEDULE_DAYS?: number | undefined;
  DUCKY_RETENTION_AUDIT_DAYS: number;
  DUCKY_RETENTION_WATCH_EVENTS_DAYS: number;
  DUCKY_RETENTION_IDEMPOTENCY_DAYS: number;
  DUCKY_RETENTION_CONVERSATION_OWNER_DAYS: number;
  DUCKY_RETENTION_CONVERSATION_OTHER_DAYS: number;
  DUCKY_RETENTION_BATCH: number;
  /** Deprecated aliases. */
  DUCKY_RETENTION_TERMINAL_JOBS_DAYS?: number | undefined;
  DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS?: number | undefined;
}): RetentionPolicy {
  const legacyAssistant = env.DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS;
  return Object.freeze({
    ...DEFAULT_RETENTION,
    enabled: env.DUCKY_RETENTION_ENABLED,
    jobMetadataDays:
      env.DUCKY_RETENTION_JOB_METADATA_DAYS ??
      env.DUCKY_RETENTION_TERMINAL_JOBS_DAYS ??
      DEFAULT_RETENTION.jobMetadataDays,
    jobDetailDays: env.DUCKY_RETENTION_JOB_DETAIL_DAYS,
    doneCaptureDays:
      env.DUCKY_RETENTION_DONE_CAPTURE_DAYS ?? legacyAssistant ?? DEFAULT_RETENTION.doneCaptureDays,
    closedTaskDays:
      env.DUCKY_RETENTION_CLOSED_TASK_DAYS ?? legacyAssistant ?? DEFAULT_RETENTION.closedTaskDays,
    closedReminderDays:
      env.DUCKY_RETENTION_CLOSED_REMINDER_DAYS ??
      legacyAssistant ??
      DEFAULT_RETENTION.closedReminderDays,
    pastScheduleDays:
      env.DUCKY_RETENTION_PAST_SCHEDULE_DAYS ??
      legacyAssistant ??
      DEFAULT_RETENTION.pastScheduleDays,
    auditDays: env.DUCKY_RETENTION_AUDIT_DAYS,
    watchEventDays: env.DUCKY_RETENTION_WATCH_EVENTS_DAYS,
    idempotencyDays: env.DUCKY_RETENTION_IDEMPOTENCY_DAYS,
    conversationOwnerDays: env.DUCKY_RETENTION_CONVERSATION_OWNER_DAYS,
    conversationOtherDays: env.DUCKY_RETENTION_CONVERSATION_OTHER_DAYS,
    batch: env.DUCKY_RETENTION_BATCH,
  });
}

export { AUDIT_OWNER_REF };
