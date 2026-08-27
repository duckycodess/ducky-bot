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
}
