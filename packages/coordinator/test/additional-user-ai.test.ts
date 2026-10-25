import { describe, expect, it } from 'vitest';
import { NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION } from '@ducky/adapters';
import type { ConversationInput, ConversationProvider, ConversationReply } from '@ducky/adapters';
import { controlId } from '../src/discord/message.js';
import { Authorizer, loadAuthzConfig } from '../src/security/authz.js';
import { EnvSchema } from '../src/config.js';
import type { Incoming } from '../src/discord/transport.js';
import { CHAT, OWNER, STRANGER, makeHarness, replyText, type Harness } from './helpers.js';

/**
 * Friend-facing AI is off until a supported provider and hosted-use path exist.
 * Being on CHAT_WHITELIST_USER_IDS names who may be offered chat later; it is
 * not that authorization, and these tests prove the model, its memory and its
 * controls are unreachable by a whitelisted user while the switch is off.
 */

const GUILD = '960000000000000001';
const PARENT = '950000000000000001';
const STARTER = '970000000000000001';

class CountingProvider implements ConversationProvider {
  readonly name = 'counting';
  readonly verified = false;
  readonly capabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
    sessionDeletion: NO_SESSION_DELETION('test stand-in'),
  };
  readonly seen: ConversationInput[] = [];
  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.seen.push(input);
    return { text: `echo:${input.text}`, mock: false };
  }
}

const off = (extra: Record<string, string> = {}) => {
  const provider = new CountingProvider();
  const h = makeHarness({
    conversation: provider,
    env: {
      DUCKY_ADDITIONAL_USER_AI_ENABLED: undefined,
      DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
      DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
      ...extra,
    },
  });
  return { h, provider };
};

const start = (h: Harness) => h.transport.start((e) => h.app.router.handle(e));

const message = (userId: string, over: Partial<Extract<Incoming, { kind: 'message' }>> = {}): Incoming => ({
  kind: 'message', userId, text: 'hello', threadKey: 'dm-1', ...over,
});

describe('the configuration default', () => {
  it('is off, and only an explicit true turns it on', () => {
    expect(EnvSchema.parse({ OWNER_DISCORD_USER_ID: OWNER }).DUCKY_ADDITIONAL_USER_AI_ENABLED).toBe(false);
    expect(
      EnvSchema.parse({ OWNER_DISCORD_USER_ID: OWNER, DUCKY_ADDITIONAL_USER_AI_ENABLED: '1' })
        .DUCKY_ADDITIONAL_USER_AI_ENABLED,
    ).toBe(true);
    expect(loadAuthzConfig({ OWNER_DISCORD_USER_ID: OWNER, CHAT_WHITELIST_USER_IDS: CHAT }).additionalUserAi).toBe(false);
  });

  it('answers mayConverse for each role', () => {
    const base = { OWNER_DISCORD_USER_ID: OWNER, CHAT_WHITELIST_USER_IDS: CHAT };
    const closed = new Authorizer(loadAuthzConfig(base));
    const open = new Authorizer(loadAuthzConfig({ ...base, DUCKY_ADDITIONAL_USER_AI_ENABLED: true }));
    expect([closed.mayConverse(OWNER), closed.mayConverse(CHAT), closed.mayConverse(STRANGER)]).toEqual([true, false, false]);
    expect([open.mayConverse(OWNER), open.mayConverse(CHAT), open.mayConverse(STRANGER)]).toEqual([true, true, false]);
  });
});

describe('a whitelisted user with additional-user AI off', () => {
  it('reaches no provider, while the owner still does', async () => {
    const { h, provider } = off();
    await start(h);

    const refused = await h.transport.dispatch(message(CHAT));
    expect(refused?.content).toMatch(/not authorized/i);
    expect(provider.seen).toHaveLength(0);

    const answered = await h.transport.dispatch(message(OWNER));
    expect(replyText(answered)).toContain('echo:hello');
    expect(provider.seen).toHaveLength(1);
    h.close();
  });

  it('stores nothing of theirs and opens no thread for them', async () => {
    const { h, provider } = off();
    await start(h);

    await h.transport.dispatch(
      message(CHAT, {
        threadKey: PARENT, messageId: STARTER, authorKind: 'user',
        context: { channelId: PARENT, guildId: GUILD },
      }),
    );
    expect(provider.seen).toHaveLength(0);
    expect(h.store.conversationThreads.byStarterMessage(STARTER)).toBeUndefined();
    expect(h.store.conversations.countForThread(CHAT, PARENT)).toBe(0);
    h.close();
  });

  it('refuses the Branch and Compact controls even with a valid signature and past participation', async () => {
    // The thread and the chat user's participation exist from when the switch
    // was on; turning it off must take the controls away with no migration.
    const provider = new CountingProvider();
    const on = makeHarness({
      conversation: provider,
      env: { DUCKY_CONVERSATION_MEMORY_ENABLED: 'true', DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT },
    });
    await start(on);
    await on.transport.dispatch({
      kind: 'message', userId: OWNER, text: 'the first question', threadKey: PARENT,
      messageId: STARTER, authorKind: 'user', context: { channelId: PARENT, guildId: GUILD },
    });
    const threadId = on.store.conversationThreads.byStarterMessage(STARTER)!.threadId;
    const spoke = await on.transport.dispatch({
      kind: 'message', userId: CHAT, text: 'me too', threadKey: threadId,
      messageId: '970000000000000050', authorKind: 'user',
      context: { channelId: threadId, guildId: GUILD, parentChannelId: PARENT },
    });
    expect(replyText(spoke)).toContain('echo:me too');
    const before = provider.seen.length;
    const compactId = controlId(
      spoke?.rows?.flatMap((r) => r.buttons).find((b) => b.label === 'Compact'),
    );
    expect(compactId).toBeTruthy();

    const closed = makeHarness({
      conversation: provider,
      env: {
        DUCKY_ADDITIONAL_USER_AI_ENABLED: undefined,
        DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
        DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
      },
      store: on.store,
      registerExecutor: false,
    });
    await start(closed);

    const compact = await closed.transport.dispatch({
      kind: 'component', customId: compactId, userId: CHAT,
    });
    expect(compact?.content).toMatch(/not authorized/i);

    const branchId = closed.app.signer.sign({
      kind: 'conv_branch', entityId: `${threadId}.970000000000000050`, actorUserId: CHAT,
    });
    const branch = await closed.transport.dispatch({
      kind: 'component', customId: branchId, userId: CHAT,
    });
    expect(branch?.content).toMatch(/not authorized/i);

    expect(provider.seen).toHaveLength(before);
    expect(on.store.conversationThreads.checkpointFor(threadId)).toBeUndefined();
    closed.close();
    on.close();
  });

  it('does not let the owner replying to their message count it as a user turn', async () => {
    const { h, provider } = off();
    await start(h);
    await h.transport.dispatch(
      message(OWNER, {
        text: 'what did they say?',
        reference: { authorId: CHAT, text: 'a friend wrote this', messageId: '970000000000000007' } as never,
      }),
    );
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.reference).toBeUndefined();
    h.close();
  });

  it('does use that reference once the switch is on, so the case above can actually fail', async () => {
    const provider = new CountingProvider();
    const h = makeHarness({ conversation: provider });
    await start(h);
    await h.transport.dispatch(
      message(OWNER, {
        text: 'what did they say?',
        reference: { authorId: CHAT, text: 'a friend wrote this', messageId: '970000000000000007' } as never,
      }),
    );
    expect(provider.seen[0]?.reference).toBeDefined();
    h.close();
  });

  it('leaves every owner-only command refused for them, exactly as before', async () => {
    const { h } = off();
    await start(h);
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'jobs', userId: CHAT, options: {},
    });
    expect(reply?.content).toMatch(/not authorized/i);
    h.close();
  });
});
