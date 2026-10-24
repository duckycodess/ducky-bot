import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuckyError, checkCommandAllowed } from '@ducky/contracts';
import { HerdrCli } from '../src/herdr/herdr-cli.js';
import { MockHerdr } from '../src/herdr/herdr.mock.js';
import type { AgentInfo } from '../src/herdr/herdr.types.js';
import { PaneProcessInfoResultSchema } from '../src/herdr/herdr.types.js';
import { MemoryBriefWriter } from '../src/pi/brief-file.js';
import { HerdrPiOrchestrator, agentNameFor, toSlugKey, workspaceLabelFor } from '../src/pi/pi-herdr.js';
import { exampleImplementedResult } from '../src/pi/pi.mock.js';
import type { OrchestrationSpec, PromptGuard } from '../src/pi/pi-orchestrator.port.js';
import { MemoryDispatchJournal } from '../src/pi/dispatch-journal.js';

/**
 * The pre-prompt guard: consulted before EVERY prompt attempt, and a refusal
 * means no model work is sent.
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

const orch = (herdr: MockHerdr, beforePrompt?: PromptGuard, result?: ReturnType<typeof exampleImplementedResult>) =>
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
    ...(beforePrompt ? { beforePrompt } : {}),
  });

const ownedIdle = (): AgentInfo => ({
  agent: 'pi', agent_status: 'idle', pane_id: `${WS}:p1`, workspace_id: WS, name: AGENT,
});
const existing = () =>
  new MockHerdr({
    available: true,
    agents: [ownedIdle()],
    workspaces: [{ workspace_id: WS, label: workspaceLabelFor(slugKey) }],
  });

describe('the pre-prompt guard', () => {
  it('is consulted with the freshly proven agent before the prompt, and the prompt follows a pass', async () => {
    const seen: unknown[] = [];
    const order: string[] = [];
    const herdr = new MockHerdr();
    const prompt = herdr.agentPrompt.bind(herdr);
    herdr.agentPrompt = async (...a) => {
      order.push('prompt');
      return prompt(...a);
    };
    const out = await orch(herdr, async (target, ctx) => {
      order.push('guard');
      seen.push(target, await ctx.proveAgent());
      return { ok: true };
    }, exampleImplementedResult()).runJob(spec());

    expect(out.kind).toBe('result');
    expect(order).toEqual(['guard', 'prompt']);
    expect(seen[0]).toMatchObject({ agentName: AGENT, paneId: expect.stringMatching(/:p1$/) });
    expect(seen[1]).toEqual(seen[0]);
  });

  it('withholds the prompt on a refusal and pauses once the agent is proven quiet', async () => {
    const herdr = new MockHerdr();
    const out = await orch(herdr, async () => ({ ok: false, reason: 'not enough room' })).runJob(spec());
    expect(out).toMatchObject({ kind: 'quiet_pause', cause: 'memory_headroom_unproven', observed: 'idle' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('treats a throwing guard as a refusal, never as a pass', async () => {
    const herdr = new MockHerdr();
    const out = await orch(herdr, async () => {
      throw new Error('boom');
    }).runJob(spec());
    expect(out.kind).toBe('quiet_pause');
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('keeps fail-closed ownership, not a pause, when quiet cannot be proven after a refusal', async () => {
    const unknown = new MockHerdr();
    const g = unknown.agentGet.bind(unknown);
    let armed = false;
    unknown.agentGet = async (t) => {
      const a = await g(t);
      return armed && a ? { ...a, agent_status: 'unknown' } : a;
    };
    const refused = await orch(unknown, async () => {
      armed = true;
      return { ok: false, reason: 'no room' };
    }).runJob(spec());
    expect(refused).toMatchObject({ kind: 'no_result' });
    expect(refused.kind === 'no_result' && refused.detail).toMatch(/withheld/);
    expect(unknown.countOf('agentPrompt')).toBe(0);
  });

  it('keeps the orphan outcome when a refused agent turns out to be working', async () => {
    const herdr = new MockHerdr();
    const get = herdr.agentGet.bind(herdr);
    let armed = false;
    herdr.agentGet = async (t) => {
      const a = await get(t);
      return armed && a ? { ...a, agent_status: 'working' } : a;
    };
    const out = await orch(herdr, async () => {
      armed = true;
      return { ok: false, reason: 'no room' };
    }).runJob(spec());
    expect(out).toMatchObject({ kind: 'orphan', reason: 'orphan_agent_still_working' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('is consulted again before EVERY retry after agent_not_ready, and can stop a retry', async () => {
    const herdr = new MockHerdr();
    let attempts = 0;
    herdr.agentPrompt = async () => {
      attempts += 1;
      throw new DuckyError('herdr_agent_not_ready', 'not yet');
    };
    let guards = 0;
    await expect(
      orch(herdr, async () => {
        guards += 1;
        return { ok: true };
      }).runJob(spec()),
    ).rejects.toThrow();
    expect(attempts).toBe(4); // the first attempt plus three bounded retries
    expect(guards).toBe(4); // one guard before each of them

    // The agent moves into a tighter place between the first attempt and its
    // retry: the retry is withheld rather than sent.
    const retry = new MockHerdr();
    let sent = 0;
    retry.agentPrompt = async () => {
      sent += 1;
      throw new DuckyError('herdr_agent_not_ready', 'not yet');
    };
    let n = 0;
    const out = await orch(retry, async () => {
      n += 1;
      return n === 1 ? { ok: true } : { ok: false, reason: 'moved into a tighter scope' };
    }).runJob(spec());
    expect(sent).toBe(1);
    expect(out).toMatchObject({ kind: 'quiet_pause', cause: 'memory_headroom_unproven' });
  });

  it('guards a resumed agent as well as a fresh one', async () => {
    const herdr = existing();
    const out = await orch(herdr, async () => ({ ok: false, reason: 'no room' })).runJob(spec({ recorded }));
    expect(out).toMatchObject({ kind: 'quiet_pause', cause: 'memory_headroom_unproven' });
    expect(herdr.countOf('agentPrompt')).toBe(0);
  });

  it('withholds when the agent cannot be positively identified at the boundary', async () => {
    const herdr = existing();
    const get = herdr.agentGet.bind(herdr);
    let calls = 0;
    herdr.agentGet = async (t) => {
      calls += 1;
      const a = await get(t);
      // identity is intact for the ownership proof and the readiness look, then lost
      return calls > 2 && a ? { ...a, workspace_id: 'wElsewhere' } : a;
    };
    let guarded = false;
    const out = await orch(herdr, async () => {
      guarded = true;
      return { ok: true };
    }).runJob(spec({ recorded }));
    expect(guarded).toBe(false);
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(out.kind).not.toBe('result');
  });

  /** An owned, idle agent whose status as seen from the Nth `agent get` onwards is `later`. */
  const flipsAfter = (n: number, later: Partial<AgentInfo>) => {
    const herdr = existing();
    const get = herdr.agentGet.bind(herdr);
    let calls = 0;
    herdr.agentGet = async (t) => {
      calls += 1;
      const a = await get(t);
      return calls >= n && a ? { ...a, ...later } : a;
    };
    return herdr;
  };

  it('never consults the guard, and never prompts, a working or blocked target', async () => {
    // The readiness wait returns early on a working agent; the prompt must not follow.
    for (const [status, reason] of [
      ['working', 'orphan_agent_still_working'],
      ['blocked', 'orphan_agent_blocked'],
    ] as const) {
      const herdr = flipsAfter(2, { agent_status: status });
      let guarded = false;
      const out = await orch(herdr, async () => {
        guarded = true;
        return { ok: true };
      }).runJob(spec({ recorded }));
      expect(guarded, status).toBe(false);
      expect(herdr.countOf('agentPrompt'), status).toBe(0);
      expect(out, status).toMatchObject({ kind: 'orphan', reason });
    }
  });

  it('never consults the guard for an unknown-status or not-ready target, and says it withheld', async () => {
    const unknown = flipsAfter(2, { agent_status: 'unknown' });
    let guarded = false;
    const out = await orch(unknown, async () => {
      guarded = true;
      return { ok: true };
    }).runJob(spec({ recorded }));
    expect(guarded).toBe(false);
    expect(unknown.countOf('agentPrompt')).toBe(0);
    expect(out.kind === 'no_result' && out.detail).toMatch(/withheld/);

    const notReady = flipsAfter(1, { interactive_ready: false });
    const out2 = await orch(notReady, async () => {
      guarded = true;
      return { ok: true };
    }).runJob(spec({ recorded }));
    expect(guarded).toBe(false);
    expect(notReady.countOf('agentPrompt')).toBe(0);
    expect(out2).toMatchObject({ kind: 'quiet_pause', cause: 'memory_headroom_unproven' });
  });

  it('gives the guard a re-proof that fails once the agent stops being quiet', async () => {
    const herdr = existing();
    let after: unknown = 'unset';
    await orch(herdr, async (_t, ctx) => {
      herdr.setAgentStatus(AGENT, 'working');
      after = await ctx.proveAgent();
      return { ok: true };
    }).runJob(spec({ recorded })).catch(() => undefined);
    expect(after).toBeUndefined();
  });

  it('pins a fresh start to the root pane it started the agent in', async () => {
    const herdr = new MockHerdr();
    const start = herdr.agentStart.bind(herdr);
    herdr.agentStart = async (...a) => {
      const info = await start(...a);
      // A same-name agent now answers from a different pane.
      herdr.state.agents[0]!.pane_id = 'wElse:p9';
      return info;
    };
    let guarded = false;
    const out = await orch(herdr, async () => {
      guarded = true;
      return { ok: true };
    }).runJob(spec());
    expect(guarded).toBe(false);
    expect(herdr.countOf('agentPrompt')).toBe(0);
    expect(out.kind).toBe('no_result');
  });

  it('pins a resume to the pane of the owned agent it first observed, even if the name moves', async () => {
    const before = flipsAfter(2, { pane_id: `${WS}:p2` });
    let guarded = false;
    const out = await orch(before, async () => {
      guarded = true;
      return { ok: true };
    }).runJob(spec({ recorded }));
    expect(guarded).toBe(false);
    expect(before.countOf('agentPrompt')).toBe(0);
    expect(out.kind).toBe('no_result');

    // Replaced DURING the guard's own reads: the re-proof sees a different pane.
    const during = existing();
    let reproof: unknown = 'unset';
    await orch(during, async (_t, ctx) => {
      during.state.agents[0]!.pane_id = `${WS}:p2`;
      reproof = await ctx.proveAgent();
      return { ok: true };
    }).runJob(spec({ recorded })).catch(() => undefined);
    expect(reproof).toBeUndefined();
  });

  it('changes nothing when no guard is configured', async () => {
    const herdr = new MockHerdr();
    expect((await orch(herdr, undefined, exampleImplementedResult()).runJob(spec())).kind).toBe('result');
    expect(herdr.countOf('agentPrompt')).toBe(1);
  });
});

describe('pane process info at the Herdr boundary', () => {
  // The shape recorded read-only from a manager role pane (a wrapper and an
  // agent in one foreground group). Interface evidence only, not a Pi probe.
  const RECORDED = {
    process_info: {
      foreground_process_group_id: 3813064,
      foreground_processes: [
        { argv: ['python3', '/some/path --token=SECRET'], argv0: 'python3', cmdline: 'python3 SECRET', cwd: '/home/x', name: 'python3', pid: 3813064 },
        { argv: ['claude', '--dangerous'], argv0: 'claude', cmdline: 'claude SECRET', cwd: '/home/x', name: 'claude', pid: 3813065 },
      ],
      pane_id: 'wB:p2',
      shell_pid: 3811095,
      tty: '/dev/pts/9',
    },
    type: 'pane_process_info',
  };

  it('keeps only pids and names; argv, cmdline, cwd and tty are dropped by the schema', () => {
    const parsed = PaneProcessInfoResultSchema.parse(RECORDED).process_info;
    expect(parsed.foreground_processes.map((p) => p.pid)).toEqual([3813064, 3813065]);
    const text = JSON.stringify(parsed);
    for (const leaked of ['SECRET', 'argv', 'cmdline', 'cwd', '/home/x', 'tty', '--dangerous']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('rejects a malformed record instead of reading it as no processes', () => {
    for (const bad of [
      { process_info: { pane_id: 'p', foreground_processes: [{ pid: -1 }] } },
      { process_info: { pane_id: 'p', foreground_processes: [{ pid: 1.5 }] } },
      { process_info: { foreground_processes: [] } },
      {},
    ]) {
      expect(PaneProcessInfoResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('is classified read-only by the central policy', () => {
    expect(checkCommandAllowed('herdr', ['pane', 'process-info', '--pane', 'wA:p1'])).toBeUndefined();
  });

  function fakeHerdr(script: string): HerdrCli {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-procinfo-'));
    const bin = path.join(dir, 'herdr');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    chmodSync(bin, 0o700);
    return new HerdrCli({ bin });
  }

  it('builds the exact read-only argv, passes a pane id only of Herdr shape, and strips the answer', async () => {
    const seen: string[][] = [];
    const bin = path.join(mkdtempSync(path.join(os.tmpdir(), 'ducky-procinfo-')), 'herdr');
    writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify({ id: 'x', result: RECORDED })}'\n`, { mode: 0o700 });
    chmodSync(bin, 0o700);
    const cli = new HerdrCli({ bin, onInvoke: (argv) => seen.push([...argv]) });

    const info = await cli.paneProcessInfo('wB:p2');
    expect(seen).toEqual([['pane', 'process-info', '--pane', 'wB:p2']]);
    expect(JSON.stringify(info)).not.toContain('SECRET');

    for (const bad of ['--current', '-x', '', 'a b', 'a;b', 'x'.repeat(65)]) {
      await expect(cli.paneProcessInfo(bad), bad).rejects.toBeInstanceOf(DuckyError);
    }
    expect(seen).toHaveLength(1);
  });

  it('answers undefined for an absent pane but throws for an outage or an unreadable body', async () => {
    const missing = fakeHerdr(
      `echo '{"error":{"code":"pane_not_found","message":"gone"},"id":"cli:pane:process_info"}' >&2; exit 1`,
    );
    await expect(missing.paneProcessInfo('wB:p9')).resolves.toBeUndefined();

    const down = fakeHerdr('echo nope >&2; exit 1');
    await expect(down.paneProcessInfo('wB:p2')).rejects.toMatchObject({ code: 'herdr_unavailable' });

    const garbage = fakeHerdr(`echo '{"id":"x","result":{"process_info":{"nope":1}}}'`);
    await expect(garbage.paneProcessInfo('wB:p2')).rejects.toMatchObject({ code: 'herdr_unavailable' });
  });
});
