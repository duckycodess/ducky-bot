import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_POLICY, OWNER_ONLY_COMMANDS, SHARED_READABLE_ROUTES } from '@ducky/contracts';
import { isSafeLinkUrl, sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { toDiscordPayload } from '../src/discord/payload.js';
import { loadEnv, resolveSkillBridge } from '../src/config.js';
import { makeHarness, OWNER } from './helpers.js';

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8');

/**
 * The source with its comments removed.
 *
 * These assertions are about what the CODE can reach, and a doc comment that
 * explains why something is absent would otherwise trip the very test that
 * keeps it absent.
 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('the bridge has no second path to GitHub', () => {
  it('names no gh surface, no issue API and no label API', () => {
    for (const file of ['domain/skill-bridge.service.ts', 'discord/agent-presenters.ts']) {
      const src = code(file);
      for (const forbidden of [
        'GhCliReader', 'gh-cli', 'api.github.com', 'issues/', '--add-label', 'gh issue',
      ]) {
        expect(src, `${file} names ${forbidden}`).not.toContain(forbidden);
      }
      // ...and it never spawns anything itself. Every subprocess goes through
      // the front-door adapter, which goes through runArgv.
      expect(src).not.toContain('runArgv');
      expect(src).not.toContain('execFile');
    }
  });

  it('cannot reach the Ducky job path, so it cannot start a competing runner', () => {
    const src = code('domain/skill-bridge.service.ts');
    expect(src).not.toContain('JobsService');
    expect(src).not.toContain('jobs.submit');
  });

  it('classifies the helper, and only as high as it needs', () => {
    const entries = COMMAND_POLICY.filter((e) => e.bin === 'agent-workflow');
    expect(entries.map((e) => e.verb.join(' ')).sort()).toEqual([
      'agentize', 'inspect', 'render', 'ticket', 'validate',
    ]);
    for (const entry of entries) {
      const expected = ['ticket', 'agentize'].includes(entry.verb[0]!)
        ? 'external_mutation'
        : 'read_only';
      expect(entry.cls, entry.verb.join(' ')).toBe(expected);
    }
  });
});

describe('the owner-only surface is not widened', () => {
  it('still registers exactly the twelve commands, and no shared route is a write', () => {
    const h = makeHarness();
    expect(h.app.router.registeredCommands().sort()).toEqual([...OWNER_ONLY_COMMANDS].sort());
    expect(OWNER_ONLY_COMMANDS).toHaveLength(12);
    // The bridge rides conversation; it adds no command.
    expect(OWNER_ONLY_COMMANDS as readonly string[]).not.toContain('ticket');
    expect(OWNER_ONLY_COMMANDS as readonly string[]).not.toContain('agentize');
    // And the card controls are never shared-readable.
    for (const route of SHARED_READABLE_ROUTES) {
      expect(route.command).not.toMatch(/^agent_/);
    }
    h.close();
  });

  it('registers the two card controls as owner-only interaction kinds', () => {
    const h = makeHarness();
    expect(h.app.router.registeredComponentKinds()).toContain('agent_details');
    expect(h.app.router.registeredComponentKinds()).toContain('agent_cancel');
    h.close();
  });

  it('refuses a card control from a stranger before it reaches the service', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'component',
      customId: h.app.signer.sign({
        kind: 'agent_cancel', entityId: 'a00001', actorUserId: OWNER,
      }),
      userId: '100000000000000003',
    });
    expect(reply?.content).toMatch(/not authorized/i);
    h.close();
  });
});

describe('a link button is a link and nothing else', () => {
  it('admits only an exact https GitHub URL', () => {
    expect(isSafeLinkUrl('https://github.com/acme/demo/issues/7')).toBe(true);
    expect(isSafeLinkUrl('https://www.github.com/acme/demo/pull/7')).toBe(true);
    for (const bad of [
      'http://github.com/acme/demo/issues/7',
      'https://evil.example.com/acme/demo',
      'https://github.com.evil.example/acme',
      'javascript:alert(1)',
      'https://user:pass@github.com/acme/demo',
      // Not re-serializable to exactly what was given.
      'https://github.com/acme/demo/../../etc',
      `https://github.com/${'a'.repeat(400)}`,
    ]) {
      expect(isSafeLinkUrl(bad), bad).toBe(false);
    }
  });

  it('drops an unsafe link at the egress boundary rather than sending it', () => {
    const safe = sanitizeOutbound({
      rows: [{
        buttons: [
          { url: 'https://evil.example.com/x', label: 'View issue' },
          { url: 'https://github.com/acme/demo/issues/7', label: 'View issue' },
        ],
      }],
    });
    expect(safe.rows?.[0]?.buttons).toHaveLength(1);
  });

  it('renders a link button with a url and no custom id', () => {
    const payload = toDiscordPayload({
      rows: [{ buttons: [{ url: 'https://github.com/acme/demo/issues/7', label: 'View issue' }] }],
    });
    const button = payload.components![0]!.components[0]!;
    expect(button.url).toBe('https://github.com/acme/demo/issues/7');
    expect(button.custom_id).toBeUndefined();
    // Discord's link style, which refuses a custom id.
    expect(button.style).toBe(5);
  });
});

describe('the bridge configuration fails closed and keeps the profiles apart', () => {
  const base = {
    OWNER_DISCORD_USER_ID: '100000000000000001',
    DUCKY_DEV_COMPONENT_SIGNING_KEY: 'x'.repeat(43),
  };

  it('is off by default', () => {
    const resolved = resolveSkillBridge(loadEnv({ ...base } as NodeJS.ProcessEnv));
    expect(resolved.enabled).toBe(false);
    expect(resolved.mutationEnabled).toBe(false);
    expect(resolved.program).toBeUndefined();
  });

  it('refuses to be enabled with nowhere to find the helper', () => {
    expect(() =>
      resolveSkillBridge(loadEnv({
        ...base, DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      } as NodeJS.ProcessEnv)),
    ).toThrow(/no helper path is configured/i);
  });

  it('refuses a relative helper path rather than resolving it', () => {
    expect(() =>
      resolveSkillBridge(loadEnv({
        ...base,
        DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
        DUCKY_DEV_WORKFLOW_HELPER: 'workflow.py',
      } as NodeJS.ProcessEnv)),
    ).toThrow(/absolute path/i);
  });

  it('refuses publishing without the bridge it would publish through', () => {
    expect(() =>
      resolveSkillBridge(loadEnv({
        ...base, DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
      } as NodeJS.ProcessEnv)),
    ).toThrow(/workflow bridge is not/i);
  });

  it('scopes the interpreter per profile like every other helper setting', () => {
    const resolved = resolveSkillBridge(loadEnv({
      OWNER_DISCORD_USER_ID: '100000000000000001',
      DUCKY_PROFILE: 'production',
      DUCKY_PROD_COMPONENT_SIGNING_KEY: 'x'.repeat(43),
      DUCKY_PROD_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_PROD_WORKFLOW_HELPER: '/prod/workflow.py',
      // A development interpreter is a development host's python, and
      // production must not run its publisher under one.
      DUCKY_DEV_WORKFLOW_PYTHON: '/dev/bin/python3',
      DUCKY_WORKFLOW_PYTHON: '/shared/bin/python3',
    } as NodeJS.ProcessEnv));
    expect(resolved.interpreter).toBe('python3');

    const dev = resolveSkillBridge(loadEnv({
      ...base,
      DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_HELPER: '/dev/workflow.py',
      DUCKY_DEV_WORKFLOW_PYTHON: '/dev/bin/python3',
    } as NodeJS.ProcessEnv));
    expect(dev.interpreter).toBe('/dev/bin/python3');
  });

  it('never lets production inherit a development helper', () => {
    const resolved = resolveSkillBridge(loadEnv({
      OWNER_DISCORD_USER_ID: '100000000000000001',
      DUCKY_PROFILE: 'production',
      DUCKY_PROD_COMPONENT_SIGNING_KEY: 'x'.repeat(43),
      // Both the development and the unscoped names are set, and production
      // reads neither: a development helper points at a development
      // dispatcher.
      DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_HELPER: '/dev/workflow.py',
      DUCKY_WORKFLOW_HELPER: '/shared/workflow.py',
      DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
      DUCKY_WORKFLOW_MUTATION_ENABLED: '1',
    } as NodeJS.ProcessEnv));

    expect(resolved.enabled).toBe(false);
    expect(resolved.program).toBeUndefined();
    expect(resolved.mutationEnabled).toBe(false);
  });
});

describe('the status readout tells the owner where the bridge stands', () => {
  it('says it is off when it is off', () => {
    const h = makeHarness();
    expect(h.app.status().repositoryWorkflow).toMatch(/^off/);
    h.close();
  });
});

describe('the workflow audit row says what it is', () => {
  it('records the command and the status, and nothing the owner typed', async () => {
    const { MockFrontDoor } = await import('@ducky/adapters');
    const h = makeHarness({
      frontDoor: new MockFrontDoor(),
      env: {
        DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
        DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
        DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
      },
    });
    await h.transport.start((e) => h.app.router.handle(e));
    await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: '$ticket add a health endpoint', threadKey: 'dm-1',
    });

    const rows = h.store.auditLog.recent(50).filter((r) => r.event === 'workflow.requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe('$ticket -> published');
    // Not a job event: searching the trail for jobs must not return this.
    expect(h.store.auditLog.recent(50).some((r) => r.event === 'job.created')).toBe(false);
    // And the owner's own words are not in the trail.
    expect(rows[0]!.detail).not.toContain('health endpoint');
    expect(rows[0]!.subjectRef).toBe('workflow');
    h.close();
  });
});
