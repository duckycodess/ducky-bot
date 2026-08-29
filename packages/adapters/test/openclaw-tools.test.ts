import { existsSync, readFileSync } from 'node:fs';
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
