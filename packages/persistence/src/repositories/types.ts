import type { ApprovalState, CaptureState, JobState } from '@ducky/contracts';

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

export interface JobRow {
  id: string;
  publicId: string;
  discordUserId: string;
  repoSlug: string;
  task: string;
  context: string | null;
  bootstrap: boolean;
  state: JobState;
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

export const toBool = (v: unknown): boolean => Number(v) === 1;
export const fromBool = (v: boolean): number => (v ? 1 : 0);
