import { DuckyError } from './errors.js';

/**
 * Environment variable names that would let a model provider bill the owner
 * separately from the subscription this runtime is meant to use.
 *
 * NAMES ONLY, ever. The guard reads which variables are set and never what they
 * hold, and the error it raises quotes the names and nothing else.
 *
 * Deliberately an explicit list plus one generic suffix rule. The list is the
 * providers the owner could plausibly point an agent at; the suffix catches a
 * provider nobody listed. A false positive is a refusal to boot with a clear
 * message, which is the cheap direction; a false negative is a silent bill.
 */
export const BILLED_API_KEY_ENV_NAMES: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY',
];

const API_KEY_SUFFIX = /(?:^|_)API_KEY$/;

/** The offending names that are set to something non-blank, sorted. Never values. */
export function billedApiKeyEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => {
      const value = env[name];
      if (value === undefined || value.trim() === '') return false;
      return BILLED_API_KEY_ENV_NAMES.includes(name) || API_KEY_SUFFIX.test(name);
    })
    .sort();
}

/**
 * Refuses to start a subscription-only process whose OWN environment carries a
 * separately billed API key name.
 *
 * **This is partial evidence, and it is labelled so.** It proves one thing: this
 * process did not start with such a variable set. It cannot prove the provider
 * is on a subscription, because a provider's own private configuration (for
 * OpenClaw, its profile store; for Herdr agents, the Herdr server's environment,
 * which they inherit) is not visible from here and may hold an API key. A
 * deployment is therefore only as subscription-only as the runbook's
 * independent checks of those places say it is, and an ambiguous route is to be
 * refused rather than described as supported quota.
 */
export function assertSubscriptionOnlyEnvironment(env: NodeJS.ProcessEnv, who: string): void {
  const found = billedApiKeyEnvNames(env);
  if (found.length === 0) return;
  throw new DuckyError(
    'invalid_input',
    `${who} runs subscription-only, but its environment sets ${found.join(', ')}. ` +
      'A separately billed API key could be used instead of the subscription, so it is ' +
      'refused rather than guessed at. Unset it for this process; no value was read.',
  );
}
