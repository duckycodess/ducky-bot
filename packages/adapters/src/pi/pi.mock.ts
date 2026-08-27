import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobResultFile } from '@ducky/contracts';
import { RESULT_RELATIVE_PATH } from './result-file.js';
import type {
  CancelOutcome, OrchestrationOutcome, OrchestrationSpec, PiOrchestrator,
} from './pi-orchestrator.port.js';

export const exampleImplementedResult = (summary = 'Mock implementation completed.'): JobResultFile => ({
  schemaVersion: 1,
  verdict: 'implemented',
  summary,
  changedFiles: ['src/example.ts'],
  review: { performed: true, independent: true, verdict: 'pass', notes: 'Reviewed by an independent pass.' },
  verification: { commands: [{ cmd: 'pnpm test', exitCode: 0, summary: 'all green' }], passed: true },
  proposedActions: [],
});

/**
 * Deterministic orchestrator used by tests and by a token-less local run.
 * It writes a real result file so the whole intake path is exercised.
 */
export interface MockPiOptions {
  /** Simulates a turn that keeps running until it is aborted. */
  readonly runUntilAborted?: boolean;
  /** What `cancel()` reports; defaults to a clean termination. */
  readonly cancelOutcome?: CancelOutcome;
  readonly writeFileToDisk?: boolean;
}

export class MockPiOrchestrator implements PiOrchestrator {
  readonly name = 'mock';
  readonly verified = false;
  readonly runs: OrchestrationSpec[] = [];
  readonly cancels: OrchestrationSpec[] = [];
  private readonly options: MockPiOptions;

  constructor(
    private readonly outcome: (spec: OrchestrationSpec) => JobResultFile = () =>
      exampleImplementedResult(),
    options: MockPiOptions | boolean = {},
  ) {
    this.options = typeof options === 'boolean' ? { writeFileToDisk: options } : options;
  }

  private get writeFileToDisk(): boolean {
    return this.options.writeFileToDisk ?? false;
  }

  readonly cleanups: { spec: OrchestrationSpec; workspaceId: string }[] = [];

  async cleanup(
    spec: OrchestrationSpec,
    workspaceId: string,
  ): Promise<{ closed: boolean; detail: string }> {
    this.cleanups.push({ spec, workspaceId });
    return { closed: true, detail: 'Mock workspace closed.' };
  }

  async cancel(spec: OrchestrationSpec): Promise<CancelOutcome> {
    this.cancels.push(spec);
    return (
      this.options.cancelOutcome ?? {
        terminated: true,
        agentStatus: 'idle',
        detail: 'Mock orchestrator stopped.',
        workspaceId: `mock-ws-${spec.publicId}`,
        agentName: `ducky-pi-${spec.slugKey}`,
      }
    );
  }

  async runJob(spec: OrchestrationSpec): Promise<OrchestrationOutcome> {
    this.runs.push(spec);

    // Mirrors the real ordering: ownership is registered before any agent runs.
    await spec.onWorkspaceCreated?.({
      workspaceId: `mock-ws-${spec.publicId}`,
      agentName: `ducky-pi-${spec.slugKey}`,
      label: `ducky-mgd:${spec.slugKey}`,
      mode: spec.mode,
      workspacePath: spec.repoPath,
      worktreePath: spec.mode === 'worktree' ? spec.repoPath : null,
    });

    await spec.onAgentStarted?.({
      workspaceId: `mock-ws-${spec.publicId}`,
      agentName: `ducky-pi-${spec.slugKey}`,
    });

    if (this.options.runUntilAborted) {
      await new Promise<void>((resolve) => {
        if (spec.signal?.aborted) return resolve();
        spec.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        kind: 'no_result',
        workspaceId: `mock-ws-${spec.publicId}`,
        agentName: `ducky-pi-${spec.slugKey}`,
        workspacePath: spec.repoPath,
      };
    }

    const result = this.outcome(spec);
    if (this.writeFileToDisk) {
      const target = path.join(spec.repoPath, RESULT_RELATIVE_PATH);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(result, null, 2), 'utf8');
    }
    return {
      kind: 'result',
      result,
      workspaceId: `mock-ws-${spec.publicId}`,
      agentName: `ducky-pi-${spec.slugKey}`,
      workspacePath: spec.repoPath,
      reused: false,
    };
  }
}
