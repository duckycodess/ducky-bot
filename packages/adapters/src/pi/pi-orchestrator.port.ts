import type {
  JobPauseCause, JobPauseQuietStatus, JobResultFile, JobWorkPhase,
} from '@ducky/contracts';

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
  /**
   * Called once an agent is actually live in the workspace, so a recorded row
   * does not sit at `creating` forever and recovery can tell a workspace that
   * got as far as running from one that never did.
   */
  readonly onAgentStarted?: (info: { workspaceId: string; agentName: string }) => Promise<void>;
  /**
   * Reports an engineering phase the orchestrator can actually OBSERVE.
   *
   * Only `planning` is emitted from here: handing the brief over is a fact.
   * `implementing`, `reviewing`, `fixing` and `verifying` are Pi's own
   * assessment of its work, and they arrive through the phase file it writes --
   * inventing them from a lifecycle status would be a guess presented as an
   * observation. Fire-and-forget: bookkeeping must never delay a turn.
   */
  readonly onPhase?: (phase: JobWorkPhase) => void;
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
  /**
   * The agent is PROVEN quiet and left no valid result (or the prompt was
   * withheld before it was sent). Produced only after a fresh `agent get`
   * positively matched the recorded name and workspace and reported `idle` or
   * `done`. It is what lets the runner pause the job for the owner instead of
   * failing it -- and it never says WHY, because nothing observed can.
   */
  | {
      kind: 'quiet_pause';
      cause: JobPauseCause;
      observed: JobPauseQuietStatus;
      workspaceId: string;
      agentName: string;
      workspacePath: string;
    }
  | { kind: 'conflict'; reason: 'foreign_agent_conflict'; agentName: string }
  | { kind: 'unavailable' }
  | {
      kind: 'no_result';
      workspaceId: string;
      agentName: string;
      workspacePath: string;
      /** Owner-safe wording for why, when it is not the ordinary "finished without a result". */
      detail?: string;
    };

/** The exact agent a prompt is about to be sent to, freshly proven. */
export interface PromptGuardTarget {
  readonly agentName: string;
  readonly workspaceId: string;
  readonly paneId: string;
}

export interface PromptGuardContext {
  /**
   * A fresh, positively identified look at the SAME agent (recorded name,
   * recorded workspace id, a pane id), or `undefined` when that cannot be
   * proved right now. A guard calls it again after its own reads so that an
   * agent that moved or was replaced in between cannot pass on stale proof.
   */
  proveAgent(): Promise<PromptGuardTarget | undefined>;
}

export type PromptGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Consulted immediately before EVERY prompt attempt -- the first one, the
 * retries after `agent_not_ready`, and a resumed agent's -- because model work
 * is what the check exists to withhold. A refusal (or an exception) withholds
 * the prompt; it never sends it anyway.
 */
export type PromptGuard = (
  target: PromptGuardTarget,
  context: PromptGuardContext,
) => Promise<PromptGuardVerdict>;

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
  /**
   * Closes a workspace after a successful terminal result.
   *
   * Only ever called with a workspace the coordinator recorded as ours, and
   * only on success -- failure, approval, owner-input and orphan states all
   * retain the workspace so the owner can inspect it.
   */
  cleanup(spec: OrchestrationSpec, workspaceId: string): Promise<{ closed: boolean; detail: string }>;
}
