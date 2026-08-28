import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHerdrPath } from '../src/herdr/paths.js';
import { WorktreeCreateResultSchema, EnvelopeSchema } from '../src/herdr/herdr.types.js';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import { HerdrPiOrchestrator, toSlugKey } from '../src/pi/pi-herdr.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';

/** The brief travels as a file; these suites use synthetic workspace paths. */
const briefs = (): MemoryBriefWriter => new MemoryBriefWriter();
import { exampleImplementedResult } from '../src/pi/pi.mock.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';

const FIXTURE = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'herdr',
  'herdr.fixtures',
  'worktree-create.json',
);

const HOME = '/home/someone';

describe('Herdr reports home-relative paths', () => {
  it('expands the tilde the live fixture actually contains', () => {
    const envelope = EnvelopeSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const result = WorktreeCreateResultSchema.parse(envelope.result);
    const reported = result.worktree?.path ?? result.workspace?.worktree?.checkout_path;

    // This is the shape that broke registration: not absolute.
    expect(reported).toBeDefined();
    expect(reported!.startsWith('~/')).toBe(true);

    const expanded = expandHerdrPath(reported!, HOME);
    expect(path.isAbsolute(expanded)).toBe(true);
    expect(path.normalize(expanded)).toBe(expanded);
    // Still inside a Herdr worktrees directory, which is what the coordinator
    // allows for a worktree outside the source repository.
    expect(expanded).toContain('/.herdr/worktrees/');
  });

  it('leaves an already-absolute path alone and normalizes it', () => {
    expect(expandHerdrPath('/var/lib/x', HOME)).toBe('/var/lib/x');
    expect(expandHerdrPath('/var/lib/./x', HOME)).toBe('/var/lib/x');
    expect(expandHerdrPath('~', HOME)).toBe(HOME);
  });

  it('does not expand a tilde that is not a home reference', () => {
    expect(expandHerdrPath('~notauser/x', HOME)).toBe('~notauser/x');
  });
});

describe('a real worktree path survives the registration boundary', () => {
  const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
    jobId: 'job-1',
    publicId: 'jabcde',
    repoSlug: 'demo',
    slugKey: toSlugKey('demo'),
    mode: 'worktree',
    repoPath: '/repos/demo',
    branch: 'ducky/job-jabcde',
    base: 'main',
    brief: 'do it',
    recoveryRequired: false,
    promptTimeoutMs: 1000,
    recoveryWaitMs: 10,
    ...over,
  });

  it('hands the registration hook an absolute normalized path', async () => {
    const herdr = new MockHerdr();
    const seen: { workspacePath: string; worktreePath: string | null }[] = [];
    const orchestrator = new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: { read: async () => exampleImplementedResult() },
      sleep: async () => {},
    });

    await orchestrator.runJob(
      spec({
        onWorkspaceCreated: async (info) => {
          seen.push({ workspacePath: info.workspacePath, worktreePath: info.worktreePath });
        },
      }),
    );

    expect(seen).toHaveLength(1);
    const { workspacePath } = seen[0]!;
    expect(path.isAbsolute(workspacePath)).toBe(true);
    expect(path.normalize(workspacePath)).toBe(workspacePath);
    expect(workspacePath.startsWith('~')).toBe(false);
  });

  it('advances the recorded state once the agent starts', async () => {
    const herdr = new MockHerdr();
    const states: string[] = [];
    const orchestrator = new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: { read: async () => exampleImplementedResult() },
      sleep: async () => {},
    });

    await orchestrator.runJob(
      spec({
        onWorkspaceCreated: async () => {
          states.push('creating');
        },
        onAgentStarted: async () => {
          states.push('active');
        },
      }),
    );

    // Registered before the agent exists, then advanced once it does, so a row
    // never sits at `creating` for a workspace that genuinely ran.
    expect(states).toEqual(['creating', 'active']);
  });
});
