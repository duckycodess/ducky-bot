import { describe, expect, it } from 'vitest';
import { BRIEFING_PROVENANCE } from '@ducky/contracts';
import { OWNER, TestClock, makeHarness } from './helpers.js';

const MANILA = 'Asia/Manila';
/** 2026-09-01 10:00 in Manila (02:00Z). */
const MORNING = '2026-09-01T02:00:00.000Z';
/** 2026-09-01 20:00 in Manila (12:00Z). */
const EVENING = '2026-09-01T12:00:00.000Z';

const flat = (m: unknown): string => JSON.stringify(m);

const boot = async (startIso = MORNING, tz = MANILA) => {
  const clock = new TestClock(startIso, tz);
  const h = makeHarness({ clock });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, clock };
};

/** Confirms a schedule entry the way the owner actually would. */
const addSchedule = async (h: Awaited<ReturnType<typeof boot>>['h'], text: string) => {
  const preview = await h.app.schedules.preview(h.owner, { kind: 'text', text });
  if (preview.kind !== 'draft') throw new Error('expected a draft');
  h.app.schedules.confirm(h.owner, preview.draft.draftId);
};

describe('briefing assembly', () => {
  it('picks morning or evening from the hour in the OWNER’s zone', async () => {
    const morning = await boot(MORNING);
    expect(morning.h.app.briefing.defaultKind()).toBe('morning');
    morning.h.close();

    const evening = await boot(EVENING);
    expect(evening.h.app.briefing.defaultKind()).toBe('evening');
    evening.h.close();

    // The same instant is still morning in UTC, where it is 02:00.
    const utc = await boot(MORNING, 'UTC');
    expect(utc.h.app.briefing.defaultKind()).toBe('morning');
    utc.h.close();
  });

  it('collects today’s schedule, tasks and reminders from stored rows only', async () => {
    const { h } = await boot();
    await addSchedule(h, '2026-09-01 14:00 | Standup | Room 3\n2026-09-05 09:00 | Later thing');
    const dueToday = h.app.tasks.add(h.owner, { title: 'ship the batch', due: 'today 17:00' });
    const overdue = h.app.tasks.add(h.owner, { title: 'reply to email', due: '2026-08-30 09:00' });
    h.app.tasks.add(h.owner, { title: 'next week', due: '2026-09-08 09:00' });
    h.app.reminders.add(h.owner, { text: 'stand up', at: 'today 15:00' });
    h.app.reminders.add(h.owner, { text: 'tomorrow thing', at: 'tomorrow 09:00' });

    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows.map((e) => e.title)).toEqual(['Standup']);
    expect(b.tasksDueToday.rows.map((t) => t.id)).toEqual([dueToday.id]);
    expect(b.tasksOverdue.rows.map((t) => t.id)).toEqual([overdue.id]);
    expect(b.overdueTotal).toBe(1);
    expect(b.remindersToday.rows.map((r) => r.text)).toEqual(['stand up']);
    expect(b.remindersTomorrow.rows.map((r) => r.text)).toEqual(['tomorrow thing']);
    expect(b.openTaskCount).toBe(3);
    expect(b.empty).toBe(false);
    h.close();
  });

  it('reads a stored schedule time as the owner’s wall clock without rewriting it', async () => {
    const { h } = await boot();
    await addSchedule(h, '2026-09-01 14:00 | Standup');

    // The stored row is untouched: still the text the owner typed.
    const stored = h.store.schedules.listForOwner(OWNER)[0];
    expect(stored?.startsAt).toBe('2026-09-01 14:00');

    // And it is rendered as 14:00 Manila = 06:00Z.
    const epoch = Math.floor(Date.parse('2026-09-01T06:00:00.000Z') / 1000);
    const message = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' },
    });
    expect(flat(message)).toContain(`<t:${epoch}:t>`);
    h.close();
  });

  it('separates a task due later today from one that is already overdue', async () => {
    const { h, clock } = await boot();
    h.app.tasks.add(h.owner, { title: 'at noon', due: 'today 12:00' });

    expect(h.app.briefing.build(h.owner, 'today').tasksOverdue.rows).toHaveLength(0);
    // 13:00 Manila: the same task is now late.
    clock.set('2026-09-01T05:00:00.000Z');
    expect(h.app.briefing.build(h.owner, 'today').tasksOverdue.rows).toHaveLength(1);
    h.close();
  });

  it('closes the day in the evening briefing and looks at tomorrow', async () => {
    const { h } = await boot(EVENING);
    const done = h.app.tasks.add(h.owner, { title: 'finished it', due: 'today 09:00' });
    h.app.tasks.complete(h.owner, done.publicId);
    await addSchedule(h, '2026-09-02 09:00 | Tomorrow standup');
    h.app.reminders.add(h.owner, { text: 'tomorrow nudge', at: 'tomorrow 09:00' });

    const b = h.app.briefing.build(h.owner, 'evening');
    expect(b.tasksClosedToday.rows.map((t) => t.id)).toEqual([done.id]);
    expect(b.scheduleTomorrow.rows.map((e) => e.title)).toEqual(['Tomorrow standup']);
    expect(b.remindersTomorrow.rows.map((r) => r.text)).toEqual(['tomorrow nudge']);
    h.close();
  });

  it('says when a section was capped instead of quietly dropping rows', async () => {
    const { h } = await boot();
    // Eleven tasks due today, against a ten-row section cap.
    for (let i = 0; i < 11; i += 1) {
      h.app.tasks.add(h.owner, { title: `task ${i}`, due: 'today 17:00' });
    }
    const b = h.app.briefing.build(h.owner, 'today');
    expect(b.tasksDueToday.rows).toHaveLength(10);
    expect(b.tasksDueToday.more).toBe(true);

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'today' },
    });
    expect(flat(reply)).toContain('only the first 10 are shown');
    h.close();
  });

  it('says plainly that there is nothing rather than padding', async () => {
    const { h } = await boot();
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.empty).toBe(true);

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: {},
    });
    expect(flat(reply)).toContain('Nothing scheduled');
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('is deterministic: the same stored rows produce the same briefing', async () => {
    const { h } = await boot();
    await addSchedule(h, '2026-09-01 14:00 | Standup');
    h.app.tasks.add(h.owner, { title: 'a task', due: 'today 17:00' });

    const a = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'today' },
    });
    const b = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'today' },
    });
    expect(flat(a)).toEqual(flat(b));
    h.close();
  });

  it('states its provenance on every briefing, and consults no provider', async () => {
    const { h } = await boot();
    h.app.tasks.add(h.owner, { title: 'something', due: 'today 17:00' });

    // The conversation provider would visibly mark anything it produced.
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'today' },
    });
    expect(flat(reply)).toContain(BRIEFING_PROVENANCE);
    expect(flat(reply)).not.toContain('[mock]');

    // And the service itself holds nothing that could generate a sentence.
    const service = h.app.briefing as unknown as Record<string, unknown>;
    for (const value of Object.values(service)) {
      expect(typeof value === 'object' && value !== null && 'reply' in (value as object)).toBe(
        false,
      );
    }
    h.close();
  });

  it('mentions every task it lists and invents none', async () => {
    const { h } = await boot();
    const titles = ['alpha task', 'beta task', 'gamma task'];
    for (const title of titles) h.app.tasks.add(h.owner, { title, due: 'today 17:00' });

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'today' },
    });
    const body = flat(reply);
    for (const title of titles) expect(body).toContain(title);
    // Exactly the ids that exist, and no other task handle.
    const handles = [...body.matchAll(/t[0-9abcdefghjkmnpqrstvwxyz]{5}/g)].map((m) => m[0]);
    const known = new Set(h.app.tasks.list(h.owner, 'all').map((t) => t.publicId));
    for (const handle of handles) expect(known.has(handle)).toBe(true);
    h.close();
  });
});
