import { describe, expect, it } from 'vitest';
import { TASK_SNOOZE_MINUTES } from '@ducky/contracts';
import { planTaskReminderFires } from '../src/domain/task-reminders.js';
import { CHAT, OWNER, TestClock, makeHarness, replyText } from './helpers.js';

const MANILA = 'Asia/Manila';
/** 2026-10-13 10:00 in Manila. */
const START = '2026-10-13T02:00:00.000Z';
const CHANNEL = '900000000000000007';
const HOUR = 3_600_000;
/**
 * Far enough past `2026-10-14 09:00` Manila for its ONE-HOUR reminder to be
 * due. The 24-hour one is already in the past when such a task is saved on the
 * 13th, so it is never scheduled at all -- which is the behaviour under test in
 * `planTaskReminderFires` above.
 */
const PAST_OFFSET = 23 * HOUR;

const flat = (m: unknown): string => JSON.stringify(m);

const boot = async (env: Record<string, string | undefined> = {}) => {
  const clock = new TestClock(START, MANILA);
  const h = makeHarness({ clock, env });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, clock };
};

/** The reminders a task actually has scheduled, soonest first. */
const linked = (h: Awaited<ReturnType<typeof boot>>['h'], taskId: string) =>
  h.store.reminders.scheduledForTask(OWNER, taskId);

const wallOf = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: MANILA, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));

describe('which reminders a deadline earns', () => {
  const planAt = (dueAt: string, allDay: boolean, nowIso: string) =>
    planTaskReminderFires({ dueAt, dueAllDay: allDay }, Date.parse(nowIso), MANILA)
      .map((ms) => new Date(ms).toISOString());

  it('gives a timed deadline 24 hours and 1 hour of notice', () => {
    // Due 2026-10-20 23:59 Manila.
    expect(planAt('2026-10-20T15:59:00.000Z', false, START)).toEqual([
      '2026-10-19T15:59:00.000Z',
      '2026-10-20T14:59:00.000Z',
    ]);
  });

  it('announces a date-only deadline at 08:00 on the day itself', () => {
    // Due 2026-10-15 (stored as that day's midnight in Manila).
    expect(planAt('2026-10-14T16:00:00.000Z', true, START)).toEqual([
      '2026-10-15T00:00:00.000Z', // 08:00 Manila
    ]);
  });

  it('skips an offset that has already passed rather than firing it at once', () => {
    // Saved 30 minutes before a timed deadline: the 24-hour offset is long
    // gone and the 1-hour one has passed too.
    expect(planAt('2026-10-13T02:30:00.000Z', false, START)).toEqual([]);
    // Saved after 08:00 on the day a date-only task is due: nothing is owed,
    // and nothing fires immediately.
    expect(planAt('2026-10-12T16:00:00.000Z', true, START)).toEqual([]);
  });

  it('owes nothing at all for a task with no deadline', () => {
    expect(planTaskReminderFires({ dueAt: null, dueAllDay: false }, Date.parse(START), MANILA))
      .toEqual([]);
  });
});

describe('a task and its reminders move together', () => {
  it('schedules both offsets when a task is added', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    const rows = linked(h, task.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => wallOf(r.firstFireAt!))).toEqual([
      '19/10/2026, 23:59',
      '20/10/2026, 22:59',
    ]);
    // Each one is a bounded one-shot: no recurrence was invented.
    expect(rows.every((r) => r.recurrenceKind === 'once' && r.maxOccurrences === 1)).toBe(true);
    h.close();
  });

  it('resynchronizes them when the deadline moves, withdrawing the old ones', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    const before = linked(h, task.id).map((r) => r.id);

    const moved = h.app.tasks.setDeadline(h.owner, task.publicId, h.app.tasks.parseDeadline('October 25 11:59 PM'));
    expect(moved.sync.cancelled).toBe(2);
    expect(moved.sync.scheduled).toBe(2);

    const after = linked(h, task.id);
    expect(after.map((r) => r.id).some((id) => before.includes(id))).toBe(false);
    expect(after.map((r) => wallOf(r.firstFireAt!))).toEqual([
      '24/10/2026, 23:59',
      '25/10/2026, 22:59',
    ]);
    h.close();
  });

  it('clears them when a deadline is removed, and the task keeps living', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    const cleared = h.app.tasks.setDeadline(h.owner, task.publicId, undefined);
    expect(cleared.task.dueAt).toBeNull();
    expect(linked(h, task.id)).toHaveLength(0);
    expect(h.app.tasks.get(h.owner, task.publicId).status).toBe('open');
    h.close();
  });

  it('stops future reminders the moment the task is done', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    h.app.tasks.complete(h.owner, task.publicId);
    expect(linked(h, task.id)).toHaveLength(0);
    h.close();
  });

  it('withdraws an occurrence that is due but not yet delivered', async () => {
    const { h, clock } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    // Past the one-hour offset, so an occurrence exists and is waiting. The
    // 24-hour one was already behind us when the task was saved and was
    // skipped rather than fired.
    clock.advance(PAST_OFFSET);
    expect(h.app.reminderNotifier.materializeDue()).toBe(1);

    h.app.tasks.complete(h.owner, task.publicId);
    const result = await h.app.reminderNotifier.tick();
    expect(result.delivered).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('keeps delivered history when a task closes', async () => {
    const { h, clock } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();
    expect(h.transport.sent).toHaveLength(1);

    h.app.tasks.complete(h.owner, task.publicId);
    const reminderId = h.store.db
      .prepare('SELECT id FROM reminders WHERE task_id = ? ORDER BY first_fire_at LIMIT 1')
      .get(task.id) as { id: string };
    const [occurrence] = h.store.reminders.occurrencesFor(reminderId.id);
    expect(occurrence?.deliveredAt).not.toBeNull();
    expect(occurrence?.abandonedAt).toBeNull();
    h.close();
  });

  it('keeps linked reminders out of the owner’s own reminder list and briefing', async () => {
    const { h } = await boot();
    h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    h.app.reminders.add(h.owner, { text: 'stand up', at: 'in 2h' });

    // The scheduling is Ducky's business; what the owner reads is their own
    // reminder and the task itself.
    expect(h.app.reminders.list(h.owner, 'all').map((r) => r.text)).toEqual(['stand up']);
    expect(h.app.briefing.build(h.owner, 'morning').scheduledReminderCount).toBe(1);
    // The cap still counts them, because they really are scheduled.
    expect(h.store.reminders.countScheduled(OWNER)).toBe(3);
    h.close();
  });
});

describe('snooze', () => {
  it('postpones the notification and never the deadline', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    const { reminder } = h.app.tasks.snooze(h.owner, task.publicId);

    expect(Date.parse(reminder.firstFireAt) - Date.parse(START)).toBe(TASK_SNOOZE_MINUTES * 60_000);
    // The task is untouched: a snooze is "tell me again later", not "this is
    // due later".
    expect(h.app.tasks.get(h.owner, task.publicId).dueAt).toBe(task.dueAt);
    h.close();
  });

  it('says so on the card, so a snooze cannot be mistaken for a reschedule', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    const card = await h.transport.dispatch({
      kind: 'component',
      customId: h.app.signer.sign({
        kind: 'task_snooze', entityId: task.publicId, actorUserId: OWNER,
      }),
      userId: OWNER,
    } as never);
    expect(flat(card)).toMatch(/deadline is unchanged/i);
    h.close();
  });
});

describe('where a task reminder is delivered', () => {
  it('posts in the configured channel, with the owner’s mention and real controls', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();

    expect(h.transport.sent).toHaveLength(1);
    const [sent] = h.transport.sent;
    expect(sent?.target).toEqual({ kind: 'channel', channelId: CHANNEL });
    expect(sent?.message.content).toBe(`<@${OWNER}>`);
    expect(flat(sent?.message)).toContain('ENG 30 Letters');
    expect(sent?.message.rows?.[0]?.buttons.map((b) => b.label)).toEqual([
      'Done', 'Edit', `Snooze ${TASK_SNOOZE_MINUTES}m`,
    ]);
    h.close();
  });

  it('shows the deadline plainly: no timezone label, no schedule line, no UUID', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();

    const body = flat(h.transport.sent[0]?.message);
    expect(body).toContain('Due October 14, 9:00 AM');
    expect(body).not.toMatch(/manila|utc|gmt|\+08/i);
    expect(body).not.toMatch(/reminder: 1 hour/i);
    expect(body).not.toContain(task.id);
    h.close();
  });

  it('keeps a free-standing reminder in the DM it has always used', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    h.app.reminders.add(h.owner, { text: 'call the dentist', at: 'in 1h' });
    clock.advance(HOUR + 60_000);
    await h.app.reminderNotifier.tick();

    expect(h.transport.sent[0]?.target).toEqual({ kind: 'user', userId: OWNER });
    expect(flat(h.transport.sent[0]?.message)).toContain('call the dentist');
    h.close();
  });

  it('falls back to the DM when no channel is configured', async () => {
    const { h, clock } = await boot();
    h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();

    expect(h.transport.sent[0]?.target).toEqual({ kind: 'user', userId: OWNER });
    // A DM is already addressed to the owner, so it carries no mention.
    expect(h.transport.sent[0]?.message.content).toBeUndefined();
    h.close();
  });

  it('survives an outage: a late reminder is delivered, not dropped', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });

    // The host was off across both offsets and came back a day late.
    clock.advance(36 * HOUR);
    const result = await h.app.reminderNotifier.tick();
    expect(result.delivered).toBeGreaterThan(0);
    expect(flat(h.transport.sent)).toContain('ENG 30 Letters');
    h.close();
  });

  it('retries a failed send on the next pass rather than losing it', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);

    h.transport.failSends = true;
    const first = await h.app.reminderNotifier.tick();
    expect(first.delivered).toBe(0);
    expect(first.failed).toBe(1);

    h.transport.failSends = false;
    const second = await h.app.reminderNotifier.tick();
    expect(second.delivered).toBe(1);
    expect(flat(h.transport.sent)).toContain('ENG 30 Letters');
    h.close();
  });
});

describe('a card in a channel is information, never authority', () => {
  it('refuses every control to a reader who is not the owner', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();

    const buttons = h.transport.sent[0]?.message.rows?.[0]?.buttons ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      const refused = await h.transport.dispatch({
        kind: 'component', customId: button.customId, userId: CHAT,
      } as never);
      expect(replyText(refused)).toMatch(/not authorized/i);
    }
    expect(h.app.tasks.get(h.owner, task.publicId).status).toBe('open');
    h.close();
  });

  it('stops acting once the deadline it describes has moved', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();
    const stale = h.transport.sent[0]!.message.rows![0]!.buttons[0]!.customId;

    h.app.tasks.setDeadline(h.owner, task.publicId, h.app.tasks.parseDeadline('October 25'));
    const refused = await h.transport.dispatch({
      kind: 'component', customId: stale, userId: OWNER,
    } as never);
    expect(replyText(refused)).toMatch(/no longer valid/i);
    expect(h.app.tasks.get(h.owner, task.publicId).status).toBe('open');
    h.close();
  });

  it('lets the owner close the task from the card', async () => {
    const { h, clock } = await boot({ DUCKY_DEV_REMINDER_CHANNEL_ID: CHANNEL });
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-14 09:00' });
    clock.advance(PAST_OFFSET);
    await h.app.reminderNotifier.tick();

    const done = h.transport.sent[0]!.message.rows![0]!.buttons[0]!.customId;
    const reply = await h.transport.dispatch({
      kind: 'component', customId: done, userId: OWNER,
    } as never);
    expect(replyText(reply)).toMatch(/is now done/i);
    expect(h.app.tasks.get(h.owner, task.publicId).status).toBe('done');
    expect(linked(h, task.id)).toHaveLength(0);
    h.close();
  });
});

describe('deleting a task takes its notifications with it', () => {
  it('counts them rather than cascading them away silently', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    expect(linked(h, task.id)).toHaveLength(2);

    const result = h.app.forget.forgetEntity(h.owner, 'task', task.publicId);
    expect(result.deleted).toBe(true);
    // One task plus the two reminders it owned.
    expect(result.rowsDeleted).toBe(3);
    expect(
      h.store.db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE task_id = ?').get(task.id),
    ).toEqual({ n: 0 });
    h.close();
  });

  it('leaves no notification behind when retention removes a closed task', async () => {
    const { h } = await boot();
    const task = h.app.tasks.add(h.owner, { title: 'ENG 30 Letters', due: '2026-10-20 23:59' });
    h.app.tasks.complete(h.owner, task.publicId);
    // Closing already cancels them; retention then removes the rows entirely.
    h.store.db
      .prepare('UPDATE tasks SET closed_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', task.id);

    const counts = h.store.retention.deleteClosedTasks(new Date().toISOString(), 10);
    expect(counts.tasks).toBe(1);
    expect(counts.reminders).toBe(2);
    expect(
      h.store.db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE task_id IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    h.close();
  });
});
