import { z } from 'zod';
import { JOB_PAUSE_CAUSES, JOB_PAUSE_QUIET_STATUSES } from './system-pause.js';

/**
 * Durable pause delivery, protocol 1.
 *
 * The first pause route (`/jobs/:id/pause`) is lease-checked, so a report the
 * executor could not deliver before its lease expired was refused, and the
 * coordinator's ordinary lease expiry charged an attempt for it. This protocol
 * is negotiated per claim, bound to the full report identity, and answered with
 * a structured disposition the executor may rely on to forget its intent.
 *
 * It is NEW routes and a NEW claim capability, not extra fields on the old
 * strict route, because an older coordinator answers an unknown field with 400
 * and the old executor client would read that as a final refusal.
 *
 * Silence is never read as a pause. A coordinator learns of a quiet agent only
 * from an exact report; a lost report leaves the ordinary, conservative holds.
 */
export const PAUSE_DELIVERY_PROTOCOL = 1 as const;

/** Advertised in a claim's `capabilities`; the coordinator echoes `pauseProtocol` only to it. */
export const PAUSE_DELIVERY_CAPABILITY = 'pause-delivery-v1';

export const PAUSE_REPORT_PATH = (jobId: string): string =>
  `/api/v1/executor/jobs/${jobId}/pause-report`;
export const PAUSE_DISPOSITION_PATH = (jobId: string): string =>
  `/api/v1/executor/jobs/${jobId}/pause-disposition`;

/** Generated once per intent and never reused: the identity of one report. */
export const PAUSE_REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LEASE_DIGEST_RE = /^[0-9a-f]{16}$/;

const identity = {
  protocol: z.literal(PAUSE_DELIVERY_PROTOCOL),
  reportId: z.string().regex(PAUSE_REPORT_ID_RE),
  workspaceId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(64),
  cause: z.enum(JOB_PAUSE_CAUSES),
};

/** The report itself. `leaseId` is the lease the pause was proved under. */
export const PauseReportRequestSchema = z.strictObject({
  ...identity,
  leaseId: z.string().min(1).max(128),
  /** What a fresh `agent get` reported. Evidence for the audit trail, not a permission. */
  agentStatus: z.enum(JOB_PAUSE_QUIET_STATUSES),
  quiescent: z.literal(true),
});
export type PauseReportRequest = z.infer<typeof PauseReportRequestSchema>;

/** Read-only: what became of a report. Carries the lease as a digest, never the lease. */
export const PauseDispositionRequestSchema = z.strictObject({
  ...identity,
  leaseDigest: z.string().regex(LEASE_DIGEST_RE),
});
export type PauseDispositionRequest = z.infer<typeof PauseDispositionRequestSchema>;

/**
 * - `paused`, `overtaken_cancelled`, `overtaken_timed_out`: a committed report
 *   (a receipt exists). A cancellation or the elapsed deadline won inside the
 *   transaction, on the coordinator's clock;
 * - `superseded`: no receipt, and the coordinator has moved past that attempt
 *   (resumed, claimed again, cancelled, terminal, or an old-protocol expiry
 *   already charged it). Nothing is mutated and nothing is released;
 * - `pending`: the coordinator still holds that attempt open and would accept a
 *   fresh report. Only ever answers a disposition query.
 */
export const PAUSE_DISPOSITIONS = [
  'paused', 'overtaken_cancelled', 'overtaken_timed_out', 'superseded', 'pending',
] as const;
export type PauseDisposition = (typeof PAUSE_DISPOSITIONS)[number];

/** The dispositions after which an executor may forget its intent. */
export const PAUSE_TERMINAL_DISPOSITIONS = [
  'paused', 'overtaken_cancelled', 'overtaken_timed_out', 'superseded',
] as const;
export type PauseTerminalDisposition = (typeof PAUSE_TERMINAL_DISPOSITIONS)[number];
export const isTerminalPauseDisposition = (d: PauseDisposition): d is PauseTerminalDisposition =>
  (PAUSE_TERMINAL_DISPOSITIONS as readonly string[]).includes(d);

/** Echoes the whole identity, so a client can verify the answer is about ITS report. */
export const PauseDeliveryResponseSchema = z.strictObject({
  ...identity,
  jobId: z.string().min(1).max(128),
  executorId: z.string().min(1).max(64),
  leaseDigest: z.string().regex(LEASE_DIGEST_RE),
  disposition: z.enum(PAUSE_DISPOSITIONS),
  state: z.string().min(1).max(64),
});
export type PauseDeliveryResponse = z.infer<typeof PauseDeliveryResponseSchema>;

/**
 * Whether anything on an executor can ever need this job's durable local records
 * again. Terminal jobs never run again, and a job waiting for approval only ever
 * ends through the coordinator (its actions are the coordinator's, not a turn):
 * for these, and only these, an executor may drop its dispatch journal entry.
 * Everything else -- running, queued, waiting for an executor, paused for the
 * owner or on a dependency -- can still be recovered, resumed or reconciled, so
 * its journal is exactly what a later quiet proof rests on.
 */
export const EXECUTOR_DONE_STATES = ['completed', 'failed', 'cancelled', 'needs_approval'] as const;
export const isExecutorDone = (state: string): boolean =>
  (EXECUTOR_DONE_STATES as readonly string[]).includes(state);

export const JOB_STATUS_PATH = (jobId: string): string => `/api/v1/executor/jobs/${jobId}/status`;

export const JobStatusRequestSchema = z.strictObject({});
export const JobStatusResponseSchema = z.strictObject({
  jobId: z.string().min(1).max(128),
  state: z.string().min(1).max(64),
  /** `isExecutorDone(state)`, decided by the coordinator. */
  executorDone: z.boolean(),
});
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;

/** The transition reason of a lease expiry whose charge was deferred (protocol 1). */
export const LEASE_EXPIRED_DEFERRED_REASON = 'lease_expired_deferred';
