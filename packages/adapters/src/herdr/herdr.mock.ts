import path from 'node:path';
import { DuckyError } from '@ducky/contracts';
import type { HerdrClient } from './herdr.port.js';
import type { AgentInfo, AgentStatus, WorkspaceSummary } from './herdr.types.js';

export interface MockHerdrState {
  available: boolean;
  agents: AgentInfo[];
  workspaces: WorkspaceSummary[];
}

/**
 * Deterministic stand-in. Records every call so tests can assert that recovery
 * never starts a second agent and never touches a workspace it does not own.
 */
export class MockHerdr implements HerdrClient {
  readonly calls: { op: string; args: unknown }[] = [];
  private seq = 0;

  constructor(readonly state: MockHerdrState = { available: true, agents: [], workspaces: [] }) {}

  private record(op: string, args: unknown): void {
    this.calls.push({ op, args });
  }

  countOf(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  setAgentStatus(name: string, status: AgentStatus): void {
    const a = this.state.agents.find((x) => x.name === name);
    if (a) (a as { agent_status: AgentStatus }).agent_status = status;
  }

  async available(): Promise<boolean> {
    this.record('available', null);
    return this.state.available;
  }

  async agentList(): Promise<AgentInfo[]> {
    this.record('agentList', null);
    if (!this.state.available) throw new DuckyError('herdr_unavailable', 'Herdr is not running.');
    return this.state.agents;
  }

  async agentGet(target: string): Promise<AgentInfo | undefined> {
    this.record('agentGet', { target });
    // An outage is NOT an absent agent, and must not read like one.
    if (!this.state.available) throw new DuckyError('herdr_unavailable', 'Herdr is not running.');
    return this.state.agents.find((a) => a.name === target || a.pane_id === target);
  }

  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    agentArgs: readonly string[],
  ): Promise<AgentInfo> {
    this.record('agentStart', { name, kind, paneId, agentArgs });
    if (this.state.agents.some((a) => a.name === name)) {
      throw new DuckyError('herdr_unavailable', 'An agent with that name is already live.');
    }
    const info: AgentInfo = {
      agent: kind,
      agent_status: 'idle',
      pane_id: paneId,
      name,
      workspace_id: paneId.split(':')[0],
    };
    this.state.agents.push(info);
    return info;
  }

  async agentPrompt(
    target: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.record('agentPrompt', { target, textLength: text.length, timeoutMs });
    if (this.promptBlocks) {
      // Models a real `herdr agent prompt --wait`: it does not return until the
      // turn settles or the wait is aborted.
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  }

  /** Set to model a long-running turn that only ends when aborted. */
  promptBlocks = false;

  async workspaceList(): Promise<WorkspaceSummary[]> {
    this.record('workspaceList', null);
    return this.state.workspaces;
  }

  async workspaceCreate(cwd: string, label: string): Promise<{ workspaceId: string; rootPaneId: string }> {
    this.record('workspaceCreate', { cwd, label });
    this.seq += 1;
    const workspaceId = `wM${this.seq}`;
    this.state.workspaces.push({ workspace_id: workspaceId, label });
    return { workspaceId, rootPaneId: `${workspaceId}:p1` };
  }

  async workspaceReportMetadata(workspaceId: string, tokens: Record<string, string>): Promise<void> {
    this.record('workspaceReportMetadata', { workspaceId, tokens });
  }

  async workspaceClose(workspaceId: string): Promise<void> {
    this.record('workspaceClose', { workspaceId });
    this.state.workspaces = this.state.workspaces.filter((w) => w.workspace_id !== workspaceId);
    this.state.agents = this.state.agents.filter((a) => a.workspace_id !== workspaceId);
  }

  async worktreeCreate(input: { cwd: string; branch: string; base: string }): Promise<{
    workspaceId: string;
    rootPaneId: string;
    path: string;
  }> {
    this.record('worktreeCreate', input);
    this.seq += 1;
    const workspaceId = `wW${this.seq}`;
    this.state.workspaces.push({ workspace_id: workspaceId, label: `ducky-mgd:${input.branch}` });
    // Mirrors the live layout: a linked worktree lives outside the source
    // repo, under a Herdr worktrees directory, already home-expanded.
    return {
      workspaceId,
      rootPaneId: `${workspaceId}:p1`,
      path: `/home/mock/.herdr/worktrees/${path.basename(input.cwd)}/${input.branch.replace(/\//g, '-')}`,
    };
  }

  async worktreeRemove(workspaceId: string): Promise<void> {
    this.record('worktreeRemove', { workspaceId });
  }
}
