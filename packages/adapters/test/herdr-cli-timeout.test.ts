import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HERDR_TIMEOUT_MS, JOB_MAX_WALL_CLOCK_MS } from '@ducky/contracts';

/**
 * The subprocess budget is invisible to every other test in this repository,
 * because `MockHerdrClient` records the timeout it was handed and never spawns
 * anything. That is exactly how a 30-second cap on a two-hour Pi turn survived:
 * the argv said `--timeout 7200000`, the child process was killed at 30s, the
 * caller read `herdr_unavailable`, and the repository was released while a real
 * agent was still writing to it.
 *
 * So this suite asserts on the OPTIONS `runArgv` actually received.
 */
const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];

vi.mock('../src/process/run.js', () => ({
  runArgv: async (command: string, args: readonly string[], options: { timeoutMs: number }) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    if (args[0] === 'agent' && args[1] === 'prompt') {
      return { code: 0, stdout: JSON.stringify({ id: 'x', result: { type: 'agent_prompted', agent: agentRecord } }), stderr: '' };
    }
    if (args[0] === 'agent' && args[1] === 'start') {
      return { code: 0, stdout: JSON.stringify({ id: 'x', result: { type: 'agent_started', agent: agentRecord, argv: ['pi'] } }), stderr: '' };
    }
    return { code: 0, stdout: JSON.stringify({ id: 'x', result: { type: 'agent_list', agents: [] } }), stderr: '' };
  },
  subprocessInFlight: () => 0,
}));

const agentRecord = {
  agent: 'pi',
  agent_status: 'idle',
  pane_id: 'wZ:p1',
  workspace_id: 'wZ',
  name: 'ducky-pi-demo',
};

const { HerdrCli } = await import('../src/herdr/herdr-cli.js');

const promptCall = () => calls.find((c) => c.args[1] === 'prompt');
const startCall = () => calls.find((c) => c.args[1] === 'start');

describe('herdr subprocess budgets', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('gives a blocking prompt a subprocess budget LONGER than the wait it hosts', async () => {
    const cli = new HerdrCli({ promptGraceMs: 30_000 });
    await cli.agentPrompt('ducky-pi-demo', 'brief', JOB_MAX_WALL_CLOCK_MS);

    const call = promptCall();
    expect(call).toBeDefined();
    // The regression: this used to be HERDR_TIMEOUT_MS regardless of the wait.
    expect(call!.timeoutMs).toBeGreaterThan(JOB_MAX_WALL_CLOCK_MS);
    expect(call!.timeoutMs).toBe(JOB_MAX_WALL_CLOCK_MS + 30_000);
    expect(call!.timeoutMs).not.toBe(HERDR_TIMEOUT_MS);
  });

  it('passes the same wait to herdr itself, so the two cannot drift apart', async () => {
    const cli = new HerdrCli({ promptGraceMs: 1_000 });
    await cli.agentPrompt('ducky-pi-demo', 'brief', 600_000);

    const call = promptCall()!;
    const flagIndex = call.args.indexOf('--timeout');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(call.args[flagIndex + 1]).toBe('600000');
    expect(call.timeoutMs).toBeGreaterThan(Number(call.args[flagIndex + 1]));
  });

  it('sends an explicit readiness timeout to agent start rather than inheriting herdr default', async () => {
    const cli = new HerdrCli({ startTimeoutMs: 90_000, promptGraceMs: 5_000 });
    await cli.agentStart('ducky-pi-demo', 'pi', 'wZ:p1', ['--thinking', 'high']);

    const call = startCall()!;
    const flagIndex = call.args.indexOf('--timeout');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(call.args[flagIndex + 1]).toBe('90000');
    expect(call.timeoutMs).toBe(95_000);
    // Native agent args stay behind the `--` separator.
    expect(call.args.slice(call.args.indexOf('--'))).toEqual(['--', '--thinking', 'high']);
  });

  it('leaves ordinary non-blocking commands on the default budget', async () => {
    const cli = new HerdrCli({});
    await cli.agentList();
    expect(calls[0]!.timeoutMs).toBe(HERDR_TIMEOUT_MS);
  });

  it('returns the settled agent from a prompt so blocked is distinguishable', async () => {
    const cli = new HerdrCli({});
    const settled = await cli.agentPrompt('ducky-pi-demo', 'brief', 1_000);
    expect(settled?.agent_status).toBe('idle');
    expect(settled?.name).toBe('ducky-pi-demo');
  });
});
