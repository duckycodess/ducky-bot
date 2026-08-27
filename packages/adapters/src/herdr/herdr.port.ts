import type { AgentInfo, WorkspaceSummary } from './herdr.types.js';

export interface HerdrClient {
  available(): Promise<boolean>;
  agentList(): Promise<AgentInfo[]>;
  agentGet(target: string): Promise<AgentInfo | undefined>;
  agentStart(name: string, kind: string, paneId: string, agentArgs: readonly string[]): Promise<AgentInfo>;
  agentPrompt(target: string, text: string, timeoutMs: number): Promise<void>;
  workspaceList(): Promise<WorkspaceSummary[]>;
  workspaceCreate(cwd: string, label: string): Promise<{ workspaceId: string; rootPaneId: string }>;
  workspaceReportMetadata(workspaceId: string, tokens: Record<string, string>): Promise<void>;
  workspaceClose(workspaceId: string): Promise<void>;
  worktreeCreate(input: {
    cwd: string;
    branch: string;
    base: string;
  }): Promise<{ workspaceId: string; rootPaneId: string; path: string }>;
  worktreeRemove(workspaceId: string): Promise<void>;
}
