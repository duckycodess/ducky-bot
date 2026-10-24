import { describe, expect, it } from 'vitest';
import { DuckyError } from '@ducky/contracts';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';
import {
  DispatchJournalError, MemoryDispatchJournal, type DispatchEntry,
} from '../src/pi/dispatch-journal.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey, workspaceLabelFor } from '../src/pi/pi-herdr.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';

/**
 * Durable dispatch provenance.
 *
 * An idle reading is quiet proof only against a durable record that the last
 * prompt submitted to the agent SETTLED. These are the cases an in-memory turn
 * got wrong: after an executor restart, and after a recovery claim replaced the
 * turn, an agent that was handed work and had not yet picked it up looked
 * exactly like a finished one.
 */
const SLUG = 'demo-repo';
const slugKey = toSlugKey(SLUG);
const AGENT = agentNameFor(slugKey);
const WS = 'wDemo';
const LABEL = workspaceLabelFor(slugKey);
const recorded = { workspaceId: WS, agentName: AGENT, workspacePath: '/repos/demo' };

const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
  jobId: 'job-1', leaseId: 'lease-1', publicId: 'jabcde', repoSlug: SLUG, slugKey, mode: 'worktree',
  repoPath: '/repos/demo', branch: 'ducky/job-jabcde', base: 'main', brief: 'do the thing',
  recoveryRequired: false, promptTimeoutMs: 1000, recoveryWaitMs: 50, ...over,
});

const orch = (herdr: MockHerdr, journal: MemoryDispatchJournal, over: Record<string, unknown> = {}) =>
  new HerdrPiOrchestrator({
    journal,
    briefWriter: new MemoryBriefWriter(),
    herdr,
    resultReader: { read: async () => undefined },
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

const agent = (status: AgentInfo['agent_status'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  agent: 'pi', agent_status: status, pane_id: `${WS}:p1`, workspace_id: WS, name: AGENT, ...over,
});
const existing = (a: AgentInfo, label = LABEL) =>
  new MockHerdr({ available: true, agents: [a], workspaces: [{ workspace_id: WS, label }] });

const entry = (state: DispatchEntry['state'], over: Partial<DispatchEntry> = {}): DispatchEntry => ({
  jobId: 'job-1', leaseId: 'lease-0', workspaceId: WS, agentName: AGENT, state, ...over,
});
const journalWith = (e: DispatchEntry): MemoryDispatchJournal => {
  const j = new MemoryDispatchJournal();
  j.entries.set(e.jobId, e);
  return j;
};

describe('the journal is written around every prompt', () => {
  it('records a clean start, then the dispatch BEFORE the text can reach the agent, then the settle', async () => {
    const herdr = new MockHerdr();
    const journal = new MemoryDispatchJournal();
    let atPrompt: string | undefined;
    const prompt = herdr.agentPrompt.bind(herdr);
    herdr.agentPrompt = async (...a: Parameters<typeof prompt>) => {
      atPrompt = journal.entries.get('job-1')?.state;
      return prompt(...a);
    };
    await orch(herdr, journal).runJob(spec());

    expect(atPrompt).toBe('dispatching');
    expect(journal.writes.map((w) => w.state)).toEqual(['settled', 'dispatching', 'settled']);
    expect(journal.writes.every((w) => w.leaseId === 'lease-1')).toBe(true);
  });

  it('does not send the prompt when the dispatch cannot be recorded', async () => {
    const herdr = new MockHerdr();
    const journal = new MemoryDispatchJournal();
    journal.failRecords = (e) => e.state === 'dispatching';
    await expect(orch(herdr, journal).runJob(spec())).rejects.toBeInstanceOf(DispatchJournalError);
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('does not send the prompt when the clean start cannot be recorded either', async () => {
    const herdr = new MockHerdr();
    const journal = new MemoryDispatchJournal();
    journal.failRecords = true;
    await expect(orch(herdr, journal).runJob(spec())).rejects.toBeInstanceOf(DispatchJournalError);
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('keeps the dispatch unsettled when the settle cannot be recorded, so the idle agent is not trusted', async () => {
    const herdr = new MockHerdr();
    const journal = new MemoryDispatchJournal();
    let dispatched = false;
    journal.failRecords = (e) => {
      if (e.state === 'dispatching') dispatched = true;
      return dispatched && e.state === 'settled';
    };
    const o = orch(herdr, journal);
    const out = await o.runJob(spec());

    expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
    expect(journal.entries.get('job-1')?.state).toBe('dispatching');
    // And a later restart's cancel does not release it either.
    const restarted = orch(herdr, journal);
    expect((await restarted.cancel(spec({ recorded: { workspaceId: out.kind === 'orphan' ? out.workspaceId : WS, agentName: AGENT, workspacePath: '/repos/demo' } }))).terminated).toBe(false);
  });

  it('puts the record back to settled when a prompt was refused as not ready (the text was not accepted)', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_agent_not_ready', 'not yet');
    };
    const journal = new MemoryDispatchJournal();
    await orch(herdr, journal).runJob(spec()).catch(() => undefined);
    expect(journal.entries.get('job-1')?.state).toBe('settled');
  });

  it('a stalled prompt that never shows pickup stays dispatching', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no change');
    };
    const journal = new MemoryDispatchJournal();
    const out = await orch(herdr, journal).runJob(spec());
    expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
    expect(journal.entries.get('job-1')?.state).toBe('dispatching');
  });

  it('withholds the prompt when the executor-level gate says a pause is owed', async () => {
    const herdr = new MockHerdr();
    const journal = new MemoryDispatchJournal();
    const o = orch(herdr, journal, { promptGate: () => 'a pause report is owed' });
    await expect(o.runJob(spec())).rejects.toThrow(/withheld/);
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(journal.writes.map((w) => w.state)).toEqual(['settled']);
  });
});

describe('recovery after a restart: a dispatched prompt that never settled is an orphan', () => {
  it('REGRESSION: crash after submit, before settle; the agent later reads idle', async () => {
    // A new process: no in-memory turn. The journal says a prompt was dispatched.
    const herdr = existing(agent('idle'));
    const out = await orch(herdr, journalWith(entry('dispatching'))).runJob(
      spec({ recorded, recoveryRequired: true }),
    );
    expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('REGRESSION: the same in one process, after a recovery claim replaced the in-memory turn', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no change');
    };
    const journal = new MemoryDispatchJournal();
    const o = orch(herdr, journal);
    const first = await o.runJob(spec());
    expect(first.kind).toBe('orphan');
    // The lease lapsed; a recovery claim runs in the SAME process with a new turn.
    herdr.agentPrompt = async () => {
      throw new Error('a recovery must never prompt');
    };
    const wsId = first.kind === 'orphan' ? first.workspaceId : WS;
    const again = await o.runJob(spec({ leaseId: 'lease-2', recorded: { workspaceId: wsId, agentName: AGENT, workspacePath: '/repos/demo' }, recoveryRequired: true }));
    expect(again).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
  });

  it('no journal entry for a recorded agent is untrusted, not quiet, and says so honestly', async () => {
    const herdr = existing(agent('idle'));
    const out = await orch(herdr, new MemoryDispatchJournal()).runJob(spec({ recorded, recoveryRequired: true }));
    expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
    expect(out.kind === 'orphan' && out.detail).toMatch(/no trustworthy record/);
  });

  it('an unreadable or mismatched journal is untrusted too', async () => {
    const unreadable = new MemoryDispatchJournal();
    unreadable.untrusted = 'corrupt';
    for (const j of [
      unreadable,
      journalWith(entry('settled', { workspaceId: 'wElsewhere' })),
      journalWith(entry('settled', { agentName: 'ducky-pi-other' })),
    ]) {
      const out = await orch(existing(agent('idle')), j).runJob(spec({ recorded, recoveryRequired: true }));
      expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
    }
  });

  it('a settled record plus a fresh positive idle look is the ONLY thing that pauses a recovery', async () => {
    const herdr = existing(agent('idle'));
    const out = await orch(herdr, journalWith(entry('settled'))).runJob(spec({ recorded, recoveryRequired: true }));
    expect(out).toMatchObject({ kind: 'quiet_pause', cause: 'agent_idle_no_result', observed: 'idle' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('observing the old work settle records it, so a later recovery may rest on it', async () => {
    const herdr = existing(agent('working'));
    const journal = journalWith(entry('dispatching'));
    const o = orch(herdr, journal, { pollIntervalMs: 1 });
    // The agent finishes while the recovery watches it.
    const get = herdr.agentGet.bind(herdr);
    let n = 0;
    herdr.agentGet = async (name: string) => {
      n += 1;
      if (n > 2) herdr.setAgentStatus(AGENT, 'idle');
      return get(name);
    };
    const out = await o.runJob(spec({ recorded, recoveryRequired: true }));
    expect(out.kind).toBe('quiet_pause');
    expect(journal.entries.get('job-1')?.state).toBe('settled');
  });

  it('an owner resume of an agent whose last turn is not recorded as settled is not prompted', async () => {
    for (const j of [journalWith(entry('dispatching')), new MemoryDispatchJournal()]) {
      const herdr = existing(agent('idle'));
      const out = await orch(herdr, j).runJob(spec({ recorded }));
      expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
      expect(herdr.countOf('agentPrompt')).toBe(0);
    }
    const herdr = existing(agent('idle'));
    await orch(herdr, journalWith(entry('settled'))).runJob(spec({ recorded }));
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });
});

describe('cancel and timeout read the journal, not memory', () => {
  const cancel = (herdr: MockHerdr, j: MemoryDispatchJournal) =>
    orch(herdr, j).cancel(spec({ recorded }));

  it('releases on a settled record and a positive idle look, after a restart', async () => {
    expect(await cancel(existing(agent('idle')), journalWith(entry('settled')))).toMatchObject({
      terminated: true, agentStatus: 'idle',
    });
  });

  it('REGRESSION: does not release on idle after a restart when the record says dispatching, is absent or is untrusted', async () => {
    const bad = new MemoryDispatchJournal();
    bad.untrusted = 'corrupt';
    for (const j of [journalWith(entry('dispatching')), new MemoryDispatchJournal(), bad]) {
      const out = await cancel(existing(agent('idle')), j);
      expect(out.terminated).toBe(false);
    }
  });

  it('does not call a vanished agent never-started when the journal says an agent existed', async () => {
    const out = await orch(new MockHerdr({ available: true, agents: [], workspaces: [] }), journalWith(entry('settled'))).cancel(spec());
    expect(out.terminated).toBe(false);
  });
});

describe('proveQuiet', () => {
  const target = { jobId: 'job-1', workspaceId: WS, agentName: AGENT };
  const prove = (herdr: MockHerdr, j: MemoryDispatchJournal) => orch(herdr, j).proveQuiet(target);

  it('is quiet only for a settled record, the recorded agent and workspace, and a fresh idle or done', async () => {
    expect(await prove(existing(agent('idle')), journalWith(entry('settled')))).toEqual({ quiet: true, observed: 'idle' });
    expect(await prove(existing(agent('done')), journalWith(entry('settled')))).toEqual({ quiet: true, observed: 'done' });
  });

  it('is not quiet for any other state, and never prompts', async () => {
    const settled = journalWith(entry('settled'));
    const cases: [string, MockHerdr, MemoryDispatchJournal][] = [
      ['working', existing(agent('working')), settled],
      ['blocked', existing(agent('blocked')), settled],
      ['unknown', existing(agent('unknown')), settled],
      ['absent', new MockHerdr({ available: true, agents: [], workspaces: [] }), settled],
      ['another workspace', existing(agent('idle', { workspace_id: 'wElsewhere' })), settled],
      ['not Ducky-managed', existing(agent('idle'), 'ducky'), settled],
      ['dispatching', existing(agent('idle')), journalWith(entry('dispatching'))],
      ['no record', existing(agent('idle')), new MemoryDispatchJournal()],
      ['other agent record', existing(agent('idle')), journalWith(entry('settled', { agentName: 'ducky-pi-x' }))],
    ];
    for (const [label, herdr, j] of cases) {
      const r = await prove(herdr, j);
      expect(r.quiet, label).toBe(false);
      expect(herdr.countOf('agentPrompt'), label).toBe(0);
    }
  });

  it('is not quiet when Herdr or the record cannot be read', async () => {
    const herdr = existing(agent('idle'));
    herdr.agentGet = async () => {
      throw new Error('socket gone');
    };
    expect((await prove(herdr, journalWith(entry('settled')))).quiet).toBe(false);
    const bad = new MemoryDispatchJournal();
    bad.untrusted = 'x';
    expect((await prove(existing(agent('idle')), bad)).quiet).toBe(false);
  });
});

describe('absence is never recorded as a settle', () => {
  it('an agent that vanishes while a recovery watches it leaves the dispatch unsettled, and a same-name agent that reappears is not trusted', async () => {
    const herdr = existing(agent('working'));
    const journal = journalWith(entry('dispatching'));
    const get = herdr.agentGet.bind(herdr);
    let n = 0;
    herdr.agentGet = async (name: string) => {
      n += 1;
      if (n > 2) herdr.state.agents = [];
      return get(name);
    };
    const first = await orch(herdr, journal).runJob(spec({ recorded, recoveryRequired: true }));
    // It vanished: not a pause, and nothing was recorded as settled.
    expect(first.kind).not.toBe('quiet_pause');
    expect(journal.entries.get('job-1')?.state).toBe('dispatching');
    expect(journal.writes.filter((w) => w.state === 'settled')).toEqual([]);

    // Later a fresh agent with the same name and workspace reads idle. It must not be
    // mistaken for the one that was handed the work.
    const later = existing(agent('idle'));
    const out = await orch(later, journal).runJob(spec({ leaseId: 'lease-2', recorded, recoveryRequired: true }));
    expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_prompt_unsettled' });
    expect(later.countOf('agentPrompt')).toBe(0);
    expect((await orch(later, journal).proveQuiet({ jobId: 'job-1', workspaceId: WS, agentName: AGENT })).quiet).toBe(false);
  });

  it('a stalled prompt whose agent then vanishes stays dispatching', async () => {
    const herdr = new MockHerdr();
    herdr.agentPrompt = async () => {
      throw new DuckyError('herdr_prompt_stalled', 'no change');
    };
    const journal = new MemoryDispatchJournal();
    const get = herdr.agentGet.bind(herdr);
    let calls = 0;
    herdr.agentGet = async (name: string) => {
      calls += 1;
      // Present for the ownership look and the readiness wait, gone once the stall is watched.
      if (calls > 3) herdr.state.agents = [];
      return get(name);
    };
    await orch(herdr, journal).runJob(spec()).catch(() => undefined);
    expect(journal.entries.get('job-1')?.state).toBe('dispatching');
  });
});
