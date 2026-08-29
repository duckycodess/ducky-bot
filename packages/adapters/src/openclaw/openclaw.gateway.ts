import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckyError, checkCommandAllowed } from '@ducky/contracts';
import { RECORDED_CONTRACT_VERSION } from './openclaw.contract.js';
import { assertPrivateGatewayUrl } from './private-url.js';
import { ATTACHMENTS_UNAVAILABLE_MESSAGE } from './openclaw.mock.js';
import { OpenClawReplySchema, replyTextFrom } from './openclaw.schema.js';
import { runArgv } from '../process/run.js';
import { redact } from '../redaction/redact.js';
import {
  NO_ATTACHMENT_CAPABILITY,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from './openclaw.port.js';

/** The pinned local install, preferred over anything on PATH. */
const PINNED_BIN = path.join(
  os.homedir(),
  '.local/opt/ducky-openclaw/node_modules/.bin/openclaw',
);

export interface GatewayOpenClawOptions {
  /** Overridden in tests; production uses the pinned install. */
  readonly bin?: string;
  /**
   * Which OpenClaw profile to run under.
   *
   * `dev` maps to the `--dev` flag and its isolated `~/.openclaw-dev` state,
   * which is where the recorded contract was observed and where the only
   * signed-in account on this host lives. It is the default for exactly that
   * reason -- and a production host that has signed in under its own default
   * profile sets `default`.
   */
  readonly profile?: 'dev' | 'default';
  readonly timeoutMs?: number;
}

/**
 * A real OpenClaw agent turn, over the recorded CLI contract.
 *
 * `pnpm probe:openclaw` records both halves against the pinned install:
 *
 * 1. **The request** -- `openclaw --dev --no-color agent --local --json
 *    --session-key agent:<id>:<key> --message-file <path>`, recorded as the
 *    argv that was actually exercised.
 * 2. **The reply** -- `{ payloads: [{ text, mediaUrl }], meta: {...} }`,
 *    recorded as a type-only shape so a model's answer never reaches a
 *    committed file.
 *
 * Three things about that argv are load-bearing:
 *
 * - **`--message-file`, never `--message`.** The owner's words must not enter
 *   argv. `checkCommandAllowed` scans every element for forbidden verbs and
 *   matches whole elements, so a ONE-WORD message of "push", "login" or "auth"
 *   would be refused before reaching the subprocess while a longer sentence
 *   sailed through. A failure that narrow is worth designing out rather than
 *   remembering: it would strike rarely, look arbitrary, and be reported as
 *   Ducky ignoring the owner. The body goes into a `0600` file that is removed
 *   in a `finally`.
 * - **`--deliver` is never constructed.** It would send the agent's reply into
 *   a chat channel. Ducky decides where its own output goes.
 * - **`--local`** is what was exercised, so it is what is built. A
 *   gateway-backed run is a different code path and has not been observed.
 *
 * **Attachments stay unavailable.** The recorded agent turn has no attachment
 * input at all -- `attachmentInputOnAgentTurn` is empty in the fixture -- so
 * this is a fact about the provider, not caution. `attachmentsUsable` also
 * requires `verified`, and `verified` is now true, which is exactly why the
 * capability itself must stay honest.
 *
 * See docs/integrations/openclaw.md.
 */
export class GatewayOpenClawProvider implements ConversationProvider {
  readonly name = 'openclaw-gateway';

  /**
   * Whether a contract has been RECORDED, not whether somebody is optimistic.
   *
   * Derived from the source constant rather than set independently, so the two
   * cannot drift: `verified` has to mean "a contract was recorded" or it means
   * nothing, and an operator can set a variable but cannot conjure an observed
   * response shape.
   */
  readonly verified = RECORDED_CONTRACT_VERSION !== null;

  /**
   * Unavailable, and this does not change now that the provider is verified.
   *
   * The recorded agent turn takes TEXT ONLY -- there is no attachment flag on
   * it. `message send --media` exists but is outbound to a chat channel, which
   * is a different operation entirely. Declaring otherwise would be an
   * over-claim on the one gate that decides whether the owner's personal files
   * leave this host.
   */
  readonly capabilities: ConversationCapabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
  };

  private readonly bin: string;
  private readonly profile: 'dev' | 'default';
  private readonly timeoutMs: number;

  /**
   * Whether this provider could serve production traffic.
   *
   * A non-networked, verifiable startup contract: it can initialise only when a
   * recorded contract exists. That is deliberately NOT a flag an operator can
   * set.
   *
   * It says nothing about whether the host has SIGNED IN. Checking that would
   * mean running the CLI at boot, and a login that expired overnight would then
   * stop the coordinator from starting rather than making one reply fail. So a
   * missing account surfaces per request, with the remedy in the message.
   */
  static initializable(): { ok: boolean; reason: string } {
    if (RECORDED_CONTRACT_VERSION === null) {
      return {
        ok: false,
        reason:
          'no OpenClaw contract is recorded on this host. Run `pnpm probe:openclaw`; it records ' +
          'a reply envelope only if a real agent turn succeeds. See docs/integrations/openclaw.md.',
      };
    }
    return { ok: true, reason: `contract ${RECORDED_CONTRACT_VERSION}` };
  }

  constructor(baseUrl: string, opts: GatewayOpenClawOptions = {}) {
    // The gateway URL is not used by the CLI contract -- a `--local` turn talks
    // to no gateway -- but it is still validated, because configuring a public
    // address for this provider means somebody intends a gateway to be reached
    // and should be told now rather than later.
    assertPrivateGatewayUrl(baseUrl);
    this.bin = opts.bin ?? PINNED_BIN;
    this.profile = opts.profile ?? 'dev';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * The argv, built exactly as recorded.
   *
   * Separate from `reply` so a test can assert it against the fixture without
   * running a subprocess -- which is what keeps the adapter pinned to the call
   * that actually produced the observed envelope.
   */
  buildArgv(sessionKey: string, messageFilePath: string): string[] {
    return [
      ...(this.profile === 'dev' ? ['--dev'] : []),
      '--no-color',
      'agent',
      '--local',
      '--json',
      '--session-key',
      sessionKey,
      '--message-file',
      messageFilePath,
    ];
  }

  /**
   * `agent:<id>:<thread>`, the shape the CLI documents.
   *
   * Per (user, thread), matching what bounded continuity already stores. The
   * user id is deliberately absent: a session key is not a secret, but it does
   * not need to carry a Discord id either, and the thread is what scopes a
   * conversation.
   */
  private sessionKeyFor(input: ConversationInput): string {
    const thread = input.threadKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
    return `agent:ducky:${thread}`;
  }

  async reply(input: ConversationInput): Promise<ConversationReply> {
    // Answered separately so the reason is exact: a capability refusal, not
    // "the integration is missing".
    if (input.attachment) {
      throw new DuckyError('attachment_rejected', ATTACHMENTS_UNAVAILABLE_MESSAGE);
    }
    if (RECORDED_CONTRACT_VERSION === null) {
      throw new DuckyError(
        'integration_not_verified',
        'The OpenClaw provider has no recorded contract on this host.',
      );
    }

    /**
     * The owner's message, in a 0600 file, in a 0700 directory of its own.
     *
     * `mkdtemp` rather than a fixed name: two concurrent replies must not share
     * a path, and a predictable one in a shared temp directory is a file
     * anybody on the host could have created first.
     */
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-openclaw-'));
    const messageFile = path.join(dir, 'message.txt');

    try {
      writeFileSync(messageFile, this.promptFrom(input), { mode: 0o600 });
      const argv = this.buildArgv(this.sessionKeyFor(input), messageFile);

      // The frozen argv above decides what can be CONSTRUCTED; the central
      // policy decides whether it may RUN. Both, always.
      const refusal = checkCommandAllowed('openclaw', argv);
      if (refusal) throw new DuckyError('not_enabled_in_phase1', refusal.detail);

      const res = await runArgv(this.bin, argv, { timeoutMs: this.timeoutMs });

      if (res.code !== 0 || res.stdout.trim() === '') {
        // stderr carries the CLI's own diagnostics and can name a provider, a
        // profile or a path. It is redacted and clamped, and never surfaced
        // whole.
        throw new DuckyError(
          'integration_not_verified',
          `The assistant could not answer (${describeFailure(res.stderr)}).`,
        );
      }

      let parsed;
      try {
        parsed = OpenClawReplySchema.parse(JSON.parse(res.stdout));
      } catch {
        // A shape this build does not recognise is a refusal, not a guess: the
        // alternative is rendering whatever happened to be in the JSON as if
        // the assistant had said it.
        throw new DuckyError(
          'integration_not_verified',
          'The assistant returned a reply this build does not recognise.',
        );
      }

      const out = replyTextFrom(parsed);
      if ('refusal' in out) throw new DuckyError('integration_not_verified', out.refusal);
      return { text: out.text, mock: false };
    } finally {
      // On success, on throw, on timeout. The owner's words do not outlive the
      // request that carried them.
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The prompt handed to the agent: earlier turns, then the new message.
   *
   * History is included only because the coordinator already bounded it -- a
   * replay window, a row cap and a per-turn length cap, all applied before this
   * is ever called. Nothing here decides what may be remembered.
   */
  private promptFrom(input: ConversationInput): string {
    const history = (input.history ?? [])
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
      .join('\n');
    return history === '' ? input.text : `${history}\nUser: ${input.text}`;
  }
}

/**
 * A short, redacted reason from a failed run.
 *
 * `ProviderAuthError` is called out by name because it has one cause and one
 * remedy, and an owner reading "could not answer" deserves to know which.
 */
function describeFailure(stderr: string): string {
  const text = redact(stderr);
  if (/ProviderAuthError|No API key found|not signed in/i.test(text)) {
    return 'this host is not signed in to a model provider for OpenClaw';
  }
  const firstLine = text.split('\n').find((l) => l.trim() !== '') ?? 'no diagnostic';
  return firstLine.slice(0, 120);
}
