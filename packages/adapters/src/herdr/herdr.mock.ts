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

  /**
   * Scripted terminal snapshots, consumed one per `agentRead`.
   *
   * The live CLI is the authority here, and the mock must not be more helpful
   * than it is -- that is how the missing `worktree create --label` shipped.
   * An empty queue therefore answers `readSnapshotDefault`, which defaults to
   * the EMPTY string: a test that has not said what the pane shows gets "I
   * could not tell", not "ready".
   */
  readSnapshots: string[] = [];
  readSnapshotDefault = '';

  async agentRead(target: string, opts: { source?: string; lines?: number } = {}): Promise<string> {
    this.record('agentRead', { target, source: opts.source ?? 'detection' });
    if (!this.state.available) throw new DuckyError('herdr_unavailable', 'Herdr is not running.');
    return this.readSnapshots.shift() ?? this.readSnapshotDefault;
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

  /**
   * Mirrors the real adapter: resolves with the agent as it stands once the
   * wait settles, so a test can model a turn that ended `blocked` rather than
   * `idle`. Set `promptSettlesAs` to choose that status.
   */
  async agentPrompt(
    target: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentInfo | undefined> {
    this.record('agentPrompt', { target, textLength: text.length, timeoutMs });
    if (this.promptBlocks) {
      // Models a real `herdr agent prompt --wait`: it does not return until the
      // turn settles or the wait is aborted.
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const agent = this.state.agents.find((a) => a.name === target || a.pane_id === target);
    if (!agent) return undefined;
    if (this.promptSettlesAs) agent.agent_status = this.promptSettlesAs;
    return agent;
  }

  /** Set to model a long-running turn that only ends when aborted. */
  promptBlocks = false;

  /** Status the agent is left in once a prompt wait settles. */
  promptSettlesAs: AgentStatus | undefined;

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

  async worktreeCreate(input: {
    cwd: string;
    branch: string;
    base: string;
    label: string;
  }): Promise<{
    workspaceId: string;
    rootPaneId: string;
    path: string;
  }> {
    this.record('worktreeCreate', input);
    this.seq += 1;
    const workspaceId = `wW${this.seq}`;
    // Uses the label it was GIVEN. It used to synthesize `ducky-mgd:<branch>`
    // regardless, which made every test believe the workspace was provably
    // ours -- while the live CLI, given no `--label`, named it after the branch
    // and cleanup silently refused to close it on every real job.
    this.state.workspaces.push({ workspace_id: workspaceId, label: input.label });
    // Mirrors the live layout: a linked worktree lives outside the source
    // repo, under a Herdr worktrees directory, already home-expanded.
    return {
      workspaceId,
      rootPaneId: `${workspaceId}:p1`,
      path: `/home/mock/.herdr/worktrees/${path.basename(input.cwd)}/${input.branch.replace(/\//g, '-')}`,
    };
  }

  /** Set to model the live `dirty_worktree_requires_force` refusal. */
  worktreeIsDirty = false;

  async worktreeRemove(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
    this.record('worktreeRemove', { workspaceId, force: opts.force === true });
    if (this.worktreeIsDirty && opts.force !== true) {
      throw new DuckyError(
        'herdr_worktree_dirty',
        'The worktree still holds uncommitted changes, so it was not removed.',
      );
    }
  }
}
