import { describe, expect, it } from 'vitest';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey, workspaceLabelFor } from '../src/pi/pi-herdr.js';
import { exampleImplementedResult } from '../src/pi/pi.mock.js';
import type { ResultReader } from '../src/pi/result-file.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';

const SLUG = 'demo-repo';
const slugKey = toSlugKey(SLUG);
const AGENT = agentNameFor(slugKey);
const WS = 'wDemo';

const reader = (result: ReturnType<typeof exampleImplementedResult> | undefined): ResultReader => ({
  read: async () => result,
});

const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  repoSlug: SLUG,
  slugKey,
  mode: 'worktree',
  repoPath: '/repos/demo',
  branch: 'ducky/job-jabcde',
  base: 'main',
  brief: 'do the thing',
  recoveryRequired: false,
  promptTimeoutMs: 1000,
  recoveryWaitMs: 50,
  ...over,
});

const ownedAgent = (status: AgentInfo['agent_status']): AgentInfo => ({
  agent: 'pi',
  agent_status: status,
  pane_id: `${WS}:p1`,
  workspace_id: WS,
  name: AGENT,
  cwd: '/repos/demo',
});

const recorded = { workspaceId: WS, agentName: AGENT, workspacePath: '/repos/demo' };

function orchestratorWith(
  herdr: MockHerdr,
  result: ReturnType<typeof exampleImplementedResult> | undefined,
): HerdrPiOrchestrator {
  return new HerdrPiOrchestrator({
    herdr,
    resultReader: reader(result),
    sleep: async () => {},
    pollIntervalMs: 1,
  });
}

describe('agent naming', () => {
  it('keeps ducky-pi-<slugKey> inside the herdr agent-name rule', () => {
    for (const slug of ['a', 'demo-repo', 'a'.repeat(64), 'weird_slug-99']) {
      const name = agentNameFor(toSlugKey(slug));
      expect(name, name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
  });

  it('labels workspaces with a prefix that a bare user label cannot collide with', () => {
    expect(workspaceLabelFor(slugKey)).toBe('ducky-mgd:demo-repo');
  });
});

describe('Herdr/Pi orchestration', () => {
  it('reports unavailable rather than pretending when Herdr is down', async () => {
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const outcome = await orchestratorWith(herdr, undefined).runJob(spec());
    expect(outcome.kind).toBe('unavailable');
    expect(herdr.countOf('agentStart')).toBe(0);
  });

  it('creates a worktree workspace and prompts when nothing exists yet', async () => {
    const herdr = new MockHerdr();
    const outcome = await orchestratorWith(herdr, exampleImplementedResult()).runJob(spec());
    expect(outcome.kind).toBe('result');
    expect(herdr.countOf('worktreeCreate')).toBe(1);
    expect(herdr.countOf('agentStart')).toBe(1);
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('refuses to adopt an agent it cannot prove it owns, and touches nothing', async () => {
    const foreign: AgentInfo = { ...ownedAgent('idle'), workspace_id: 'wUser' };
    const herdr = new MockHerdr({
      available: true,
      agents: [foreign],
      // a *user* workspace that happens to be labelled "ducky"
      workspaces: [{ workspace_id: 'wUser', label: 'ducky' }],
    });
    const outcome = await orchestratorWith(herdr, undefined).runJob(spec({ recorded: undefined }));
    expect(outcome).toMatchObject({ kind: 'conflict', reason: 'foreign_agent_conflict' });
    expect(herdr.countOf('agentStart')).toBe(0);
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(herdr.countOf('workspaceClose')).toBe(0);
  });

  it('refuses reuse when the workspace label is not Ducky-managed', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [ownedAgent('idle')],
      workspaces: [{ workspace_id: WS, label: 'ducky' }],
    });
    const outcome = await orchestratorWith(herdr, undefined).runJob(spec({ recorded }));
    expect(outcome.kind).toBe('conflict');
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('recovers a finished turn by reading the existing result instead of re-running', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [ownedAgent('idle')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const outcome = await orchestratorWith(herdr, exampleImplementedResult('recovered')).runJob(
      spec({ recorded, recoveryRequired: true }),
    );
    expect(outcome).toMatchObject({ kind: 'result', reused: true });
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(herdr.countOf('agentStart')).toBe(0);
  });

  it('reattaches to a working agent and submits its result once it settles', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [ownedAgent('working')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    // settles on the first poll
    const orchestrator = new HerdrPiOrchestrator({
      herdr,
      resultReader: reader(exampleImplementedResult()),
      sleep: async () => herdr.setAgentStatus(AGENT, 'idle'),
      pollIntervalMs: 1,
    });
    const outcome = await orchestrator.runJob(spec({ recorded, recoveryRequired: true }));
    expect(outcome).toMatchObject({ kind: 'result', reused: true });
    expect(herdr.countOf('agentStart')).toBe(0);
  });

  it('fails closed on a working agent that never settles, without starting a second writer', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [ownedAgent('working')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const outcome = await orchestratorWith(herdr, undefined).runJob(
      spec({ recorded, recoveryRequired: true, recoveryWaitMs: 3 }),
    );
    expect(outcome).toMatchObject({ kind: 'orphan', reason: 'orphan_agent_still_working' });
    expect(herdr.countOf('agentStart')).toBe(0);
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(herdr.countOf('workspaceClose')).toBe(0);
  });

  it('never answers a blocked agent automatically', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [ownedAgent('blocked')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const outcome = await orchestratorWith(herdr, undefined).runJob(spec({ recorded }));
    expect(outcome).toMatchObject({ kind: 'orphan', reason: 'orphan_agent_blocked' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('reports no_result rather than inventing one', async () => {
    const herdr = new MockHerdr();
    const outcome = await orchestratorWith(herdr, undefined).runJob(spec());
    expect(outcome.kind).toBe('no_result');
  });

  it('is experimental until a live probe has been recorded', () => {
    expect(orchestratorWith(new MockHerdr(), undefined).verified).toBe(false);
    expect(
      new HerdrPiOrchestrator({ herdr: new MockHerdr(), verified: true }).verified,
    ).toBe(true);
  });
});

describe('worktree mode uses the checkout path Herdr reports', () => {
  it('reads the result from the linked worktree, never from the source repo', async () => {
    const herdr = new MockHerdr();
    const seen: string[] = [];
    const orchestrator = new HerdrPiOrchestrator({
      herdr,
      resultReader: {
        read: async (workspacePath: string) => {
          seen.push(workspacePath);
          return exampleImplementedResult();
        },
      },
      sleep: async () => {},
    });

    const outcome = await orchestrator.runJob(spec({ mode: 'worktree', repoPath: '/repos/demo' }));

    // Herdr checks a linked worktree out under its own directory; reading the
    // source repository instead would report a stale or missing result.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('/repos/demo');
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') expect(outcome.workspacePath).toBe(seen[0]);
  });

  it('uses the repository itself in direct bootstrap mode', async () => {
    const herdr = new MockHerdr();
    const seen: string[] = [];
    const orchestrator = new HerdrPiOrchestrator({
      herdr,
      resultReader: {
        read: async (workspacePath: string) => {
          seen.push(workspacePath);
          return exampleImplementedResult();
        },
      },
      sleep: async () => {},
    });

    await orchestrator.runJob(spec({ mode: 'direct', repoPath: '/repos/greenfield' }));
    expect(seen).toEqual(['/repos/greenfield']);
  });
});

describe('cancellation against the real adapter shape', () => {
  const owned = (status: AgentInfo['agent_status']): AgentInfo => ({
    agent: 'pi',
    agent_status: status,
    pane_id: `${WS}:p1`,
    workspace_id: WS,
    name: AGENT,
    cwd: '/repos/demo',
  });

  it('stops waiting on a blocking prompt as soon as the signal fires', async () => {
    const herdr = new MockHerdr();
    // Models `herdr agent prompt --wait`: it does not return on its own.
    herdr.promptBlocks = true;
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });

    const controller = new AbortController();
    const started = Date.now();
    const run = orchestrator.runJob(spec({ signal: controller.signal })).catch((e) => e as Error);
    setTimeout(() => controller.abort(), 20);

    const outcome = await run;
    // Returned because it was aborted, not because a long timeout elapsed.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome).toBeInstanceOf(Error);
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('reports a still-working agent as not terminated, and touches nothing', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [owned('working')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });

    const outcome = await orchestrator.cancel(spec({ recorded }));
    expect(outcome.terminated).toBe(false);
    expect(outcome.agentStatus).toBe('working');
    expect(outcome.detail).toMatch(/still working/i);
    // Never typed into, never closed.
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(herdr.countOf('workspaceClose')).toBe(0);
  });

  it('reports an idle or absent agent as terminated', async () => {
    for (const [status, agents] of [
      ['idle', [owned('idle')]],
      ['absent', []],
    ] as const) {
      const herdr = new MockHerdr({ available: true, agents: [...agents], workspaces: [] });
      const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });
      const outcome = await orchestrator.cancel(spec({ recorded }));
      expect(outcome.terminated, status).toBe(true);
    }
  });

  it('never claims termination when Herdr itself cannot be reached', async () => {
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });
    const outcome = await orchestrator.cancel(spec({ recorded }));
    expect(outcome.terminated).toBe(false);
    expect(outcome.agentStatus).toBe('unknown');
  });
});

describe('workspace cleanup is ownership-proving', () => {
  it('closes only the recorded, Ducky-labelled workspace', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });

    const out = await orchestrator.cleanup(spec({ recorded, mode: 'direct' }), WS);
    expect(out.closed).toBe(true);
    expect(herdr.countOf('workspaceClose')).toBe(1);
  });

  it('refuses to close a user workspace even if its id is passed in', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [],
      // A human's workspace that happens to be labelled "ducky".
      workspaces: [{ workspace_id: 'wUser', label: 'ducky' }],
    });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });

    const mismatched = await orchestrator.cleanup(spec({ recorded }), 'wUser');
    expect(mismatched.closed).toBe(false);
    expect(mismatched.detail).toMatch(/not the one recorded/i);

    const forged = await orchestrator.cleanup(
      spec({ recorded: { ...recorded, workspaceId: 'wUser' } }),
      'wUser',
    );
    expect(forged.closed).toBe(false);
    expect(forged.detail).toMatch(/not Ducky-managed/i);
    expect(herdr.countOf('workspaceClose')).toBe(0);
    expect(herdr.countOf('worktreeRemove')).toBe(0);
  });

  it('keeps the workspace when the agent is still working', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [owned('working')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });
    const out = await orchestrator.cleanup(spec({ recorded }), WS);
    expect(out.closed).toBe(false);
    expect(herdr.countOf('workspaceClose')).toBe(0);
  });

  it('removes the worktree rather than just closing it in worktree mode', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {} });
    await orchestrator.cleanup(spec({ recorded, mode: 'worktree' }), WS);
    expect(herdr.countOf('worktreeRemove')).toBe(1);
    expect(herdr.countOf('workspaceClose')).toBe(0);
  });
});

function owned(status: AgentInfo['agent_status']): AgentInfo {
  return {
    agent: 'pi',
    agent_status: status,
    pane_id: `${WS}:p1`,
    workspace_id: WS,
    name: AGENT,
    cwd: '/repos/demo',
  };
}
