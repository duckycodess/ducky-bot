import type { ConversationInput, ConversationProvider, ConversationReply } from './openclaw.port.js';

/**
 * Stand-in for the OpenClaw gateway, which is not installed on this host and
 * whose API therefore could not be verified. Replies are canned and always
 * marked, so a canned reply can never be mistaken for a real assistant answer.
 */
export class MockConversationProvider implements ConversationProvider {
  readonly name = 'mock';
  readonly verified = false;

  async reply(input: ConversationInput): Promise<ConversationReply> {
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
