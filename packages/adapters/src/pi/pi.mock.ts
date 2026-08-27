import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobResultFile } from '@ducky/contracts';
import { RESULT_RELATIVE_PATH } from './result-file.js';
import type {
  OrchestrationOutcome, OrchestrationSpec, PiOrchestrator,
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
export class MockPiOrchestrator implements PiOrchestrator {
  readonly name = 'mock';
  readonly verified = false;
  readonly runs: OrchestrationSpec[] = [];

  constructor(
    private readonly outcome: (spec: OrchestrationSpec) => JobResultFile = () =>
      exampleImplementedResult(),
    private readonly writeFileToDisk = false,
  ) {}

  async runJob(spec: OrchestrationSpec): Promise<OrchestrationOutcome> {
    this.runs.push(spec);
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
