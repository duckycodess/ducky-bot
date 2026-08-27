import {
  DUCKY_AGENT_PREFIX, DUCKY_WORKSPACE_LABEL_PREFIX, MAX_SLUG_KEY_LEN,
} from '@ducky/contracts';
import { createHash } from 'node:crypto';
import type { HerdrClient } from '../herdr/herdr.port.js';
import type { AgentInfo } from '../herdr/herdr.types.js';
import { FileResultReader, RESULT_RELATIVE_PATH, type ResultReader } from './result-file.js';
import type {
  OrchestrationOutcome, OrchestrationSpec, PiOrchestrator,
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
      const settled = await this.pollUntilSettled(agentName, spec.recoveryWaitMs);
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

    await this.herdr.agentPrompt(agentName, spec.brief, spec.promptTimeoutMs);
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
    await this.herdr.agentStart(agentName, 'pi', rootPaneId, [
      '--session-id', `ducky-${spec.slugKey}`,
      '--thinking', this.thinkingLevel,
    ]);
    await this.herdr.agentPrompt(agentName, spec.brief, spec.promptTimeoutMs);

    const result = await this.results.read(workspacePath);
    return result
      ? { kind: 'result', result, workspaceId, agentName, workspacePath, reused: false }
      : { kind: 'no_result', workspaceId, agentName, workspacePath };
  }

  /** Reattach rather than restart: never kill a writer that may still be live. */
  private async pollUntilSettled(
    agentName: string,
    waitMs: number,
  ): Promise<'settled' | 'blocked' | undefined> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs);
      const now = await this.herdr.agentGet(agentName);
      if (!now) return 'settled';
      if (now.agent_status === 'blocked') return 'blocked';
      if (now.agent_status === 'idle' || now.agent_status === 'done') return 'settled';
    }
    return undefined;
  }
}
