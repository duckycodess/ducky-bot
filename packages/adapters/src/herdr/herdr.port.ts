import type { AgentInfo, AgentReadSource, WorkspaceSummary } from './herdr.types.js';

export interface HerdrClient {
  available(): Promise<boolean>;
  agentList(): Promise<AgentInfo[]>;
  agentGet(target: string): Promise<AgentInfo | undefined>;
  /**
   * Reads a terminal snapshot from an agent's pane.
   *
   * **Returns TEXT, not JSON.** Recorded on this host: `herdr agent read`
   * writes the raw snapshot to stdout with no envelope and exits 0, so it needs
   * its own call path -- the same lesson `workspace report-metadata` taught,
   * which answers with an empty body.
   *
   * Read-only in the strongest sense: it never sends input. It exists so
   * readiness can be OBSERVED from the agent's own output instead of trusted
   * from Herdr's `interactive_ready`, which is documented to be wrong while an
   * agent is still painting its banners.
   *
   * The returned string is truncated to `HERDR_READ_MAX_BYTES`: a pane is
   * unbounded, untrusted output.
   */
  agentRead(
    target: string,
    opts?: { source?: AgentReadSource; lines?: number },
  ): Promise<string>;
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
