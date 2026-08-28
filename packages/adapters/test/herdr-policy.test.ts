import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommandAllowed, isDuckyError } from '@ducky/contracts';
import { HerdrCli } from '../src/herdr/herdr-cli.js';

/**
 * The herdr surface, checked against the central command policy.
 *
 * `gh` and the executor's `git` helper have consulted the policy since it
 * existed; the herdr adapter did not, so three of its operations were never
 * classified at all and the documented "every gh, git and herdr operation is
 * classified" was true of two binaries out of three.
 *
 * These tests are deliberately about ARGV CONSTRUCTION rather than responses:
 * the stand-in binary answers nonsense on purpose, so a method may well fail to
 * parse. What matters is that it got PAST the policy gate (which runs before
 * anything is spawned) and that the argv it built is classified.
 */
function fakeHerdr(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-policyherdr-'));
  const bin = path.join(dir, 'herdr');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
}

interface Attempt {
  readonly name: string;
  readonly argv: readonly string[] | undefined;
  readonly refusal: boolean;
}

async function attempt(
  name: string,
  run: (cli: HerdrCli, record: (argv: readonly string[]) => void) => Promise<unknown>,
): Promise<Attempt> {
  let seen: readonly string[] | undefined;
  const cli = new HerdrCli({
    bin: fakeHerdr(`echo '{"id":"x","result":{}}'`),
    onInvoke: (argv) => {
      seen = argv;
    },
    timeoutMs: 5_000,
    startTimeoutMs: 100,
    promptGraceMs: 100,
  });
  let refusal = false;
  try {
    await run(cli, () => undefined);
  } catch (err) {
    refusal = isDuckyError(err) && err.code === 'not_enabled_in_phase1';
  }
  return { name, argv: seen, refusal };
}

describe('every herdr invocation is classified and enforced', () => {
  it('lets through exactly the operations the orchestrator actually uses', async () => {
    const attempts = await Promise.all([
      attempt('agentList', (c) => c.agentList()),
      attempt('agentGet', (c) => c.agentGet('ducky-pi-demo')),
      attempt('agentStart', (c) =>
        c.agentStart('ducky-pi-demo', 'pi', 'pane-1', ['--session-id', 'ducky-demo', '--thinking', 'medium']),
      ),
      attempt('agentPrompt', (c) => c.agentPrompt('ducky-pi-demo', 'read .ducky/brief.md and start', 500)),
      attempt('workspaceList', (c) => c.workspaceList()),
      attempt('workspaceCreate', (c) => c.workspaceCreate('/repos/demo', 'ducky-mgd:demo')),
      attempt('workspaceReportMetadata', (c) => c.workspaceReportMetadata('ws-1', { job: 'jabcde' })),
      attempt('workspaceClose', (c) => c.workspaceClose('ws-1')),
      attempt('paneSplit', (c) => c.paneSplit('pane-1', '/repos/demo')),
      attempt('worktreeCreate', (c) =>
        c.worktreeCreate({ cwd: '/repos/demo', branch: 'ducky/job-1', base: 'HEAD', label: 'ducky-mgd:demo' }),
      ),
      attempt('worktreeRemove', (c) => c.worktreeRemove('ws-1')),
    ]);

    for (const a of attempts) {
      expect(a.refusal, `${a.name} was refused by the command policy`).toBe(false);
      // It reached the subprocess, which is only reachable past the gate.
      expect(a.argv, `${a.name} never built an argv`).toBeDefined();
      expect(
        checkCommandAllowed('herdr', a.argv!),
        `${a.name}: ${a.argv!.join(' ')}`,
      ).toBeUndefined();
    }
  });

  it('refuses a forced worktree removal before it spawns anything', async () => {
    const a = await attempt('worktreeRemove --force', (c) =>
      c.worktreeRemove('ws-1', { force: true }),
    );
    expect(a.refusal).toBe(true);
    // The gate runs BEFORE onInvoke, so nothing was ever handed to a child.
    expect(a.argv).toBeUndefined();
  });

  it('refuses an unclassified herdr operation rather than defaulting to allowed', () => {
    // Nothing constructs these today; the point is that adding a method which
    // did would trip the gate instead of shipping.
    expect(checkCommandAllowed('herdr', ['pane', 'send-keys', 'pane-1', 'C-c'])?.reason).toBe(
      'unclassified',
    );
    expect(checkCommandAllowed('herdr', ['server', 'stop'])?.reason).toBe('unclassified');
    expect(checkCommandAllowed('herdr', ['session', 'attach', 'ducky'])?.reason).toBe('unclassified');
  });
});
