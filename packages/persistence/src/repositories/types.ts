import type {
  ApprovalExecutionState, ApprovalState, AuditActorKind, AuditEvent, AuditOutcome, AuditSubjectKind,
  CaptureState, ConversationRole, DependencyCheckStatus, DependencyState, DependencyType,
  GitHubWatchState, JobState, JobWorkPhase, RecurrenceKind, ReminderState,
  TaskPriority, TaskState,
} from '@ducky/contracts';

export interface RepoRow {
  slug: string;
  absolutePath: string;
  defaultBranch: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  allowWorktree: boolean;
  allowBootstrap: boolean;
  bootstrapAllowedEntries: string[];
  enabled: boolean;
}

export interface CaptureRow {
  id: string;
  discordUserId: string;
  content: string;
  status: CaptureState;
  createdAt: string;
  updatedAt: string;
}

/**
 * One stored conversation turn.
 *
 * Only ever read back for the SAME (user, thread) it was written for -- see
 * `ConversationsRepo`, which has no method that could return another account's
 * words.
 */
export interface ConversationTurnRow {
  id: string;
  discordUserId: string;
  /** The Discord channel the message arrived in. */
  threadKey: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

/** Which slot of the day a proactive briefing covers. */
export type BriefingSlotKind = 'morning' | 'evening';
export type BriefingDeliveryStatus = 'pending' | 'delivered' | 'abandoned' | 'skipped';

/**
 * One proactive briefing, from due to settled.
 *
 * `dayKey` is the owner's own civil day (`YYYY-MM-DD` in their zone), because
 * "today's briefing" is a civil-day concept and the zone is a projection.
 */
export interface BriefingDeliveryRow {
  id: string;
  discordUserId: string;
  kind: BriefingSlotKind;
  dayKey: string;
  dueAt: string;
  status: BriefingDeliveryStatus;
  attempts: number;
  lastErrorAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface JobRow {
  id: string;
  publicId: string;
  discordUserId: string;
  repoSlug: string;
  task: string;
  context: string | null;
  bootstrap: boolean;
  state: JobState;
  /**
   * Where a RUNNING job is in the engineering loop, or null when nothing is
   * in progress. Orthogonal to `state`: the state says who owns the job, the
   * phase says what the agent is doing.
   */
  workPhase: JobWorkPhase | null;
  cancelRequested: boolean;
  attempts: number;
  maxAttempts: number;
  ownerInputRounds: number;
  maxOwnerInputRounds: number;
  recoveryRequired: boolean;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  executorId: string | null;
  retainedWorkspaceId: string | null;
  /**
   * The configured shared channel this job was submitted from, or null.
   * Written only when the channel was configured-shared at submit time, and
   * re-validated against live configuration before any delivery.
   */
  originSharedChannelId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReservationRow {
  repoSlug: string;
  jobId: string;
  acquiredAt: string;
  expiresAt: string | null;
  reason: 'active_job' | 'orphan_agent';
}

export interface ApprovalRow {
  id: string;
  jobId: string;
  actionIndex: number;
  actionKind: string;
  description: string;
  detailsJson: string;
  state: ApprovalState;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

/** A configured owner-only GitHub repository watch. */
export interface GitHubWatchRow {
  id: string;
  publicId: string;
  discordUserId: string;
  repoSlug: string;
  intervalMinutes: number;
  nextCheckAt: string | null;
  state: GitHubWatchState;
  snapshotHash: string | null;
  snapshotJson: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

/** A meaningful watch change waiting for owner-DM delivery. */
export interface GitHubWatchEventRow {
  id: string;
  watchId: string;
  publicWatchId: string;
  discordUserId: string;
  repoSlug: string;
  fingerprint: string;
  summary: string;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  abandonedAt: string | null;
}

/** One durable, at-most-once execution attempt for an approved action. */
export interface ApprovalExecutionRow {
  approvalId: string;
  jobId: string;
  state: ApprovalExecutionState;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ExecutorRow {
  id: string;
  name: string;
  state: 'active' | 'revoked';
  version: string | null;
  lastSeenAt: string | null;
}

export interface ExecutorCredentialRow {
  keyId: string;
  executorId: string;
  bearerVerifier: string;
  hmacKeyFingerprint: string;
  state: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type HerdrWorkspaceState = 'creating' | 'active' | 'closed';

export interface HerdrWorkspaceRow {
  workspaceId: string;
  repoSlug: string;
  jobId: string;
  label: string;
  mode: 'worktree' | 'direct';
  agentName: string;
  worktreePath: string | null;
  /** Where the result file lives; for a worktree this is not the repo root. */
  workspacePath: string | null;
  state: HerdrWorkspaceState;
  createdAt: string;
  updatedAt?: string | null;
  closedAt: string | null;
}

export interface OwnerInputRow {
  round: number;
  question: string;
  answer: string;
}

/**
 * Where a job notification can go. Tracked separately per transition so the
 * two can succeed, fail and retry independently.
 */
export const NOTIFICATION_TARGETS = ['owner_dm', 'shared_channel'] as const;
export type NotificationTarget = (typeof NOTIFICATION_TARGETS)[number];

/**
 * A job_transitions row with at least one target still undelivered, joined
 * with the fields the notifier needs.
 *
 * `ownerDelivered` / `sharedDelivered` say which targets are already
 * satisfied, so the notifier sends only what is actually outstanding rather
 * than re-deciding the whole transition.
 */
export interface PendingNotificationRow {
  transitionId: number;
  jobId: string;
  publicId: string;
  discordUserId: string;
  repoSlug: string;
  /** Never trusted on its own; re-checked against live configuration at send time. */
  originSharedChannelId: string | null;
  fromState: JobState;
  toState: JobState;
  reason: string;
  actor: string;
  createdAt: string;
  ownerDelivered: boolean;
  sharedDelivered: boolean;
}

/**
 * A task: a commitment with a state that can be completed, deliberately
 * distinct from a `CaptureRow`, which is an unsorted thought with neither a
 * due time nor a priority.
 *
 * `dueAt` is an ISO-8601 UTC instant like every other timestamp here.
 * `dueAllDay` records that the owner gave a date with no time of day, so a
 * presenter can show a date rather than a 00:00 nobody typed.
 */
export interface TaskRow {
  id: string;
  publicId: string;
  discordUserId: string;
  title: string;
  dueAt: string | null;
  dueAllDay: boolean;
  priority: TaskPriority;
  status: TaskState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/**
 * A reminder schedule.
 *
 * `nextFireAt` is the ONLY cursor: it is non-null exactly while the reminder
 * is `scheduled`, and advancing it past an occurrence is what stops a repeated
 * tick from firing the same occurrence twice. `intervalMinutes` is a fixed
 * interval and `maxOccurrences` a hard count, so a stored recurrence is always
 * bounded.
 */
export interface ReminderRow {
  id: string;
  publicId: string;
  discordUserId: string;
  text: string;
  recurrenceKind: RecurrenceKind;
  intervalMinutes: number | null;
  maxOccurrences: number;
  firedCount: number;
  nextFireAt: string | null;
  status: ReminderState;
  createdAt: string;
  updatedAt: string;
  firstFireAt: string;
  lastFiredAt: string | null;
  closedAt: string | null;
}

/**
 * One due occurrence of a reminder: the durable delivery unit, the same shape
 * of ledger `job_notification_deliveries` is for job transitions.
 *
 * `missedCount` is how many earlier occurrences were collapsed into this one
 * after an outage. Recorded rather than dropped, so a catch-up message can say
 * plainly what it stands for.
 */
export interface ReminderOccurrenceRow {
  id: string;
  reminderId: string;
  occurrenceNo: number;
  scheduledFor: string;
  missedCount: number;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  abandonedAt: string | null;
}

/** An undelivered occurrence joined with the reminder it belongs to. */
export interface PendingReminderOccurrenceRow {
  occurrenceId: string;
  reminderId: string;
  publicId: string;
  discordUserId: string;
  text: string;
  occurrenceNo: number;
  scheduledFor: string;
  missedCount: number;
  attempts: number;
  recurrenceKind: RecurrenceKind;
  maxOccurrences: number;
  nextFireAt: string | null;
}

/**
 * What a job is blocked on, and the bounded schedule for finding out whether
 * it still is.
 *
 * `nextCheckAt` is non-null exactly while `state` is `waiting` -- the schema
 * enforces it -- so "is anything still being polled?" is a fact of the row
 * rather than something the resolver has to be trusted to maintain.
 */
export interface DependencyRow {
  id: string;
  jobId: string;
  type: DependencyType;
  description: string;
  externalKey: string | null;
  state: DependencyState;
  nextCheckAt: string | null;
  checksMade: number;
  maxChecks: number;
  deadlineAt: string;
  lastCheckAt: string | null;
  lastStatus: DependencyCheckStatus | null;
  lastDetail: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/**
 * One audit row. A RECORD, never an authority: nothing reads this to decide
 * anything, and it carries no secret, no raw authentication material, no
 * terminal output and no Discord user id.
 */
export interface AuditLogRow {
  id: number;
  at: string;
  event: AuditEvent;
  actorKind: AuditActorKind;
  actorRef: string | null;
  subjectKind: AuditSubjectKind | null;
  subjectRef: string | null;
  outcome: AuditOutcome;
  detail: string | null;
}

export const toBool = (v: unknown): boolean => Number(v) === 1;
export const fromBool = (v: boolean): number => (v ? 1 : 0);
