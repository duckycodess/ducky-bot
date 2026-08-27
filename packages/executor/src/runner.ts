import { createHash } from 'node:crypto';
import {
  DuckyError, JOB_MAX_WALL_CLOCK_MS, RECOVERY_WAIT_MS, isDuckyError,
  type ClaimResponse, type ExecutorFailureReason,
} from '@ducky/contracts';
import {
  agentNameFor, buildOrchestrationBrief, redact, toSlugKey, workspaceLabelFor,
  type OrchestrationOutcome, type OrchestrationSpec, type PiOrchestrator,
} from '@ducky/adapters';
import { RESULT_RELATIVE_PATH } from '@ducky/adapters';
import type { CoordinatorClient } from './client.js';
import { resolveWorkspace } from './workspace.js';
import { acquireWriterLock } from './single-writer.js';
import { JobSupervisor } from './supervisor.js';

export interface RunnerDeps {
  readonly client: CoordinatorClient;
  readonly orchestrator: PiOrchestrator;
  /** Recorded workspace for this job, when the executor has one from a prior turn. */
  readonly recordedWorkspace?: (jobId: string) => {
    workspaceId: string;
    agentName: string;
    workspacePath: string;
  } | undefined;
  readonly onWorkspace?: (jobId: string, info: {
    workspaceId: string;
    agentName: string;
    workspacePath: string;
    mode: 'worktree' | 'direct';
  }) => void;
  readonly log?: (line: string) => void;
  readonly heartbeatMs?: number | undefined;
}

/**
 * Runs one claimed job to a reported outcome.
 *
 * The writer lock is taken immediately before the Pi turn and released as soon
 * as it ends, so a job that pauses for an owner answer leaves no live writer
 * behind. Nothing here ever fabricates a result: an unresolvable workspace is
 * reported through the structured failure route instead.
 */
export async function runClaimedJob(deps: RunnerDeps, claim: ClaimResponse): Promise<void> {
  const { client, orchestrator } = deps;
  const log = deps.log ?? (() => {});
  const started = Date.now();

  let resolved;
  try {
    resolved = await resolveWorkspace(claim.payload, claim.publicId);
  } catch (err) {
    const detail = isDuckyError(err) ? err.ownerMessage : 'Workspace could not be prepared.';
    await client.reportFailure(claim.jobId, claim.leaseId, 'workspace_rejected', { detail });
    return;
  }

  const slugKey = toSlugKey(claim.payload.repoSlug);
  const brief = buildOrchestrationBrief({
    publicId: claim.publicId,
    repoSlug: claim.payload.repoSlug,
    task: claim.payload.task,
    context: claim.payload.context,
    ownerInputs: claim.ownerInputs,
    mode: resolved.mode,
    resultRelativePath: RESULT_RELATIVE_PATH,
  });

  // The prompt itself is never logged; only its digest.
  log(`job ${claim.publicId} prompt <prompt:sha256:${digest(brief)}> mode=${resolved.mode}`);

  // Heartbeats the lease and aborts the turn if the owner cancels. Without it
  // a cancellation would go unseen until the lease expired.
  const supervisor = new JobSupervisor({
    client,
    jobId: claim.jobId,
    leaseId: claim.leaseId,
    ...(deps.heartbeatMs === undefined ? {} : { intervalMs: deps.heartbeatMs }),
    ...(deps.log ? { log: deps.log } : {}),
  });

  const spec: OrchestrationSpec = {
    jobId: claim.jobId,
    publicId: claim.publicId,
    repoSlug: claim.payload.repoSlug,
    slugKey,
    mode: resolved.mode,
    repoPath: resolved.repoPath,
    branch: resolved.branch,
    base: resolved.base,
    brief,
    recorded: deps.recordedWorkspace?.(claim.jobId),
    recoveryRequired: claim.payload.recoveryRequired,
    promptTimeoutMs: JOB_MAX_WALL_CLOCK_MS,
    recoveryWaitMs: RECOVERY_WAIT_MS,
    signal: supervisor.signal,
    onWorkspaceCreated: async (info) => {
      // Durable ownership before the agent exists. If this fails the
      // orchestrator aborts rather than starting an unrecorded agent.
      await client.registerWorkspace(claim.jobId, {
        leaseId: claim.leaseId,
        workspaceId: info.workspaceId,
        agentName: info.agentName,
        label: info.label,
        mode: info.mode,
        workspacePath: info.workspacePath,
        worktreePath: info.worktreePath,
        state: 'creating',
      });
      deps.onWorkspace?.(claim.jobId, {
        workspaceId: info.workspaceId,
        agentName: info.agentName,
        workspacePath: info.workspacePath,
        mode: info.mode,
      });
    },
  };

  const lock = acquireWriterLock(claim.payload.repoSlug);
  let outcome: OrchestrationOutcome;
  supervisor.start();
  try {
    outcome = await orchestrator.runJob(spec);
  } catch (err) {
    const detail = isDuckyError(err) ? err.ownerMessage : 'The orchestrator failed.';
    const reason: ExecutorFailureReason =
      isDuckyError(err) && err.code === 'herdr_unavailable' ? 'herdr_unavailable' : 'no_result';
    await client.reportFailure(claim.jobId, claim.leaseId, reason, { detail: redact(detail) });
    return;
  } finally {
    supervisor.stop();
    // Released before any report, including needs_owner_input.
    lock.release();
  }

  // The owner cancelled mid-turn. Confirm what the agent is actually doing
  // before acknowledging: claiming a termination we did not observe would let
  // the coordinator release the repository while a writer was still live.
  if (supervisor.cancelRequested) {
    const stopped = await orchestrator.cancel(spec);
    await client.cancelAck(claim.jobId, {
      leaseId: claim.leaseId,
      terminated: stopped.terminated,
      note: redact(stopped.detail).slice(0, 400),
    });
    if (!stopped.terminated) {
      // Fail closed: the repository stays reserved for the owner to clear.
      await client.reportFailure(claim.jobId, claim.leaseId, 'orphan_agent_still_working', {
        detail: redact(stopped.detail).slice(0, 400),
        ...(stopped.workspaceId === undefined ? {} : { workspaceId: stopped.workspaceId }),
        ...(stopped.agentName === undefined ? {} : { agentName: stopped.agentName }),
      });
    }
    return;
  }

  if (Date.now() - started > JOB_MAX_WALL_CLOCK_MS) {
    await client.reportFailure(claim.jobId, claim.leaseId, 'wall_clock_exceeded', {
      detail: 'The job exceeded its wall-clock budget.',
    });
    return;
  }

  switch (outcome.kind) {
    case 'result':
      deps.onWorkspace?.(claim.jobId, {
        workspaceId: outcome.workspaceId,
        agentName: outcome.agentName,
        workspacePath: outcome.workspacePath,
        mode: resolved.mode,
      });
      await client.submitResult(claim.jobId, claim.leaseId, outcome.result);
      return;

    case 'orphan':
      // A possibly-live writer stays untouched and keeps blocking the repo
      // until the owner clears it.
      await client.reportFailure(claim.jobId, claim.leaseId, outcome.reason, {
        workspaceId: outcome.workspaceId,
        agentName: outcome.agentName,
        detail: `Agent ${outcome.agentName} could not be resolved safely.`,
      });
      return;

    case 'conflict':
      await client.reportFailure(claim.jobId, claim.leaseId, 'foreign_agent_conflict', {
        agentName: outcome.agentName,
        detail: 'An agent with that name exists but is not provably ours; nothing was touched.',
      });
      return;

    case 'unavailable':
      await client.reportFailure(claim.jobId, claim.leaseId, 'herdr_unavailable', {
        detail: 'Herdr is not reachable on this host.',
      });
      return;

    case 'no_result':
      deps.onWorkspace?.(claim.jobId, {
        workspaceId: outcome.workspaceId,
        agentName: outcome.agentName,
        workspacePath: outcome.workspacePath,
        mode: resolved.mode,
      });
      await client.reportFailure(claim.jobId, claim.leaseId, 'no_result', {
        workspaceId: outcome.workspaceId,
        agentName: outcome.agentName,
        detail: 'The agent finished without writing a valid result file.',
      });
      return;
  }
}

function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export { agentNameFor, DuckyError };
