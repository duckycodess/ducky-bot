import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_THREAD_ROW_CAP, THREAD_AUTO_ARCHIVE_MINUTES, THREAD_NAME_MAX,
} from '@ducky/contracts';
import { NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION } from '@ducky/adapters';
import type {
  ConversationInput, ConversationProvider, ConversationReply,
} from '@ducky/adapters';
import { CHAT, OWNER, STRANGER, makeHarness, replyText, type Harness } from './helpers.js';
import type { Incoming } from '../src/discord/transport.js';

/**
 * Native Discord threads as durable conversations (issue #4).
 *
 * The properties under test are the ones the acceptance criteria name: exactly
 * one visible thread per qualifying starter, the thread as the conversation's
 * identity, inherited role without inherited rights, full history while the
 * thread lives, bounded context, explicit participation, and an honest refusal
 * whenever Discord will not cooperate.
 */

const GUILD = '960000000000000001';
const PARENT = '950000000000000001';
const OTHER_CHANNEL = '950000000000000002';
const SHARED = '950000000000000003';

/** Records exactly what each turn was handed, so scoping is observable. */
class RecordingProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = false;
  readonly capabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
    sessionDeletion: NO_SESSION_DELETION('test stand-in'),
  };
  readonly seen: ConversationInput[] = [];

  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.seen.push({ ...input, history: [...(input.history ?? [])] });
    return { text: `echo:${input.text}`, mock: false };
  }

  last(): ConversationInput {
    return this.seen[this.seen.length - 1]!;
  }
}

interface ThreadHarness extends Harness {
  readonly provider: RecordingProvider;
}

const withThreads = (extra: Record<string, string> = {}): ThreadHarness => {
  const provider = new RecordingProvider();
  const h = makeHarness({
    conversation: provider,
    env: {
      DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
      DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
      ...extra,
    },
  });
  return { ...h, provider };
};

const started = async (h: Harness): Promise<Harness> => {
  await h.transport.start((e) => h.app.router.handle(e));
  return h;
};

/** A top-level message in a guild channel, as the real transport builds one. */
const topLevel = (over: Partial<Extract<Incoming, { kind: 'message' }>> = {}): Incoming => ({
  kind: 'message',
  userId: OWNER,
  text: 'hello there',
  threadKey: PARENT,
  messageId: '970000000000000001',
  authorKind: 'user',
  context: { channelId: PARENT, guildId: GUILD },
  ...over,
});

/** A message typed inside a thread, which is how Discord reports one. */
const inThread = (
  threadId: string,
  over: Partial<Extract<Incoming, { kind: 'message' }>> = {},
): Incoming => ({
  kind: 'message',
  userId: OWNER,
  text: 'and a follow-up',
  threadKey: threadId,
  messageId: '970000000000000099',
  authorKind: 'user',
  context: { channelId: threadId, guildId: GUILD, parentChannelId: PARENT },
  ...over,
});

describe('one native thread per qualifying starter', () => {
  it('opens exactly one visible thread and routes the starter into it', async () => {
    const h = await started(withThreads()) as ThreadHarness;

    await h.transport.dispatch(topLevel());

    expect(h.transport.threadsCreated).toHaveLength(1);
    const created = h.transport.threadsCreated[0]!;
    expect(created.channelId).toBe(PARENT);
    expect(created.messageId).toBe('970000000000000001');
    expect(created.name.length).toBeLessThanOrEqual(THREAD_NAME_MAX);
    expect(created.name).toContain('hello there');

    // The thread's id IS the conversation. The starter's own turn is stored
    // under it, not under the parent channel.
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(2);
    expect(h.store.conversations.countForThread(OWNER, PARENT)).toBe(0);
    h.close();
  });

  it('continues the same conversation inside the thread, spawning nothing', async () => {
    const h = await started(withThreads()) as ThreadHarness;

    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;
    await h.transport.dispatch(inThread(threadId));

    // One thread, two exchanges, no recursion.
    expect(h.transport.threadsCreated).toHaveLength(1);
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(4);
    // And the second turn saw the first.
    expect(h.provider.last().history?.map((t) => t.text)).toEqual([
      'hello there',
      'echo:hello there',
    ]);
    h.close();
  });

  it('is idempotent: the same starter message never opens a second thread', async () => {
    const h = await started(withThreads()) as ThreadHarness;

    await h.transport.dispatch(topLevel());
    await h.transport.dispatch(topLevel());

    expect(h.transport.threadsCreated).toHaveLength(1);
    h.close();
  });

  it('recovers MESSAGE_ALREADY_HAS_THREAD by the documented id identity', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    // Discord says the message already has one; a thread made from a message
    // carries that message's id, so the conversation is rejoined rather than
    // duplicated.
    h.transport.threadStartFailure = {
      ok: false,
      alreadyExists: true,
      threadId: '970000000000000001',
    };

    await h.transport.dispatch(topLevel());

    const row = h.store.conversationThreads.byStarterMessage('970000000000000001');
    expect(row?.threadId).toBe('970000000000000001');
    expect(h.store.conversations.countForThread(OWNER, '970000000000000001')).toBe(2);
    h.close();
  });

  it('asks for the seven-day auto-archive Discord offers', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    let asked = 0;
    const realStart = h.transport.startThread.bind(h.transport);
    h.transport.startThread = async (input) => {
      expect(input.autoArchiveMinutes).toBe(THREAD_AUTO_ARCHIVE_MINUTES);
      asked += 1;
      return realStart(input);
    };

    await h.transport.dispatch(topLevel());
    expect(asked).toBe(1);
    h.close();
  });
});

describe('what never spawns a thread', () => {
  const refuses = async (event: Incoming, extra: Record<string, string> = {}) => {
    const h = await started(withThreads(extra)) as ThreadHarness;
    await h.transport.dispatch(event);
    const created = h.transport.threadsCreated.length;
    h.close();
    return created;
  };

  it('a bot post', async () => {
    expect(await refuses(topLevel({ authorKind: 'bot' }))).toBe(0);
  });

  it('a webhook notification', async () => {
    expect(await refuses(topLevel({ authorKind: 'webhook' }))).toBe(0);
  });

  it('an author kind the transport could not determine', async () => {
    // Unknown is treated exactly like a bot, so a transport that forgets to
    // populate the field loses the feature rather than carpeting a channel.
    expect(await refuses(topLevel({ authorKind: 'unknown' }))).toBe(0);
  });

  it('a channel nobody configured', async () => {
    expect(
      await refuses(
        topLevel({ threadKey: OTHER_CHANNEL, context: { channelId: OTHER_CHANNEL, guildId: GUILD } }),
      ),
    ).toBe(0);
  });

  it('a DM, which has no guild', async () => {
    expect(await refuses(topLevel({ context: { channelId: PARENT, guildId: undefined } }))).toBe(0);
  });

  it('a message already inside a thread', async () => {
    expect(await refuses(inThread('970000000000000055'))).toBe(0);
  });

  it('a stranger, who would get no answer anyway', async () => {
    expect(await refuses(topLevel({ userId: STRANGER }))).toBe(0);
  });

  it('a message whose id the transport did not report', async () => {
    expect(await refuses(topLevel({ messageId: undefined }))).toBe(0);
  });

  it('every channel, when no parent is configured at all', async () => {
    const h = await started(
      makeHarness({
        conversation: new RecordingProvider(),
        env: { DUCKY_CONVERSATION_MEMORY_ENABLED: 'true' },
      }),
    );
    await h.transport.dispatch(topLevel());
    expect(h.transport.threadsCreated).toHaveLength(0);
    h.close();
  });
});

describe('configuration refuses a channel that is not a conversation', () => {
  it('refuses a shared channel as a thread parent, at boot', () => {
    expect(() =>
      makeHarness({
        env: {
          DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED,
          DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: SHARED,
        },
      }),
    ).toThrow(/shared/i);
  });

  it('refuses a briefing channel, which is where output is delivered', () => {
    expect(() =>
      makeHarness({
        env: {
          DUCKY_DEV_BRIEFING_CHANNEL_ID: OTHER_CHANNEL,
          DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: OTHER_CHANNEL,
        },
      }),
    ).toThrow(/not a conversation channel/i);
  });

  it('refuses a task channel, which is for personal records', () => {
    expect(() =>
      makeHarness({
        env: {
          DUCKY_DEV_TASK_CHANNEL_ID: OTHER_CHANNEL,
          DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: OTHER_CHANNEL,
        },
      }),
    ).toThrow(/not a conversation channel/i);
  });

  it('accepts the gpt channel, which is exactly what it is for', async () => {
    const h = await started(
      makeHarness({
        conversation: new RecordingProvider(),
        env: {
          DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
          DUCKY_DEV_GPT_CHANNEL_ID: PARENT,
          DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
        },
      }),
    );
    await h.transport.dispatch(topLevel());
    expect(h.transport.threadsCreated).toHaveLength(1);
    h.close();
  });

  it('refuses a value that is not a Discord channel id', () => {
    expect(() =>
      makeHarness({ env: { DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: 'general' } }),
    ).toThrow(/not a Discord channel id/i);
  });
});

describe('a thread that cannot be opened is refused, never redirected', () => {
  for (const [failure, pattern] of [
    ['forbidden', /Create Public Threads/i],
    ['rate_limited', /rate-limit/i],
    ['unavailable', /could not open a thread/i],
  ] as const) {
    it(`refuses visibly on ${failure} and answers nowhere else`, async () => {
      const h = await started(withThreads()) as ThreadHarness;
      h.transport.threadStartFailure = { ok: false, failure };

      const reply = await h.transport.dispatch(topLevel());

      expect(reply?.content).toMatch(pattern);
      // The whole point: no answer in the parent, and no conversation stored
      // against it either.
      expect(h.provider.seen).toHaveLength(0);
      expect(h.store.conversations.countForThread(OWNER, PARENT)).toBe(0);
      h.close();
    });
  }
});

describe('a thread inherits its parent’s role and none of anybody’s rights', () => {
  it('answers in a thread under the configured gpt channel', async () => {
    // Containment used to compare the incoming channel id against the
    // configured gpt id, and a thread's id is not its parent's -- so every
    // thread under the channel designated FOR conversation was silenced.
    const h = await started(
      makeHarness({
        conversation: new RecordingProvider(),
        env: {
          DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
          DUCKY_DEV_GPT_CHANNEL_ID: PARENT,
          DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
        },
      }),
    );

    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;
    const reply = await h.transport.dispatch(inThread(threadId));

    expect(replyText(reply)).toContain('echo:');
    h.close();
  });

  it('still silences an unrelated guild channel when gpt is configured', async () => {
    const h = await started(
      makeHarness({
        conversation: new RecordingProvider(),
        env: {
          DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
          DUCKY_DEV_GPT_CHANNEL_ID: PARENT,
          DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
        },
      }),
    );

    const reply = await h.transport.dispatch(
      topLevel({
        threadKey: OTHER_CHANNEL,
        messageId: '970000000000000003',
        context: { channelId: OTHER_CHANNEL, guildId: GUILD },
      }),
    );
    expect(reply).toBeUndefined();
    h.close();
  });

  it('lets the extra chat user converse in a thread and act on nothing', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;

    const chat = await h.transport.dispatch(
      inThread(threadId, { userId: CHAT, text: 'hello from the whitelist' }),
    );
    expect(replyText(chat)).toContain('echo:');

    // Every owner-only command, in the very same thread, is refused.
    for (const name of ['jobs', 'task', 'forget', 'status']) {
      const refused = await h.transport.dispatch({
        kind: 'command',
        name,
        userId: CHAT,
        options: {},
        context: { channelId: threadId, guildId: GUILD, parentChannelId: PARENT },
      });
      expect(refused?.content, name).toMatch(/not authorized/i);
    }
    h.close();
  });

  it('refuses an owner workflow control pressed by the extra chat user', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    // A control the OWNER minted, pressed by somebody else. The signature is
    // bound to the owner, so visibility buys nothing.
    const ownerControl = h.app.signer.sign({
      kind: 'task_done',
      entityId: 'tsk-1234',
      actorUserId: OWNER,
    });
    const refused = await h.transport.dispatch({
      kind: 'component',
      customId: ownerControl,
      userId: CHAT,
    });
    expect(refused?.content).toMatch(/not authorized/i);
    h.close();
  });
});

describe('full history while the thread lives, bounded context per turn', () => {
  it('keeps every turn of a native thread past the legacy row cap', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;

    // Well past the per-thread cap an ordinary channel is held to.
    for (let i = 0; i < CONVERSATION_THREAD_ROW_CAP; i += 1) {
      await h.transport.dispatch(
        inThread(threadId, { text: `turn ${i}`, messageId: `97000000000000${1000 + i}` }),
      );
    }

    const stored = h.store.conversations.countForThread(OWNER, threadId);
    expect(stored).toBeGreaterThan(CONVERSATION_THREAD_ROW_CAP);
    h.close();
  });

  it('still caps an ordinary channel, exactly as ADR 0021 shipped it', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    for (let i = 0; i < 10; i += 1) {
      h.store.conversations.append({
        id: `t-${i}`,
        discordUserId: OWNER,
        threadKey: 'dm-1',
        role: 'user',
        content: `turn ${i}`,
        rowCap: 5,
      });
    }
    expect(h.store.conversations.countForThread(OWNER, 'dm-1')).toBe(5);
    h.close();
  });

  it('compacts automatically rather than exceeding the byte budget', async () => {
    const h = await started(withThreads({
      // Small enough that a handful of long turns will not fit.
      DUCKY_CONVERSATION_CONTEXT_BUDGET_BYTES: '2000',
    })) as ThreadHarness;

    await h.transport.dispatch(topLevel({ text: 'x'.repeat(300) }));
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;
    for (let i = 0; i < 20; i += 1) {
      await h.transport.dispatch(
        inThread(threadId, { text: `${'y'.repeat(300)} ${i}`, messageId: `97000000000000${2000 + i}` }),
      );
    }

    const checkpoint = h.store.conversationThreads.checkpointFor(threadId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.turnsCovered).toBeGreaterThan(0);

    // Nothing was deleted to achieve it.
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(42);

    // And what the provider actually received stayed inside the budget.
    const last = h.provider.last();
    const sent =
      (last.checkpoint ?? '').length +
      (last.history ?? []).reduce((n, t) => n + t.text.length, 0) +
      last.text.length;
    expect(sent).toBeLessThanOrEqual(2000);
    h.close();
  });

  it('refuses a turn whose context cannot be brought under the budget', async () => {
    const h = await started(withThreads({
      DUCKY_CONVERSATION_CONTEXT_BUDGET_BYTES: '2000',
    })) as ThreadHarness;

    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;

    const reply = await h.transport.dispatch(
      inThread(threadId, { text: 'z'.repeat(5000), messageId: '970000000000003001' }),
    );

    expect(reply?.content).toMatch(/too large/i);
    // Refused BEFORE the provider was called, and nothing was stored.
    expect(h.provider.seen).toHaveLength(1);
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(2);
    h.close();
  });

  it('survives a restart with the same thread identity and the same history', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;
    await h.transport.dispatch(inThread(threadId, { text: 'before the restart' }));

    // A second app over the SAME store is what a restart looks like from the
    // database's point of view.
    const restarted = makeHarness({
      conversation: new RecordingProvider(),
      env: {
        DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
        DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
      },
      store: h.store,
      registerExecutor: false,
    });
    await restarted.transport.start((e) => restarted.app.router.handle(e));

    expect(restarted.app.conversationThreads.isNativeThread(threadId)).toBe(true);
    const reply = await restarted.transport.dispatch(
      inThread(threadId, { text: 'after the restart', messageId: '970000000000004001' }),
    );
    expect(replyText(reply)).toContain('echo:');
    expect(restarted.store.conversations.countForThread(OWNER, threadId)).toBe(6);
    restarted.close();
  });
});

describe('participation is explicit, and it is what a thread read requires', () => {
  it('issues no proof to somebody who has never spoken in the thread', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    await h.transport.dispatch(topLevel());
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;

    expect(h.app.conversationMemory.participation(h.owner, threadId)).toBeDefined();
    expect(h.app.conversationMemory.participation(h.chat, threadId)).toBeUndefined();
    h.close();
  });

  it('replays nothing of a thread to a reader who only watched', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    await h.transport.dispatch(topLevel({ text: 'something the owner said' }));
    const threadId = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;

    // The whitelist user's FIRST turn in the thread: they were not a
    // participant when the context was assembled, so they get nothing.
    await h.transport.dispatch(inThread(threadId, { userId: CHAT, text: 'first words' }));
    expect(h.provider.last().history ?? []).toEqual([]);
    h.close();
  });

  it('never replays one thread into another', async () => {
    const h = await started(withThreads()) as ThreadHarness;
    await h.transport.dispatch(topLevel({ text: 'first conversation' }));
    const first = h.store.conversationThreads.byStarterMessage('970000000000000001')!.threadId;
    await h.transport.dispatch(inThread(first, { text: 'more of the first' }));

    await h.transport.dispatch(
      topLevel({ text: 'second conversation', messageId: '970000000000000002' }),
    );
    const second = h.store.conversationThreads.byStarterMessage('970000000000000002')!.threadId;

    expect(second).not.toBe(first);
    expect(h.provider.last().history ?? []).toEqual([]);
    expect(h.provider.last().checkpoint).toBeUndefined();
    h.close();
  });

  it('never makes a thread under a shared channel a conversation store', async () => {
    const h = await started(
      makeHarness({
        conversation: new RecordingProvider(),
        env: {
          DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
          DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED,
        },
      }),
    );

    await h.transport.dispatch({
      kind: 'message',
      userId: OWNER,
      text: 'said in a thread under a channel other people read',
      threadKey: '970000000000005001',
      messageId: '970000000000005002',
      authorKind: 'user',
      context: { channelId: '970000000000005001', guildId: GUILD, parentChannelId: SHARED },
    });

    expect(h.store.conversations.countForThread(OWNER, '970000000000005001')).toBe(0);
    h.close();
  });
});
