import { describe, expect, it } from 'vitest';
import { DuckyError } from '@ducky/contracts';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey, workspaceLabelFor } from '../src/pi/pi-herdr.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';

/** The brief travels as a file; these suites use synthetic workspace paths. */
const briefs = (): MemoryBriefWriter => new MemoryBriefWriter();
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

/**
 * `sleep` yields real time on purpose. Several waits here are bounded by WALL
 * CLOCK (the stall pickup window, the recovery wait, the settled-state poll),
 * so a sleep that resolves immediately spins instead of advancing and the loop
 * allocates until the heap runs out. The windows are then set small enough that
 * the tests stay fast.
 */
const shortSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(2, ms)));

function orchestratorWith(
  herdr: MockHerdr,
  result: ReturnType<typeof exampleImplementedResult> | undefined,
): HerdrPiOrchestrator {
  return new HerdrPiOrchestrator({
    briefWriter: briefs(),
    herdr,
    resultReader: reader(result),
    sleep: shortSleep,
    pollIntervalMs: 2,
    stallPickupMs: 30,
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
      briefWriter: briefs(),
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
      new HerdrPiOrchestrator({ herdr: new MockHerdr(), verified: true, briefWriter: briefs() }).verified,
    ).toBe(true);
  });
});

describe('worktree mode uses the checkout path Herdr reports', () => {
  it('reads the result from the linked worktree, never from the source repo', async () => {
    const herdr = new MockHerdr();
    const seen: string[] = [];
    const orchestrator = new HerdrPiOrchestrator({
      briefWriter: briefs(),
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
      briefWriter: briefs(),
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
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });

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
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });

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
      const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });
      const outcome = await orchestrator.cancel(spec({ recorded }));
      expect(outcome.terminated, status).toBe(true);
    }
  });

  it('never claims termination when Herdr itself cannot be reached', async () => {
    const herdr = new MockHerdr({ available: false, agents: [], workspaces: [] });
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });
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
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });

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
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });

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
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });
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
    const orchestrator = new HerdrPiOrchestrator({ herdr, sleep: async () => {}, briefWriter: briefs() });
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

/**
 * What the SETTLED agent is for.
 *
 * `herdr agent prompt --wait` returns on an observed lifecycle change, and one
 * of the states it settles on is `blocked` -- Pi showing an approval or
 * question UI. Before the adapter read the settled agent back, that case was
 * indistinguishable from a finished turn: the result file was absent, so the
 * outcome was `no_result`, and the coordinator released a repository whose pane
 * still had a live writer sitting in it.
 */
describe('prompt settling', () => {
  it('reports a turn that settled BLOCKED as an orphan, not as a missing result', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    herdr.promptSettlesAs = 'blocked';
    const orch = orchestratorWith(herdr, undefined);

    const out = await orch.runJob(spec());
    expect(out.kind).toBe('orphan');
    expect(out.kind === 'orphan' && out.reason).toBe('orphan_agent_blocked');
  });

  it('does not read the result file at all once the agent settled blocked', async () => {
    let reads = 0;
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    herdr.promptSettlesAs = 'blocked';
    const orch = new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: { read: async () => { reads += 1; return undefined; } },
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    await orch.runJob(spec());
    expect(reads).toBe(0);
  });

  it('still submits a result when the turn settled normally', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    herdr.promptSettlesAs = 'idle';
    const orch = orchestratorWith(herdr, exampleImplementedResult());

    const out = await orch.runJob(spec());
    expect(out.kind).toBe('result');
  });

  it('re-reads the result file a bounded number of times before giving up', async () => {
    let reads = 0;
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    // Models the real race: the lifecycle change is observed before the
    // agent's last write has landed on disk.
    const orch = new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: {
        read: async () => {
          reads += 1;
          return reads >= 3 ? exampleImplementedResult() : undefined;
        },
      },
      sleep: async () => {},
      pollIntervalMs: 1,
      resultSettleAttempts: 3,
      resultSettleDelayMs: 0,
    });

    const out = await orch.runJob(spec());
    expect(out.kind).toBe('result');
    expect(reads).toBe(3);
  });

  it('gives up after the configured attempts rather than polling forever', async () => {
    let reads = 0;
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    const orch = new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: { read: async () => { reads += 1; return undefined; } },
      sleep: async () => {},
      pollIntervalMs: 1,
      resultSettleAttempts: 2,
      resultSettleDelayMs: 0,
    });

    const out = await orch.runJob(spec());
    expect(out.kind).toBe('no_result');
    expect(reads).toBe(2);
  });
});

/**
 * The prompt call itself failing is a different problem from the turn ending.
 *
 * A killed subprocess, a stalled wait or a dropped socket all leave the AGENT
 * untouched. Reporting `herdr_unavailable` -- which is what happened before
 * this branch existed -- is not an orphan reason, so the coordinator released
 * the repository reservation while a real Pi agent kept writing.
 */
describe('prompt failure', () => {
  /**
   * `agentGet` is consulted twice for different reasons: once BEFORE anything
   * is created, to decide whether an agent already exists, and again after a
   * failed wait, to establish what is still running. The stub has to answer
   * "nothing yet" the first time or the run never reaches the prompt at all.
   */
  const failingPromptHerdr = (agentAfter: AgentInfo | undefined, throwOnGet = false) => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    let gets = 0;
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_unavailable', 'the wait died');
    };
    herdr.agentGet = async () => {
      gets += 1;
      if (gets === 1) return undefined;
      if (throwOnGet) throw new DuckyError('herdr_unavailable', 'socket gone');
      return agentAfter;
    };
    return herdr;
  };

  it('is an orphan when the agent is still working', async () => {
    const orch = orchestratorWith(failingPromptHerdr(ownedAgent('working')), undefined);
    const out = await orch.runJob(spec());
    expect(out.kind === 'orphan' && out.reason).toBe('orphan_agent_still_working');
  });

  it('is an orphan when the agent is blocked', async () => {
    const orch = orchestratorWith(failingPromptHerdr(ownedAgent('blocked')), undefined);
    const out = await orch.runJob(spec());
    expect(out.kind === 'orphan' && out.reason).toBe('orphan_agent_blocked');
  });

  it('is an orphan when Herdr cannot even be asked what the agent is doing', async () => {
    const orch = orchestratorWith(failingPromptHerdr(undefined, true), undefined);
    const out = await orch.runJob(spec());
    expect(out.kind === 'orphan' && out.reason).toBe('orphan_agent_still_working');
  });

  it('accepts a result the agent finished before the wait broke', async () => {
    const orch = orchestratorWith(failingPromptHerdr(ownedAgent('idle')), exampleImplementedResult());
    const out = await orch.runJob(spec());
    expect(out.kind).toBe('result');
  });

  it('re-raises the original failure when nothing runs and nothing was written', async () => {
    const orch = orchestratorWith(failingPromptHerdr(undefined), undefined);
    await expect(orch.runJob(spec())).rejects.toThrow(/the wait died/);
  });

  it('a stalled prompt with a quiet agent re-raises the stall, not an outage claim', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no activity observed');
    };
    const orch = orchestratorWith(herdr, undefined);

    const err = await orch.runJob(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuckyError);
    expect((err as DuckyError).code).toBe('herdr_prompt_stalled');
  });
});

/**
 * Cleaning up after a REAL job, which Probe A proved does not work the obvious
 * way: `herdr worktree remove` answers `dirty_worktree_requires_force` when the
 * checkout holds modified or untracked files, and every finished job leaves at
 * least `.ducky/result.json` there.
 *
 * The fix is NOT to force. That checkout holds the implementation the job was
 * asked to produce, and nothing has committed it -- the brief forbids
 * committing -- so forcing would delete the work. The workspace is kept and
 * said so instead.
 */
describe('cleanup of a worktree that holds the work', () => {
  const cleanupHerdr = (dirty: boolean) => {
    const herdr = new MockHerdr({
      available: true,
      agents: [],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });
    herdr.worktreeIsDirty = dirty;
    return herdr;
  };

  it('keeps a dirty worktree instead of deleting the implementation', async () => {
    const herdr = cleanupHerdr(true);
    const orch = orchestratorWith(herdr, undefined);

    const out = await orch.cleanup(spec({ recorded }), WS);
    expect(out.closed).toBe(false);
    expect(out.detail).toMatch(/uncommitted/i);
  });

  it('never passes --force when cleaning up a real job', async () => {
    const herdr = cleanupHerdr(true);
    const orch = orchestratorWith(herdr, undefined);
    await orch.cleanup(spec({ recorded }), WS);

    const removals = herdr.calls.filter((c) => c.op === 'worktreeRemove');
    expect(removals).toHaveLength(1);
    expect((removals[0]!.args as { force: boolean }).force).toBe(false);
  });

  it('still closes a clean worktree', async () => {
    const orch = orchestratorWith(cleanupHerdr(false), undefined);
    const out = await orch.cleanup(spec({ recorded }), WS);
    expect(out.closed).toBe(true);
  });
});

/**
 * The label a worktree workspace is CREATED with.
 *
 * `cleanup()` proves ownership three ways, and one of them is the
 * `ducky-mgd:` workspace label. Herdr names a worktree workspace after the
 * branch unless `--label` is passed, so without it the proof could never
 * succeed and every worktree job leaked its workspace and its checkout.
 *
 * No unit test caught that, because the mock used to synthesize a
 * `ducky-mgd:` label of its own regardless of what it was given. It now uses
 * the label it actually receives, which is what makes these assertions mean
 * something.
 */
describe('worktree workspace labelling', () => {
  it('creates the worktree workspace with the Ducky-managed label', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    const orch = orchestratorWith(herdr, exampleImplementedResult());

    await orch.runJob(spec());

    const create = herdr.calls.find((c) => c.op === 'worktreeCreate');
    expect(create).toBeDefined();
    expect((create!.args as { label: string }).label).toBe(workspaceLabelFor(slugKey));
    expect((create!.args as { label: string }).label.startsWith('ducky-mgd:')).toBe(true);
  });

  it('can then prove ownership and close that very workspace', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    const orch = orchestratorWith(herdr, exampleImplementedResult());

    const out = await orch.runJob(spec());
    expect(out.kind).toBe('result');
    const workspaceId = out.kind === 'result' ? out.workspaceId : '';

    const cleaned = await orch.cleanup(
      spec({ recorded: { workspaceId, agentName: AGENT, workspacePath: '/x' } }),
      workspaceId,
    );
    expect(cleaned.closed).toBe(true);
  });

  it('refuses to close a workspace whose label is not Ducky-managed', async () => {
    // Exactly what the live CLI produced before `--label` was passed.
    const herdr = new MockHerdr({
      available: true,
      agents: [],
      workspaces: [{ workspace_id: WS, label: 'ducky-job-jabcde' }],
    });
    const orch = orchestratorWith(herdr, undefined);

    const cleaned = await orch.cleanup(spec({ recorded }), WS);
    expect(cleaned.closed).toBe(false);
    expect(cleaned.detail).toMatch(/not Ducky-managed/);
  });
});

/**
 * `agent_prompt_stalled` tolerance.
 *
 * Herdr requires a lifecycle change within its own 5-second window after a
 * prompt is submitted, and gives up waiting otherwise. The text HAS been
 * delivered by then. Observed live on this host: two identical Probe B runs,
 * same brief, same code -- one flipped to `working` inside the window and
 * completed, one did not and failed the job outright.
 *
 * So a stall is a signal to keep OBSERVING, never to give up and never to
 * re-prompt (which would be a second writer).
 */
describe('a stalled prompt', () => {
  const stalling = (statuses: (AgentInfo['agent_status'] | 'absent')[]) => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    let gets = 0;
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no activity observed');
    };
    herdr.agentGet = async () => {
      const at = gets;
      gets += 1;
      if (at === 0) return undefined; // pre-flight: no agent exists yet
      const s = statuses[at - 1] ?? statuses[statuses.length - 1]!;
      return s === 'absent' ? undefined : ownedAgent(s);
    };
    return herdr;
  };

  // A real (tiny) sleep, not a no-op: these loops are bounded by WALL CLOCK,
  // so a sleep that never yields spins instead of advancing.
  const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(2, ms)));

  const orch = (herdr: MockHerdr, result: ReturnType<typeof exampleImplementedResult> | undefined) =>
    new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: reader(result),
      sleep: tick,
      pollIntervalMs: 2,
      stallPickupMs: 40,
      resultSettleAttempts: 1,
      resultSettleDelayMs: 0,
    });

  it('waits for an agent that picks the work up late, and accepts its result', async () => {
    // idle, idle, then working, then idle again = a real turn that started slow.
    const herdr = stalling(['idle', 'working', 'idle']);
    const out = await orch(herdr, exampleImplementedResult()).runJob(spec());
    expect(out.kind).toBe('result');
  });

  it('never re-prompts an agent that did pick the work up', async () => {
    // A second prompt to an agent that IS working would be a second writer, so
    // the count is the property under test. Counted here rather than through
    // the mock's ledger, because this suite replaces `agentPrompt` outright.
    let prompts = 0;
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    let gets = 0;
    herdr.agentPrompt = async () => {
      prompts += 1;
      throw new DuckyError('herdr_prompt_stalled', 'no activity observed');
    };
    herdr.agentGet = async () => {
      const at = gets;
      gets += 1;
      if (at === 0) return undefined;
      return ownedAgent(at === 1 ? 'working' : 'idle');
    };

    const out = await orch(herdr, exampleImplementedResult()).runJob(spec());
    expect(out.kind).toBe('result');
    expect(prompts).toBe(1);
  });

  it('is an orphan when the late-starting agent is still working at the deadline', async () => {
    const herdr = stalling(['working']);
    const o = new HerdrPiOrchestrator({
      briefWriter: briefs(),
      herdr,
      resultReader: reader(undefined),
      sleep: tick,
      pollIntervalMs: 2,
      stallPickupMs: 20,
    });
    const out = await o.runJob(spec({ promptTimeoutMs: 20 }));
    expect(out.kind === 'orphan' && out.reason).toBe('orphan_agent_still_working');
  });

  it('is an orphan when the agent turns out to be blocked', async () => {
    const herdr = stalling(['blocked']);
    const out = await orch(herdr, undefined).runJob(spec());
    expect(out.kind === 'orphan' && out.reason).toBe('orphan_agent_blocked');
  });

  it('accepts a result from a turn that finished before we looked', async () => {
    const herdr = stalling(['idle']);
    const out = await orch(herdr, exampleImplementedResult()).runJob(spec());
    expect(out.kind).toBe('result');
  });

  it('reports the stall honestly when the agent never starts and writes nothing', async () => {
    const herdr = stalling(['idle']);
    const err = await orch(herdr, undefined).runJob(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuckyError);
    expect((err as DuckyError).code).toBe('herdr_prompt_stalled');
  });
});

/**
 * What actually crosses the terminal.
 *
 * The brief must NOT be pasted: measured on this host, 3.3 KB over 66 lines was
 * left unsent in Pi's input buffer and the job failed without starting. Only a
 * one-line pointer is submitted, and the brief is written into the workspace.
 */
describe('brief handover through the workspace', () => {
  it('pastes a short pointer and writes the brief to the workspace', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    const writer = new MemoryBriefWriter();
    const longBrief = `# Ducky job\n${'instruction line\n'.repeat(200)}`;
    const orch = new HerdrPiOrchestrator({
      herdr,
      briefWriter: writer,
      resultReader: reader(exampleImplementedResult()),
      sleep: shortSleep,
      pollIntervalMs: 2,
      stallPickupMs: 30,
    });

    await orch.runJob(spec({ brief: longBrief }));

    // The whole brief reached the workspace...
    expect(writer.written).toHaveLength(1);
    expect(writer.written[0]!.brief).toBe(longBrief);

    // ...and only the pointer was submitted to the pane.
    const prompt = herdr.calls.find((c) => c.op === 'agentPrompt');
    expect(prompt).toBeDefined();
    const submitted = prompt!.args as { textLength: number };
    expect(submitted.textLength).toBeLessThan(300);
    expect(submitted.textLength).toBeLessThan(longBrief.length);
  });

  it('writes the brief into the same workspace the result is read from', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    const writer = new MemoryBriefWriter();
    const orch = new HerdrPiOrchestrator({
      herdr,
      briefWriter: writer,
      resultReader: reader(exampleImplementedResult()),
      sleep: shortSleep,
      pollIntervalMs: 2,
      stallPickupMs: 30,
    });

    const out = await orch.runJob(spec());
    expect(out.kind).toBe('result');
    // For a worktree that is Herdr's checkout directory, not the repo root.
    expect(writer.written[0]!.workspacePath).toBe(
      out.kind === 'result' ? out.workspacePath : 'mismatch',
    );
  });

  it('fails the turn rather than pasting when the brief cannot be written', async () => {
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    const orch = new HerdrPiOrchestrator({
      herdr,
      briefWriter: { write: async () => { throw new Error('read-only workspace'); } },
      resultReader: reader(exampleImplementedResult()),
      sleep: shortSleep,
      pollIntervalMs: 2,
    });

    await expect(orch.runJob(spec())).rejects.toThrow(/read-only workspace/);
    // Nothing was submitted, so no agent was set to work on a half-given brief.
    expect(herdr.calls.filter((c) => c.op === 'agentPrompt')).toHaveLength(0);
  });
});

/**
 * The phase file is cleared BEFORE the brief goes over.
 *
 * A resumed job reuses its workspace, so the phase the previous turn finished
 * on is still there. Without clearing it the new turn inherits it and reports
 * `verifying` while it has only just started planning.
 */
describe('stale phase on a resumed turn', () => {
  it('clears the previous phase before submitting the brief', async () => {
    const order: string[] = [];
    const herdr = new MockHerdr({ available: true, agents: [], workspaces: [] });
    herdr.agentPrompt = async () => {
      order.push('prompt');
      return ownedAgent('idle');
    };

    const orch = new HerdrPiOrchestrator({
      herdr,
      briefWriter: { write: async () => { order.push('brief'); return '.ducky/brief.md'; } },
      phaseReader: {
        read: async () => undefined,
        clear: async () => { order.push('clear'); },
      },
      resultReader: reader(exampleImplementedResult()),
      sleep: shortSleep,
      pollIntervalMs: 2,
      stallPickupMs: 30,
    });

    await orch.runJob(spec());
    // Cleared first, then the brief, then the prompt. Any other order lets a
    // stale phase be read as the current turn's.
    expect(order).toEqual(['clear', 'brief', 'prompt']);
  });

  it('clears on a RESUMED turn too, which is the case that matters', async () => {
    let cleared = 0;
    const herdr = new MockHerdr({
      available: true,
      agents: [ownedAgent('idle')],
      workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
    });

    const orch = new HerdrPiOrchestrator({
      herdr,
      briefWriter: new MemoryBriefWriter(),
      phaseReader: { read: async () => undefined, clear: async () => { cleared += 1; } },
      resultReader: reader(exampleImplementedResult()),
      sleep: shortSleep,
      pollIntervalMs: 2,
      stallPickupMs: 30,
    });

    const out = await orch.runJob(spec({ recorded }));
    expect(out.kind).toBe('result');
    expect(cleared).toBe(1);
  });
});
