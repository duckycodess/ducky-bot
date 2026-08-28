/**
 * How long the owner's data is kept.
 *
 * Two rules govern everything here, and they are why the shape looks cautious:
 *
 * 1. **Off unless configured.** Retention deletes the owner's own records, so
 *    the default is to keep everything. `enabled: false` means every window is
 *    ignored and nothing is ever removed.
 * 2. **Only finished things.** No window applies to work that is still live. A
 *    non-terminal job, an open dependency, a held reservation, an open
 *    workspace, a pending approval, an undelivered reminder occurrence and an
 *    active credential are all outside the reach of every policy below --
 *    enforced by predicates in the service, not by hoping the windows are big
 *    enough.
 */

/** Tables that retention may NEVER delete from, whatever is configured. */
export const RETENTION_FORBIDDEN_TABLES = [
  /** Configuration mirror; deleting one orphans jobs and watches. */
  'repos',
  /** Security trail with no power, but a trail. Tiny and permanent. */
  'authorized_user_audit',
  /** Identity. Removed only by an explicit CLI revoke. */
  'executors',
  /** Security material metadata. Removed only by an explicit CLI revoke. */
  'executor_credentials',
  /** A reservation is by definition live; retention aborts rather than clears. */
  'repo_reservations',
  /** Migration bookkeeping. */
  'schema_migrations',
] as const;
export type RetentionForbiddenTable = (typeof RETENTION_FORBIDDEN_TABLES)[number];

export interface RetentionPolicy {
  /** Master switch. False means keep everything, forever. */
  readonly enabled: boolean;
  /**
   * The job row, its transitions and its delivery ledger: the SHAPE of what
   * happened. Longer than the detail below, because "what did that job do in
   * March" is usually a question about shape.
   */
  readonly jobMetadataDays: number;
  /**
   * The DETAIL of a finished job -- the result snapshot, its events and the
   * owner's answers -- pruned earlier than the job itself.
   *
   * This is the most detailed thing Ducky stores about a repository: a summary,
   * review notes, verification output and a changed-file list. Every reader
   * already treats a missing result as normal (a queued job has none), so the
   * job survives its own detail without any presenter pretending otherwise.
   */
  readonly jobDetailDays: number;
  /** Done or archived captures. */
  readonly doneCaptureDays: number;
  /** Tasks that are done or cancelled. Nothing open is ever in scope. */
  readonly closedTaskDays: number;
  /** Reminders that have finished or been cancelled, and their occurrences. */
  readonly closedReminderDays: number;
  /** Confirmed schedule entries whose event is also genuinely past. */
  readonly pastScheduleDays: number;
  /** The structured audit log. A record, bounded like everything else. */
  readonly auditDays: number;
  /** Delivered or abandoned GitHub watch events. */
  readonly watchEventDays: number;
  /** Idempotency keys, which may echo a response body. */
  readonly idempotencyDays: number;
  /** Cancelled watches, kept a while so a re-add is not confusing. */
  readonly cancelledWatchDays: number;
  /** Retention's own run log. */
  readonly runLogDays: number;
  /**
   * Stored conversation turns, split by WHO said them.
   *
   * The owner is talking to their own assistant; everyone else on the chat
   * whitelist is a guest whose words Ducky keeps for as short a time as the
   * feature can work with. Two windows rather than one, because collapsing them
   * would mean choosing between keeping a guest's messages as long as the
   * owner's or throwing the owner's away as fast as a guest's.
   */
  readonly conversationOwnerDays: number;
  readonly conversationOtherDays: number;
  /** Rows removed per table per pass, so a tick is never long. */
  readonly batch: number;
}

/**
 * Conservative on purpose. A window that is too long costs disk; one that is
 * too short costs the owner their history, and only one of those is
 * recoverable.
 */
export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({
  enabled: false,
  jobMetadataDays: 90,
  jobDetailDays: 30,
  doneCaptureDays: 365,
  closedTaskDays: 90,
  closedReminderDays: 90,
  pastScheduleDays: 180,
  auditDays: 90,
  watchEventDays: 90,
  idempotencyDays: 7,
  cancelledWatchDays: 365,
  runLogDays: 365,
  conversationOwnerDays: 30,
  conversationOtherDays: 7,
  batch: 200,
});

export const RETENTION_TRIGGERS = ['scheduled', 'manual'] as const;
export type RetentionTrigger = (typeof RETENTION_TRIGGERS)[number];

export const RETENTION_OUTCOMES = ['ok', 'partial', 'failed'] as const;
export type RetentionOutcome = (typeof RETENTION_OUTCOMES)[number];

/**
 * What one pass did. Counts only -- never a title, a task, or an id.
 *
 * `jobsSkipped` is reported rather than swallowed: a terminal job old enough to
 * prune but still holding a reservation or an open workspace is an
 * inconsistency somebody should look at, not something for retention to tidy
 * away.
 */
export interface RetentionCounts {
  readonly jobsDeleted: number;
  readonly jobsSkipped: number;
  readonly jobChildRowsDeleted: number;
  readonly capturesDeleted: number;
  readonly tasksDeleted: number;
  readonly remindersDeleted: number;
  readonly reminderOccurrencesDeleted: number;
  readonly schedulesDeleted: number;
  readonly watchesDeleted: number;
  readonly watchEventsDeleted: number;
  readonly workspacesDeleted: number;
  readonly idempotencyKeysDeleted: number;
  readonly runLogRowsDeleted: number;
  readonly conversationTurnsDeleted: number;
  /**
   * Detail rows removed from jobs that are still KEPT. Counted separately from
   * `jobChildRowsDeleted`, which belongs to jobs that went entirely: the two
   * answer different questions, and adding them together would hide the fact
   * that a job survived while its result did not.
   */
  readonly jobDetailRowsDeleted: number;
  readonly auditRowsDeleted: number;
}

export const EMPTY_RETENTION_COUNTS: RetentionCounts = Object.freeze({
  jobsDeleted: 0,
  jobsSkipped: 0,
  jobChildRowsDeleted: 0,
  capturesDeleted: 0,
  tasksDeleted: 0,
  remindersDeleted: 0,
  reminderOccurrencesDeleted: 0,
  schedulesDeleted: 0,
  watchesDeleted: 0,
  watchEventsDeleted: 0,
  workspacesDeleted: 0,
  idempotencyKeysDeleted: 0,
  runLogRowsDeleted: 0,
  conversationTurnsDeleted: 0,
  jobDetailRowsDeleted: 0,
  auditRowsDeleted: 0,
});

export const totalRetentionDeletions = (c: RetentionCounts): number =>
  c.jobsDeleted +
  c.jobChildRowsDeleted +
  c.capturesDeleted +
  c.tasksDeleted +
  c.remindersDeleted +
  c.reminderOccurrencesDeleted +
  c.schedulesDeleted +
  c.watchesDeleted +
  c.watchEventsDeleted +
  c.workspacesDeleted +
  c.idempotencyKeysDeleted +
  c.runLogRowsDeleted +
  c.conversationTurnsDeleted +
  c.jobDetailRowsDeleted +
  c.auditRowsDeleted;

/**
 * What the owner may delete by hand, and nothing broader.
 *
 * There is deliberately no `all`, no `everything` and no wildcard: the contract
 * itself has no way to express "delete all of it", so no layer above it can
 * accidentally offer one. Every target except `conversation` names ONE record
 * by the id the owner can actually see, and `conversation` means "my own
 * conversation" -- one person's, never everyone's.
 *
 * These are CHOICES on the existing owner-only `/forget` command, not new
 * commands: the owner-only surface is not widened by any of them.
 */
export const FORGET_TARGETS = [
  'job',
  'conversation',
  'capture',
  'task',
  'reminder',
  'schedule',
] as const;
export type ForgetTarget = (typeof FORGET_TARGETS)[number];

export const isForgetTarget = (v: string): v is ForgetTarget =>
  (FORGET_TARGETS as readonly string[]).includes(v);

/** The per-record targets: everything that names one row by id. */
export const FORGET_ENTITY_TARGETS = ['job', 'capture', 'task', 'reminder', 'schedule'] as const;
export type ForgetEntityTarget = (typeof FORGET_ENTITY_TARGETS)[number];

export const isForgetEntityTarget = (v: string): v is ForgetEntityTarget =>
  (FORGET_ENTITY_TARGETS as readonly string[]).includes(v);

export const FORGET_TARGET_LABEL = {
  job: 'job',
  conversation: 'conversation',
  capture: 'capture',
  task: 'task',
  reminder: 'reminder',
  schedule: 'schedule entry',
} as const satisfies Record<ForgetTarget, string>;

/** Why a `/forget` request was refused, so the reply can be exact. */
export const FORGET_REFUSALS = [
  'unknown_job',
  /** Nothing of that kind with that id belongs to this owner. */
  'unknown_record',
  'job_still_running',
  'reservation_held',
  'workspace_open',
  'approval_pending',
  'dependency_open',
] as const;
export type ForgetRefusal = (typeof FORGET_REFUSALS)[number];

export const FORGET_REFUSAL_MESSAGE: Record<ForgetRefusal, string> = {
  unknown_job: 'No job with that id.',
  // An unknown id and somebody else's id are answered IDENTICALLY, here as
  // everywhere: the reply must not confirm that a record exists.
  unknown_record: 'Nothing of yours with that id.',
  job_still_running: 'That job has not finished. Cancel it first.',
  reservation_held:
    'That job still holds its repository. Clear it with `/job cleanup` first.',
  workspace_open:
    'That job still has an open workspace, which may contain work. Clear it with `/job cleanup` first.',
  approval_pending: 'That job has an approval still waiting on a decision.',
  dependency_open: 'That job is still waiting on a dependency.',
};
