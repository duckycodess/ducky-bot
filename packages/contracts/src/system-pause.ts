import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * A SYSTEM pause: the executor stopped a claimed attempt without anything the
 * owner asked a question about, and without the agent writing a result.
 *
 * It rides the existing paused `needs_owner_input` state, so the repository
 * reservation, the retained workspace, the 24-hour expiry and cancellation all
 * keep working unchanged. What differs is what it is NOT:
 *
 * - it is not an owner question, so it has no question text, no result
 *   snapshot and no `job_owner_inputs` row, and resuming it consumes none of the
 *   job's `ownerInputRounds`;
 * - it is not a failure, so it consumes none of `attempts`;
 * - it is not a diagnosis. Nothing here says the provider's quota or sign-in
 *   was the cause, because nothing Ducky observes can prove that.
 */
export const JOB_PAUSE_CAUSES = ['agent_idle_no_result', 'memory_headroom_unproven'] as const;
export type JobPauseCause = (typeof JOB_PAUSE_CAUSES)[number];

/**
 * The only agent states that count as proof the agent is quiet. Absent,
 * unknown, working and blocked are deliberately not here: each of those keeps
 * its own fail-closed outcome and never earns the slot release a pause carries.
 */
export const JOB_PAUSE_QUIET_STATUSES = ['idle', 'done'] as const;
export type JobPauseQuietStatus = (typeof JOB_PAUSE_QUIET_STATUSES)[number];

export const JobPauseRequestSchema = z.strictObject({
  leaseId: z.string().min(1).max(128),
  cause: z.enum(JOB_PAUSE_CAUSES),
  /** The exact workspace and agent the executor proved quiet, checked against the recorded row. */
  workspaceId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(64),
  /** What a fresh `agent get` reported. Evidence for the audit trail, not a permission. */
  agentStatus: z.enum(JOB_PAUSE_QUIET_STATUSES),
  /**
   * Must be literally true. A request without positive quiescence is a schema
   * error rather than a pause that quietly releases the engineering slot.
   */
  quiescent: z.literal(true),
});
export type JobPauseRequest = z.infer<typeof JobPauseRequestSchema>;

export const JobPauseResponseSchema = z.strictObject({
  /** `needs_owner_input` when paused; `cancelled` or `failed` when a cancel or the deadline won. */
  state: z.string(),
  paused: z.boolean(),
});
export type JobPauseResponse = z.infer<typeof JobPauseResponseSchema>;

const PAUSE_PREFIX = 'system_pause:';

/** Short, stable, non-reversible tag of the pausing lease; the lease itself is never stored. */
export const leaseDigest = (leaseId: string): string =>
  createHash('sha256').update(leaseId).digest('hex').slice(0, 16);

/**
 * The transition reason of a system pause. It carries the cause AND a digest of
 * the pausing lease, which is what makes a retried pause report recognisable
 * after the lease itself has been cleared.
 */
export const systemPauseReason = (cause: JobPauseCause, leaseId: string): string =>
  `${PAUSE_PREFIX}${cause}:${leaseDigest(leaseId)}`;

export function parseSystemPauseReason(
  reason: string,
): { cause: JobPauseCause; leaseDigest: string } | undefined {
  if (!reason.startsWith(PAUSE_PREFIX)) return undefined;
  const [cause, digest, ...rest] = reason.slice(PAUSE_PREFIX.length).split(':');
  if (rest.length > 0 || !digest || !/^[0-9a-f]{16}$/.test(digest)) return undefined;
  return (JOB_PAUSE_CAUSES as readonly string[]).includes(cause ?? '')
    ? { cause: cause as JobPauseCause, leaseDigest: digest }
    : undefined;
}

/** The owner resuming a system pause. Not an answer: it writes no owner-input row. */
export const SYSTEM_RESUME_REASON = 'owner_resumed_system_pause';

/**
 * What the owner reads. Generic on purpose: the first cause says the agent was
 * quiet and left no result, and explicitly declines to say why.
 */
export const SYSTEM_PAUSE_OWNER_TEXT: Record<JobPauseCause, string> = {
  agent_idle_no_result:
    'The agent stopped without a valid result, and Herdr reports it idle or done. ' +
    'Ducky cannot tell whether that was a provider sign-in, quota or access problem or ' +
    'something else, and it has not guessed. The workspace and repository are kept. ' +
    'Check the agent, then resume to start a fresh bounded attempt.',
  memory_headroom_unproven:
    'Ducky could not prove that the agent was the recorded one, ready for input, and had ' +
    "enough memory headroom in its own cgroup and every ancestor, so it withheld the prompt. " +
    'Nothing was sent to the model. The workspace and repository are kept. Resume once ' +
    'memory is available.',
};

/**
 * A pause report that arrived AFTER the coordinator had already decided the
 * job's fate: an owner cancellation or an elapsed attempt deadline won inside
 * the transaction. The reason carries the digest of the reporting lease so a
 * retried report (the response was lost) replays the same terminal state
 * instead of being refused as a stale lease and logged as undelivered.
 */
export const PAUSE_OVERTAKEN_OUTCOMES = ['cancelled', 'timed_out'] as const;
export type PauseOvertakenOutcome = (typeof PAUSE_OVERTAKEN_OUTCOMES)[number];

const OVERTAKEN_PREFIX = 'pause_overtaken:';

export const pauseOvertakenReason = (outcome: PauseOvertakenOutcome, leaseId: string): string =>
  `${OVERTAKEN_PREFIX}${outcome}:${leaseDigest(leaseId)}`;

export function parsePauseOvertakenReason(
  reason: string,
): { outcome: PauseOvertakenOutcome; leaseDigest: string } | undefined {
  if (!reason.startsWith(OVERTAKEN_PREFIX)) return undefined;
  const [outcome, digest, ...rest] = reason.slice(OVERTAKEN_PREFIX.length).split(':');
  if (rest.length > 0 || !digest || !/^[0-9a-f]{16}$/.test(digest)) return undefined;
  return (PAUSE_OVERTAKEN_OUTCOMES as readonly string[]).includes(outcome ?? '')
    ? { outcome: outcome as PauseOvertakenOutcome, leaseDigest: digest }
    : undefined;
}

export const PAUSE_OVERTAKEN_OWNER_TEXT: Record<PauseOvertakenOutcome, string> = {
  cancelled: 'Cancelled. The agent was already quiet when the executor reported, so nothing was left running.',
  timed_out: 'The attempt budget ran out before the executor could pause the job. The agent was observed quiet.',
};
