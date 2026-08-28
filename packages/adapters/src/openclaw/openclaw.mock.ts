import { DuckyError } from '@ducky/contracts';
import {
  NO_ATTACHMENT_CAPABILITY,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from './openclaw.port.js';

/**
 * Refused by BOTH stand-ins, and worth writing once. It is a capability
 * statement, not a policy one: nothing on this host can read those bytes, so
 * saying anything softer would be a promise we cannot keep.
 */
export const ATTACHMENTS_UNAVAILABLE_MESSAGE =
  'No conversational backend that can read files is configured, so attachments are not accepted. ' +
  'The bytes were not downloaded.';

/**
 * Stand-in for the OpenClaw gateway, which is not installed on this host and
 * whose API therefore could not be verified. Replies are canned and always
 * marked, so a canned reply can never be mistaken for a real assistant answer.
 */
export class MockConversationProvider implements ConversationProvider {
  readonly name = 'mock';
  readonly verified = false;

  /**
   * Honest about attachments in both directions: it advertises none, and it
   * still throws if one somehow arrives. The router already refuses before
   * downloading, so reaching this line means a wiring bug -- which should
   * fail loudly rather than silently drop the owner's file on the floor.
   */
  readonly capabilities: ConversationCapabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
  };

  async reply(input: ConversationInput): Promise<ConversationReply> {
    if (input.attachment) {
      throw new DuckyError('attachment_rejected', ATTACHMENTS_UNAVAILABLE_MESSAGE);
    }
    const trimmed = input.text.trim();
    const body =
      trimmed.length === 0
        ? 'I did not catch that.'
        : `No conversational backend is configured, so I cannot answer "${truncate(trimmed, 120)}" yet. ` +
          'Slash commands (/capture, /inbox, /schedule, /job, /jobs, /repo, /status) work normally.';
    return { text: body, mock: true };
  }
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
