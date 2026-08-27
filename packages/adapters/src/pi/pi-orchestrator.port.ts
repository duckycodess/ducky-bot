import type { JobResultFile } from '@ducky/contracts';

export interface OrchestrationSpec {
  readonly jobId: string;
  readonly publicId: string;
  readonly repoSlug: string;
  /** Normalized slug that fits herdr's 32-char agent-name rule with the prefix. */
  readonly slugKey: string;
  readonly mode: 'worktree' | 'direct';
  /** Repository root; the base for a worktree, or the cwd itself in direct mode. */
  readonly repoPath: string;
  readonly branch: string;
  readonly base: string;
  readonly brief: string;
  /** Set when this job already owns a recorded Ducky workspace (retry/answer). */
  readonly recorded?: { workspaceId: string; agentName: string; workspacePath: string } | undefined;
  readonly recoveryRequired: boolean;
  readonly promptTimeoutMs: number;
  readonly recoveryWaitMs: number;
  /** Aborted when the owner cancels; the orchestrator stops waiting. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Called as soon as a Ducky workspace exists and BEFORE any agent is started
   * in it. If it throws, the orchestrator must not start an agent: without a
   * durable ownership record a later recovery could mistake a live Ducky agent
   * for a stranger's and release the repository underneath it.
   */
  readonly onWorkspaceCreated?: (info: {
    workspaceId: string;
    agentName: string;
    label: string;
    mode: 'worktree' | 'direct';
    workspacePath: string;
    worktreePath: string | null;
  }) => Promise<void>;
}

/**
 * What actually happened when we tried to stop a running turn.
 *
 * `terminated` is only true when the agent is observably no longer working.
 * We never claim termination we did not verify: the coordinator uses this to
 * decide whether a job may be marked cancelled, and a false positive there
 * would release the repository while a writer was still live.
 */
export interface CancelOutcome {
  readonly terminated: boolean;
  readonly agentStatus: 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | 'absent';
  readonly detail: string;
  readonly workspaceId?: string | undefined;
  readonly agentName?: string | undefined;
}

export type OrchestrationOutcome =
  | {
      kind: 'result';
      result: JobResultFile;
      workspaceId: string;
      agentName: string;
      workspacePath: string;
      reused: boolean;
    }
  | {
      kind: 'orphan';
      reason: 'orphan_agent_still_working' | 'orphan_agent_blocked';
      workspaceId: string;
      agentName: string;
    }
  | { kind: 'conflict'; reason: 'foreign_agent_conflict'; agentName: string }
  | { kind: 'unavailable' }
  | { kind: 'no_result'; workspaceId: string; agentName: string; workspacePath: string };

export interface PiOrchestrator {
  readonly name: string;
  /** False until `pnpm probe:herdr` has recorded live fixtures for this host. */
  readonly verified: boolean;
  runJob(spec: OrchestrationSpec): Promise<OrchestrationOutcome>;
  /**
   * Attempts to stop an in-flight turn and reports honestly whether it did.
   * Implementations must not fabricate a termination they cannot observe.
   */
  cancel(spec: OrchestrationSpec): Promise<CancelOutcome>;
}
