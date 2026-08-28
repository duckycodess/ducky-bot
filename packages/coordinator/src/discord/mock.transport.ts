import { sanitizeOutbound } from './sanitize-outbound.js';
import { dmTarget } from './message.js';
import type { OutboundMessage, SendTarget } from './message.js';
import type { DiscordTransport, Incoming, IncomingHandler } from './transport.js';

/**
 * In-memory transport. Drives the tests and a token-less local run, and
 * sanitizes exactly like the real one so the choke point is exercised either
 * way.
 */
export class MockDiscordTransport implements DiscordTransport {
  readonly kind = 'mock';
  readonly sent: { target: SendTarget; message: OutboundMessage }[] = [];
  #handler: IncomingHandler | undefined;

  async start(handler: IncomingHandler): Promise<void> {
    this.#handler = handler;
  }

  async stop(): Promise<void> {
    this.#handler = undefined;
  }

  async send(target: SendTarget, message: OutboundMessage): Promise<void> {
    this.sent.push({ target, message: sanitizeOutbound(message) });
  }

  /** Test helper: pushes an event through the router and returns the reply. */
  async dispatch(event: Incoming): Promise<OutboundMessage | undefined> {
    if (!this.#handler) throw new Error('transport not started');
    const reply = await this.#handler(event);
    if (reply) {
      const safe = sanitizeOutbound(reply);
      this.sent.push({ target: dmTarget(event.userId), message: safe });
      return safe;
    }
    return undefined;
  }

  lastMessage(): OutboundMessage | undefined {
    return this.sent.at(-1)?.message;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
