import { describe, expect, it } from 'vitest';
import { OWNER_ONLY_COMMANDS, SHARED_READABLE_ROUTES } from '@ducky/contracts';
import { CHAT, OWNER, STRANGER, TestClock, makeHarness } from './helpers.js';

const MANILA = 'Asia/Manila';
/** 2026-09-01 10:00 in Manila. */
const START = '2026-09-01T02:00:00.000Z';

const flat = (m: unknown): string => JSON.stringify(m);

const boot = async (clock = new TestClock(START, MANILA)) => {
  const h = makeHarness({ clock });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, clock };
};

describe('tasks', () => {
  it('records a task with a due instant resolved in the owner’s zone', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'file the tax return', due: 'tomorrow 09:00' });

    expect(task.title).toBe('file the tax return');
    expect(task.status).toBe('open');
    expect(task.priority).toBe('normal');
    // 09:00 on the 2nd in Manila is 01:00Z on the 2nd.
    expect(task.dueAt).toBe('2026-09-02T01:00:00.000Z');
    expect(task.dueAllDay).toBe(false);
    h.close();
  });

  it('keeps a bare date as an all-day due date rather than inventing a time', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'renew passport', due: '2026-12-25' });
    expect(task.dueAllDay).toBe(true);
    expect(task.dueAt).toBe('2026-12-24T16:00:00.000Z');
    h.close();
  });

  it('is a different record from a capture', async () => {
    const { h } = await boot();
    h.app.captures.create(h.owner, 'a passing thought');
    h.app.tasks.add(h.owner, { title: 'a commitment' });

    expect(h.app.captures.list(h.owner)).toHaveLength(1);
    expect(h.app.tasks.list(h.owner)).toHaveLength(1);
    // Adding one never writes the other.
    expect(h.app.captures.list(h.owner)[0]?.content).toBe('a passing thought');
    expect(h.app.tasks.list(h.owner)[0]?.title).toBe('a commitment');
    h.close();
  });

  it('refuses a time expression it does not understand instead of guessing', async () => {
    const { h } = await boot();
    expect(() => h.app.tasks.add(h.owner, { title: 'x', due: 'sometime soon' })).toThrow(
      /not understood/,
    );
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('accepts a due date already in the past, because overdue is a real state', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'late thing', due: '2026-08-01 09:00' });
    expect(task.dueAt).toBe('2026-08-01T01:00:00.000Z');
    expect(h.app.tasks.list(h.owner, 'overdue').map((t) => t.id)).toEqual([task.id]);
    h.close();
  });

  it('filters by today and overdue against the owner’s civil day', async () => {
    const { h } = await boot();
    const overdue = h.app.tasks.add(h.owner, { title: 'earlier today', due: '2026-09-01 08:00' });
    const later = h.app.tasks.add(h.owner, { title: 'later today', due: '2026-09-01 18:00' });
    h.app.tasks.add(h.owner, { title: 'next week', due: '2026-09-08 09:00' });

    expect(h.app.tasks.list(h.owner, 'today').map((t) => t.id)).toEqual([overdue.id, later.id]);
    expect(h.app.tasks.list(h.owner, 'overdue').map((t) => t.id)).toEqual([overdue.id]);
    h.close();
  });

  it('completes and cancels without letting one decision overwrite the other', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'do it' });
    expect(h.app.tasks.complete(h.owner, task.publicId).status).toBe('done');
    // Repeating the same close is a no-op, not an error.
    expect(h.app.tasks.complete(h.owner, task.publicId).status).toBe('done');
    // Closing it the OTHER way would rewrite a decision, so it is refused.
    expect(() => h.app.tasks.cancel(h.owner, task.publicId)).toThrow(/already done/);
    h.close();
  });

  it('answers identically for a malformed id and an unknown one', async () => {
    const { h } = await boot();
    expect(() => h.app.tasks.complete(h.owner, 'not-an-id')).toThrow(/No task with that id/);
    expect(() => h.app.tasks.complete(h.owner, 'tzzzzz')).toThrow(/No task with that id/);
    h.close();
  });
});

describe('reminders', () => {
  it('schedules a one-shot at the resolved instant', async () => {
    const { h } = await boot();
    const r = h.app.reminders.add(h.owner, { text: 'call the dentist', at: 'in 30m' });

    expect(r.recurrenceKind).toBe('once');
    expect(r.maxOccurrences).toBe(1);
    expect(r.intervalMinutes).toBeNull();
    expect(r.nextFireAt).toBe('2026-09-01T02:30:00.000Z');
    h.close();
  });

  it('refuses a time in the past, unlike a task due date', async () => {
    const { h } = await boot();
    expect(() => h.app.reminders.add(h.owner, { text: 'x', at: '2026-08-01 09:00' })).toThrow(
      /already passed/,
    );
    h.close();
  });

  it('bounds every recurrence, and refuses a cron expression outright', async () => {
    const { h } = await boot();
    const repeating = h.app.reminders.add(h.owner, {
      text: 'drink water', at: 'in 1h', every: '2h', count: 4,
    });
    expect(repeating.recurrenceKind).toBe('interval');
    expect(repeating.intervalMinutes).toBe(120);
    expect(repeating.maxOccurrences).toBe(4);

    // Omitting the count still bounds it -- there is no "forever".
    const defaulted = h.app.reminders.add(h.owner, { text: 'stretch', at: 'in 2h', every: '1d' });
    expect(defaulted.maxOccurrences).toBe(10);

    expect(() =>
      h.app.reminders.add(h.owner, { text: 'x', at: 'in 1h', every: '0 9 * * 1' }),
    ).toThrow(/repeat interval/);
    h.close();
  });

  it('enforces the interval floor and ceiling', async () => {
    const { h } = await boot();
    expect(() =>
      h.app.reminders.add(h.owner, { text: 'x', at: 'in 1h', every: '1m' }),
    ).toThrow(/shortest repeat interval/);
    expect(() =>
      h.app.reminders.add(h.owner, { text: 'x', at: 'in 1h', every: '400d' }),
    ).toThrow(/longest repeat interval|365 days/);
    h.close();
  });

  it('refuses a count with no interval rather than silently making it a one-shot', async () => {
    const { h } = await boot();
    expect(() => h.app.reminders.add(h.owner, { text: 'x', at: 'in 1h', count: 5 })).toThrow();
    h.close();
  });

  it('cancels a scheduled reminder and clears its cursor', async () => {
    const { h } = await boot();
    const r = h.app.reminders.add(h.owner, { text: 'x', at: 'in 1h', every: '1h', count: 5 });
    const cancelled = h.app.reminders.cancel(h.owner, r.publicId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.nextFireAt).toBeNull();
    expect(h.app.reminders.list(h.owner, 'scheduled')).toHaveLength(0);
    expect(h.app.reminders.list(h.owner, 'all')).toHaveLength(1);
    h.close();
  });
});

describe('the assistant Discord surface', () => {
  it('adds, lists, completes and cancels a task through the router', async () => {
    const { h } = await boot();
    const added = await h.transport.dispatch({
      kind: 'command', name: 'task', subcommand: 'add', userId: OWNER,
      options: { title: 'buy milk', due: 'today 18:00', priority: 'high' },
    });
    expect(added?.content).toMatch(/Task `t\w{5}` added \(high priority\)/);
    expect(added?.ephemeral).toBe(true);
    // A Discord timestamp, so the owner's client renders it in their own zone.
    expect(added?.content).toMatch(/<t:\d+:f>/);

    const list = await h.transport.dispatch({
      kind: 'command', name: 'task', subcommand: 'list', userId: OWNER, options: {},
    });
    expect(flat(list)).toContain('buy milk');
    expect(list?.ephemeral).toBe(true);

    const done = list?.rows?.[0]?.buttons.find((b) => b.label.startsWith('done'));
    expect(done).toBeDefined();
    const closed = await h.transport.dispatch({
      kind: 'component', customId: done!.customId, userId: OWNER,
    });
    expect(closed?.content).toMatch(/is now done/);
    expect(h.app.tasks.list(h.owner, 'open')).toHaveLength(0);
    h.close();
  });

  it('never mints a control a non-owner could reuse', async () => {
    const { h } = await boot();
    h.app.tasks.add(h.owner, { title: 'private' });
    const list = await h.transport.dispatch({
      kind: 'command', name: 'task', subcommand: 'list', userId: OWNER, options: {},
    });
    const customId = list?.rows?.[0]?.buttons[0]?.customId ?? '';
    expect(customId.length).toBeGreaterThan(0);
    expect(customId.length).toBeLessThanOrEqual(100);

    // Signed to the owner: the same id presented by anyone else is refused.
    const reused = await h.transport.dispatch({
      kind: 'component', customId, userId: STRANGER,
    });
    expect(reused?.content).toMatch(/not authorized/i);
    expect(h.app.tasks.list(h.owner, 'open')).toHaveLength(1);
    h.close();
  });

  it('adds and cancels a reminder through the router', async () => {
    const { h } = await boot();
    const added = await h.transport.dispatch({
      kind: 'command', name: 'reminder', subcommand: 'add', userId: OWNER,
      options: { text: 'stand up', at: 'in 45m', every: '1h', count: 3 },
    });
    expect(added?.content).toMatch(/every 1h, 0 of 3 sent/);

    const list = await h.transport.dispatch({
      kind: 'command', name: 'reminder', subcommand: 'list', userId: OWNER, options: {},
    });
    const cancel = list?.rows?.[0]?.buttons[0]?.customId ?? '';
    const cancelled = await h.transport.dispatch({
      kind: 'component', customId: cancel, userId: OWNER,
    });
    expect(cancelled?.content).toMatch(/cancelled/);
    expect(h.app.reminders.list(h.owner, 'scheduled')).toHaveLength(0);
    h.close();
  });

  it('reports a bad time expression as owner-readable text, not a stack trace', async () => {
    const { h } = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'reminder', subcommand: 'add', userId: OWNER,
      options: { text: 'x', at: 'whenever' },
    });
    expect(reply?.content).toMatch(/not understood/);
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });
});

describe('the assistant is owner-only in full', () => {
  it('refuses every assistant service method to a chat user and a stranger', async () => {
    const { h } = await boot();
    for (const actor of [h.chat, h.stranger]) {
      expect(() => h.app.tasks.add(actor, { title: 'x' })).toThrow(/not authorized/i);
      expect(() => h.app.tasks.list(actor)).toThrow(/not authorized/i);
      expect(() => h.app.tasks.complete(actor, 'tabcde')).toThrow(/not authorized/i);
      expect(() => h.app.tasks.cancel(actor, 'tabcde')).toThrow(/not authorized/i);
      expect(() => h.app.reminders.add(actor, { text: 'x', at: 'in 1h' })).toThrow(
        /not authorized/i,
      );
      expect(() => h.app.reminders.list(actor)).toThrow(/not authorized/i);
      expect(() => h.app.reminders.cancel(actor, 'rabcde')).toThrow(/not authorized/i);
      expect(() => h.app.briefing.build(actor)).toThrow(/not authorized/i);
    }
    h.close();
  });

  it('refuses the assistant commands to a whitelist user at the router', async () => {
    const { h } = await boot();
    for (const name of ['task', 'reminder', 'briefing']) {
      const reply = await h.transport.dispatch({
        kind: 'command', name, userId: CHAT, options: {},
      });
      expect(reply?.content, name).toMatch(/not authorized/i);
    }
    h.close();
  });

  it('has no shared route to any assistant command, even with a channel configured', async () => {
    const SHARED = '900000000000000001';
    const h = makeHarness({
      clock: new TestClock(START, MANILA),
      env: { DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED },
    });
    await h.transport.start((e) => h.app.router.handle(e));
    h.app.tasks.add(h.owner, { title: 'a private commitment' });
    h.app.reminders.add(h.owner, { text: 'a private reminder', at: 'in 1h' });

    // The manifest itself must not name any of them.
    const sharedCommands = SHARED_READABLE_ROUTES.map((r) => r.command);
    for (const name of ['task', 'reminder', 'briefing']) {
      expect(sharedCommands).not.toContain(name);
      expect(OWNER_ONLY_COMMANDS).toContain(name);
    }

    // And a request from that channel is answered privately, or refused.
    const fromChannel = await h.transport.dispatch({
      kind: 'command', name: 'task', subcommand: 'list', userId: OWNER, options: {},
      context: { channelId: SHARED, guildId: '800000000000000001' },
    });
    expect(fromChannel?.ephemeral).toBe(true);

    const stranger = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: STRANGER, options: {},
      context: { channelId: SHARED, guildId: '800000000000000001' },
    });
    expect(stranger?.content).toMatch(/not authorized/i);
    expect(flat(stranger)).not.toContain('private');
    h.close();
  });
});
