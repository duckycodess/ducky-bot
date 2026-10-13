import { describe, expect, it } from 'vitest';
import {
  BILLED_API_KEY_ENV_NAMES, assertSubscriptionOnlyEnvironment, billedApiKeyEnvNames,
} from '../src/subscription-only.js';

describe('subscription-only environment guard', () => {
  it('passes an environment with no separately billed key name', () => {
    expect(() =>
      assertSubscriptionOnlyEnvironment({ PATH: '/usr/bin', HOME: '/home/x', DUCKY_PROFILE: 'production' }, 'The coordinator'),
    ).not.toThrow();
  });

  it('refuses every listed provider name', () => {
    for (const name of BILLED_API_KEY_ENV_NAMES) {
      expect(() => assertSubscriptionOnlyEnvironment({ [name]: 'x' }, 'The coordinator'), name).toThrow(
        new RegExp(name),
      );
    }
  });

  it('refuses a provider nobody listed through the generic suffix rule', () => {
    expect(billedApiKeyEnvNames({ MISTRAL_API_KEY: 'x', SOME_NEW_PROVIDER_API_KEY: 'y' })).toEqual([
      'MISTRAL_API_KEY', 'SOME_NEW_PROVIDER_API_KEY',
    ]);
  });

  it('ignores a blank value, which is how an env file unsets a name', () => {
    expect(billedApiKeyEnvNames({ OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '   ' })).toEqual([]);
  });

  it('does not match names that merely contain the words', () => {
    expect(billedApiKeyEnvNames({ API_KEY_FILE: 'x', MYAPI_KEYS: 'x', DISCORD_DEV_TOKEN: 'x' })).toEqual([]);
  });

  it('names the variable and never prints its value', () => {
    const secret = 'sk-live-should-never-appear-0123456789';
    let message = '';
    try {
      assertSubscriptionOnlyEnvironment({ OPENAI_API_KEY: secret }, 'The executor');
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).not.toContain(secret);
    expect(message).toMatch(/subscription-only/);
  });
});
