import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_THREAD_ROW_CAP, CONVERSATION_TURN_TEXT_MAX,
} from '@ducky/contracts';
import type {
  ConversationInput, ConversationProvider, ConversationReply,
} from '@ducky/adapters';
import { NO_ATTACHMENT_CAPABILITY } from '@ducky/adapters';
import { CHAT, OWNER, makeHarness, type Harness } from './helpers.js';

/**
 * Bounded conversation continuity (ADR 0021).
 *
 * The properties under test are the ones that make storing the owner's words
 * defensible at all: off unless enabled, isolated per (user, thread), never a
 * shared channel, bounded, and deletable.
 */

/** Records what history each turn was handed, so isolation is observable. */
class RecordingProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = false;
  readonly capabilities = { attachments: NO_ATTACHMENT_CAPABILITY };
  readonly seen: { text: string; history: readonly { role: string; text: string }[] }[] = [];

  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.seen.push({ text: input.text, history: [...(input.history ?? [])] });
    return { text: `echo:${input.text}`, mock: false };
  }

  last(): { text: string; history: readonly { role: string; text: string }[] } {
    return this.seen[this.seen.length - 1]!;
  }
}

const say = async (h: Harness, userId: string, threadKey: string, text: string) =>
  h.app.router.handle({ kind: 'message', userId, text, threadKey });

const withMemory = (extra: Record<string, string> = {}, provider = new RecordingProvider()) => {
  const h = makeHarness({
    conversation: provider,
    env: { DUCKY_CONVERSATION_MEMORY_ENABLED: 'true', ...extra },
  });
  return { h, provider };
};

describe('conversation continuity is off unless it is switched on', () => {
  it('stores nothing at all by default', async () => {
    const provider = new RecordingProvider();
    const h = makeHarness({ conversation: provider });

    await say(h, OWNER, 'dm-1', 'hello');
    await say(h, OWNER, 'dm-1', 'again');

    expect(h.store.conversations.countForUser(OWNER)).toBe(0);
    // And nothing is replayed, so the provider sees no history either.
    expect(provider.last().history).toEqual([]);
    h.close();
  });

  it('still deletes rows an earlier run stored after the flag goes off', async () => {
    // Enabled: two turns land.
    const first = withMemory();
    await say(first.h, OWNER, 'dm-1', 'remember this');
    expect(first.h.store.conversations.countForUser(OWNER)).toBe(2);
    first.h.close();

    // A fresh instance with memory OFF, sharing the same rows via its own store
    // would be a different database, so the honest test is the service itself:
    // deletion must not depend on the flag.
    const off = makeHarness({ conversation: new RecordingProvider() });
    off.store.conversations.append({
      id: 'leftover-1', discordUserId: OWNER, threadKey: 'dm-1',
      role: 'user', content: 'from an earlier run', rowCap: CONVERSATION_THREAD_ROW_CAP,
    });
    const result = off.app.conversationMemory.forgetConversationFor(off.owner);
    expect(result.turnsDeleted).toBe(1);
    expect(result.enabled).toBe(false);
    off.close();
  });
});

describe('continuity is isolated per user and per thread', () => {
  it('replays the owner’s own earlier turns, oldest first', async () => {
    const { h, provider } = withMemory();

    await say(h, OWNER, 'dm-1', 'first');
    await say(h, OWNER, 'dm-1', 'second');

    const history = provider.last().history;
    expect(history.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:first',
      'assistant:echo:first',
    ]);
    h.close();
  });

  it('never reads one person’s history into another’s prompt', async () => {
    const { h, provider } = withMemory();

    await say(h, OWNER, 'shared-thread', 'owner secret');
    await say(h, CHAT, 'shared-thread', 'hello from the whitelist');

    // Same thread key, different person: the whitelist user's prompt carries
    // nothing the owner said.
    expect(provider.last().history).toEqual([]);
    expect(h.store.conversations.countForUser(OWNER)).toBe(2);
    expect(h.store.conversations.countForUser(CHAT)).toBe(2);
    h.close();
  });

  it('never reads one thread into another', async () => {
    const { h, provider } = withMemory();

    await say(h, OWNER, 'dm-1', 'in the first thread');
    await say(h, OWNER, 'dm-2', 'in the second thread');

    expect(provider.last().history).toEqual([]);
    expect(h.store.conversations.countForThread(OWNER, 'dm-1')).toBe(2);
    expect(h.store.conversations.countForThread(OWNER, 'dm-2')).toBe(2);
    h.close();
  });
});

describe('a shared channel is never a conversation store', () => {
  const SHARED = '200000000000000009';

  it('neither stores nor replays turns whose thread is a shared channel', async () => {
    const { h, provider } = withMemory({ DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED });

    await say(h, OWNER, SHARED, 'said in a channel other people can read');
    await say(h, OWNER, SHARED, 'and again');

    expect(h.store.conversations.countForThread(OWNER, SHARED)).toBe(0);
    expect(provider.last().history).toEqual([]);
    h.close();
  });

  it('still stores the same owner’s DM thread', async () => {
    const { h } = withMemory({ DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED });

    await say(h, OWNER, SHARED, 'in the shared channel');
    await say(h, OWNER, 'dm-1', 'in a DM');

    expect(h.store.conversations.countForThread(OWNER, SHARED)).toBe(0);
    expect(h.store.conversations.countForThread(OWNER, 'dm-1')).toBe(2);
    h.close();
  });
});

describe('continuity is bounded', () => {
  it('replays only the configured number of turns', async () => {
    const { h, provider } = withMemory({ DUCKY_CONVERSATION_MEMORY_TURNS: '2' });

    for (const text of ['one', 'two', 'three']) await say(h, OWNER, 'dm-1', text);

    expect(provider.last().history.length).toBe(2);
    h.close();
  });

  it('truncates an over-long turn visibly rather than storing it whole', async () => {
    const { h } = withMemory();
    const huge = 'x'.repeat(CONVERSATION_TURN_TEXT_MAX + 500);

    await say(h, OWNER, 'dm-1', huge);

    const stored = h.store.conversations.recent(OWNER, 'dm-1', 5);
    const userTurn = stored.find((t) => t.role === 'user')!;
    expect(userTurn.content.length).toBe(CONVERSATION_TURN_TEXT_MAX);
    expect(userTurn.content.endsWith('…')).toBe(true);
    h.close();
  });

  it('caps the rows one thread can hold, keeping the newest', async () => {
    const { h } = withMemory();
    for (let i = 0; i < CONVERSATION_THREAD_ROW_CAP + 10; i += 1) {
      h.store.conversations.append({
        id: `t-${i}`, discordUserId: OWNER, threadKey: 'dm-1',
        role: 'user', content: `turn ${i}`, rowCap: CONVERSATION_THREAD_ROW_CAP,
      });
    }
    expect(h.store.conversations.countForThread(OWNER, 'dm-1')).toBe(CONVERSATION_THREAD_ROW_CAP);
    const newest = h.store.conversations.recent(OWNER, 'dm-1', 1)[0]!;
    expect(newest.content).toBe(`turn ${CONVERSATION_THREAD_ROW_CAP + 9}`);
    h.close();
  });
});

describe('/forget conversation deletes, and says what it deleted', () => {
  it('reports counts and removes every thread for that user only', async () => {
    const { h } = withMemory();

    await say(h, OWNER, 'dm-1', 'one');
    await say(h, OWNER, 'dm-2', 'two');
    await say(h, CHAT, 'dm-3', 'not mine to delete');

    const out = await h.app.router.handle({
      kind: 'command', name: 'forget', userId: OWNER, options: { target: 'conversation' },
    });

    expect(out?.content).toMatch(/Deleted 4 stored conversation turn\(s\)/);
    expect(h.store.conversations.countForUser(OWNER)).toBe(0);
    expect(h.store.conversations.countForUser(CHAT)).toBe(2);
    h.close();
  });

  it('audits the deletion by count and never by content', async () => {
    const { h } = withMemory();
    await say(h, OWNER, 'dm-1', 'a very distinctive sentence');

    h.app.forget.forgetConversation(h.owner);

    const rows = h.store.db
      .prepare("SELECT subject_kind, subject_ref, detail FROM audit_log WHERE event = 'data.deleted'")
      .all() as { subject_kind: string; subject_ref: string; detail: string }[];
    const row = rows.find((r) => r.subject_kind === 'conversation')!;
    expect(row.subject_ref).toBe('all');
    expect(row.detail).toBe('rows 2');
    expect(row.detail).not.toContain('distinctive');
    h.close();
  });

  it('says plainly that there is nothing stored when there is not', async () => {
    const h = makeHarness({ conversation: new RecordingProvider() });
    const out = await h.app.router.handle({
      kind: 'command', name: 'forget', userId: OWNER, options: { target: 'conversation' },
    });
    expect(out?.content).toMatch(/Nothing to forget/);
    expect(out?.content).toMatch(/continuity is off/);
    h.close();
  });
});

describe('retention covers stored turns', () => {
  it('keeps the owner’s history longer than a guest’s, and only past the window', async () => {
    const { h } = withMemory({
      DUCKY_RETENTION_ENABLED: 'true',
      DUCKY_RETENTION_CONVERSATION_OWNER_DAYS: '30',
      DUCKY_RETENTION_CONVERSATION_OTHER_DAYS: '7',
    });

    const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const insert = (id: string, userId: string, at: string) => {
      h.store.db
        .prepare(
          `INSERT INTO conversation_turns (id, discord_user_id, thread_key, role, content, created_at)
           VALUES (?,?,?,'user','text',?)`,
        )
        .run(id, userId, 'dm-1', at);
    };

    insert('owner-old', OWNER, ago(40));
    insert('owner-recent', OWNER, ago(10));
    insert('guest-old', CHAT, ago(10));
    insert('guest-recent', CHAT, ago(2));

    const result = await h.app.retention.run('manual');

    expect(result.counts.conversationTurnsDeleted).toBe(2);
    const left = h.store.db
      .prepare('SELECT id FROM conversation_turns ORDER BY id')
      .all() as { id: string }[];
    expect(left.map((r) => r.id)).toEqual(['guest-recent', 'owner-recent']);
    h.close();
  });
});
