import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDuckyError } from '@ducky/contracts';
import { HerdrCli } from '../src/herdr/herdr-cli.js';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey } from '../src/pi/pi-herdr.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';

/** A stand-in `herdr` binary with scripted output, so no real Herdr is touched. */
function fakeHerdr(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-fakeherdr-'));
  const bin = path.join(dir, 'herdr');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
}

const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  repoSlug: 'demo',
  slugKey: toSlugKey('demo'),
  mode: 'direct',
  repoPath: '/repos/demo',
  branch: 'main',
  base: 'HEAD',
  brief: 'do it',
  recoveryRequired: false,
  promptTimeoutMs: 1000,
  recoveryWaitMs: 10,
  ...over,
});

describe('a Herdr outage is not an absent agent', () => {
  it('throws herdr_unavailable when the command fails', async () => {
    const cli = new HerdrCli({ bin: fakeHerdr('echo "connection refused" >&2; exit 1') });
    await expect(cli.agentGet('ducky-pi-demo')).rejects.toSatisfy(
      (e: unknown) => isDuckyError(e) && e.code === 'herdr_unavailable',
    );
  });

  it('throws when the response is not JSON at all', async () => {
    const cli = new HerdrCli({ bin: fakeHerdr('echo "not json"') });
    await expect(cli.agentGet('ducky-pi-demo')).rejects.toSatisfy(
      (e: unknown) => isDuckyError(e) && e.code === 'herdr_unavailable',
    );
  });

  it('throws when the record is unreadable rather than pretending it is absent', async () => {
    const cli = new HerdrCli({ bin: fakeHerdr(`echo '{"id":"x","result":{"agent":{}}}'`) });
    await expect(cli.agentGet('ducky-pi-demo')).rejects.toSatisfy(
      (e: unknown) => isDuckyError(e) && e.code === 'herdr_unavailable',
    );
  });

  it('returns undefined only when Herdr says the agent does not exist', async () => {
    const cli = new HerdrCli({ bin: fakeHerdr('echo "no such agent" >&2; exit 1') });
    await expect(cli.agentGet('ducky-pi-demo')).resolves.toBeUndefined();
  });

  it('returns the agent when Herdr answers normally', async () => {
    const cli = new HerdrCli({
      bin: fakeHerdr(
        `echo '{"id":"x","result":{"agent":{"agent":"pi","agent_status":"idle","pane_id":"w1:p1","name":"ducky-pi-demo"}}}'`,
      ),
    });
    const agent = await cli.agentGet('ducky-pi-demo');
    expect(agent).toMatchObject({ agent: 'pi', agent_status: 'idle' });
  });
});

describe('an outage never triggers creation or destruction', () => {
  it('reports unavailable instead of creating a second workspace', async () => {
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });

    const outcome = await orchestrator.runJob(spec());

    expect(outcome).toEqual({ kind: 'unavailable' });
    // Nothing was created beside whatever might already be live.
    expect(herdr.countOf('workspaceCreate')).toBe(0);
    expect(herdr.countOf('worktreeCreate')).toBe(0);
    expect(herdr.countOf('agentStart')).toBe(0);
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('refuses to clean up a workspace whose agent state is unproven', async () => {
    const recorded = {
      workspaceId: 'wX',
      agentName: agentNameFor(toSlugKey('demo')),
      workspacePath: '/repos/demo',
    };
    // The listing succeeds, then the agent lookup fails: exactly the shape of
    // a server going away mid-cleanup.
    let calls = 0;
    const herdr = new MockHerdr({
      available: true,
      agents: [],
      workspaces: [{ workspace_id: 'wX', label: 'ducky-mgd:demo' }],
    });
    const original = herdr.agentGet.bind(herdr);
    herdr.agentGet = async (target: string) => {
      calls += 1;
      throw new Error('herdr socket closed');
      return original(target);
    };

    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });
    const out = await orchestrator.cleanup(spec({ recorded }), 'wX');

    expect(calls).toBe(1);
    expect(out.closed).toBe(false);
    expect(out.detail).toMatch(/could not be reached/i);
    expect(herdr.countOf('workspaceClose')).toBe(0);
    expect(herdr.countOf('worktreeRemove')).toBe(0);
  });

  it('never claims a termination it could not observe', async () => {
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });
    const out = await orchestrator.cancel(
      spec({ recorded: { workspaceId: 'wX', agentName: 'ducky-pi-demo', workspacePath: '/repos/demo' } }),
    );
    expect(out.terminated).toBe(false);
    expect(out.agentStatus).toBe('unknown');
  });
});
