import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HerdrPiOrchestrator, MemoryBriefWriter, MemoryDispatchJournal, MockHerdr, MockPiOrchestrator,
  agentNameFor, toSlugKey,
} from '@ducky/adapters';
import { leaseDigest, type PauseDeliveryResponse } from '@ducky/contracts';
import { ExecutorLoop } from '../src/loop.js';
import { FilePauseIntentStore, type PauseIntent } from '../src/pause-intents.js';
import { StateDir } from '../src/state-store.js';

/**
 * A mock orchestrator invents what a real one must earn. With a pause owed on
 * disk, an invented "quiet" proof would release the engineering slot, so the
 * production executor must never run one -- not even as a fallback when Herdr is
 * down at boot.
 */
const repoRoot = path.resolve(__dirname, '..', '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('production code never references a mock orchestrator', () => {
  it('no executor, coordinator or probe source names MockPiOrchestrator or MockHerdr', () => {
    const roots = ['packages/executor/src', 'packages/coordinator/src', 'scripts'].map((r) => path.join(repoRoot, r));
    const offenders = roots
      .flatMap(sources)
      .filter((f) => /\bMock(PiOrchestrator|Herdr)\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });

  it('the executor entry point builds the real orchestrator unconditionally', () => {
    const main = readFileSync(path.join(repoRoot, 'packages/executor/src/main.ts'), 'utf8');
    expect(main).toMatch(/new HerdrPiOrchestrator\(/);
    expect(main).not.toMatch(/Mock/);
    expect(main).not.toMatch(/herdrUp\s*\?/);
  });

  it('the mock proves nothing by default', async () => {
    const proof = await new MockPiOrchestrator().proveQuiet({ jobId: 'j', workspaceId: 'w', agentName: 'a' });
    expect(proof.quiet).toBe(false);
  });
});

describe('Herdr down at boot with a pause owed', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'ducky-nomock-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const intent: PauseIntent = {
    v: 1, reportId: '11111111-1111-4111-8111-111111111111', executorId: 'exec-a', jobId: 'job-1',
    publicId: 'jabcde', leaseId: 'lease-1', workspaceId: 'wDemo',
    agentName: agentNameFor(toSlugKey('demo-repo')), cause: 'agent_idle_no_result', agentStatus: 'idle',
  };
  const pending = (): PauseDeliveryResponse => ({
    protocol: 1, reportId: intent.reportId, workspaceId: intent.workspaceId, agentName: intent.agentName,
    cause: intent.cause, jobId: intent.jobId, executorId: 'exec-a', leaseDigest: leaseDigest(intent.leaseId),
    disposition: 'pending', state: 'waiting_for_executor',
  });

  it('the real orchestrator cannot prove quiet, so the loop reports nothing, claims nothing and keeps the intent', async () => {
    const dir = StateDir.open(path.join(scratch, 'pause-intents'), { uid: process.getuid!(), forbiddenRoots: [], maxRecords: 8 });
    const intents = new FilePauseIntentStore(dir);
    intents.write(intent);
    // The journal even says the agent settled: the proof must still fail, because Herdr cannot be looked at.
    const journal = new MemoryDispatchJournal().seedSettled({
      jobId: 'job-1', workspaceId: intent.workspaceId, agentName: intent.agentName,
    });
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const orchestrator = new HerdrPiOrchestrator({ herdr, journal, briefWriter: new MemoryBriefWriter() });

    const client = {
      executorId: 'exec-a',
      heartbeat: vi.fn(async () => undefined),
      claim: vi.fn(async () => undefined),
      pauseDisposition: vi.fn(async () => pending()),
      pauseReport: vi.fn(async () => pending()),
    };
    const log = vi.fn();
    const loop = new ExecutorLoop({
      client: client as never, orchestrator, intents, pollWaitMs: 0, version: 't', log,
      herdrAvailable: () => herdr.available(),
    });

    expect(await loop.runOnce()).toBe('pause_held');
    expect(client.pauseReport).not.toHaveBeenCalled();
    expect(client.claim).not.toHaveBeenCalled();
    expect(intents.list().intents).toHaveLength(1);
    expect(log.mock.calls.flat().join('\n')).toMatch(/not proven quiet now/);

    // And with nothing owed, an unreachable Herdr still means no claim.
    intents.remove(intent);
    expect(await loop.runOnce()).toBe('held');
    expect(client.claim).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/Herdr is not reachable/);

    // Herdr comes back: claiming resumes.
    herdr.state.available = true;
    expect(await loop.runOnce()).toBe('idle');
    expect(client.claim).toHaveBeenCalledTimes(1);
  });

  it('the real orchestrator against a down Herdr runs nothing, proves nothing and cancels nothing', async () => {
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const o = new HerdrPiOrchestrator({ herdr, journal: new MemoryDispatchJournal(), briefWriter: new MemoryBriefWriter() });
    const spec = {
      jobId: 'job-1', leaseId: 'l', publicId: 'jabcde', repoSlug: 'demo-repo', slugKey: toSlugKey('demo-repo'),
      mode: 'worktree' as const, repoPath: '/repos/demo', branch: 'b', base: 'main', brief: 'x',
      recoveryRequired: false, promptTimeoutMs: 1000, recoveryWaitMs: 10,
      recorded: { workspaceId: 'wDemo', agentName: intent.agentName, workspacePath: '/repos/demo' },
    };
    expect(await o.runJob(spec)).toEqual({ kind: 'unavailable' });
    expect((await o.cancel(spec)).terminated).toBe(false);
    expect((await o.proveQuiet({ jobId: 'job-1', workspaceId: 'wDemo', agentName: intent.agentName })).quiet).toBe(false);
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });
});
