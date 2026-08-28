import { DuckyError } from '@ducky/contracts';
import { assertPrivateGatewayUrl } from './private-url.js';
import { ATTACHMENTS_UNAVAILABLE_MESSAGE } from './openclaw.mock.js';
import {
  NO_ATTACHMENT_CAPABILITY,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from './openclaw.port.js';

/**
 * Placeholder for the real gateway client.
 *
 * OpenClaw is not installed on this host, so its routes, auth model and
 * response shape could not be verified. Rather than guess an API, every method
 * fails loudly and points at the integration note. The private-URL guard still
 * runs at construction so a misconfigured public gateway is caught even before
 * the integration exists.
 *
 * See docs/integrations/openclaw.md for what has to be probed to finish this.
 */
export class HttpOpenClawProvider implements ConversationProvider {
  readonly name = 'openclaw-http';
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
      'The OpenClaw HTTP provider is not implemented: its API has not been verified on this host. See docs/integrations/openclaw.md.',
    );
  }
}
