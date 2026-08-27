import { DuckyError } from '@ducky/contracts';
import { assertPrivateGatewayUrl } from './private-url.js';
import type { ConversationInput, ConversationProvider, ConversationReply } from './openclaw.port.js';

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

  constructor(baseUrl: string) {
    assertPrivateGatewayUrl(baseUrl);
  }

  async reply(_input: ConversationInput): Promise<ConversationReply> {
    throw new DuckyError(
      'integration_not_verified',
      'The OpenClaw HTTP provider is not implemented: its API has not been verified on this host. See docs/integrations/openclaw.md.',
    );
  }
}
