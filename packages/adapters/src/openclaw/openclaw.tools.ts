/**
 * Proving the agent turn is TEXT ONLY, rather than asserting it in a persona.
 *
 * ## The problem this exists for
 *
 * Ducky documents conversation as a route with no tool access. That was true of
 * Ducky -- it builds one argv, passes no tool flag, and has no tool surface of
 * its own -- and it was NOT true of the thing on the other end. OpenClaw's
 * `tools.profile` decides what an agent turn may reach, and the pinned docs are
 * explicit that unset means `full`, described as "No restriction (same as
 * unset)":
 *
 * | profile     | includes                                                    |
 * |-------------|-------------------------------------------------------------|
 * | `minimal`   | `session_status` only                                       |
 * | `messaging` | `group:messaging`, session read tools                       |
 * | `coding`    | `group:fs`, `group:runtime`, `group:web`, and more          |
 * | `full`      | no restriction                                              |
 *
 * On this host the key was absent entirely. `group:runtime` is
 * `exec`/`process`/`code_execution`; `group:fs` is `read`/`write`/`edit`. So an
 * ordinary sentence in a chat channel could in principle have reached a shell
 * on the owner's machine, while the documentation said conversation had no
 * tools.
 *
 * ## Why a persona instruction is not the fix
 *
 * "Do not take actions" in a prompt is a request. A tool policy is a
 * capability. Prompt injection from message content is explicitly out of scope
 * for the prompt layer (see SECURITY.md), so the control has to be
 * configuration the model cannot argue with.
 *
 * ## What this does
 *
 * Reads the EFFECTIVE policy through the supported read-only surface
 * (`openclaw config get`) and refuses to run a turn unless it is provably
 * text-only. Absence is unsafe, not neutral: an unset profile IS `full`, so a
 * missing key fails closed exactly like a permissive one.
 *
 * The check is lazy and cached rather than done at boot. A tool policy cannot
 * change under a running coordinator without somebody editing configuration, so
 * checking once per process is enough -- and doing it lazily means a slow or
 * wedged CLI delays one reply instead of preventing the coordinator from
 * starting at all.
 */
import { DuckyError, checkCommandAllowed } from '@ducky/contracts';
import { runArgv } from '../process/run.js';

/**
 * The only profile Ducky will run a conversation under.
 *
 * `minimal` is `session_status` only. `messaging` is not accepted even though
 * it sounds harmless: it carries `group:messaging`, which is a send capability,
 * and Ducky decides where its own output goes.
 */
export const REQUIRED_TOOL_PROFILE = 'minimal';

/**
 * Tools denied on top of the profile.
 *
 * `minimal` still allows `session_status`, which reads session state. Nothing
 * in a Ducky conversation needs it, and "text only" should mean text only, so
 * it is denied explicitly rather than tolerated as close enough.
 */
export const REQUIRED_TOOL_DENY: readonly string[] = Object.freeze(['session_status']);

export interface ToolPolicyVerdict {
  readonly safe: boolean;
  /** Owner-facing, and specific enough to act on. Never a config value dump. */
  readonly detail: string;
  /** What was actually read, for a diagnostic line and a probe fixture. */
  readonly profile: string | null;
  readonly denied: readonly string[];
}

/** `config get` prints this, with exit 0, when a path is not set at all. */
const NOT_FOUND = /config path not found/i;

/**
 * Reads one config path through the supported non-interactive surface.
 *
 * Returns null for "not set", which the caller must treat as the permissive
 * default rather than as an absence of information.
 */
async function readConfigPath(
  bin: string,
  profile: 'dev' | 'default',
  dotPath: string,
  timeoutMs: number,
): Promise<string | null> {
  const argv = [
    ...(profile === 'dev' ? ['--dev'] : []),
    '--no-color',
    'config',
    'get',
    dotPath,
  ];
  const refusal = checkCommandAllowed('openclaw', argv);
  if (refusal) throw new DuckyError('not_enabled_in_phase1', refusal.detail);

  const res = await runArgv(bin, argv, { timeoutMs });
  const out = `${res.stdout}${res.stderr}`.trim();
  if (res.code !== 0) {
    throw new DuckyError(
      'integration_not_verified',
      'The OpenClaw tool policy could not be read.',
    );
  }
  if (out === '' || NOT_FOUND.test(out)) return null;
  return out;
}

/**
 * Whether a turn may run at all.
 *
 * Every failure mode returns `safe: false`. There is deliberately no path that
 * treats an unreadable policy as acceptable: not knowing whether a shell is
 * reachable is the same as knowing one is, for the purposes of deciding whether
 * to send somebody's sentence to it.
 */
export async function verifyTextOnlyToolPolicy(opts: {
  readonly bin: string;
  readonly profile: 'dev' | 'default';
  readonly timeoutMs?: number;
}): Promise<ToolPolicyVerdict> {
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let profile: string | null;
  let denyRaw: string | null;
  try {
    profile = await readConfigPath(opts.bin, opts.profile, 'tools.profile', timeoutMs);
    denyRaw = await readConfigPath(opts.bin, opts.profile, 'tools.deny', timeoutMs);
  } catch (err) {
    return {
      safe: false,
      profile: null,
      denied: [],
      detail:
        `the OpenClaw tool policy could not be read (${
          err instanceof DuckyError ? err.code : 'unknown'
        }), so it cannot be shown to be text-only`,
      };
  }

  if (profile === null) {
    return {
      safe: false,
      profile: null,
      denied: [],
      detail:
        'no `tools.profile` is set, and an unset profile means `full` -- filesystem, runtime ' +
        'and web tools are reachable from an ordinary chat message',
    };
  }

  const normalized = profile.replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (normalized !== REQUIRED_TOOL_PROFILE) {
    return {
      safe: false,
      profile: normalized,
      denied: [],
      detail:
        `\`tools.profile\` is \`${normalized}\`, which grants more than text. Ducky's ` +
        `conversation route requires \`${REQUIRED_TOOL_PROFILE}\``,
    };
  }

  const denied = (denyRaw ?? '')
    .replace(/[[\]"']/g, ' ')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');

  const missing = REQUIRED_TOOL_DENY.filter((t) => !denied.includes(t));
  if (missing.length > 0) {
    return {
      safe: false,
      profile: normalized,
      denied,
      detail:
        `\`tools.profile\` is \`${normalized}\`, but ${missing.join(', ')} is not in ` +
        '`tools.deny`. Text only should mean text only',
    };
  }

  return {
    safe: true,
    profile: normalized,
    denied,
    detail: `tools.profile=${normalized}, denying ${denied.join(', ')}`,
  };
}
