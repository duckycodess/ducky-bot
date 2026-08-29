import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommandAllowed } from '@ducky/contracts';
import { GatewayOpenClawProvider } from '../src/openclaw/openclaw.gateway.js';
import {
  REQUIRED_TOOL_DENY, REQUIRED_TOOL_PROFILE, verifyTextOnlyToolPolicy,
} from '../src/openclaw/openclaw.tools.js';

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/openclaw/openclaw.fixtures/tool-policy.json',
);

describe('the conversation route must be provably text-only', () => {
  /**
   * The gap this closes. Ducky documented conversation as having no tool
   * access. That was true of Ducky -- one argv, no tool flag, no tool surface
   * of its own -- and false of the agent on the other end: OpenClaw's
   * `tools.profile` decides what a turn may reach, and the pinned docs say an
   * UNSET profile means `full`, which is filesystem, runtime and web.
   */
  it('requires minimal, and denies the one tool minimal still allows', () => {
    expect(REQUIRED_TOOL_PROFILE).toBe('minimal');
    expect(REQUIRED_TOOL_DENY).toContain('session_status');
  });

  it('treats an UNREADABLE policy as unsafe, not as unknown', async () => {
    // Not knowing whether a shell is reachable is the same as knowing one is,
    // for the purpose of deciding whether to send somebody's sentence to it.
    const verdict = await verifyTextOnlyToolPolicy({
      bin: '/nonexistent/openclaw',
      profile: 'dev',
      timeoutMs: 5_000,
    });
    expect(verdict.safe).toBe(false);
    expect(verdict.detail).toMatch(/could not be read|text-only/i);
  });

  it('refuses a turn when the policy is not provably text-only', async () => {
    // The provider must fail CLOSED: a refusal, not a turn sent anyway.
    const provider = new GatewayOpenClawProvider('ws://127.0.0.1:19001', {
      bin: '/nonexistent/openclaw',
      timeoutMs: 5_000,
    });
    await expect(
      provider.reply({ userId: 'u', text: 'hi', threadKey: 't' }),
    ).rejects.toThrow(/provably text-only/i);
  });

  it('can READ the policy and can never write it', () => {
    /**
     * `config get` is classified read-only; `config set` and `config patch`
     * are deliberately unlisted, and an unclassified command is refused before
     * it spawns. So Ducky can prove the policy and cannot relax it.
     */
    expect(checkCommandAllowed('openclaw', ['--dev', 'config', 'get', 'tools.profile']))
      .toBeUndefined();
    expect(checkCommandAllowed('openclaw', ['--dev', 'config', 'set', 'tools.profile', 'full'])?.reason)
      .toBe('unclassified');
    expect(checkCommandAllowed('openclaw', ['--dev', 'config', 'patch'])?.reason)
      .toBe('unclassified');
  });

  it.runIf(existsSync(FIXTURE))('records that --local actually honours the policy', () => {
    /**
     * The decisive evidence, and the reason this is a recording rather than a
     * reading of the docs: the reply envelope reports how many tools the model
     * was handed. It was 31 with no profile set and is 0 under minimal plus a
     * deny -- same `--local` invocation both times.
     */
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    expect(f['profileIsMinimal']).toBe(true);
    expect(f['denyIncludesSessionStatus']).toBe(true);
    expect(f['toolsExposedToModel']).toBe(0);
    expect(f['textOnly']).toBe(true);
  });
});

describe('a per-agent or per-provider override cannot slip past', () => {
  /**
   * The precedence gap this covers.
   *
   * The pinned docs are explicit: `agents.list[].tools.profile` overrides the
   * global `tools.profile`, and `tools.byProvider` applies between the base
   * profile and allow/deny. So proving `tools.profile=minimal` proves nothing
   * on its own -- an override could hand the very agent Ducky talks to a
   * filesystem, and the global check would still have said "safe".
   *
   * Two independent controls now: the global DENY list, which wins where a
   * profile is overridden, and the absence of any scope that could grant.
   */
  const stub = (answers: Record<string, string>): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-openclaw-stub-'));
    const file = path.join(dir, 'openclaw');
    // Answers `config get <path>`; anything unlisted reports "not found",
    // which is exactly what the real CLI does for an unset path.
    const cases = Object.entries(answers)
      .map(([k, v]) => `    ${k}) printf '%s' ${JSON.stringify(v)} ;;`)
      .join('\n');
    writeFileSync(
      file,
      `#!/bin/sh\nfor a in "$@"; do last="$a"; done\ncase "$last" in\n${cases}\n` +
        `    *) printf 'Config path not found: %s.' "$last"; exit 1 ;;\nesac\nexit 0\n`,
      { mode: 0o700 },
    );
    return file;
  };

  const FULL_DENY = JSON.stringify(REQUIRED_TOOL_DENY);

  it('accepts a config with the full deny list and no override', async () => {
    const v = await verifyTextOnlyToolPolicy({
      bin: stub({ 'tools.profile': 'minimal', 'tools.deny': FULL_DENY }),
      profile: 'dev',
      timeoutMs: 5_000,
    });
    expect(v.safe).toBe(true);
  });

  it.each([
    'agents.list',
    'agents.defaults.tools',
    'tools.byProvider',
    'tools.toolsBySender',
    'tools.allow',
    'tools.alsoAllow',
    'tools.elevated',
  ])('refuses when %s is configured, however harmless it looks', async (dotPath) => {
    /**
     * Absence is REQUIRED rather than inspected. Reading an override and
     * deciding it looks harmless means re-implementing OpenClaw's precedence
     * rules inside Ducky and being wrong about them silently.
     */
    const v = await verifyTextOnlyToolPolicy({
      bin: stub({
        'tools.profile': 'minimal',
        'tools.deny': FULL_DENY,
        [dotPath]: '[]',
      }),
      profile: 'dev',
      timeoutMs: 5_000,
    });
    expect(v.safe).toBe(false);
    expect(v.detail).toContain(dotPath);
  });

  it('refuses a deny list that omits a single group', async () => {
    // `minimal` plus a partial deny was the state this review found: it looked
    // safe and was not, because a per-agent profile can override the profile.
    const partial = REQUIRED_TOOL_DENY.filter((t) => t !== 'group:runtime');
    const v = await verifyTextOnlyToolPolicy({
      bin: stub({ 'tools.profile': 'minimal', 'tools.deny': JSON.stringify(partial) }),
      profile: 'dev',
      timeoutMs: 5_000,
    });
    expect(v.safe).toBe(false);
    expect(v.detail).toContain('group:runtime');
  });

  it('refuses a non-minimal profile even with a full deny list', async () => {
    const v = await verifyTextOnlyToolPolicy({
      bin: stub({ 'tools.profile': 'coding', 'tools.deny': FULL_DENY }),
      profile: 'dev',
      timeoutMs: 5_000,
    });
    expect(v.safe).toBe(false);
  });
});
