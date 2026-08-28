import { createHash } from 'node:crypto';
import {
  DuckyError, JOB_MAX_WALL_CLOCK_MS, RECOVERY_WAIT_MS, isDuckyError,
  type ClaimResponse, type ExecutorFailureReason,
} from '@ducky/contracts';
import {
  agentNameFor, buildOrchestrationBrief, redact, toSlugKey, workspaceLabelFor,
  type OrchestrationOutcome, type OrchestrationSpec, type PiOrchestrator,
} from '@ducky/adapters';
import { PHASE_RELATIVE_PATH, RESULT_RELATIVE_PATH } from '@ducky/adapters';
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
    phaseRelativePath: PHASE_RELATIVE_PATH,
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

  /** What was registered when the workspace was created, reused verbatim later. */
  let registered:
    | {
        workspaceId: string;
        agentName: string;
        label: string;
        mode: 'worktree' | 'direct';
        workspacePath: string;
        worktreePath: string | null;
      }
    | undefined;

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
    // Prefer what the coordinator sent: after a restart the in-memory map is
    // empty, and without this the adapter would meet its own agent as a
    // stranger and report a foreign conflict.
    recorded:
      (claim.recordedWorkspace
        ? {
            workspaceId: claim.recordedWorkspace.workspaceId,
            agentName: claim.recordedWorkspace.agentName,
            workspacePath: claim.recordedWorkspace.workspacePath,
          }
        : undefined) ?? deps.recordedWorkspace?.(claim.jobId),
    recoveryRequired: claim.payload.recoveryRequired,
    promptTimeoutMs: JOB_MAX_WALL_CLOCK_MS,
    recoveryWaitMs: RECOVERY_WAIT_MS,
    signal: supervisor.signal,
    onPhase: (phase) => supervisor.reportPhase(phase),
    onWorkspaceCreated: async (info) => {
      // Remembered so the follow-up state advance re-sends the SAME path. For
      // a worktree that is Herdr's checkout directory, not the repo root, and
      // overwriting it would corrupt the record cleanup later relies on.
      registered = info;
      // Pi writes its phase inside the workspace, so the supervisor can only
      // start looking once that path exists. For a worktree this is Herdr's
      // checkout directory -- the same place the result file lives.
      supervisor.watchWorkspace(info.workspacePath);
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
    onAgentStarted: async (info) => {
      // Advance the record off `creating`, so a stale row is distinguishable
      // from one whose agent genuinely started.
      if (!registered || registered.workspaceId !== info.workspaceId) return;
      await client
        .registerWorkspace(claim.jobId, {
          leaseId: claim.leaseId,
          workspaceId: registered.workspaceId,
          agentName: registered.agentName,
          label: registered.label,
          mode: registered.mode,
          workspacePath: registered.workspacePath,
          worktreePath: registered.worktreePath,
          state: 'active',
        })
        .catch(() => {
          /* the turn is already under way; bookkeeping is not worth aborting it */
        });
    },
  };

  // A resumed job already owns a workspace, so its phase file may exist from
  // the moment the turn starts -- `onWorkspaceCreated` will not fire again.
  if (spec.recorded) supervisor.watchWorkspace(spec.recorded.workspacePath);

  const lock = acquireWriterLock(claim.payload.repoSlug);
  let outcome: OrchestrationOutcome | undefined;
  let failure: unknown;
  supervisor.start();

  try {
    // Raced, not awaited to completion. A real turn is a blocking
    // `herdr agent prompt --wait`; waiting it out would mean a cancellation
    // took effect only after the full wall-clock timeout.
    outcome = await Promise.race([
      orchestrator.runJob(spec).then((o) => o).catch((err) => {
        failure = err;
        return undefined;
      }),
      cancelled(supervisor.signal),
    ]);
  } finally {
    supervisor.stop();
  }

  // Cancellation WINS the race. If the owner's request was observed at all,
  // this turn's result is not accepted -- even when the orchestration happened
  // to resolve at the same moment. Accepting it would complete, and clean up
  // after, work the owner had explicitly stopped. Re-submitting is the owner's
  // call to make.
  if (supervisor.cancelRequested) {
    if (outcome !== undefined) {
      log(`job ${claim.publicId}: result discarded, the owner cancelled during the turn`);
    }
    let stopped;
    try {
      stopped = await orchestrator.cancel(spec);
    } catch (err) {
      stopped = {
        terminated: false,
        agentStatus: 'unknown' as const,
        detail: isDuckyError(err) ? err.ownerMessage : 'Could not confirm whether the agent stopped.',
        workspaceId: spec.recorded?.workspaceId,
        agentName: spec.recorded?.agentName,
      };
    }

    // Only safe to let go once nothing of ours is running. Ownership was
    // already registered when the workspace was created, so nothing more needs
    // recording here.
    if (stopped.terminated) lock.release();

    await client.cancelAck(claim.jobId, {
      leaseId: claim.leaseId,
      terminated: stopped.terminated,
      note: redact(stopped.detail).slice(0, 400),
    });
    if (!stopped.terminated) {
      await client.reportFailure(claim.jobId, claim.leaseId, 'orphan_agent_still_working', {
        detail: redact(stopped.detail).slice(0, 400),
        ...(stopped.workspaceId === undefined ? {} : { workspaceId: stopped.workspaceId }),
        ...(stopped.agentName === undefined ? {} : { agentName: stopped.agentName }),
      });
      // Deliberately NOT released: the lock outlives this run so a retry on
      // this host cannot start a second writer beside the live agent.
    }
    return;
  }

  // Past the cancellation branch the turn has genuinely ended -- but "the turn
  // ended" is not the same as "nothing of ours is running". An ORPHAN outcome
  // means the orchestrator observed an agent that may still be writing, so the
  // host-side writer lock is deliberately KEPT, exactly as the cancellation
  // branch above keeps it. Releasing it here (which is what used to happen,
  // because the release was unconditional) would let a retry on this host start
  // a second writer beside a live Pi agent -- the one thing the single-writer
  // guarantee exists to prevent.
  const keepsWriterLock = outcome?.kind === 'orphan';
  if (!keepsWriterLock) lock.release();

  if (failure !== undefined) {
    const err = failure;
    const detail = isDuckyError(err) ? err.ownerMessage : 'The orchestrator failed.';
    // A stalled prompt is NOT an outage: the orchestrator has already proved,
    // via `agentGet`, that no agent of ours is running and no result was
    // written. It is reported as an absent result so the reason stays honest.
    const reason: ExecutorFailureReason =
      isDuckyError(err) && err.code === 'herdr_unavailable' ? 'herdr_unavailable' : 'no_result';
    await client.reportFailure(claim.jobId, claim.leaseId, reason, { detail: redact(detail) });
    return;
  }
  if (outcome === undefined) {
    await client.reportFailure(claim.jobId, claim.leaseId, 'no_result', {
      detail: 'The orchestrator returned nothing.',
    });
    return;
  }

  if (Date.now() - started > JOB_MAX_WALL_CLOCK_MS) {
    await client.reportFailure(claim.jobId, claim.leaseId, 'wall_clock_exceeded', {
      detail: 'The job exceeded its wall-clock budget.',
    });
    return;
  }

  switch (outcome.kind) {
    case 'result': {
      deps.onWorkspace?.(claim.jobId, {
        workspaceId: outcome.workspaceId,
        agentName: outcome.agentName,
        workspacePath: outcome.workspacePath,
        mode: resolved.mode,
      });
      const accepted = (await client.submitResult(claim.jobId, claim.leaseId, outcome.result)) as
        | { state?: string }
        | undefined;

      // Clean up ONLY after a genuinely terminal success. A job that paused for
      // an owner answer, is awaiting approval, or failed keeps its workspace so
      // the work stays inspectable -- and so the next round can reuse it.
      if (accepted?.state === 'completed') {
        // cleanup() proves ownership against `recorded`, so hand it exactly
        // the workspace this run produced.
        // The result is already accepted at this point, so a cleanup problem
        // must never escape and be reported as a job failure: the work
        // succeeded, only the tidying did not. A kept workspace is recoverable
        // (the reconciler sweeps it, and the owner can clear the job); a
        // successful job re-reported as failed is not.
        let cleaned: { closed: boolean; detail: string };
        try {
          cleaned = await orchestrator.cleanup(
            {
              ...spec,
              recorded: {
                workspaceId: outcome.workspaceId,
                agentName: outcome.agentName,
                workspacePath: outcome.workspacePath,
              },
            },
            outcome.workspaceId,
          );
        } catch (err) {
          const detail = isDuckyError(err) ? err.ownerMessage : 'Cleanup failed.';
          cleaned = { closed: false, detail: `not cleaned up: ${redact(detail).slice(0, 200)}` };
        }
        log(`job ${claim.publicId} cleanup: ${cleaned.detail}`);
        if (cleaned.closed) {
          // Recorded only after the exact recorded workspace was proved closed,
          // through a lease-free route -- submitting the result already cleared
          // the lease, so the old registration call could never have succeeded
          // here and the row would have stayed open for reapers to trip over.
          try {
            await client.closeWorkspace(claim.jobId, outcome.workspaceId);
          } catch (err) {
            log(
              `job ${claim.publicId}: workspace closed in Herdr but bookkeeping failed ` +
                `(${redact((err as Error).message).slice(0, 120)})`,
            );
          }
        }
      }
      return;
    }

    case 'orphan':
      // A possibly-live writer stays untouched and keeps blocking the repo
      // until the owner clears it. The writer lock was NOT released above, so
      // this host cannot start a second writer either.
      log(
        `job ${claim.publicId}: ${outcome.reason}; writer lock for ` +
          `\`${claim.payload.repoSlug}\` retained for the owner`,
      );
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

/** Resolves (to undefined) as soon as the owner cancels. */
function cancelled(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export { agentNameFor, DuckyError };
