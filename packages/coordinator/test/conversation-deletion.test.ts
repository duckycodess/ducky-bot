import { describe, expect, it } from 'vitest';
import { RetentionService } from '../src/domain/retention.service.js';
import { NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION } from '@ducky/adapters';
import type {
  ConversationInput, ConversationProvider, ConversationReply,
} from '@ducky/adapters';
import { CHAT, OWNER, STRANGER, makeHarness, type Harness } from './helpers.js';
import type { Incoming } from '../src/discord/transport.js';

/**
 * Two-store deletion (ADR 0024, extended by ADR 0025).
 *
 * `/forget conversation` reaches ONE of the two stores. The property under test
 * is that it says so, and that what it can do about the other store -- stop
 * using the contaminated session -- actually happens and is described as
 * orphaning rather than as erasure.
 */

const GUILD = '960000000000000001';
const PARENT = '950000000000000001';
const STARTER = '970000000000000001';

class RecordingProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = false;
  readonly capabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
    sessionDeletion: NO_SESSION_DELETION(
      'no OpenClaw session-deletion contract has been recorded on this host',
    ),
  };
  readonly seen: ConversationInput[] = [];

  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.seen.push({ ...input });
    return { text: `echo:${input.text}`, mock: false };
  }

  last(): ConversationInput {
    return this.seen[this.seen.length - 1]!;
  }
}

const harness = (extra: Record<string, string> = {}) => {
  const provider = new RecordingProvider();
  const h = makeHarness({
    conversation: provider,
    env: {
      DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
      DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: PARENT,
      ...extra,
    },
  });
  return { h, provider };
};

const start = async (h: Harness): Promise<void> => {
  await h.transport.start((e) => h.app.router.handle(e));
};

const topLevel = (over: Partial<Extract<Incoming, { kind: 'message' }>> = {}): Incoming => ({
  kind: 'message',
  userId: OWNER,
  text: 'something to forget',
  threadKey: PARENT,
  messageId: STARTER,
  authorKind: 'user',
  context: { channelId: PARENT, guildId: GUILD },
  ...over,
});

const inThread = (
  threadId: string,
  over: Partial<Extract<Incoming, { kind: 'message' }>> = {},
): Incoming => ({
  kind: 'message',
  userId: OWNER,
  text: 'more of it',
  threadKey: threadId,
  messageId: '970000000000000099',
  authorKind: 'user',
  context: { channelId: threadId, guildId: GUILD, parentChannelId: PARENT },
  ...over,
});

const openThread = async (h: Harness): Promise<string> => {
  await h.transport.dispatch(topLevel());
  return h.store.conversationThreads.byStarterMessage(STARTER)!.threadId;
};

const forget = async (h: Harness) =>
  h.app.router.handle({
    kind: 'command', name: 'forget', userId: OWNER, options: { target: 'conversation' },
  });

describe('Forget says which store it reached, and which it did not', () => {
  it('reports PARTIAL and names why the provider cannot be reached', async () => {
    const { h } = harness();
    await start(h);
    await openThread(h);

    const out = await forget(h);

    expect(out?.content).toMatch(/Deleted 2 stored conversation turn\(s\)/);
    expect(out?.content).toMatch(/PARTIAL/);
    expect(out?.content).toMatch(/no OpenClaw session-deletion contract has been recorded/);
    // The distinction that matters, in the words the owner reads.
    expect(out?.content).toMatch(/ORPHANED, not erased/);
    h.close();
  });

  it('never claims a provider deletion it did not perform', async () => {
    const { h } = harness();
    await start(h);
    await openThread(h);
    const out = await forget(h);

    expect(out?.content).not.toMatch(/deleted your provider/i);
    expect(h.app.forget.forgetConversation(h.owner).providerDeletion).toBe('unsupported');
    h.close();
  });

  it('says plainly when there was no provider session to rotate', async () => {
    const { h } = harness();
    await start(h);
    const out = await forget(h);
    expect(out?.content).toMatch(/No provider session had been opened/);
    h.close();
  });
});

describe('a forgotten conversation cannot pick its provider session back up', () => {
  it('rotates the session key so a later turn starts a new one', async () => {
    const { h, provider } = harness();
    await start(h);
    const threadId = await openThread(h);

    expect(h.app.conversationMemory.epochFor(h.owner, threadId)).toBe(0);
    expect(provider.last().sessionEpoch).toBe(0);

    await forget(h);

    expect(h.app.conversationMemory.epochFor(h.owner, threadId)).toBe(1);
    await h.transport.dispatch(inThread(threadId, { text: 'after forgetting' }));
    expect(provider.last().sessionEpoch).toBe(1);
    h.close();
  });

  it('replays nothing of the deleted conversation afterwards', async () => {
    const { h, provider } = harness();
    await start(h);
    const threadId = await openThread(h);
    await h.transport.dispatch(inThread(threadId, { text: 'a distinctive sentence' }));

    await forget(h);
    await h.transport.dispatch(
      inThread(threadId, { text: 'and now?', messageId: '970000000000001001' }),
    );

    expect(JSON.stringify(provider.last())).not.toContain('a distinctive sentence');
    expect(provider.last().checkpoint).toBeUndefined();
    h.close();
  });

  it('rotates every actor contaminated by a SHARED thread, and deletes none of their rows', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    // The whitelist user speaks in the same visible thread, so their provider
    // session was fed the owner's turns as context.
    await h.transport.dispatch(
      inThread(threadId, { userId: CHAT, text: 'hello from the whitelist' }),
    );
    expect(h.store.conversations.countForThread(CHAT, threadId)).toBe(2);

    const out = await forget(h);

    // Their session is rotated -- the owner's words cannot reappear through it.
    expect(h.store.conversationThreads.epochFor(threadId, CHAT)).toBe(1);
    // And nothing of theirs was deleted. It is rotation, not reach.
    expect(h.store.conversations.countForThread(CHAT, threadId)).toBe(2);
    expect(out?.content).toMatch(/2 provider session\(s\) were rotated/);
    h.close();
  });

  it('audits by count, including the rotations, and never by content', async () => {
    const { h } = harness();
    await start(h);
    await h.transport.dispatch(topLevel({ text: 'a very distinctive sentence' }));

    h.app.forget.forgetConversation(h.owner);

    const row = (h.store.db
      .prepare(
        "SELECT subject_kind, subject_ref, detail FROM audit_log " +
          "WHERE event = 'data.deleted' AND subject_kind = 'conversation'",
      )
      .get()) as { subject_ref: string; detail: string };
    expect(row.subject_ref).toBe('all');
    expect(row.detail).toBe('rows 2; sessions rotated 1+0');
    expect(row.detail).not.toContain('distinctive');
    h.close();
  });

  it('removes the checkpoint with the turns it summarized', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    for (let i = 0; i < 20; i += 1) {
      await h.transport.dispatch(
        inThread(threadId, { text: `turn ${i}`, messageId: `97000000000000${2000 + i}` }),
      );
    }
    h.app.conversationMemory.compact(h.owner, threadId);
    expect(h.store.conversationThreads.checkpointFor(threadId)).toBeDefined();

    await forget(h);

    // A summary of deleted words is still those words.
    expect(h.store.conversationThreads.checkpointFor(threadId)).toBeUndefined();
    h.close();
  });
});

describe('retention is lifecycle-aware, not age-only', () => {
  const retention = (h: Harness, over: Record<string, unknown> = {}) =>
    new RetentionService({
      store: h.store,
      timeZone: 'UTC',
      ownerId: OWNER,
      policy: {
        enabled: true,
        jobMetadataDays: 90, jobDetailDays: 30, doneCaptureDays: 365,
        closedTaskDays: 90, closedReminderDays: 90, pastScheduleDays: 180,
        auditDays: 90, watchEventDays: 90, idempotencyDays: 7,
        cancelledWatchDays: 365, runLogDays: 365,
        conversationOwnerDays: 30, conversationOtherDays: 7,
        closedThreadDays: 14, batch: 200,
        ...over,
      },
    });

  const ageTurns = (h: Harness, threadKey: string, days: number): void => {
    h.store.db
      .prepare('UPDATE conversation_turns SET created_at = ? WHERE thread_key = ?')
      .run(new Date(Date.now() - days * 86_400_000).toISOString(), threadKey);
  };

  it('keeps every turn of a LIVE thread, however old', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    ageTurns(h, threadId, 400);

    const result = await retention(h).run('manual');

    expect(result.counts.conversationTurnsDeleted).toBe(0);
    expect(result.counts.conversationThreadsSkipped).toBe(1);
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(2);
    h.close();
  });

  it('still ages out an ordinary channel’s turns on their own window', async () => {
    const { h } = harness();
    await start(h);
    await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: 'in a DM', threadKey: 'dm-1',
    });
    ageTurns(h, 'dm-1', 400);

    const result = await retention(h).run('manual');

    expect(result.counts.conversationTurnsDeleted).toBe(2);
    h.close();
  });

  it('removes a CLOSED thread whole, once past its own window', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    h.app.conversationMemory.compact(h.owner, threadId);

    // Discord answered Unknown Channel: the thread is gone, which starts the
    // clock and deletes nothing on its own.
    h.transport.markThreadGone(threadId);
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(2);

    h.store.db
      .prepare('UPDATE conversation_threads SET closed_at = ? WHERE thread_id = ?')
      .run(new Date(Date.now() - 30 * 86_400_000).toISOString(), threadId);

    const result = await retention(h).run('manual');

    expect(result.counts.conversationThreadsDeleted).toBe(1);
    expect(result.counts.conversationThreadRowsDeleted).toBeGreaterThan(0);
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(0);
    expect(h.store.conversationThreads.byThreadId(threadId)).toBeUndefined();
    expect(h.store.conversationThreads.checkpointFor(threadId)).toBeUndefined();
    h.close();
  });

  it('keeps a closed thread that is still inside its window', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    h.transport.markThreadGone(threadId);

    const result = await retention(h).run('manual');

    expect(result.counts.conversationThreadsDeleted).toBe(0);
    expect(h.store.conversationThreads.byThreadId(threadId)).toBeDefined();
    h.close();
  });

  /**
   * The sequence that nearly deleted a live conversation.
   *
   * `ThreadDelete` is not a certain signal: Discord sends it to a client that
   * has merely LOST ACCESS to a thread, which a permission change on the
   * parent is enough to cause. The mapping closed, nothing ever contradicted
   * it, and a conversation that was still being had sat on the purge clock.
   */
  it('reopens a falsely closed thread when the conversation resumes', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);

    // A permission flap, indistinguishable from a deletion at the event.
    h.transport.markThreadGone(threadId);
    expect(h.store.conversationThreads.byThreadId(threadId)!.closedAt).not.toBeNull();

    // Access returns and the conversation carries on. The message is better
    // evidence than the event that closed the mapping.
    await h.transport.dispatch(
      inThread(threadId, { text: 'still here', messageId: '970000000000007001' }),
    );

    expect(h.store.conversationThreads.byThreadId(threadId)!.closedAt).toBeNull();
    h.close();
  });

  it('keeps the full transcript and the mapping across the purge window', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    await h.transport.dispatch(
      inThread(threadId, { text: 'an early turn', messageId: '970000000000007002' }),
    );

    h.transport.markThreadGone(threadId);
    await h.transport.dispatch(
      inThread(threadId, { text: 'and it resumes', messageId: '970000000000007003' }),
    );

    // Age everything well past BOTH the 14-day purge window and the ordinary
    // 7/30-day turn windows, then run retention.
    h.store.db
      .prepare('UPDATE conversation_turns SET created_at = ? WHERE thread_key = ?')
      .run(new Date(Date.now() - 400 * 86_400_000).toISOString(), threadId);

    const result = await retention(h).run('manual');

    expect(result.counts.conversationThreadsDeleted).toBe(0);
    expect(result.counts.conversationTurnsDeleted).toBe(0);
    expect(result.counts.conversationThreadsSkipped).toBe(1);
    expect(h.store.conversationThreads.byThreadId(threadId)).toBeDefined();
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(6);
    h.close();
  });

  it('does not let an unauthorized poster keep somebody else’s transcript alive', async () => {
    /**
     * Without the authorization check, a stranger posting in a public thread
     * could hold the owner's words off the retention clock indefinitely --
     * turning a conversation feature into a way for a third party to extend
     * how long somebody else's data is stored. A thread where only
     * unauthorized people talk also gets no replies, so nothing about it is
     * live.
     */
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    h.transport.markThreadGone(threadId);

    await h.transport.dispatch(
      inThread(threadId, {
        userId: STRANGER,
        text: 'posting in a public thread',
        messageId: '970000000000007004',
      }),
    );

    expect(h.store.conversationThreads.byThreadId(threadId)!.closedAt).not.toBeNull();
    h.close();
  });

  it('never ages a native thread’s turns out through the ordinary windows', async () => {
    /**
     * A native thread is governed by its own lifecycle, open or closed. Scoping
     * the exclusion to OPEN threads made the windows incoherent -- a closed
     * thread would shed a guest's turns at 7 days and the owner's at 30 while
     * the whole thread was due for purge at 14 -- and it meant a falsely
     * closed thread lost history piecemeal before anybody could notice.
     */
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);
    h.transport.markThreadGone(threadId);

    h.store.db
      .prepare('UPDATE conversation_turns SET created_at = ? WHERE thread_key = ?')
      .run(new Date(Date.now() - 400 * 86_400_000).toISOString(), threadId);

    // Closed, but still INSIDE its own purge window: the age windows must not
    // reach it, so nothing is deleted at all.
    const result = await retention(h).run('manual');

    expect(result.counts.conversationTurnsDeleted).toBe(0);
    expect(result.counts.conversationThreadsDeleted).toBe(0);
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(2);
    h.close();
  });

  it('refuses to purge a live thread even when asked directly', async () => {
    const { h } = harness();
    await start(h);
    const threadId = await openThread(h);

    // The guard is at the statement, not at the caller: a mis-scoped delete of
    // a live conversation must fail rather than succeed quietly.
    const out = h.store.conversationThreads.purgeThread(threadId);
    expect(out).toEqual({ deleted: false, rows: 0 });
    expect(h.store.conversations.countForThread(OWNER, threadId)).toBe(2);
    h.close();
  });
});
