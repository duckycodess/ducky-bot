import { z } from 'zod';
import { JobResultFileSchema } from './job-result.js';
import { JOB_WORK_PHASES, type JobWorkPhase } from './job-state.js';
import { EXECUTOR_ID_RE, PUBLIC_JOB_ID_RE } from './ids.js';
import { CLAIM_MAX_WAIT_MS, MAX_ANSWER, MAX_PROGRESS_MESSAGE, MAX_QUESTION } from './limits.js';

export const ExecutorIdSchema = z.string().regex(EXECUTOR_ID_RE);

export const HeartbeatRequestSchema = z.strictObject({
  executorId: ExecutorIdSchema,
  version: z.string().max(64),
  capabilities: z.array(z.string().max(64)).max(32),
  activeJobIds: z.array(z.string().max(64)).max(32),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const ClaimRequestSchema = z.strictObject({
  executorId: ExecutorIdSchema,
  capabilities: z.array(z.string().max(64)).max(32),
  waitMs: z.number().int().min(0).max(CLAIM_MAX_WAIT_MS),
  idempotencyKey: z.string().min(8).max(128),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const OwnerInputSchema = z.strictObject({
  round: z.number().int().min(0),
  question: z.string().max(MAX_QUESTION),
  answer: z.string().max(MAX_ANSWER),
});
export type OwnerInput = z.infer<typeof OwnerInputSchema>;

export const JobPayloadSchema = z.strictObject({
  repoSlug: z.string().max(64),
  absolutePath: z.string().max(4096),
  defaultBranch: z.string().max(255).nullable(),
  task: z.string(),
  context: z.string().nullable(),
  bootstrap: z.boolean(),
  allowWorktree: z.boolean(),
  allowBootstrap: z.boolean(),
  bootstrapAllowedEntries: z.array(z.string().max(255)).max(32),
  maxOwnerInputRounds: z.number().int().min(0),
  recoveryRequired: z.boolean(),
  ownerInputRounds: z.number().int().min(0),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export const HERDR_WORKSPACE_STATES = ['creating', 'active', 'closed'] as const;
export type HerdrWorkspaceState = (typeof HERDR_WORKSPACE_STATES)[number];

/**
 * A workspace the coordinator already knows this job owns.
 *
 * Sent on claim so a RESTARTED executor -- which has lost its in-memory map --
 * can still prove ownership and reattach, rather than seeing an unrecognised
 * agent and reporting a foreign conflict against its own workspace.
 *
 * This is executor-to-executor data relayed through the coordinator. It carries
 * a filesystem path and is never surfaced to Discord.
 */
export const RecordedWorkspaceSchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(64),
  workspacePath: z.string().min(1).max(4096),
  mode: z.enum(['worktree', 'direct']),
  state: z.enum(HERDR_WORKSPACE_STATES),
});
export type RecordedWorkspace = z.infer<typeof RecordedWorkspaceSchema>;

export const ClaimResponseSchema = z.strictObject({
  jobId: z.string(),
  publicId: z.string().regex(PUBLIC_JOB_ID_RE),
  leaseId: z.string(),
  leaseExpiresAt: z.string(),
  payload: JobPayloadSchema,
  ownerInputs: z.array(OwnerInputSchema).max(16),
  recordedWorkspace: RecordedWorkspaceSchema.nullable(),
});
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

/**
 * A progress report.
 *
 * `phase` is an ALLOWLISTED enum, not a free string: it moves the job through
 * the engineering loop, so an unrecognised value has to be a refusal rather
 * than something that gets stored and later rendered. `kind` and `message`
 * stay free text because they are only ever displayed, and both are redacted
 * and clamped before they are persisted.
 */
export const JobProgressSchema = z.strictObject({
  kind: z.string().max(64),
  message: z.string().max(MAX_PROGRESS_MESSAGE),
  phase: z.enum(JOB_WORK_PHASES).optional(),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const JobHeartbeatRequestSchema = z.strictObject({
  leaseId: z.string().min(1).max(128),
  progress: JobProgressSchema.optional(),
});
export type JobHeartbeatRequest = z.infer<typeof JobHeartbeatRequestSchema>;

/**
 * What a job heartbeat answers.
 *
 * `workPhase` is the phase the coordinator ACCEPTED, which is not necessarily
 * the one that was reported: the phase machine refuses a backwards or skipped
 * edge. Echoing it back is what lets the executor log the phase that actually
 * took effect rather than the one it hoped for -- and it is the evidence a live
 * certification run records.
 */
export interface JobHeartbeatResponse {
  readonly cancelRequested: boolean;
  readonly leaseExpiresAt: string;
  readonly workPhase?: JobWorkPhase | null;
}

export const JobResultRequestSchema = z.strictObject({
  leaseId: z.string().min(1).max(128),
  result: JobResultFileSchema,
});
export type JobResultRequest = z.infer<typeof JobResultRequestSchema>;

export const CancelAckRequestSchema = z.strictObject({
  leaseId: z.string().min(1).max(128),
  terminated: z.boolean(),
  note: z.string().max(MAX_PROGRESS_MESSAGE).optional(),
});
export type CancelAckRequest = z.infer<typeof CancelAckRequestSchema>;

/**
 * Structured failure report. An orphaned or unresolvable workspace has no
 * review and no verification, so forcing it through the result schema would
 * mean fabricating evidence. It gets its own route instead.
 */
export const EXECUTOR_FAILURE_REASONS = [
  'orphan_agent_still_working',
  'orphan_agent_blocked',
  'foreign_agent_conflict',
  'herdr_unavailable',
  'workspace_rejected',
  'no_result',
  'wall_clock_exceeded',
  'cancelled_by_owner',
] as const;
export type ExecutorFailureReason = (typeof EXECUTOR_FAILURE_REASONS)[number];

/** Reasons that leave a possibly-live writer behind and must block the repo. */
export const ORPHAN_FAILURE_REASONS: readonly ExecutorFailureReason[] = [
  'orphan_agent_still_working',
  'orphan_agent_blocked',
];

export const JobFailureRequestSchema = z.strictObject({
  leaseId: z.string().min(1).max(128),
  reason: z.enum(EXECUTOR_FAILURE_REASONS),
  detail: z.string().max(MAX_PROGRESS_MESSAGE).optional(),
  workspaceId: z.string().max(128).optional(),
  agentName: z.string().max(64).optional(),
  workspacePath: z.string().max(4096).optional(),
});
export type JobFailureRequest = z.infer<typeof JobFailureRequestSchema>;

/**
 * Registered as soon as a Ducky workspace exists and BEFORE any agent is
 * started in it, so an executor crash between creation and the first prompt
 * still leaves the coordinator able to prove the workspace is ours.
 *
 * Without this the next claim would see an unrecognised agent, report
 * `foreign_agent_conflict`, and release the reservation while a live writer was
 * still running in that workspace.
 */

export const WorkspaceRegistrationRequestSchema = z.strictObject({
  leaseId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  mode: z.enum(['worktree', 'direct']),
  workspacePath: z.string().min(1).max(4096),
  worktreePath: z.string().max(4096).nullable().optional(),
  state: z.enum(HERDR_WORKSPACE_STATES).default('creating'),
});
export type WorkspaceRegistrationRequest = z.infer<typeof WorkspaceRegistrationRequestSchema>;

export const WorkspaceRegistrationResponseSchema = z.strictObject({
  registered: z.boolean(),
  workspaceId: z.string(),
});

/**
 * Bookkeeping after a workspace was actually closed.
 *
 * Deliberately lease-free: accepting a result clears the lease, so the close
 * that follows a successful cleanup has none to present. It is authenticated
 * by the owning executor and can only ever target a workspace already recorded
 * against that job.
 */
export const WorkspaceCloseRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
});
export type WorkspaceCloseRequest = z.infer<typeof WorkspaceCloseRequestSchema>;

export const EXECUTOR_HEADERS = {
  executorId: 'x-ducky-executor-id',
  keyId: 'x-ducky-key-id',
  timestamp: 'x-ducky-timestamp',
  nonce: 'x-ducky-nonce',
  signature: 'x-ducky-signature',
} as const;

/** The exact string both sides sign. Version-prefixed so it can evolve. */
export function canonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}): string {
  return [
    'v1',
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodySha256Hex,
  ].join('\n');
}
