import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parentChannelIdOfChannel, referenceOf,
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

/** A structurally-typed stand-in for the one discord.js shape used here. */
const messageWith = (over: Record<string, unknown>) =>
  ({
    client: { user: { id: BOT } },
    reference: { messageId: '970000000000000050', channelId: THREAD },
    ...over,
  }) as never;

describe('only the transport may say a message was Ducky’s own', () => {
  it('marks Ducky’s own message as self, from the client id', () => {
    const ref = referenceOf(
      messageWith({ referencedMessage: { content: 'an earlier reply', author: { id: BOT } } }),
    );
    expect(ref?.authorIsSelf).toBe(true);
    expect(ref?.authorId).toBe(BOT);
  });

  it('marks a person’s message as NOT self, whoever they are', () => {
    for (const id of [OWNER, CHAT, STRANGER]) {
      const ref = referenceOf(
        messageWith({ referencedMessage: { content: 'something said', author: { id } } }),
      );
      expect(ref?.authorIsSelf, id).toBe(false);
    }
  });

  it('leaves it UNDEFINED when the client id cannot be read', () => {
    // Undefined is treated by the router as "not Ducky", so an unreadable
    // client loses the anchor rather than mislabelling one.
    const ref = referenceOf(
      messageWith({
        client: { user: null },
        referencedMessage: { content: 'something said', author: { id: OWNER } },
      }),
    );
    expect(ref?.authorIsSelf).toBeUndefined();
  });

  it('carries no text when the referenced message was not cached', () => {
    const ref = referenceOf(messageWith({ referencedMessage: null }));
    expect(ref?.messageId).toBe('970000000000000050');
    expect(ref?.text).toBeUndefined();
    expect(ref?.authorIsSelf).toBeUndefined();
  });

  it('is undefined entirely when the message replies to nothing', () => {
    expect(referenceOf(messageWith({ reference: null }))).toBeUndefined();
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
