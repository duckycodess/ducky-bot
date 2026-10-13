import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parentChannelIdOfChannel, resolveReference,
} from '../src/discord/discordjs.transport.js';
import { ReplyPersistencePolicy } from '../src/domain/reply-persistence.js';
import { ChannelRolePolicy } from '../src/domain/channel-roles.js';
import { CHAT, OWNER, STRANGER } from './helpers.js';

/**
 * The transport half of native threads.
 *
 * Three things live only here and cannot be asserted through the router: the
 * bot's own identity (which is what makes an `assistant` anchor label
 * possible), the gateway event that tells Ducky a thread is gone, and the
 * parent-channel resolution a slash command needs in order to inherit a role.
 */

const TRANSPORT_SRC = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'discord', 'discordjs.transport.ts'),
  'utf8',
);

const BOT = '111111111111111111';
const THREAD = '970000000000000001';

/**
 * A stand-in shaped like the discord.js objects this code actually touches.
 *
 * It models the REAL mechanism rather than a convenient one, which is the
 * whole point of rewriting these: the previous version built a
 * `referencedMessage` field that discord.js has never had, so the tests passed
 * against a shape production never produces and the feature was dead.
 *
 * What discord.js v14 really does: for a reply it ships `referenced_message`
 * inline on the gateway payload and `_add`s it to the CHANNEL'S MESSAGE CACHE,
 * leaving `message.reference` as ids only. An older reply misses the cache and
 * needs `fetchReference()`.
 */
const messageLike = (over: {
  channelId?: string;
  reference?: { messageId?: string; channelId?: string; type?: number } | null;
  cached?: Record<string, { content?: string; author?: { id?: string } }>;
  fetchReference?: () => Promise<unknown>;
  selfId?: string | null;
}) => {
  const cache = over.cached ?? {};
  return {
    channelId: over.channelId ?? THREAD,
    client: { user: over.selfId === null ? null : { id: over.selfId ?? BOT } },
    reference: over.reference === undefined
      ? { messageId: ANCHOR, channelId: THREAD, type: 0 }
      : over.reference,
    channel: { messages: { cache: { get: (id: string) => cache[id] } } },
    ...(over.fetchReference ? { fetchReference: over.fetchReference } : {}),
  } as never;
};

const ANCHOR = '970000000000000050';

describe('a reply anchor is read the way discord.js actually exposes one', () => {
  it('reads the referenced message out of the channel cache, with no API call', async () => {
    let fetched = 0;
    const ref = await resolveReference(
      messageLike({
        cached: { [ANCHOR]: { content: 'the earlier question', author: { id: OWNER } } },
        fetchReference: async () => {
          fetched += 1;
          return undefined;
        },
      }),
      { mayFetch: true },
    );

    expect(ref?.text).toBe('the earlier question');
    expect(ref?.authorId).toBe(OWNER);
    expect(ref?.authorIsSelf).toBe(false);
    // The cache hit is the common case; it must not cost a REST call.
    expect(fetched).toBe(0);
  });

  it('falls back to fetchReference when the cache has aged out', async () => {
    const ref = await resolveReference(
      messageLike({
        cached: {},
        fetchReference: async () => ({
          content: 'something said last week',
          author: { id: OWNER },
        }),
      }),
      { mayFetch: true },
    );

    expect(ref?.text).toBe('something said last week');
    expect(ref?.authorId).toBe(OWNER);
  });

  /**
   * The REST call is the expensive half, so it is gated on the sender being
   * somebody Ducky would answer. The router refuses an unauthorized sender a
   * moment later -- but the call would already have happened by then, spending
   * the bot's shared rate budget on a stranger replying to old messages.
   */
  it('does NOT fetch on a cache miss when the sender may not converse', async () => {
    let fetched = 0;
    const ref = await resolveReference(
      messageLike({
        cached: {},
        fetchReference: async () => {
          fetched += 1;
          return { content: 'an older message', author: { id: OWNER } };
        },
      }),
      { mayFetch: false },
    );

    expect(fetched).toBe(0);
    // The reference still exists, carrying ids and no text, so the router says
    // the message was unreadable rather than that there was no reply.
    expect(ref?.messageId).toBe(ANCHOR);
    expect(ref?.text).toBeUndefined();
  });

  it('still reads the FREE half of the cache for anybody', async () => {
    // A cache hit costs nothing, so gating it would lose the feature for no
    // saving. Only the call that leaves the process is gated.
    const ref = await resolveReference(
      messageLike({
        cached: { [ANCHOR]: { content: 'already in the cache', author: { id: OWNER } } },
      }),
      { mayFetch: false },
    );
    expect(ref?.text).toBe('already in the cache');
  });

  it('fetches for nobody when the transport was given no predicate', async () => {
    // Fail closed: an unwired transport loses the uncached half rather than
    // making API calls on behalf of strangers.
    let fetched = 0;
    await resolveReference(
      messageLike({
        cached: {},
        fetchReference: async () => {
          fetched += 1;
          return undefined;
        },
      }),
    );
    expect(fetched).toBe(0);
  });

  it('returns the reference WITHOUT text when the fetch fails', async () => {
    // Deleted, or inaccessible. The router then says "I could not read the
    // message you replied to" rather than acting as though there was no reply.
    const ref = await resolveReference(
      messageLike({
        cached: {},
        fetchReference: async () => {
          throw new Error('Unknown Message');
        },
      }),
      { mayFetch: true },
    );

    expect(ref?.messageId).toBe(ANCHOR);
    expect(ref?.text).toBeUndefined();
    expect(ref?.authorId).toBeUndefined();
  });

  it('never fetches a message from another channel', async () => {
    /**
     * `fetchReference` resolves the REFERENCE's channel, which may be anywhere.
     * The router drops a cross-thread anchor, but only after the transport has
     * already read it -- and reading it was the part that should not happen.
     */
    let fetched = 0;
    const ref = await resolveReference(
      messageLike({
        channelId: THREAD,
        reference: { messageId: ANCHOR, channelId: '970000000000009999', type: 0 },
        cached: {},
        fetchReference: async () => {
          fetched += 1;
          return { content: 'a secret from another channel', author: { id: OWNER } };
        },
      }),
      { mayFetch: true },
    );

    expect(fetched).toBe(0);
    expect(ref?.channelId).toBe('970000000000009999');
    expect(ref?.text).toBeUndefined();
  });

  it('treats a FORWARD as not a reply at all', async () => {
    // Shares the `message_reference` field and means something else: a forward
    // relays somebody else's message rather than pointing at one here.
    const ref = await resolveReference(
      messageLike({
        reference: { messageId: ANCHOR, channelId: THREAD, type: 1 },
        cached: { [ANCHOR]: { content: 'forwarded text', author: { id: OWNER } } },
      }),
    );
    expect(ref).toBeUndefined();
  });

  it('is undefined entirely when the message replies to nothing', async () => {
    expect(await resolveReference(messageLike({ reference: null }))).toBeUndefined();
  });
});

describe('only the transport may say a message was Ducky’s own', () => {
  const cachedFrom = (authorId: string) =>
    messageLike({ cached: { [ANCHOR]: { content: 'an earlier reply', author: { id: authorId } } } });

  it('marks Ducky’s own message as self, from the client id', async () => {
    const ref = await resolveReference(cachedFrom(BOT));
    expect(ref?.authorIsSelf).toBe(true);
    expect(ref?.authorId).toBe(BOT);
  });

  it('marks a person’s message as NOT self, whoever they are', async () => {
    for (const id of [OWNER, CHAT, STRANGER]) {
      const ref = await resolveReference(cachedFrom(id));
      expect(ref?.authorIsSelf, id).toBe(false);
    }
  });

  it('leaves it UNDEFINED when the client id cannot be read', async () => {
    // Undefined is treated by the router as "not Ducky", so an unreadable
    // client loses the anchor rather than mislabelling one.
    const ref = await resolveReference(
      messageLike({
        selfId: null,
        cached: { [ANCHOR]: { content: 'an earlier reply', author: { id: OWNER } } },
      }),
    );
    expect(ref?.authorIsSelf).toBeUndefined();
  });
});

describe('a deleted thread is learned from the gateway, not only from a failed send', () => {
  /**
   * The failed-send path alone was unreachable in practice: a deleted thread
   * emits no `MessageCreate`, and a reply inside a live thread goes through
   * `message.reply`, so `sendToChannel` is only ever called for a thread Ducky
   * has just created. The retention clock would effectively never start.
   */
  it('registers Events.ThreadDelete and routes it to the thread-gone hook', () => {
    expect(TRANSPORT_SRC).toMatch(/client\.on\(Events\.ThreadDelete/);
    const handler = /client\.on\(Events\.ThreadDelete[\s\S]{0,400}?\n {4}\}\);/.exec(
      TRANSPORT_SRC,
    )?.[0] ?? '';
    expect(handler).toMatch(/this\.#threadGone\?\.\(thread\.id\)/);
  });

  it('does NOT treat an archived thread as a deleted one', () => {
    // Posting in an archived but unlocked thread unarchives it, which is how a
    // conversation resumes after a week of quiet. Ageing one out because it
    // went quiet would delete a conversation somebody can still scroll back to.
    expect(TRANSPORT_SRC).not.toMatch(/Events\.ThreadUpdate/);
  });

  it('keeps the failed-send path as the fallback for a deletion missed while down', () => {
    expect(TRANSPORT_SRC).toMatch(/UNKNOWN_CHANNEL/);
  });

  it('asks for no new gateway intent: ThreadDelete rides Guilds', () => {
    // The whole reason this event was chosen over a channel-delete sweep or a
    // new intent. The requested set must be exactly the four it already was.
    const requested = [...TRANSPORT_SRC.matchAll(/GatewayIntentBits\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(requested)].sort()).toEqual([
      'DirectMessages', 'GuildMessages', 'Guilds', 'MessageContent',
    ]);
  });
});

describe('every message reply leaves through the sanitizer', () => {
  /**
   * The thread refusal path built a payload directly and never passed through
   * `sanitizeOutbound`. The strings were fixed so nothing leaked -- but the
   * guarantee this codebase states is structural ("all Discord output goes
   * through sanitizeOutbound, called inside the transport so it cannot be
   * bypassed"), and a guarantee that holds because today's strings happen to
   * be safe is not that guarantee.
   */
  it('gates the anchor fetch on the injected authorization predicate', () => {
    // The transport holds no authorization rule of its own: it asks and obeys,
    // the same way it does for reply persistence.
    expect(TRANSPORT_SRC).toMatch(/mayFetch: this\.mayConverse\?\.\(message\.author\.id\) \?\? false/);
  });

  it('calls message.reply from exactly one place', () => {
    const calls = [...TRANSPORT_SRC.matchAll(/\bmessage\s*\n?\s*\.reply\(/g)];
    expect(calls).toHaveLength(1);
  });

  it('sanitizes in that one place', () => {
    const replyTo = /private async replyTo\([\s\S]*?\n {2}\}/.exec(TRANSPORT_SRC)?.[0] ?? '';
    expect(replyTo).toMatch(/sanitizeOutbound\(outbound\)/);
    expect(replyTo).toMatch(/message\.reply\(payload\)/);
  });

  it('sanitizes the thread-delivery path too, and takes an OutboundMessage', () => {
    // Taking an already-built payload would let a caller hand it something
    // that skipped the choke point.
    const send = /private async sendToChannel\([\s\S]*?\n {2}\}/.exec(TRANSPORT_SRC)?.[0] ?? '';
    expect(send).toMatch(/outbound: OutboundMessage/);
    expect(send).toMatch(/sanitizeOutbound\(outbound\)/);
  });

  it('builds no payload anywhere without sanitizing first', () => {
    // Every remaining `toDiscordPayload` takes either a sanitized value or a
    // reply that came back through `route`, which sanitizes.
    const unsanitized = [...TRANSPORT_SRC.matchAll(/toDiscordPayload\((?!sanitizeOutbound)/g)]
      .map((m) => TRANSPORT_SRC.slice(m.index, (m.index ?? 0) + 60));
    for (const call of unsanitized) {
      expect(call, call).toMatch(/toDiscordPayload\(reply\)/);
    }
  });
});

describe('a slash command in a thread resolves its parent like a message does', () => {
  it('reports the parent of a thread channel', () => {
    expect(
      parentChannelIdOfChannel({ isThread: () => true, parentId: '950000000000000001' }),
    ).toBe('950000000000000001');
  });

  it('reports nothing for a top-level channel', () => {
    expect(parentChannelIdOfChannel({ isThread: () => false, parentId: '95' })).toBeUndefined();
  });

  it('reports nothing for a DM, which cannot answer isThread', () => {
    expect(parentChannelIdOfChannel({})).toBeUndefined();
    expect(parentChannelIdOfChannel(null)).toBeUndefined();
  });

  it('lets a command in a thread inherit its parent’s role, so its reply persists', () => {
    /**
     * A message carried the parent from the start and a command did not, so
     * the two disagreed about one channel: `/task list` typed in a thread
     * under the configured task channel had no role and fell back to
     * ephemeral, while a plain message in the same thread persisted.
     */
    const roles = new ChannelRolePolicy({ task: '950000000000000001' });
    const policy = new ReplyPersistencePolicy(roles, OWNER);

    const inThread = {
      userId: OWNER,
      kind: 'command' as const,
      commandName: 'task',
      context: {
        channelId: THREAD,
        guildId: '960000000000000001',
        parentChannelId: '950000000000000001',
      },
    };
    expect(policy.persists(inThread)).toBe(true);

    // And it is still a ROLE, not a right: a non-owner gets nothing from it.
    expect(policy.persists({ ...inThread, userId: CHAT })).toBe(false);
    // Nor does a thread under an unconfigured channel.
    expect(
      policy.persists({
        ...inThread,
        context: { ...inThread.context, parentChannelId: '950000000000000009' },
      }),
    ).toBe(false);
  });
});
