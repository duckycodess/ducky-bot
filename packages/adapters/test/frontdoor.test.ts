import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkCommandAllowed, type TicketSpec } from '@ducky/contracts';
import { FRONTDOOR_POLICY_BIN, FrontDoorCli } from '../src/frontdoor/frontdoor.cli.js';
import { DisabledFrontDoor } from '../src/frontdoor/frontdoor.disabled.js';
import type { RunOptions, RunResult } from '../src/process/run.js';

/** The installed helper is never spawned here: every run is recorded instead. */
const recorder = (answers: string[] | string, code = 0) => {
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  const calls: { command: string; argv: readonly string[]; options: RunOptions }[] = [];
  const run = async (
    command: string,
    argv: readonly string[],
    options: RunOptions,
  ): Promise<RunResult> => {
    calls.push({ command, argv, options });
    // The LAST answer repeats, so a test with several calls does not have to
    // script each one.
    const stdout = queue.length > 1 ? queue.shift()! : (queue[0] ?? '');
    return { code, stdout, stderr: 'secret stderr' };
  };
  return { calls, run };
};

const spec = (): TicketSpec => ({
  schema: 'ticket-spec/v1',
  id: '49f0f610-a0a3-4d47-b6f0-11884bdd6f68',
  repository: 'acme/demo',
  title: 'A title',
  goal: 'A goal',
  context: [],
  scope: ['s'],
  non_goals: [],
  acceptance_criteria: ['a'],
  constraints: [],
  dependencies: [],
  references: [],
  verification: ['v'],
  risks: [],
  open_questions: [],
  source: { mode: 'conversation', summary: 'owner', decisions: [] },
});

/** This file IS an installed absolute path that exists, which is all the adapter checks. */
const PROGRAM = new URL(import.meta.url).pathname;

describe('the front-door adapter spawns through the policy', () => {
  it('classifies every operation it can construct', () => {
    expect(checkCommandAllowed(FRONTDOOR_POLICY_BIN, ['inspect', '.'])).toBeUndefined();
    expect(checkCommandAllowed(FRONTDOOR_POLICY_BIN, ['validate', '--spec', '/tmp/x'])).toBeUndefined();
    // Publication and onboarding are external mutations, so the default
    // local-only ceiling refuses them.
    expect(checkCommandAllowed(FRONTDOOR_POLICY_BIN, ['ticket', '--spec', '/tmp/x'])?.reason)
      .toBe('class_not_allowed');
    expect(
      checkCommandAllowed(FRONTDOOR_POLICY_BIN, ['ticket', '--spec', '/tmp/x'], 'external_mutation'),
    ).toBeUndefined();
    // And an operation that is not in the table is refused outright.
    expect(checkCommandAllowed(FRONTDOOR_POLICY_BIN, ['new', 'thing'])?.reason).toBe('unclassified');
  });

  it('builds an argv array with no shell and a mandatory timeout', async () => {
    const { calls, run } = recorder('{"root":"/tmp/demo","repository":"acme/demo"}');
    const cli = new FrontDoorCli({ program: PROGRAM, interpreter: 'python3', run });

    await cli.inspect({ path: '/tmp/demo', repository: 'acme/demo', network: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('python3');
    expect(calls[0]!.argv).toEqual([
      PROGRAM, 'inspect', '/tmp/demo', '--repository', 'acme/demo', '--network',
    ]);
    expect(calls[0]!.options.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]!.options.maxBuffer).toBeGreaterThan(0);
  });

  it('reads only the narrow fields a card needs, and keeps the root internal', async () => {
    const { run } = recorder(
      JSON.stringify({
        root: '/home/someone/projects/demo',
        repository: 'acme/demo',
        dirty: true,
        signals: ['AGENTS.md', 'package.json'],
        active_jobs: [{ worktree: '/x' }],
        registration: { enabled: true, path: '/home/someone/projects/demo' },
        workflow: { version: 1 },
        beads: true,
      }),
    );
    const found = await new FrontDoorCli({ program: PROGRAM, run }).inspect({ path: '.' });

    expect(found).toMatchObject({
      repository: 'acme/demo',
      dirty: true,
      registered: true,
      registrationEnabled: true,
      activeJobs: 1,
      signalCount: 2,
      hasWorkflowContract: true,
      beads: true,
    });
    // The signal LIST never crosses the boundary -- only its size.
    expect(JSON.stringify(found)).not.toContain('AGENTS.md');
  });
});

describe('external mutation is separately opted in', () => {
  it('refuses to publish when mutation is not enabled, and spawns nothing', async () => {
    const { calls, run } = recorder('{"ok":true}');
    const cli = new FrontDoorCli({ program: PROGRAM, run });

    await expect(cli.publish({ spec: spec(), ready: false })).rejects.toThrow(/not enabled/i);
    await expect(cli.agentize({ path: '.' })).rejects.toThrow(/not enabled/i);
    expect(calls).toHaveLength(0);
    expect(cli.availability().mutationEnabled).toBe(false);
  });

  it('passes --ready only when it is asked for', async () => {
    const { calls, run } = recorder('{"ok":true,"queued":false,"issue":7}');
    const cli = new FrontDoorCli({ program: PROGRAM, run, mutationEnabled: true });

    await cli.publish({ spec: spec(), ready: false, path: '/tmp/demo' });
    expect(calls[0]!.argv).not.toContain('--ready');

    await cli.publish({ spec: spec(), ready: true, path: '/tmp/demo' });
    expect(calls[1]!.argv).toContain('--ready');
  });

  it('refuses an agent:* label, which is the dispatcher\'s own namespace', async () => {
    const { run } = recorder('{"ok":true}');
    const cli = new FrontDoorCli({ program: PROGRAM, run, mutationEnabled: true });
    await expect(
      cli.publish({ spec: spec(), ready: false, labels: ['agent:ready'] }),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      cli.publish({ spec: spec(), ready: false, labels: ['enhancement; rm -rf'] }),
    ).rejects.toThrow(/not allowed/i);
  });

  it('refuses a repository that is not owner/name', async () => {
    const { run } = recorder('{"ok":true}');
    const cli = new FrontDoorCli({ program: PROGRAM, run, mutationEnabled: true });
    await expect(cli.agentize({ repository: '../etc/passwd' })).rejects.toThrow(/owner\/name/i);
  });
});

describe('nothing raw escapes the adapter', () => {
  it('writes the spec to a private temp file and removes it afterwards', async () => {
    let seenSpecPath = '';
    let contents = '';
    const run = async (_c: string, argv: readonly string[]): Promise<RunResult> => {
      const i = argv.indexOf('--spec');
      seenSpecPath = argv[i + 1]!;
      contents = readFileSync(seenSpecPath, 'utf8');
      return { code: 0, stdout: '{"ok":true,"id":"x"}', stderr: '' };
    };
    const cli = new FrontDoorCli({ program: PROGRAM, run });

    await cli.validate(spec());
    expect(JSON.parse(contents).id).toBe(spec().id);
    expect(existsSync(seenSpecPath)).toBe(false);
  });

  it('keeps a structured failure and never surfaces stderr', async () => {
    const { run } = recorder('{"ok":false,"queued":false,"started":false,"error":"Repository is not enabled"}', 1);
    const cli = new FrontDoorCli({ program: PROGRAM, run, mutationEnabled: true });

    const published = await cli.publish({ spec: spec(), ready: true });
    expect(published.ok).toBe(false);
    expect(published.queued).toBe(false);
    expect(published.started).toBe(false);
    expect(published.error).toBe('Repository is not enabled');
    expect(JSON.stringify(published)).not.toContain('secret stderr');
  });

  it('refuses output it cannot parse, without quoting it', async () => {
    const { run } = recorder('Traceback: /home/someone/.local/share/agent-flow/workflow.py line 1', 1);
    const cli = new FrontDoorCli({ program: PROGRAM, run });
    await expect(cli.inspect({ path: '.' })).rejects.toThrow(/shape Ducky does not recognise/);
    await expect(cli.inspect({ path: '.' })).rejects.not.toThrow(/agent-flow/);
  });

  it('refuses empty output rather than reporting success', async () => {
    const { run } = recorder('', 1);
    const cli = new FrontDoorCli({ program: PROGRAM, run });
    await expect(cli.inspect({ path: '.' })).rejects.toThrow(/before it could report a reason/);
  });
});

describe('an unconfigured instance cannot reach the workflow at all', () => {
  it('refuses every method and says so once', async () => {
    const door = new DisabledFrontDoor();
    expect(door.availability().usable).toBe(false);
    expect(door.availability().mutationEnabled).toBe(false);
    await expect(door.inspect()).rejects.toThrow(/not enabled/i);
    await expect(door.validate()).rejects.toThrow(/not enabled/i);
    await expect(door.publish()).rejects.toThrow(/not enabled/i);
    await expect(door.agentize()).rejects.toThrow(/not enabled/i);
  });

  it('reports a missing or relative program rather than spawning one', () => {
    expect(new FrontDoorCli({ program: '' }).availability().reason).toBe('not_configured');
    expect(new FrontDoorCli({ program: 'workflow.py' }).availability().reason).toBe('not_configured');
    expect(new FrontDoorCli({ program: '/nope/workflow.py' }).availability().reason)
      .toBe('missing_program');
  });
});
