import { DuckyError } from '@ducky/contracts';
import { RECORDED_CONTRACT_VERSION } from './openclaw.contract.js';
import { assertPrivateGatewayUrl } from './private-url.js';
import { ATTACHMENTS_UNAVAILABLE_MESSAGE } from './openclaw.mock.js';
import {
  NO_ATTACHMENT_CAPABILITY,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from './openclaw.port.js';

/**
 * The guard in front of a real OpenClaw client, and a record of what was
 * actually probed.
 *
 * OpenClaw IS now installed on this host -- pinned, into a dedicated local
 * prefix -- and `pnpm probe:openclaw` records its real surface. Two of the
 * things it recorded matter enough to state here, because the first version of
 * this file assumed otherwise:
 *
 * 1. **It is not an HTTP JSON endpoint.** OpenClaw runs a WebSocket gateway
 *    (`ws://127.0.0.1:19001` on its dev profile), and the supported one-shot
 *    contract is its CLI: `openclaw agent --json --session-key agent:<id>:<key>
 *    --message <text>`, which maps cleanly onto this port. `--deliver` exists
 *    and must NEVER be passed: it would send agent output into a chat channel.
 * 2. **An agent turn takes TEXT ONLY.** There is no attachment flag on it.
 *    `message send --media` is outbound to a chat channel, which is a different
 *    thing entirely -- so `capabilities.attachments` stays unavailable for this
 *    provider even once its text contract is verified.
 *
 * What is still missing is the half a caller does not control: a successful
 * REPLY. An agent turn needs model provider credentials, none are configured
 * here, and the probe records the failure (`ProviderAuthError`, exit 1, empty
 * stdout, diagnostics on stderr) rather than inventing the success shape. So
 * `reply()` still throws, and it points at the integration note.
 *
 * See docs/integrations/openclaw.md.
 */
export class GatewayOpenClawProvider implements ConversationProvider {
  readonly name = 'openclaw-gateway';
  readonly verified = false;

  /**
   * Attachments are advertised as UNAVAILABLE, and will stay that way until
   * the API is verified against a running instance.
   *
   * This is not pessimism: guessing an attachment wire format would be worse
   * than guessing a text one, because the payload is the owner's personal
   * files rather than a sentence. `attachmentsUsable` also requires
   * `verified`, so even flipping this flag alone could not open the path.
   */
  readonly capabilities: ConversationCapabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
  };

  /**
   * Whether this provider could serve production traffic.
   *
   * A non-networked, verifiable startup contract: the provider can initialise
   * only when a recorded contract exists for it.
   *
   * The comment here used to say "OpenClaw is not installed and there are no
   * fixtures", which stopped being true the moment the pinned install landed
   * and `openclaw.fixtures/` filled up. What is missing is narrower and is the
   * only thing that matters: no successful agent turn has been recorded, so
   * `RECORDED_CONTRACT_VERSION` is null and this stays `false`. Production then
   * refuses at startup rather than discovering it on the owner's first message.
   *
   * It is deliberately NOT a flag an operator can set. `verified` has to mean
   * "a contract was recorded", or it means nothing.
   */
  static initializable(): { ok: boolean; reason: string } {
    if (RECORDED_CONTRACT_VERSION === null) {
      return {
        ok: false,
        reason:
          'the OpenClaw contract is recorded only in HALF on this host: the request shape, ' +
          'session semantics, transport and auth model are captured, but no successful agent ' +
          'turn is -- an agent needs model provider credentials, and none are configured, so ' +
          'the reply shape has never been observed. Configure a provider for an OpenClaw ' +
          'agent and run `pnpm probe:openclaw` again. See docs/integrations/openclaw.md.',
      };
    }
    return { ok: true, reason: `contract ${RECORDED_CONTRACT_VERSION}` };
  }

  constructor(baseUrl: string) {
    assertPrivateGatewayUrl(baseUrl);
  }

  async reply(input: ConversationInput): Promise<ConversationReply> {
    // Answered separately from the general failure so the reason is exact:
    // this is a capability refusal, not "the integration is missing".
    if (input.attachment) {
      throw new DuckyError('attachment_rejected', ATTACHMENTS_UNAVAILABLE_MESSAGE);
    }
    throw new DuckyError(
      'integration_not_verified',
      'The OpenClaw provider is not implemented: its reply contract has not been observed on ' +
        'this host, because no model provider credential is configured for an OpenClaw agent. ' +
        'See docs/integrations/openclaw.md.',
    );
  }
}
