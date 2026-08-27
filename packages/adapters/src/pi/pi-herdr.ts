import {
  DUCKY_AGENT_PREFIX, DUCKY_WORKSPACE_LABEL_PREFIX, MAX_SLUG_KEY_LEN,
} from '@ducky/contracts';
import { createHash } from 'node:crypto';
import type { HerdrClient } from '../herdr/herdr.port.js';
import type { AgentInfo } from '../herdr/herdr.types.js';
import { FileResultReader, RESULT_RELATIVE_PATH, type ResultReader } from './result-file.js';
import type {
  CancelOutcome, OrchestrationOutcome, OrchestrationSpec, PiOrchestrator,
} from './pi-orchestrator.port.js';

export { RESULT_RELATIVE_PATH };

/** Fits `ducky-pi-<slugKey>` inside herdr's [a-z][a-z0-9_-]{0,31} agent names. */
export function toSlugKey(slug: string): string {
  const base = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '');
  if (base.length <= MAX_SLUG_KEY_LEN) return base || 'repo';
  const digest = createHash('sha256').update(slug).digest('hex').slice(0, 6);
  return `${base.slice(0, MAX_SLUG_KEY_LEN - 7)}-${digest}`;
}

export const agentNameFor = (slugKey: string): string => `${DUCKY_AGENT_PREFIX}${slugKey}`;
export const workspaceLabelFor = (slugKey: string): string =>
  `${DUCKY_WORKSPACE_LABEL_PREFIX}${slugKey}`;

export interface HerdrPiOptions {
  readonly herdr: HerdrClient;
  readonly resultReader?: ResultReader;
  readonly sleep?: (ms: number) => Promise<void>;
  /** True only once `pnpm probe:herdr` has recorded live fixtures. */
  readonly verified?: boolean;
  readonly pollIntervalMs?: number;
  readonly thinkingLevel?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives Pi through Herdr's existing CLI. Pi remains the engineering
 * orchestrator; nothing here replaces it, and no agent is ever spawned outside
 * Herdr's supervision.
 *
 * Ownership is proved three ways before an existing agent is reused or any
 * workspace is closed: the agent name prefix, the workspace label prefix, and
 * an authoritative row recorded by the caller. The live host already has a
 * user workspace labelled exactly "ducky", so a label alone proves nothing.
 */
export class HerdrPiOrchestrator implements PiOrchestrator {
  readonly name = 'herdr-pi';
  readonly verified: boolean;

  private readonly herdr: HerdrClient;
  private readonly results: ResultReader;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly thinkingLevel: string;

  constructor(opts: HerdrPiOptions) {
    this.herdr = opts.herdr;
    this.results = opts.resultReader ?? new FileResultReader();
    this.sleep = opts.sleep ?? defaultSleep;
    this.verified = opts.verified ?? false;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.thinkingLevel = opts.thinkingLevel ?? 'high';
  }

  /**
   * Stops waiting on a turn and reports what the agent is actually doing.
   *
   * Herdr exposes no verified way to interrupt a Pi turn without risking a
   * half-written edit, so this deliberately does NOT send keystrokes into a
   * live pane. If the agent is still working we say so and let the caller fail
   * closed into an orphan reservation, which keeps the repository blocked for
   * the owner instead of pretending the work stopped.
   */
  async cancel(spec: OrchestrationSpec): Promise<CancelOutcome> {
    const agentName = agentNameFor(spec.slugKey);
    const workspaceId = spec.recorded?.workspaceId;

    let agent;
    try {
      agent = await this.herdr.agentGet(agentName);
    } catch {
      return {
        terminated: false,
        agentStatus: 'unknown',
        detail: 'Herdr could not be reached to confirm whether the agent stopped.',
        workspaceId,
        agentName,
      };
    }

    if (!agent) {
      return {
        terminated: true,
        agentStatus: 'absent',
        detail: 'The agent is gone, so nothing is still running.',
        workspaceId,
        agentName,
      };
    }
    if (agent.agent_status === 'idle' || agent.agent_status === 'done') {
      return {
        terminated: true,
        agentStatus: agent.agent_status,
        detail: 'The agent finished its turn and is idle.',
        workspaceId,
        agentName,
      };
    }
    return {
      terminated: false,
      agentStatus: agent.agent_status,
      detail:
        `The Pi agent is still ${agent.agent_status}. It was left untouched rather than ` +
        'interrupted mid-edit; the repository stays reserved until you clear it.',
      workspaceId,
      agentName,
    };
  }

  /**
   * Closes a Ducky workspace once its job succeeded.
   *
   * Ownership is proved again here rather than trusted from the caller: the
   * label must be Ducky-managed and the workspace must be the one recorded for
   * this job. A user's workspace can therefore never be closed, even if a
   * wrong id were somehow passed in. A still-working agent also blocks the
   * close, since finishing a result does not guarantee the pane is idle.
   */
  async cleanup(
    spec: OrchestrationSpec,
    workspaceId: string,
  ): Promise<{ closed: boolean; detail: string }> {
    if (spec.recorded?.workspaceId !== workspaceId) {
      return { closed: false, detail: 'That workspace is not the one recorded for this job.' };
    }

    const workspaces = await this.herdr.workspaceList();
    const ws = workspaces.find((w) => w.workspace_id === workspaceId);
    if (!ws) return { closed: true, detail: 'The workspace was already gone.' };
    if (!(ws.label ?? '').startsWith(DUCKY_WORKSPACE_LABEL_PREFIX)) {
      return { closed: false, detail: 'That workspace is not Ducky-managed; it was left alone.' };
    }

    const agent = await this.herdr.agentGet(agentNameFor(spec.slugKey));
    if (agent && (agent.agent_status === 'working' || agent.agent_status === 'blocked')) {
      return { closed: false, detail: `The agent is still ${agent.agent_status}; the workspace was kept.` };
    }

    if (spec.mode === 'worktree') {
      await this.herdr.worktreeRemove(workspaceId);
    } else {
      await this.herdr.workspaceClose(workspaceId);
    }
    return { closed: true, detail: 'Workspace closed.' };
  }

  async runJob(spec: OrchestrationSpec): Promise<OrchestrationOutcome> {
    if (!(await this.herdr.available())) return { kind: 'unavailable' };

    const agentName = agentNameFor(spec.slugKey);
    const existing = await this.herdr.agentGet(agentName);

    if (existing) {
      const owned = await this.proveOwnership(existing, spec, agentName);
      if (!owned) return { kind: 'conflict', reason: 'foreign_agent_conflict', agentName };
      return this.resumeExisting(existing, spec, agentName, owned.workspacePath);
    }

    return this.startFresh(spec, agentName);
  }

  // --------------------------------------------------------------------------

  /**
   * All three conditions must hold. The recorded row is authoritative: without
   * it we never reuse, never prompt, and never close.
   */
  private async proveOwnership(
    agent: AgentInfo,
    spec: OrchestrationSpec,
    agentName: string,
  ): Promise<{ workspacePath: string } | undefined> {
    if (agent.name !== agentName || !agent.name.startsWith(DUCKY_AGENT_PREFIX)) return undefined;
    const recorded = spec.recorded;
    if (!recorded || recorded.agentName !== agentName) return undefined;
    if (agent.workspace_id && agent.workspace_id !== recorded.workspaceId) return undefined;

    const workspaces = await this.herdr.workspaceList();
    const ws = workspaces.find((w) => w.workspace_id === recorded.workspaceId);
    if (!ws || !(ws.label ?? '').startsWith(DUCKY_WORKSPACE_LABEL_PREFIX)) return undefined;

    return { workspacePath: recorded.workspacePath };
  }

  private async resumeExisting(
    agent: AgentInfo,
    spec: OrchestrationSpec,
    agentName: string,
    workspacePath: string,
  ): Promise<OrchestrationOutcome> {
    const workspaceId = spec.recorded!.workspaceId;

    if (agent.agent_status === 'blocked') {
      // Herdr saw an approval or question UI in the pane. Answering it
      // automatically would be exactly the unattended decision the approval
      // gate exists to prevent, so fail closed and let the owner look.
      return { kind: 'orphan', reason: 'orphan_agent_blocked', workspaceId, agentName };
    }

    if (agent.agent_status === 'working') {
      const settled = await this.pollUntilSettled(agentName, spec.recoveryWaitMs, spec.signal);
      if (!settled) {
        return { kind: 'orphan', reason: 'orphan_agent_still_working', workspaceId, agentName };
      }
      if (settled === 'blocked') {
        return { kind: 'orphan', reason: 'orphan_agent_blocked', workspaceId, agentName };
      }
      const recovered = await this.results.read(workspacePath);
      if (recovered) {
        return { kind: 'result', result: recovered, workspaceId, agentName, workspacePath, reused: true };
      }
      return { kind: 'no_result', workspaceId, agentName, workspacePath };
    }

    // idle or done. If a previous turn already wrote a result and only the
    // report was lost, submit it instead of re-running the work.
    if (spec.recoveryRequired) {
      const recovered = await this.results.read(workspacePath);
      if (recovered) {
        return { kind: 'result', result: recovered, workspaceId, agentName, workspacePath, reused: true };
      }
    }

    await this.herdr.agentPrompt(agentName, spec.brief, spec.promptTimeoutMs, spec.signal);
    const result = await this.results.read(workspacePath);
    return result
      ? { kind: 'result', result, workspaceId, agentName, workspacePath, reused: true }
      : { kind: 'no_result', workspaceId, agentName, workspacePath };
  }

  private async startFresh(spec: OrchestrationSpec, agentName: string): Promise<OrchestrationOutcome> {
    const label = workspaceLabelFor(spec.slugKey);

    let workspaceId: string;
    let rootPaneId: string;
    let workspacePath: string;

    if (spec.mode === 'worktree') {
      const wt = await this.herdr.worktreeCreate({
        cwd: spec.repoPath,
        branch: spec.branch,
        base: spec.base,
      });
      workspaceId = wt.workspaceId;
      rootPaneId = wt.rootPaneId;
      // Herdr checks a linked worktree out under its own directory, so the
      // result file lives there -- not under the source repository.
      workspacePath = wt.path;
    } else {
      const ws = await this.herdr.workspaceCreate(spec.repoPath, label);
      workspaceId = ws.workspaceId;
      rootPaneId = ws.rootPaneId;
      workspacePath = spec.repoPath;
    }

    await this.herdr.workspaceReportMetadata(workspaceId, { owner: 'ducky', job: spec.publicId });

    // Register ownership BEFORE an agent exists. A crash after this point still
    // leaves durable proof that the workspace is ours, so recovery reattaches
    // instead of treating a live agent as a stranger's.
    await spec.onWorkspaceCreated?.({
      workspaceId,
      agentName,
      label,
      mode: spec.mode,
      workspacePath,
      worktreePath: spec.mode === 'worktree' ? workspacePath : null,
    });

    await this.herdr.agentStart(agentName, 'pi', rootPaneId, [
      '--session-id', `ducky-${spec.slugKey}`,
      '--thinking', this.thinkingLevel,
    ]);
    await this.herdr.agentPrompt(agentName, spec.brief, spec.promptTimeoutMs, spec.signal);

    const result = await this.results.read(workspacePath);
    return result
      ? { kind: 'result', result, workspaceId, agentName, workspacePath, reused: false }
      : { kind: 'no_result', workspaceId, agentName, workspacePath };
  }

  /** Reattach rather than restart: never kill a writer that may still be live. */
  private async pollUntilSettled(
    agentName: string,
    waitMs: number,
    signal?: AbortSignal | undefined,
  ): Promise<'settled' | 'blocked' | undefined> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return undefined;
      await this.sleep(this.pollIntervalMs);
      const now = await this.herdr.agentGet(agentName);
      if (!now) return 'settled';
      if (now.agent_status === 'blocked') return 'blocked';
      if (now.agent_status === 'idle' || now.agent_status === 'done') return 'settled';
    }
    return undefined;
  }
}
