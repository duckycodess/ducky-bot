import { DuckyError } from '@ducky/contracts';
import {
  NO_ATTACHMENT_CAPABILITY,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from './openclaw.port.js';

export const CONVERSATION_DISABLED_MESSAGE =
  'Conversation is not enabled on this instance. Slash commands work normally.';

/**
 * The honest production answer while no conversational backend is verified.
 *
 * Deliberately NOT the mock. A mock invents a sentence and marks it `[mock]`,
 * which is fine on a development box and wrong on a production one: the owner
 * asked a question and got prose back. This refuses instead, so there is never
 * a generated sentence to mistake for an answer.
 *
 * It throws rather than returning text so the refusal travels the same error
 * path as every other unavailable integration, and so no presenter can render
 * it as if it were a reply.
 */
export class DisabledConversationProvider implements ConversationProvider {
  readonly name = 'disabled';
  readonly verified = false;
  readonly capabilities: ConversationCapabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
  };

  async reply(_input: ConversationInput): Promise<ConversationReply> {
    throw new DuckyError('integration_not_verified', CONVERSATION_DISABLED_MESSAGE);
  }
}
