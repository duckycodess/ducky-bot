import { describe, expect, it } from 'vitest';
import type { ImportedPreferences } from '@ducky/contracts';
import { importDoc, MANILA } from './assistant-import-fixture.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * The owner asks for a briefing. Where the reply can be read by others it must
 * not carry the owner's private imported data; where it cannot, it must still be
 * whole. Native task, schedule and reminder content is the same either way.
 */
const NOW = '2026-10-13T00:00:00.000Z'; // Tuesday 08:00 Manila
const ROLE = '900000000000000031';
const OTHER = '900000000000000099';
const GUILD = '800000000000000001';
const T0 = '2026-10-01T00:00:00.000Z';

// What a MORNING briefing shows of the private data: a capture count and the digest.
const PRIVATE = ['Quick-capture inbox', 'PR #5 opened: Add a thing', 'widgets'];

const boot = (): Harness => {
  const h = makeHarness({
    clock: new TestClock(NOW, MANILA),
    env: {
      DUCKY_IMPORTED_PREFERENCES: 'true', DUCKY_OWNER_TIMEZONE: MANILA,
      DUCKY_DEV_BRIEFING_CHANNEL_ID: ROLE,
    },
  });
  const prefs: ImportedPreferences = {
    ...importDoc()['preferences'], includeWeather: false, includeGithub: true, includeCaptures: true,
  };
  h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify(prefs), source: 'import', at: T0 });
  h.store.assistantImport.insertCapture({
    id: 'c1', discordUserId: OWNER, content: 'PRIVATE-CAPTURE-TEXT', status: 'open', createdAt: T0, updatedAt: T0,
  });
  h.store.assistantWatch.insertTarget({
    id: 'w1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/widgets', display: 'acme/widgets',
    defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
  });
  h.store.assistantWatch.insertImportedEvent({
    id: 'e1', targetId: 'w1', kind: 'pr_opened', identity: '5:opened', occurredAt: T0,
    payloadJson: JSON.stringify({ number: 5, title: 'Add a thing' }), alertedAt: null, digestedAt: null, createdAt: T0,
  });
  // Native content that must survive in every reply.
  h.app.tasks.add(h.owner, { title: 'NATIVE-TASK-TITLE', due: 'today 23:00' });
  h.store.schedules.insertMany(OWNER, [
    { title: 'NATIVE-SCHEDULE-ROW', startsAt: '2026-10-13 15:00', endsAt: null, location: null, notes: null },
  ], 'text', ['s1']);
  return h;
};

const text = (m: unknown): string => JSON.stringify(m);
const ctx = (channelId: string) => ({ channelId, guildId: GUILD, parentChannelId: undefined });

const NATIVE = ['NATIVE-TASK-TITLE', 'NATIVE-SCHEDULE-ROW'];

describe('the /briefing command', () => {
  it('is whole in a DM, where only the owner reads it', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({ kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' } });
    for (const s of [...PRIVATE, ...NATIVE]) expect(text(reply), s).toContain(s);
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('omits the private sections in a role channel, where the reply persists', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' }, context: ctx(ROLE),
    });
    // The reply really is persistent here, which is why the private data must not be in it.
    expect(reply?.ephemeral).toBe(false);
    for (const s of PRIVATE) expect(text(reply), s).not.toContain(s);
    // The native briefing is untouched.
    for (const s of NATIVE) expect(text(reply), s).toContain(s);
    h.close();
  });

  it('is whole in an ordinary guild channel, where the reply is ephemeral to the owner', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' }, context: ctx(OTHER),
    });
    expect(reply?.ephemeral).toBe(true);
    for (const s of [...PRIVATE, ...NATIVE]) expect(text(reply), s).toContain(s);
    h.close();
  });

  it('keeps the capture TEXT, which the evening review lists, out of a role channel too', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const inChannel = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'evening' }, context: ctx(ROLE),
    });
    expect(text(inChannel)).not.toContain('PRIVATE-CAPTURE-TEXT');
    const inDm = await h.transport.dispatch({ kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'evening' } });
    expect(text(inDm)).toContain('PRIVATE-CAPTURE-TEXT');
    h.close();
  });

  it('does not settle the digest by being asked for, in any of them', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    await h.transport.dispatch({ kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' }, context: ctx(ROLE) });
    await h.transport.dispatch({ kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' } });
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.close();
  });
});

describe('"brief me" in conversation', () => {
  const say = (h: Harness, context?: ReturnType<typeof ctx>) =>
    h.transport.dispatch({
      kind: 'message', userId: OWNER, text: 'brief me', threadKey: 'dm-1', ...(context ? { context } : {}),
    });

  it('is whole in a DM', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await say(h);
    for (const s of [...PRIVATE, ...NATIVE]) expect(text(reply), s).toContain(s);
    h.close();
  });

  it('omits the private sections in a role channel, and keeps the native briefing', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await say(h, ctx(ROLE));
    expect(reply).toBeDefined();
    for (const s of PRIVATE) expect(text(reply), s).not.toContain(s);
    for (const s of NATIVE) expect(text(reply), s).toContain(s);
    h.close();
  });

  it('omits them in an ordinary guild channel too: a message reply there is public', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await say(h, ctx(OTHER));
    expect(reply).toBeDefined();
    for (const s of PRIVATE) expect(text(reply), s).not.toContain(s);
    for (const s of NATIVE) expect(text(reply), s).toContain(s);
    h.close();
  });

  it('fails closed when the caller does not say the reply is private', async () => {
    const h = boot();
    const reply = await h.app.intents.handle(h.owner, 'dm-1', 'brief me');
    expect(reply).toBeDefined();
    for (const s of PRIVATE) expect(text(reply), s).not.toContain(s);
    const priv = await h.app.intents.handle(h.owner, 'dm-1', 'brief me', undefined, { privateReply: true });
    for (const s of PRIVATE) expect(text(priv), s).toContain(s);
    h.close();
  });
});
