import type { AgentInfo, WorkspaceSummary } from './herdr.types.js';

export interface HerdrClient {
  available(): Promise<boolean>;
  agentList(): Promise<AgentInfo[]>;
  agentGet(target: string): Promise<AgentInfo | undefined>;
  agentStart(name: string, kind: string, paneId: string, agentArgs: readonly string[]): Promise<AgentInfo>;
  /**
   * Submits a prompt and waits for the turn to settle. Resolves with the
   * SETTLED agent so the caller can distinguish `idle`/`done` from `blocked`;
   * `undefined` when herdr answered without an agent record.
   */
  agentPrompt(
    target: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentInfo | undefined>;
  workspaceList(): Promise<WorkspaceSummary[]>;
  workspaceCreate(cwd: string, label: string): Promise<{ workspaceId: string; rootPaneId: string }>;
  workspaceReportMetadata(workspaceId: string, tokens: Record<string, string>): Promise<void>;
  workspaceClose(workspaceId: string): Promise<void>;
  /**
   * Creates a linked worktree AND its workspace. `label` must be the
   * Ducky-managed label: it is the only thing that later proves the workspace
   * is ours and may be closed.
   */
  worktreeCreate(input: {
    cwd: string;
    branch: string;
    base: string;
    label: string;
  }): Promise<{ workspaceId: string; rootPaneId: string; path: string }>;
  /**
   * Removes a worktree checkout. Throws `herdr_worktree_dirty` when the
   * checkout still holds uncommitted work and `force` was not requested.
   */
  worktreeRemove(workspaceId: string, opts?: { force?: boolean }): Promise<void>;
}
