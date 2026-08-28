import { describe, expect, it } from 'vitest';
import { DuckyError } from '@ducky/contracts';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey } from '../src/pi/pi-herdr.js';
import { observePiPromptReady } from '../src/pi/pi-ready.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';
import { exampleImplementedResult } from '../src/pi/pi.mock.js';
import type { ResultReader } from '../src/pi/result-file.js';
import type { OrchestrationSpec } from '../src/pi/pi-orchestrator.port.js';

/**
 * The readiness observation, and the orchestrator behaviour built on it.
 *
 * The snapshots below reproduce the STRUCTURE recorded from live
 * `herdr agent read --source detection --format text` on this host (herdr
 * 0.8.0, pi 0.83.0): a box-rule input frame, and -- on an agent that has done
 * some work -- a status footer carrying the transfer counters. Pane text itself
 * is data, not contract, so none is copied here.
 *
 * The footer is NOT required, and that correction came from the probe rather
 * than from reasoning: see `readiness-evidence.test.ts` and the comment at the
 * top of `pi-ready.ts`. A freshly started Pi has no counters to show.
 */
const RULE = '─'.repeat(80);

const readyPane = [
  '  Some earlier output from the turn',
  RULE,
  '',
  RULE,
  '',
  RULE,
  '~/repos/demo (main)',
  '↑857k ↓60k R21M CH99.6% $0.747 (sub) ?/272k (auto)',
  '🔌 MCP: 1 server enabled think:max',
].join('\n');

/** What the stall bug actually looks like: banners, no interactive chrome. */
const bannerPane = [
  'π 0.83.0',
  '',
  'A new version of pi is available (0.84.0). Run `pi update`.',
  'note: 3 packages are looking for funding',
  '',
  'Loading session …',
].join('\n');

describe('observing whether Pi can take a prompt', () => {
  it('accepts a pane showing the interactive frame and status footer', () => {
    const o = observePiPromptReady(readyPane);
    expect(o.ready).toBe(true);
    expect(o.reason).toBe('ready');
    expect(o.ruleLines).toBeGreaterThanOrEqual(2);
  });

  it('refuses a pane that is still printing banners', () => {
    const o = observePiPromptReady(bannerPane);
    expect(o.ready).toBe(false);
    expect(o.reason).toBe('no_input_frame');
  });

  it('refuses an empty or unavailable snapshot rather than assuming the best', () => {
    expect(observePiPromptReady('').reason).toBe('empty');
    expect(observePiPromptReady('   \n  \n').reason).toBe('empty');
  });

  it('accepts a frame with no status footer, because a fresh agent has none', () => {
    // The correction the probe forced. Requiring the footer refused every
    // freshly started agent -- which is the only kind readiness ever waits on.
    const fresh = [RULE, '', RULE, '', RULE, '~/repos/demo (main)'].join('\n');
    const o = observePiPromptReady(fresh);
    expect(o.ready).toBe(true);
    expect(o.hasStatusFooter).toBe(false);
  });

  it('does not mistake a transfer arrow inside earlier output for the footer', () => {
    // The footer is corroboration only, but it should still be recorded
    // accurately: it sits at the BOTTOM, below the frame.
    const arrowInBody = [
      '↑ this line is part of the turn output',
      'more output',
      'more output',
      'more output',
      'more output',
      'more output',
      RULE,
      RULE,
    ].join('\n');
    expect(observePiPromptReady(arrowInBody).hasStatusFooter).toBe(false);
  });

  it('needs more than one rule line, so a single separator is not a frame', () => {
    expect(observePiPromptReady([RULE, 'some output'].join('\n')).ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const SLUG = 'demo-repo';
const slugKey = toSlugKey(SLUG);
const AGENT = agentNameFor(slugKey);
const WS = 'wDemo';

const spec = (over: Partial<OrchestrationSpec> = {}): OrchestrationSpec => ({
  jobId: 'job-1',
  publicId: 'jabcde',
  repoSlug: SLUG,
  slugKey,
  mode: 'direct',
  repoPath: '/repos/demo',
  branch: 'main',
  base: 'HEAD',
  brief: 'do the thing',
  recoveryRequired: false,
  promptTimeoutMs: 500,
  recoveryWaitMs: 20,
  ...over,
});

const reader = (): ResultReader => ({ read: async () => exampleImplementedResult() });

const idleAgent = (): AgentInfo => ({
  agent: 'pi',
  agent_status: 'idle',
  pane_id: `${WS}:p1`,
  workspace_id: WS,
  name: AGENT,
  cwd: '/repos/demo',
  interactive_ready: true,
});

const shortSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(1, ms)));

function orchestrator(herdr: MockHerdr, over: { readyMarkerWaitMs?: number } = {}) {
  return new HerdrPiOrchestrator({
    herdr,
    briefWriter: new MemoryBriefWriter(),
    resultReader: reader(),
    sleep: shortSleep,
    pollIntervalMs: 2,
    stallPickupMs: 20,
    readyWaitMs: 200,
    readyMarkerWaitMs: over.readyMarkerWaitMs ?? 120,
  });
}

/**
 * A workspace already recorded for this job, so `run` reuses the agent rather
 * than creating layout -- the readiness path is what these exercise.
 */
const recorded = { workspaceId: WS, agentName: AGENT, workspacePath: '/repos/demo' };

describe('the orchestrator waits for the pane, not for the clock', () => {
  it('prompts as soon as the pane shows the frame twice', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [idleAgent()],
      workspaces: [{ workspace_id: WS, label: `ducky-mgd:${slugKey}` }],
    });
    herdr.readSnapshots = [readyPane, readyPane];

    const out = await orchestrator(herdr).runJob(spec({ recorded }));

    expect(out.kind).toBe('result');
    // Twice, not once: the frame paints progressively, so one glimpse of it can
    // be a half-drawn UI.
    expect(herdr.countOf('agentRead')).toBe(2);
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('keeps looking while the pane is still painting banners, then prompts once', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [idleAgent()],
      workspaces: [{ workspace_id: WS, label: `ducky-mgd:${slugKey}` }],
    });
    // Herdr says ready throughout -- that is exactly the live bug. The pane is
    // the thing that changes its mind.
    herdr.readSnapshots = [bannerPane, bannerPane, readyPane, readyPane];

    const out = await orchestrator(herdr).runJob(spec({ recorded }));

    expect(out.kind).toBe('result');
    expect(herdr.countOf('agentRead')).toBe(4);
    // The whole point: ONE prompt. A second would be a second writer.
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('falls back to herdr’s own signal when the marker never appears', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [idleAgent()],
      workspaces: [{ workspace_id: WS, label: `ducky-mgd:${slugKey}` }],
    });
    // Never ready, forever. The job must still run: a Pi whose chrome we no
    // longer recognise is no worse off than before this existed.
    herdr.readSnapshotDefault = bannerPane;

    const out = await orchestrator(herdr, { readyMarkerWaitMs: 20 }).runJob(spec({ recorded }));

    expect(out.kind).toBe('result');
    expect(herdr.countOf('agentRead')).toBeGreaterThan(0);
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('treats an empty snapshot as an observation it could not make', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [idleAgent()],
      workspaces: [{ workspace_id: WS, label: `ducky-mgd:${slugKey}` }],
    });
    // The default: nothing scripted, so the pane answers nothing. That is the
    // absence of an observation, not evidence of banners, and it must not spend
    // the whole marker budget.
    const started = Date.now();
    const out = await orchestrator(herdr, { readyMarkerWaitMs: 60_000 }).runJob(spec({ recorded }));

    expect(out.kind).toBe('result');
    expect(herdr.countOf('agentPrompt')).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('treats an unreadable pane as an observation it could not make', async () => {
    const herdr = new MockHerdr({
      available: true,
      agents: [idleAgent()],
      workspaces: [{ workspace_id: WS, label: `ducky-mgd:${slugKey}` }],
    });
    // An older Herdr, a refused command, a dead socket. Reading the pane is
    // never a dependency of running a job.
    herdr.agentRead = async () => {
      throw new DuckyError('herdr_unavailable', 'no such command');
    };

    const out = await orchestrator(herdr).runJob(spec({ recorded }));

    expect(out.kind).toBe('result');
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });

  it('does not read the pane at all for an agent that is already working', async () => {
    const busy = { ...idleAgent(), agent_status: 'working' as const };
    const herdr = new MockHerdr({
      available: true,
      agents: [busy],
      workspaces: [{ workspace_id: WS, label: `ducky-mgd:${slugKey}` }],
    });
    herdr.readSnapshots = [readyPane];

    // A working agent is an orphan decision, not a readiness one: nothing is
    // prompted and no snapshot is needed to know that.
    const out = await orchestrator(herdr).runJob(spec({ recorded, recoveryRequired: true }));

    expect(out.kind).toBe('orphan');
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(herdr.countOf('agentRead')).toBe(0);
  });
});
