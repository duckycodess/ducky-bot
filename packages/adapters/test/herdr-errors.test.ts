import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isDuckyError } from '@ducky/contracts';

/**
 * Failure classification, against RESPONSES RECORDED FROM THIS HOST.
 *
 * `herdr` reports a failure as exit-status 1 with a JSON envelope on STDERR
 * carrying a machine-stable `code`. Classifying on the human `message` instead
 * happens to work today only because "agent_not_found" also contains the words
 * "not found" -- a wording change would silently reclassify "no such agent" as
 * "Herdr is down", and those two have opposite consequences for a repository
 * reservation.
 */
let next: { code: number; stdout: string; stderr: string } = { code: 0, stdout: '', stderr: '' };

vi.mock('../src/process/run.js', () => ({
  runArgv: async () => next,
  subprocessInFlight: () => 0,
}));

const { HerdrCli } = await import('../src/herdr/herdr-cli.js');

/** Verbatim from `herdr agent get ducky-pi-nonexistent-xyz` on this host. */
const AGENT_NOT_FOUND_STDERR =
  '{"error":{"code":"agent_not_found","message":"agent target ducky-pi-nonexistent-xyz not found"},"id":"cli:agent:get"}';

const cli = () => new HerdrCli({});

describe('herdr failure classification', () => {
  beforeEach(() => {
    next = { code: 0, stdout: '', stderr: '' };
  });

  it('treats the recorded agent_not_found envelope as an absent agent, not an outage', async () => {
    next = { code: 1, stdout: '', stderr: AGENT_NOT_FOUND_STDERR };
    await expect(cli().agentGet('ducky-pi-nonexistent-xyz')).resolves.toBeUndefined();
  });

  it('classifies a not-found code even when the message says nothing recognisable', async () => {
    next = {
      code: 1,
      stdout: '',
      stderr: '{"error":{"code":"workspace_not_found","message":"gone"},"id":"cli:workspace:get"}',
    };
    await expect(cli().agentGet('whatever')).resolves.toBeUndefined();
  });

  it('does NOT call a stalled prompt an outage', async () => {
    next = {
      code: 1,
      stdout: '',
      stderr:
        '{"error":{"code":"agent_prompt_stalled","message":"no state change observed"},"id":"cli:agent:prompt"}',
    };
    const err = await cli()
      .agentPrompt('ducky-pi-demo', 'brief', 1_000)
      .catch((e: unknown) => e);
    expect(isDuckyError(err)).toBe(true);
    expect(isDuckyError(err) && err.code).toBe('herdr_prompt_stalled');
  });

  it('reports a genuine server error as an outage, and never leaks the raw message as the code', async () => {
    next = {
      code: 1,
      stdout: '',
      stderr: '{"error":{"code":"internal","message":"socket closed"},"id":"cli:agent:list"}',
    };
    const err = await cli().agentList().catch((e: unknown) => e);
    expect(isDuckyError(err) && err.code).toBe('herdr_unavailable');
    expect(isDuckyError(err) && err.ownerMessage).toContain('internal');
  });

  it('treats an exit-2 syntax error with no envelope as an outage', async () => {
    next = { code: 2, stdout: '', stderr: 'error: unexpected argument --nope' };
    const err = await cli().agentList().catch((e: unknown) => e);
    expect(isDuckyError(err) && err.code).toBe('herdr_unavailable');
  });

  it('still falls back to wording when no parseable envelope is present', async () => {
    next = { code: 1, stdout: '', stderr: 'no such agent' };
    await expect(cli().agentGet('x')).resolves.toBeUndefined();
  });

  it('an outage on agentGet is raised, never collapsed into "no such agent"', async () => {
    next = { code: 1, stdout: '', stderr: '{"error":{"code":"internal","message":"boom"}}' };
    await expect(cli().agentGet('x')).rejects.toThrow(/herdr_unavailable/);
  });

  it('a redacted secret in a failure message never reaches the error text', async () => {
    next = {
      code: 1,
      stdout: '',
      stderr: 'failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    };
    const err = await cli().agentList().catch((e: unknown) => e);
    expect(isDuckyError(err) && err.ownerMessage).not.toContain('ghp_abcdefghij');
    expect(isDuckyError(err) && err.ownerMessage).toContain('[REDACTED');
  });
});
