import { describe, expect, it } from 'vitest';
import { isDuckyError, resolveConversationMode } from '@ducky/contracts';
import {
  DisabledConversationProvider, GatewayOpenClawProvider, MockConversationProvider,
  RECORDED_CONTRACT_VERSION,
} from '@ducky/adapters';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import { REPOS_JSON } from './helpers.js';

/**
 * Which backend answers the owner is a DECISION, not a default.
 *
 * The previous selection was `if (!OPENCLAW_BASE_URL) return mock`, with no
 * profile check at all -- so a production instance with the variable unset (the
 * default; it is not even in `.env.example`) silently answered from a canned
 * mock. `PROJECT_CONTEXT.md` rules out exactly that, and the profile rules say
 * production fails closed rather than borrowing a development stand-in.
 */
describe('conversation mode resolution', () => {
  it('lets a development box omit it and get the marked mock', () => {
    expect(resolveConversationMode(undefined, 'development')).toBe('mock');
    expect(resolveConversationMode('', 'development')).toBe('mock');
  });

  it('REFUSES an unset value for production', () => {
    const err = (() => {
      try {
        resolveConversationMode(undefined, 'production');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isDuckyError(err)).toBe(true);
    expect(isDuckyError(err) && err.ownerMessage).toMatch(/required for the production profile/i);
  });

  it('REFUSES mock for production, whatever else is configured', () => {
    expect(() => resolveConversationMode('mock', 'production')).toThrow(/refused for the production/i);
  });

  it('allows disabled anywhere, which is the honest production answer today', () => {
    expect(resolveConversationMode('disabled', 'production')).toBe('disabled');
    expect(resolveConversationMode('disabled', 'development')).toBe('disabled');
  });

  it('allows openclaw in both profiles', () => {
    expect(resolveConversationMode('openclaw', 'production')).toBe('openclaw');
    expect(resolveConversationMode('OpenClaw', 'development')).toBe('openclaw');
  });

  it('refuses a value that is not a mode at all', () => {
    expect(() => resolveConversationMode('gpt', 'development')).toThrow(/must be one of/i);
  });
});

describe('the disabled provider', () => {
  it('refuses rather than generating a sentence', async () => {
    const p = new DisabledConversationProvider();
    const err = await p
      .reply({ userId: '1', text: 'hello', threadKey: 't' })
      .catch((e: unknown) => e);
    expect(isDuckyError(err)).toBe(true);
    expect(isDuckyError(err) && err.code).toBe('integration_not_verified');
  });

  it('is never reported as verified and never claims attachment support', () => {
    const p = new DisabledConversationProvider();
    expect(p.verified).toBe(false);
    expect(p.capabilities.attachments.supported).toBe(false);
  });

  it('produces no "[mock]" text, because it is not pretending to answer', async () => {
    const p = new DisabledConversationProvider();
    const err = await p.reply({ userId: '1', text: 'x', threadKey: 't' }).catch((e: unknown) => e);
    expect(String(isDuckyError(err) ? err.ownerMessage : '')).not.toContain('[mock]');
  });
});

/**
 * The real selection path in `app.ts`.
 *
 * `makeHarness` always injects a conversation provider, so it deliberately
 * cannot exercise this -- these cases call the composition root directly.
 */
describe('startup selection', () => {
  const baseEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({
      NODE_ENV: 'test',
      DUCKY_PROFILE: 'development',
      OWNER_DISCORD_USER_ID: '100000000000000001',
      DUCKY_DEV_COMPONENT_SIGNING_KEY: 'k'.repeat(64),
      DUCKY_EXECUTOR_CREDENTIALS: JSON.stringify({ version: 1, executors: [] }),
      DUCKY_DB_PATH: ':memory:',
      DUCKY_REPOS_FILE: 'unused-in-tests',
      ...over,
    }) as NodeJS.ProcessEnv;

  const boot = (over: Record<string, string> = {}) =>
    createApp(baseEnv(over), { transport: new MockDiscordTransport(), allowlistJson: REPOS_JSON });

  it('a development instance with nothing configured boots on the marked mock', () => {
    const app = boot();
    expect(app.conversation).toBeInstanceOf(MockConversationProvider);
    app.close();
  });

  it('a development instance can choose disabled', () => {
    const app = boot({ DUCKY_CONVERSATION_PROVIDER: 'disabled' });
    expect(app.conversation).toBeInstanceOf(DisabledConversationProvider);
    app.close();
  });

  it('a PRODUCTION instance refuses to boot with no provider chosen', () => {
    expect(() =>
      boot({
        DUCKY_PROFILE: 'production',
        DISCORD_PROD_TOKEN: 't'.repeat(40),
        DISCORD_PROD_APP_ID: '200000000000000002',
        DUCKY_PROD_COMPONENT_SIGNING_KEY: 'p'.repeat(64),
      }),
    ).toThrow(/DUCKY_CONVERSATION_PROVIDER is required for the production profile/i);
  });

  it('a PRODUCTION instance refuses to boot on the mock', () => {
    expect(() =>
      boot({
        DUCKY_PROFILE: 'production',
        DUCKY_CONVERSATION_PROVIDER: 'mock',
        DISCORD_PROD_TOKEN: 't'.repeat(40),
        DISCORD_PROD_APP_ID: '200000000000000002',
        DUCKY_PROD_COMPONENT_SIGNING_KEY: 'p'.repeat(64),
      }),
    ).toThrow(/refused for the production profile/i);
  });

  it('openclaw without a URL fails at STARTUP, not on the first message', () => {
    expect(() => boot({ DUCKY_CONVERSATION_PROVIDER: 'openclaw' })).toThrow(
      /requires OPENCLAW_BASE_URL/i,
    );
  });

  it('openclaw with a public URL is still refused at startup', () => {
    expect(() =>
      boot({
        DUCKY_CONVERSATION_PROVIDER: 'openclaw',
        OPENCLAW_BASE_URL: 'https://openclaw.example.com',
      }),
    ).toThrow(/loopback or a private tailnet/i);
  });

  it('openclaw on loopback constructs in DEVELOPMENT, and refuses per request', async () => {
    // Development may point at a gateway and find out per request. That is a
    // local box choosing to experiment, not an instance answering the owner.
    const app = boot({
      DUCKY_CONVERSATION_PROVIDER: 'openclaw',
      OPENCLAW_BASE_URL: 'http://127.0.0.1:8080',
    });
    expect(app.conversation.verified).toBe(false);
    await expect(
      app.conversation.reply({ userId: '1', text: 'x', threadKey: 't' }),
    ).rejects.toThrow(/not implemented|not been verified/i);
    app.close();
  });

  /**
   * PRODUCTION is different, and this is the case the first pass got wrong.
   *
   * A private URL proves the address is not public. It proves nothing about
   * whether anything there speaks a contract we have recorded. Booting on it
   * and throwing on the owner's first message is precisely the "discover it in
   * production" outcome the provider modes exist to prevent.
   */
  it('a PRODUCTION instance refuses openclaw while no contract is recorded', () => {
    expect(() =>
      boot({
        DUCKY_PROFILE: 'production',
        DUCKY_CONVERSATION_PROVIDER: 'openclaw',
        OPENCLAW_BASE_URL: 'http://127.0.0.1:8080',
        DISCORD_PROD_TOKEN: 't'.repeat(40),
        DISCORD_PROD_APP_ID: '200000000000000002',
        DUCKY_PROD_COMPONENT_SIGNING_KEY: 'p'.repeat(64),
      }),
    ).toThrow(/cannot be used on the production profile/i);
  });

  it('says WHY, and points at the probe rather than at a flag', () => {
    const err = (() => {
      try {
        boot({
          DUCKY_PROFILE: 'production',
          DUCKY_CONVERSATION_PROVIDER: 'openclaw',
          OPENCLAW_BASE_URL: 'http://127.0.0.1:8080',
          DISCORD_PROD_TOKEN: 't'.repeat(40),
          DISCORD_PROD_APP_ID: '200000000000000002',
          DUCKY_PROD_COMPONENT_SIGNING_KEY: 'p'.repeat(64),
        });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isDuckyError(err)).toBe(true);
    const msg = isDuckyError(err) ? err.ownerMessage : '';
    expect(msg).toMatch(/recorded only in HALF/i);
    expect(msg).toMatch(/probe:openclaw/);
    // And it names the mode that DOES work today.
    expect(msg).toMatch(/disabled/);
  });

  it('production CAN boot on disabled, so the instance is not bricked', () => {
    // Production legitimately requires its own credential FILE (inline
    // credentials are refused there), so a realistic boot needs one.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-provider-'));
    const file = path.join(dir, 'executor-credentials-production.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        executors: [{
          executorId: 'exec-p', keyId: 'k1',
          bearerToken: 'b'.repeat(43), hmacSecret: 'h'.repeat(43),
          state: 'active',
        }],
      }),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);

    const app = boot({
      DUCKY_PROFILE: 'production',
      DUCKY_CONVERSATION_PROVIDER: 'disabled',
      DISCORD_PROD_TOKEN: 't'.repeat(40),
      DISCORD_PROD_APP_ID: '200000000000000002',
      DUCKY_PROD_COMPONENT_SIGNING_KEY: 'p'.repeat(64),
      DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE: file,
    });
    expect(app.conversation.name).toBe('disabled');
    app.close();
  });
});

/**
 * The initialisation contract itself.
 *
 * Non-networked by design: reachability at boot would not prove the API either,
 * and a gateway that is merely down should not stop a correctly configured
 * instance from starting. What it checks is whether a contract has been
 * RECORDED.
 */
describe('the OpenClaw initialisation contract', () => {
  it('reports not-initializable while nothing is recorded', () => {
    expect(RECORDED_CONTRACT_VERSION).toBeNull();
    const init = GatewayOpenClawProvider.initializable();
    expect(init.ok).toBe(false);
    expect(init.reason).toMatch(/recorded only in HALF/i);
  });

  it('is not settable from the environment', () => {
    // `verified` must mean "a contract was recorded", or it means nothing. An
    // env var would let an operator assert a backend into existence, which is
    // the failure this replaced.
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'adapters', 'src', 'openclaw', 'openclaw.contract.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/process\.env/);
  });

  it('keeps the provider unverified and attachment-incapable regardless', () => {
    const p = new GatewayOpenClawProvider('ws://127.0.0.1:19001');
    expect(p.verified).toBe(false);
    expect(p.capabilities.attachments.supported).toBe(false);
  });
});
