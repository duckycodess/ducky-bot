import { DuckyError } from './errors.js';
import type { DuckyProfile } from './profile.js';

/**
 * Which conversational backend an instance runs.
 *
 * Explicit, and never inferred from whether a URL happens to be set. The old
 * behaviour was `if (!OPENCLAW_BASE_URL) return mock`, with no profile check at
 * all -- so a PRODUCTION instance with the variable unset (the default, since
 * it is not even in `.env.example`) silently answered the owner from a canned
 * mock. `PROJECT_CONTEXT.md` rules out exactly that kind of plausible-looking
 * fake, and the profile isolation rules say production fails closed rather than
 * borrowing a development stand-in.
 */
/**
 * Who said a stored turn.
 *
 * Closed to the two participants. There is deliberately no `system` role: a
 * stored preamble would be configuration masquerading as history, and nothing
 * may put words in this table that the owner or Ducky did not actually say.
 */
export const CONVERSATION_ROLES = ['user', 'assistant'] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export const CONVERSATION_PROVIDERS = ['mock', 'disabled', 'openclaw'] as const;
export type ConversationProviderMode = (typeof CONVERSATION_PROVIDERS)[number];

export const isConversationProviderMode = (v: string): v is ConversationProviderMode =>
  (CONVERSATION_PROVIDERS as readonly string[]).includes(v);

/**
 * Resolves the mode for a profile, or throws at STARTUP.
 *
 * The rules, and why each one:
 *
 * - **development, unset** -> `mock`. A local box stays trivial to run, and
 *   every mock reply is prefixed `[mock]` so it cannot be mistaken for real.
 * - **production, unset** -> REFUSED. Which backend answers the owner is not
 *   something to default into; it has to be a decision somebody made.
 * - **production, `mock`** -> REFUSED. A marked stand-in is not a production
 *   conversational backend, and shipping one would make Ducky lie by omission
 *   to whoever is talking to it.
 * - **`disabled`** -> allowed anywhere, and it is the correct production answer
 *   until the OpenClaw contract is verified. Conversation refuses clearly
 *   instead of being faked.
 * - **`openclaw`** -> allowed anywhere, and the provider must initialise. A
 *   development instance may then fail per request (the API is unverified); a
 *   production instance must fail at startup rather than discover it later.
 */
export function resolveConversationMode(
  raw: string | undefined,
  profile: DuckyProfile,
): ConversationProviderMode {
  const value = (raw ?? '').trim().toLowerCase();

  if (value === '') {
    if (profile === 'production') {
      throw new DuckyError(
        'invalid_input',
        'DUCKY_CONVERSATION_PROVIDER is required for the production profile. ' +
          'Choose `disabled` (conversation refuses clearly) or `openclaw` (a verified ' +
          'gateway). `mock` is refused in production because a canned reply must never ' +
          'be mistaken for a real one.',
      );
    }
    return 'mock';
  }

  if (!isConversationProviderMode(value)) {
    throw new DuckyError(
      'invalid_input',
      `DUCKY_CONVERSATION_PROVIDER must be one of ${CONVERSATION_PROVIDERS.join(', ')}.`,
    );
  }

  if (value === 'mock' && profile === 'production') {
    throw new DuckyError(
      'invalid_input',
      'DUCKY_CONVERSATION_PROVIDER=mock is refused for the production profile: every mock ' +
        'reply is a canned stand-in. Use `disabled` until a real provider is verified.',
    );
  }

  return value;
}
