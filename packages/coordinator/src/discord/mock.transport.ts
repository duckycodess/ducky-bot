import { sanitizeOutbound } from './sanitize-outbound.js';
import { dmTarget } from './message.js';
import type { ThreadStartOutcome } from '../domain/conversation-threads.js';
import type { OutboundMessage, SendTarget } from './message.js';
import type {
  ConversationThreadEntry, DiscordTransport, Incoming, IncomingHandler,
} from './transport.js';

/**
 * In-memory transport. Drives the tests and a token-less local run, and
 * sanitizes exactly like the real one so the choke point is exercised either
 * way.
 */
export class MockDiscordTransport implements DiscordTransport {
  readonly kind = 'mock';
  readonly sent: { target: SendTarget; message: OutboundMessage }[] = [];
  #handler: IncomingHandler | undefined;
  #enterThread: ConversationThreadEntry | undefined;

  /**
   * Threads this stand-in has "created", by id.
   *
   * Recorded so a test can assert that exactly one thread was opened per
   * starter -- the property the whole feature turns on -- without needing
   * Discord.
   */
  readonly threadsCreated: { channelId: string; messageId?: string; name: string }[] = [];

  /**
   * Set to make thread creation fail, the way a missing permission or a rate
   * limit does. Without a way to fail, a test can only ever exercise the happy
   * path -- and the refusal branch is the one that must never fall back into
   * the parent conversation.
   */
  threadStartFailure: ThreadStartOutcome | undefined;

  #threadGone: ((threadId: string) => void) | undefined;

  useConversationThreads(enter: ConversationThreadEntry, onGone?: (threadId: string) => void): void {
    this.#enterThread = enter;
    this.#threadGone = onGone;
  }

  /**
   * Test helper: models Discord answering `Unknown Channel` for a thread.
   *
   * The real transport learns this by trying to post into a thread that is no
   * longer there; a test should not have to fake a REST error to exercise what
   * follows from it.
   */
  markThreadGone(threadId: string): void {
    this.#threadGone?.(threadId);
  }

  async start(handler: IncomingHandler): Promise<void> {
    this.#handler = handler;
  }

  /**
   * Mirrors Discord's own identity rather than inventing one: a thread started
   * FROM a message carries that message's id. A standalone thread (what Branch
   * opens) gets a synthetic snowflake-shaped id, because Discord would assign
   * one too.
   */
  async startThread(input: {
    readonly channelId: string;
    readonly messageId?: string | undefined;
    readonly name: string;
    readonly autoArchiveMinutes: number;
  }): Promise<ThreadStartOutcome> {
    if (this.threadStartFailure) return this.threadStartFailure;
    this.threadsCreated.push({
      channelId: input.channelId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      name: input.name,
    });
    const threadId = input.messageId
      ?? String(900000000000000000n + BigInt(this.threadsCreated.length));
    return { ok: true, threadId };
  }

  async stop(): Promise<void> {
    this.#handler = undefined;
  }

  /**
   * Set to model a transport that cannot deliver right now.
   *
   * Every proactive path retries on a durable ledger rather than in memory, and
   * "the send failed" is the branch that proves it: without a way to fail, a
   * test can only ever exercise the happy path.
   */
  failSends = false;

  async send(target: SendTarget, message: OutboundMessage): Promise<void> {
    if (this.failSends) throw new Error('mock transport: delivery refused');
    this.sent.push({ target, message: sanitizeOutbound(message) });
  }

  /**
   * The in-memory editable-message store.
   *
   * Modelled rather than stubbed, because the property under test is that a
   * card is EDITED and not reposted -- which a stub that always appends could
   * not distinguish from a bug.
   */
  readonly cards = new Map<string, { target: SendTarget; message: OutboundMessage }>();
  #nextCardId = 1;
  /** Set to model a card the owner deleted. The caller must post a fresh one. */
  missingCardIds = new Set<string>();

  async sendCard(target: SendTarget, message: OutboundMessage): Promise<string | undefined> {
    if (this.failSends) throw new Error('mock transport: delivery refused');
    const id = `m${this.#nextCardId++}`;
    const safe = sanitizeOutbound(message);
    this.cards.set(id, { target, message: safe });
    this.sent.push({ target, message: safe });
    return id;
  }

  async updateCard(
    target: SendTarget,
    messageId: string,
    message: OutboundMessage,
  ): Promise<boolean> {
    if (this.failSends) throw new Error('mock transport: delivery refused');
    if (this.missingCardIds.has(messageId) || !this.cards.has(messageId)) return false;
    this.cards.set(messageId, { target, message: sanitizeOutbound(message) });
    return true;
  }

  /** Test helper: the card as it now reads, after every edit. */
  card(messageId: string): OutboundMessage | undefined {
    return this.cards.get(messageId)?.message;
  }

  /**
   * Test helper: pushes an event through the router and returns the reply.
   *
   * It runs the SAME thread-entry hook the real transport does, so a test
   * exercises the real decision, the real mapping write and the real rerouting
   * rather than a simplified stand-in of them.
   */
  async dispatch(event: Incoming): Promise<OutboundMessage | undefined> {
    if (!this.#handler) throw new Error('transport not started');

    let routed = event;
    if (event.kind === 'message' && this.#enterThread) {
      const outcome = await this.#enterThread(event);
      if (outcome.kind === 'refused') {
        const refusal = sanitizeOutbound({ content: outcome.message, ephemeral: false });
        this.sent.push({ target: dmTarget(event.userId), message: refusal });
        return refusal;
      }
      if (outcome.kind === 'thread' && outcome.threadId !== event.threadKey) {
        routed = {
          ...event,
          threadKey: outcome.threadId,
          context: {
            channelId: outcome.threadId,
            guildId: event.context?.guildId,
            parentChannelId: event.context?.channelId,
          },
        };
      }
    }

    const reply = await this.#handler(routed);
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
