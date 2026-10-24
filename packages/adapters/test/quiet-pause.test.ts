import { describe, expect, it } from 'vitest';
import { DuckyError } from '@ducky/contracts';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey, workspaceLabelFor } from '../src/pi/pi-herdr.js';
import { exampleImplementedResult } from '../src/pi/pi.mock.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';

/**
 * When does a turn that left no result earn a PAUSE?
 *
 * Only when a fresh look positively proves the recorded agent quiet. Every other
 * observation keeps the outcome it always had, because a pause releases the
 * engineering slot and "I could not tell" must never do that.
 */
const SLUG = 'demo-repo';
const slugKey = toSlugKey(SLUG);
const AGENT = agentNameFor(slugKey);
const WS = 'wDemo';
const LABEL = workspaceLabelFor(slugKey);
const recorded = { workspaceId: WS, agentName: AGENT, workspacePath: '/repos/demo' };

const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
  jobId: 'job-1', publicId: 'jabcde', repoSlug: SLUG, slugKey, mode: 'worktree',
  repoPath: '/repos/demo', branch: 'ducky/job-jabcde', base: 'main', brief: 'do the thing',
  recoveryRequired: false, promptTimeoutMs: 1000, recoveryWaitMs: 50, ...over,
});

const agent = (status: AgentInfo['agent_status'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  agent: 'pi', agent_status: status, pane_id: `${WS}:p1`, workspace_id: WS, name: AGENT,
  cwd: '/repos/demo', ...over,
});

const orch = (herdr: MockHerdr, result = undefined as ReturnType<typeof exampleImplementedResult> | undefined) =>
  new HerdrPiOrchestrator({
    briefWriter: new MemoryBriefWriter(),
    herdr,
    resultReader: { read: async () => result },
    sleep: async () => {},
    pollIntervalMs: 1,
    stallPickupMs: 5,
    resultSettleAttempts: 1,
    resultSettleDelayMs: 0,
  });

/** An existing, owned agent, as a recovery or an owner-resume meets it. */
const existing = (a: AgentInfo, label = LABEL) =>
  new MockHerdr({ available: true, agents: [a], workspaces: [{ workspace_id: WS, label }] });

describe('a fresh turn that settles with no result', () => {
  for (const status of ['idle', 'done'] as const) {
    it(`pauses on a positively identified ${status} agent and records what was observed`, async () => {
      const herdr = new MockHerdr();
      herdr.promptSettlesAs = status;
      expect(await orch(herdr).runJob(spec())).toMatchObject({
        kind: 'quiet_pause', cause: 'agent_idle_no_result', observed: status,
      });
      expect(herdr.countOf('agentPrompt')).toBe(1);
    });
  }

  it('keeps no_result for an unknown status', async () => {
    const herdr = new MockHerdr();
    herdr.promptSettlesAs = 'unknown';
    expect((await orch(herdr).runJob(spec())).kind).toBe('no_result');
  });

  it('keeps each orphan outcome for a working or blocked agent', async () => {
    const working = new MockHerdr();
    working.promptSettlesAs = 'working';
    expect(await orch(working).runJob(spec())).toMatchObject({ kind: 'orphan', reason: 'orphan_agent_still_working' });
    const blocked = new MockHerdr();
    blocked.promptSettlesAs = 'blocked';
    expect(await orch(blocked).runJob(spec())).toMatchObject({ kind: 'orphan', reason: 'orphan_agent_blocked' });
  });

  it('is not quiet proof when the agent is absent on the fresh look', async () => {
    const herdr = new MockHerdr();
    const get = herdr.agentGet.bind(herdr);
    herdr.agentPrompt = async (t) => {
      herdr.state.agents = [];
      return get(t);
    };
    expect((await orch(herdr).runJob(spec())).kind).toBe('no_result');
  });

  it('is not quiet proof when Herdr cannot be asked', async () => {
    const herdr = new MockHerdr();
    let prompted = false;
    const get = herdr.agentGet.bind(herdr);
    herdr.agentPrompt = async (t) => {
      prompted = true;
      return get(t);
    };
    herdr.agentGet = async (t) => {
      if (prompted) throw new DuckyError('herdr_unavailable', 'down');
      return get(t);
    };
    expect((await orch(herdr).runJob(spec())).kind).toBe('no_result');
  });

  it('is not quiet proof when the agent no longer carries the recorded workspace id', async () => {
    for (const mutate of [
      (a: AgentInfo) => { a.workspace_id = 'wElsewhere'; },
      (a: AgentInfo) => { delete (a as { workspace_id?: string }).workspace_id; },
      (a: AgentInfo) => { (a as { name?: string }).name = 'ducky-pi-someone-else'; },
    ]) {
      const herdr = new MockHerdr();
      const get = herdr.agentGet.bind(herdr);
      herdr.agentPrompt = async (t) => {
        const a = (await get(t))!;
        mutate(a);
        return a;
      };
      herdr.agentGet = async (t) => herdr.state.agents[0] ?? undefined;
      expect((await orch(herdr).runJob(spec())).kind).toBe('no_result');
    }
  });

  it('is not quiet proof when the workspace is no longer provably Ducky-managed', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async (t) => {
      herdr.state.workspaces = herdr.state.workspaces.map((w) => ({ ...w, label: 'ducky' }));
      return herdr.state.agents.find((a) => a.name === t);
    };
    expect((await orch(herdr).runJob(spec())).kind).toBe('no_result');
  });

  it('does not turn a valid result into a pause', async () => {
    const herdr = new MockHerdr();
    expect((await orch(herdr, exampleImplementedResult()).runJob(spec())).kind).toBe('result');
  });
});

describe('a stalled prompt', () => {
  const stalled = (herdr: MockHerdr) => {
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no activity observed');
    };
    return herdr;
  };

  it('is a pause when no pickup was observed and a fresh look proves the agent quiet', async () => {
    expect(await orch(stalled(new MockHerdr())).runJob(spec())).toMatchObject({
      kind: 'quiet_pause', observed: 'idle',
    });
  });

  it('still re-raises the stall when the agent cannot be proven quiet', async () => {
    const herdr = stalled(new MockHerdr());
    const get = herdr.agentGet.bind(herdr);
    let looks = 0;
    herdr.agentGet = async (t) => {
      looks += 1;
      const a = await get(t);
      // The final look after the stall is the one that matters here.
      return a && looks > 3 ? { ...a, agent_status: 'unknown' } : a;
    };
    const err = await orch(herdr).runJob(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuckyError);
    expect((err as DuckyError).code).toBe('herdr_prompt_stalled');
  });

  it('never relabels any other failure as a pause', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new Error('socket exploded');
    };
    await expect(orch(herdr).runJob(spec())).rejects.toThrow(/socket exploded/);
  });
});

describe('recovery of an agent that is already there', () => {
  it('pauses a quiet recovery instead of sending the brief again', async () => {
    const herdr = existing(agent('idle'));
    const out = await orch(herdr).runJob(spec({ recorded, recoveryRequired: true }));
    expect(out).toMatchObject({ kind: 'quiet_pause', observed: 'idle' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('submits a result that was written before the report was lost', async () => {
    const herdr = existing(agent('done'));
    const out = await orch(herdr, exampleImplementedResult()).runJob(spec({ recorded, recoveryRequired: true }));
    expect(out.kind).toBe('result');
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('does NOT fall through to a prompt when the quiet proof is missing', async () => {
    // Herdr names no workspace for the agent: recovery owns it by the recorded
    // row, but the fresh quiet proof needs a positive workspace id.
    const noWorkspace = existing(agent('idle', { workspace_id: undefined as never }));
    const a = await orch(noWorkspace).runJob(spec({ recorded, recoveryRequired: true }));
    expect(a.kind).toBe('no_result');
    expect(noWorkspace.countOf('agentPrompt')).toBe(0);

    // The workspace is not provably Ducky-managed any more.
    const notOurs = existing(agent('idle'), 'ducky');
    expect((await orch(notOurs).runJob(spec({ recorded, recoveryRequired: true }))).kind).toBe('conflict');
    expect(notOurs.countOf('agentPrompt')).toBe(0);

    // The agent vanishes between the ownership check and the fresh look.
    const vanishing = existing(agent('idle'));
    const get = vanishing.agentGet.bind(vanishing);
    let looks = 0;
    vanishing.agentGet = async (t) => {
      looks += 1;
      return looks === 1 ? get(t) : undefined;
    };
    expect((await orch(vanishing).runJob(spec({ recorded, recoveryRequired: true }))).kind).toBe('no_result');
    expect(vanishing.countOf('agentPrompt')).toBe(0);

    // Herdr cannot be asked on the fresh look.
    const unreachable = existing(agent('idle'));
    const get2 = unreachable.agentGet.bind(unreachable);
    let n = 0;
    unreachable.agentGet = async (t) => {
      n += 1;
      if (n === 1) return get2(t);
      throw new DuckyError('herdr_unavailable', 'down');
    };
    expect((await orch(unreachable).runJob(spec({ recorded, recoveryRequired: true }))).kind).toBe('no_result');
    expect(unreachable.countOf('agentPrompt')).toBe(0);
  });

  it('keeps the orphan outcome for an agent that turned out to be working in the fresh look', async () => {
    const herdr = existing(agent('idle'));
    const get = herdr.agentGet.bind(herdr);
    let n = 0;
    herdr.agentGet = async (t) => {
      n += 1;
      const a = await get(t);
      return n === 1 || !a ? a : { ...a, agent_status: 'working' };
    };
    expect(await orch(herdr).runJob(spec({ recorded, recoveryRequired: true }))).toMatchObject({
      kind: 'orphan', reason: 'orphan_agent_still_working',
    });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('still prompts an ordinary resume, which is a fresh bounded turn', async () => {
    const herdr = existing(agent('idle'));
    const out = await orch(herdr, exampleImplementedResult()).runJob(spec({ recorded, recoveryRequired: false }));
    expect(out.kind).toBe('result');
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });
});
