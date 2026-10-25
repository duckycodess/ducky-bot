import { describe, expect, it } from 'vitest';
import { DuckyError } from '@ducky/contracts';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey, workspaceLabelFor } from '../src/pi/pi-herdr.js';
import { exampleImplementedResult } from '../src/pi/pi.mock.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';
import { MemoryDispatchJournal } from '../src/pi/dispatch-journal.js';

/**
 * `terminated: true` is the only thing that releases a repository, a writer lock
 * and the engineering slot after a timeout or a cancellation. It must mean a
 * POSITIVE proof that the recorded agent is quiet, and never an idle reading
 * taken while the turn may still be starting.
 */
const SLUG = 'demo-repo';
const slugKey = toSlugKey(SLUG);
const AGENT = agentNameFor(slugKey);
const WS = 'wDemo';
const recorded = { workspaceId: WS, agentName: AGENT, workspacePath: '/repos/demo' };

/** The durable record every recorded agent in these tests already has: its last turn settled. */
const seeded = (): MemoryDispatchJournal =>
  new MemoryDispatchJournal().seedSettled({ jobId: 'job-1', workspaceId: WS, agentName: AGENT });

const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
  jobId: 'job-1', leaseId: 'lease-1', publicId: 'jabcde', repoSlug: SLUG, slugKey, mode: 'worktree',
  repoPath: '/repos/demo', branch: 'ducky/job-jabcde', base: 'main', brief: 'do the thing',
  recoveryRequired: false, promptTimeoutMs: 1000, recoveryWaitMs: 50, ...over,
});

const orch = (herdr: MockHerdr, over: Record<string, unknown> = {}, result?: ReturnType<typeof exampleImplementedResult>) =>
  new HerdrPiOrchestrator({
    journal: seeded(),
    briefWriter: new MemoryBriefWriter(),
    herdr,
    resultReader: { read: async () => result },
    sleep: async () => {},
    pollIntervalMs: 1,
    stallPickupMs: 5,
    resultSettleAttempts: 1,
    resultSettleDelayMs: 0,
    readyWaitMs: 20,
    readyMarkerWaitMs: 5,
    cancelDrainMs: 40,
    ...over,
  });

const owned = (status: AgentInfo['agent_status'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  agent: 'pi', agent_status: status, pane_id: `${WS}:p1`, workspace_id: WS, name: AGENT, ...over,
});
const ours = (a: AgentInfo, label = workspaceLabelFor(slugKey)) =>
  new MockHerdr({ available: true, agents: [a], workspaces: [{ workspace_id: WS, label }] });

describe('normal confirmed quiet', () => {
  it('releases after a turn that settled and an agent that is positively the recorded, idle one', async () => {
    const herdr = new MockHerdr();
    const o = orch(herdr, {}, exampleImplementedResult());
    expect((await o.runJob(spec())).kind).toBe('result');

    const out = await o.cancel(spec());
    expect(out).toMatchObject({ terminated: true, agentStatus: 'idle' });
    expect(out.workspaceId).toMatch(/^wW/);
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('releases for a never-started job, whose absent agent proves nothing is running', async () => {
    const herdr = new MockHerdr();
    // Nothing recorded durably either: a journal entry would mean an agent existed.
    const o = new HerdrPiOrchestrator({ herdr, journal: new MemoryDispatchJournal(), briefWriter: new MemoryBriefWriter() });
    expect(await o.cancel(spec())).toMatchObject({ terminated: true, agentStatus: 'absent' });
  });

  it('releases an agent that was never prompted because every attempt was refused as not ready', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_agent_not_ready', 'not yet');
    };
    const o = orch(herdr);
    await o.runJob(spec()).catch(() => undefined);
    expect((await o.cancel(spec())).terminated).toBe(true);
  });

  it('releases an agent when the abort landed before any prompt was dispatched', async () => {
    const herdr = new MockHerdr();
    const controller = new AbortController();
    controller.abort();
    const o = orch(herdr);
    await o.runJob(spec({ signal: controller.signal })).catch(() => undefined);
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect((await o.cancel(spec({ signal: controller.signal }))).terminated).toBe(true);
  });
});

describe('absence, mismatch and unproven identity are never quiet', () => {
  const afterRun = async (mutate: (h: MockHerdr) => void) => {
    const herdr = new MockHerdr();
    const o = orch(herdr, {}, exampleImplementedResult());
    await o.runJob(spec());
    mutate(herdr);
    return o.cancel(spec());
  };

  it('a started agent that has vanished stays an orphan', async () => {
    const out = await afterRun((h) => { h.state.agents = []; });
    expect(out).toMatchObject({ terminated: false, agentStatus: 'absent' });
  });

  it('a recorded agent that has vanished stays an orphan after a restart too', async () => {
    const out = await orch(new MockHerdr({ available: true, agents: [], workspaces: [] })).cancel(spec({ recorded }));
    expect(out).toMatchObject({ terminated: false, agentStatus: 'absent' });
  });

  it('a same-name idle agent in another workspace is not the agent', async () => {
    const out = await afterRun((h) => { h.state.agents[0]!.workspace_id = 'wElsewhere'; });
    expect(out.terminated).toBe(false);
    expect(out.detail).toMatch(/not provably the recorded/);
  });

  it('a same-name idle agent in another pane is not the agent', async () => {
    const out = await afterRun((h) => { h.state.agents[0]!.pane_id = 'wX:p9'; });
    expect(out.terminated).toBe(false);
  });

  it('an agent with no workspace id, or a different name, is not the agent', async () => {
    const noWs = await afterRun((h) => { delete (h.state.agents[0] as { workspace_id?: string }).workspace_id; });
    expect(noWs.terminated).toBe(false);
    const renamed = await afterRun((h) => { (h.state.agents[0] as { name?: string }).name = 'ducky-pi-other'; });
    expect(renamed.terminated).toBe(false);
  });

  it('a workspace that is no longer provably Ducky-managed is not quiet proof', async () => {
    const out = await afterRun((h) => {
      h.state.workspaces = h.state.workspaces.map((w) => ({ ...w, label: 'ducky' }));
    });
    expect(out.terminated).toBe(false);
  });

  it('unknown, working and blocked are not quiet', async () => {
    for (const status of ['unknown', 'working', 'blocked'] as const) {
      const out = await afterRun((h) => h.setAgentStatus(AGENT, status));
      expect(out.terminated, status).toBe(false);
      expect(out.agentStatus, status).toBe(status);
    }
  });

  it('a pinned pane that was replaced on a resume is not the agent either', async () => {
    const herdr = ours(owned('idle'));
    const o = orch(herdr, {}, exampleImplementedResult());
    await o.runJob(spec({ recorded }));
    herdr.state.agents[0]!.pane_id = `${WS}:p2`;
    expect((await o.cancel(spec({ recorded }))).terminated).toBe(false);
  });
});

describe('the pending-prompt pickup race', () => {
  it('does not release while the abandoned runJob may still dispatch', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = () => new Promise(() => {}); // delivered, never settles, ignores abort
    const o = orch(herdr);
    void o.runJob(spec()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15));

    const out = await o.cancel(spec());
    expect(out.terminated).toBe(false);
    expect(out.detail).toMatch(/still be dispatching/);
  });

  it('does not release an idle agent right after a prompt whose turn was never seen to settle', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new Error('the wait died just after delivery');
    };
    const o = orch(herdr);
    await o.runJob(spec()).catch(() => undefined);
    // Herdr still says idle: the agent simply has not flipped to working yet.
    expect(herdr.state.agents[0]!.agent_status).toBe('idle');

    const out = await o.cancel(spec());
    expect(out.terminated).toBe(false);
    expect(out.detail).toMatch(/never observed to settle/);
  });

  it('does not release after a stalled prompt that nothing was seen to pick up', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no activity observed');
    };
    const o = orch(herdr);
    await o.runJob(spec()).catch(() => undefined);
    expect((await o.cancel(spec())).terminated).toBe(false);
  });

  it('waits for the abandoned runJob to wind down, then releases a turn that did settle', async () => {
    const herdr = new MockHerdr();
    // The prompt settles at once; runJob then spends real time re-reading the
    // result, which is exactly when a deadline can fire.
    const o = orch(herdr, {
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      resultSettleAttempts: 4,
      resultSettleDelayMs: 25,
      cancelDrainMs: 1000,
    });
    const run = o.runJob(spec()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));

    const out = await o.cancel(spec());
    expect(out.terminated).toBe(true);
    await run;
  });

  it('does not release on a turn whose settle was seen only as working, and keeps blocked as blocked', async () => {
    const herdr = new MockHerdr();
    herdr.promptSettlesAs = 'working';
    const o = orch(herdr);
    await o.runJob(spec()).catch(() => undefined);
    expect((await o.cancel(spec())).terminated).toBe(false);
  });
});
