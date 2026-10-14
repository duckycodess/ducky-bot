import { describe, expect, it } from 'vitest';
import { TASK_SNOOZE_MINUTES, type ImportedPreferences } from '@ducky/contracts';
import { planTaskReminderFires } from '../src/domain/task-reminders.js';
import { briefingMessage } from '../src/discord/assistant-presenters.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * Imported reminder policy and imported preferences, through the real services.
 * Invented data only.
 */
const MANILA = 'Asia/Manila';
/** Tuesday 2026-10-13 10:00 in Manila. */
const START = '2026-10-13T02:00:00.000Z';
const T0 = '2026-10-01T00:00:00.000Z';
const MIN = 60_000;
const HOUR = 60 * MIN;

const PREFS: ImportedPreferences = {
  timeZone: MANILA, morningEnabled: true, morningTime: '07:00', eveningEnabled: true,
  eveningTime: '21:00', weekendBriefings: true, lookaheadDays: 3, includeWeather: false,
  includeGithub: false, includeCaptures: true, includeMeal: false, assistantWording: false,
  defaultReminderOffsetsMinutes: [1440, 60],
};

const boot = (env: Record<string, string | undefined> = {}, startIso = START) => {
  const clock = new TestClock(startIso, MANILA);
  const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA, ...env } });
  return { h, clock };
};

const setPrefs = (h: Harness, over: Partial<ImportedPreferences> = {}) =>
  h.store.ownerPreferences.insert({
    ownerId: OWNER, prefsJson: JSON.stringify({ ...PREFS, ...over }), source: 'import', at: T0,
  });

/** An open imported task due `inMs` after START, with a policy. */
const importTask = (
  h: Harness, id: string, inMs: number,
  policy: { enabled: boolean; offsetsMinutes: number[] | null } | null,
  over: { dueAllDay?: boolean } = {},
) => {
  const dueAt = new Date(Date.parse(START) + inMs).toISOString();
  h.store.assistantImport.insertTask({
    id, publicId: `t${id}`.slice(0, 6).padEnd(6, 'x'), discordUserId: OWNER, title: `Task ${id}`, dueAt,
    dueAllDay: over.dueAllDay ?? false, priority: 'normal', status: 'open', createdAt: T0, updatedAt: T0,
    closedAt: null, reminderPolicy: policy,
  });
  return h.store.tasks.byId(OWNER, id)!;
};

const fires = (h: Harness, id: string): number[] =>
  h.store.reminders.scheduledForTask(OWNER, id).map((r) => Date.parse(r.firstFireAt) - Date.parse(START));

describe('which reminders an imported policy earns', () => {
  const plan = (
    policy: { enabled: boolean; offsetsMinutes: number[] | null } | null,
    dueInMs: number,
    allDay = false,
    defaults?: number[],
  ) =>
    planTaskReminderFires(
      { dueAt: new Date(Date.parse(START) + dueInMs).toISOString(), dueAllDay: allDay, reminderPolicy: policy },
      Date.parse(START), MANILA, defaults,
    ).map((ms) => ms - Date.parse(START));

  it('keeps the native rule for a task without a policy', () => {
    expect(plan(null, 3 * 24 * HOUR)).toEqual([2 * 24 * HOUR, 3 * 24 * HOUR - HOUR]);
  });

  it('reminds nothing when the policy is disabled', () => {
    expect(plan({ enabled: false, offsetsMinutes: null }, 3 * 24 * HOUR)).toEqual([]);
  });

  it('follows its own offsets, soonest first, and drops the ones already past', () => {
    expect(plan({ enabled: true, offsetsMinutes: [30, 120, 10_000] }, 6 * HOUR)).toEqual([
      6 * HOUR - 120 * MIN, 6 * HOUR - 30 * MIN,
    ]);
  });

  it('defers to the owner’s default list when it carries none of its own', () => {
    expect(plan({ enabled: true, offsetsMinutes: null }, 6 * HOUR, false, [90])).toEqual([6 * HOUR - 90 * MIN]);
    // And to the native 24 h / 1 h when there is no default list either.
    expect(plan({ enabled: true, offsetsMinutes: null }, 3 * 24 * HOUR)).toEqual([2 * 24 * HOUR, 3 * 24 * HOUR - HOUR]);
  });

  it('reminds once at the deadline when a future deadline has no offset left', () => {
    expect(plan({ enabled: true, offsetsMinutes: [1440, 60] }, 30 * MIN)).toEqual([30 * MIN]);
  });

  it('does not remind about a deadline that has already passed', () => {
    expect(plan({ enabled: true, offsetsMinutes: [60] }, -HOUR)).toEqual([]);
  });

  it('keeps the native 08:00 rule for an all-day deadline even with an enabled policy', () => {
    // Due 2026-10-15 (stored as that day's midnight in Manila): 08:00 that day.
    const due = Date.parse('2026-10-14T16:00:00.000Z');
    const out = planTaskReminderFires(
      { dueAt: new Date(due).toISOString(), dueAllDay: true, reminderPolicy: { enabled: true, offsetsMinutes: null } },
      Date.parse(START), MANILA,
    );
    expect(out.map((ms) => new Date(ms).toISOString())).toEqual(['2026-10-15T00:00:00.000Z']);
  });
});

describe('an imported task through Done, Edit and Snooze', () => {
  it('re-derives its reminders from the stored policy when the deadline moves', () => {
    const { h } = boot();
    const t = importTask(h, 'p1', 6 * HOUR, { enabled: true, offsetsMinutes: [45] });
    // The import wrote none; resync is what generates them.
    h.app.tasks.setDeadline(h.owner, t.publicId, h.app.tasks.parseDeadline('2026-10-20 23:59'));
    const moved = h.store.tasks.byId(OWNER, 'p1')!;
    expect(moved.reminderPolicy).toEqual({ enabled: true, offsetsMinutes: [45] });
    const rows = h.store.reminders.scheduledForTask(OWNER, 'p1');
    // Exactly the one offset the policy names, not the native pair.
    expect(rows).toHaveLength(1);
    expect(Date.parse(moved.dueAt!) - Date.parse(rows[0]!.firstFireAt)).toBe(45 * MIN);
    h.close();
  });

  it('honours a disabled policy across an edit', () => {
    const { h } = boot();
    const t = importTask(h, 'p2', 6 * HOUR, { enabled: false, offsetsMinutes: null });
    const out = h.app.tasks.setDeadline(h.owner, t.publicId, h.app.tasks.parseDeadline('2026-10-20 23:59'));
    expect(out.sync.scheduled).toBe(0);
    expect(fires(h, 'p2')).toEqual([]);
    h.close();
  });

  it('leaves a native task on the native defaults', () => {
    const { h } = boot();
    const t = h.app.tasks.add(h.owner, { title: 'Native', due: '2026-10-20 23:59' });
    expect(h.store.reminders.scheduledForTask(OWNER, t.id)).toHaveLength(2);
    expect(t.reminderPolicy ?? null).toBeNull();
    h.close();
  });

  it('cancels its pending reminders when it is done, and keeps what was delivered', () => {
    const { h } = boot();
    const t = importTask(h, 'p3', 6 * HOUR, { enabled: true, offsetsMinutes: [30] });
    h.app.tasks.setDeadline(h.owner, t.publicId, h.app.tasks.parseDeadline('2026-10-20 23:59'));
    expect(h.store.reminders.scheduledForTask(OWNER, 'p3')).toHaveLength(1);
    h.app.tasks.complete(h.owner, t.publicId);
    expect(h.store.reminders.scheduledForTask(OWNER, 'p3')).toEqual([]);
    h.close();
  });

  it('postpones the notification and never the deadline', () => {
    const { h } = boot();
    const t = importTask(h, 'p4', 6 * HOUR, { enabled: true, offsetsMinutes: [30] });
    const before = h.store.tasks.byId(OWNER, 'p4')!.dueAt;
    h.app.tasks.snooze(h.owner, t.publicId);
    expect(h.store.tasks.byId(OWNER, 'p4')!.dueAt).toBe(before);
    const rows = h.store.reminders.scheduledForTask(OWNER, 'p4');
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0]!.firstFireAt) - Date.parse(START)).toBe(TASK_SNOOZE_MINUTES * MIN);
    h.close();
  });

  it('refuses to act on a closed imported task', () => {
    const { h } = boot();
    h.store.assistantImport.insertTask({
      id: 'p5', publicId: 'tp5xxx', discordUserId: OWNER, title: 'Closed', dueAt: null, dueAllDay: false,
      priority: 'normal', status: 'done', createdAt: T0, updatedAt: T0, closedAt: T0, reminderPolicy: null,
    });
    expect(() => h.app.tasks.snooze(h.owner, 'tp5xxx')).toThrow(/already closed/);
    expect(() => h.app.tasks.setDeadline(h.owner, 'tp5xxx', undefined)).toThrow(/already done/);
    h.close();
  });
});

describe('imported preferences are selected, scoped and never authoritative', () => {
  it('are ignored unless the profile selects them', () => {
    const { h } = boot();
    setPrefs(h, { defaultReminderOffsetsMinutes: [10] });
    const t = importTask(h, 'q1', 6 * HOUR, { enabled: true, offsetsMinutes: null });
    h.app.tasks.setDeadline(h.owner, t.publicId, h.app.tasks.parseDeadline('2026-10-20 23:59'));
    // Native list, not the stored [10].
    expect(h.store.reminders.scheduledForTask(OWNER, 'q1')).toHaveLength(2);
    h.close();
  });

  it('supply the default offsets a policy defers to, when selected', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h, { defaultReminderOffsetsMinutes: [10] });
    const t = importTask(h, 'q2', 6 * HOUR, { enabled: true, offsetsMinutes: null });
    h.app.tasks.setDeadline(h.owner, t.publicId, h.app.tasks.parseDeadline('2026-10-20 23:59'));
    const rows = h.store.reminders.scheduledForTask(OWNER, 'q2');
    expect(rows).toHaveLength(1);
    expect(Date.parse(h.store.tasks.byId(OWNER, 'q2')!.dueAt!) - Date.parse(rows[0]!.firstFireAt)).toBe(10 * MIN);
    h.close();
  });

  it('read an unparseable row as absent rather than half-applied', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: '{"nope":true}', source: 'import', at: T0 });
    expect(h.app.briefing.build(h.owner, 'morning').lookahead).toBeUndefined();
    h.close();
  });

  it('never decide who may act: the owner is the configured one whatever is stored', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h);
    expect(h.app.authz.ownerId).toBe(OWNER);
    expect(() => h.app.tasks.add(h.stranger, { title: 'x' })).toThrow();
    h.close();
  });
});

describe('briefing sections an imported preference asks for', () => {
  const dueIn = (h: Harness, id: string, days: number, priority: 'low' | 'normal' | 'high' = 'normal') =>
    h.store.assistantImport.insertTask({
      id, publicId: `t${id}`.padEnd(6, 'x').slice(0, 6), discordUserId: OWNER, title: `Task ${id}`,
      dueAt: new Date(Date.parse(START) + days * 24 * HOUR).toISOString(), dueAllDay: false, priority,
      status: 'open', createdAt: T0, updatedAt: T0, closedAt: null, reminderPolicy: null,
    });
  const capture = (h: Harness, id: string, content: string) =>
    h.store.assistantImport.insertCapture({
      id, discordUserId: OWNER, content, status: 'open', createdAt: T0, updatedAt: T0,
    });

  it('adds nothing by default', () => {
    const { h } = boot();
    dueIn(h, 'a', 1);
    capture(h, 'c1', 'a thought');
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.lookahead).toBeUndefined();
    expect(b.captures).toBeUndefined();
    expect(JSON.stringify(briefingMessage(b))).not.toContain('Quick-capture');
    h.close();
  });

  it('looks ahead from tomorrow for the stated number of days, high priority first', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h, { lookaheadDays: 3 });
    dueIn(h, 'today', 0.1);
    dueIn(h, 'd1', 1);
    dueIn(h, 'd3', 3, 'high');
    dueIn(h, 'd9', 9);
    const b = h.app.briefing.build(h.owner, 'morning');
    // Days 1..3 from tomorrow: the high-priority one wins over the plain one.
    expect(b.lookahead!.tasks.rows.map((t) => t.id)).toEqual(['d3']);
    expect(b.lookahead!.days).toBe(3);
    const rendered = JSON.stringify(briefingMessage(b));
    expect(rendered).toContain('Next 3 days');
    h.close();
  });

  it('falls back to the next few tasks when none is high priority, and omits a zero lookahead', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h, { lookaheadDays: 3 });
    for (let i = 1; i <= 7; i += 1) dueIn(h, `n${i}`, 1 + (i % 3) * 0.1);
    expect(h.app.briefing.build(h.owner, 'morning').lookahead!.tasks.rows).toHaveLength(5);
    h.close();
    const second = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(second.h, { lookaheadDays: 0 });
    expect(second.h.app.briefing.build(second.h.owner, 'morning').lookahead).toBeUndefined();
    second.h.close();
  });

  it('keeps the lookahead out of the evening briefing', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h);
    dueIn(h, 'd1', 1);
    expect(h.app.briefing.build(h.owner, 'evening').lookahead).toBeUndefined();
    h.close();
  });

  it('reports the unresolved capture count in the morning and lists items in the evening', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h);
    for (let i = 0; i < 8; i += 1) capture(h, `c${i}`, `thought ${i}`);
    const morning = h.app.briefing.build(h.owner, 'morning');
    expect(morning.captures).toMatchObject({ total: 8, listed: false });
    expect(JSON.stringify(briefingMessage(morning))).toContain('8 unresolved items');
    const evening = h.app.briefing.build(h.owner, 'evening');
    expect(evening.captures).toMatchObject({ total: 8, listed: true });
    expect(evening.captures!.rows).toHaveLength(6);
    expect(JSON.stringify(briefingMessage(evening))).toContain('and 2 more in the inbox');
    h.close();
  });

  it('omits captures when the preference excludes them', () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    setPrefs(h, { includeCaptures: false });
    capture(h, 'c1', 'x');
    expect(h.app.briefing.build(h.owner, 'morning').captures).toBeUndefined();
    h.close();
  });
});

describe('pushed briefings under imported preferences', () => {
  const briefingEnv = {
    DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true', DUCKY_OWNER_TIMEZONE: MANILA,
  };

  it('uses the preference times in place of the documented defaults', async () => {
    // 07:00 preference, default would be 07:30: at 07:10 Manila the morning is due.
    const { h } = boot(briefingEnv, '2026-10-12T23:10:00.000Z');
    setPrefs(h);
    expect((await h.app.briefingNotifier.tick()).claimed).toBe(1);
    h.close();
  });

  it('never replaces a time the operator set explicitly', async () => {
    const { h } = boot({ ...briefingEnv, DUCKY_BRIEFING_MORNING_AT: '09:00' }, '2026-10-12T23:10:00.000Z');
    setPrefs(h);
    expect((await h.app.briefingNotifier.tick()).claimed).toBe(0);
    h.close();
  });

  it('skips a slot the preference disables', async () => {
    const { h } = boot(briefingEnv, '2026-10-13T14:00:00.000Z'); // 22:00 Manila: both slots due
    setPrefs(h, { morningEnabled: false });
    await h.app.briefingNotifier.tick();
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-10-13')).toBeUndefined();
    expect(h.store.briefings.bySlot(OWNER, 'evening', '2026-10-13')).toBeDefined();
    h.close();
  });

  it('sends nothing on a weekend when weekends are off, and does on a weekday', async () => {
    // 2026-10-17 is a Saturday.
    const sat = boot(briefingEnv, '2026-10-17T01:00:00.000Z');
    setPrefs(sat.h, { weekendBriefings: false });
    expect((await sat.h.app.briefingNotifier.tick()).claimed).toBe(0);
    sat.h.close();
    const tue = boot(briefingEnv, '2026-10-13T01:00:00.000Z');
    setPrefs(tue.h, { weekendBriefings: false });
    expect((await tue.h.app.briefingNotifier.tick()).claimed).toBe(1);
    tue.h.close();
  });

  it('never turns briefings on: the operator flag still decides', async () => {
    const { h } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true', DUCKY_OWNER_TIMEZONE: MANILA }, '2026-10-12T23:10:00.000Z');
    setPrefs(h);
    expect((await h.app.briefingNotifier.tick()).claimed).toBe(0);
    h.close();
  });

  it('changes nothing when preferences are not selected', async () => {
    const { h } = boot({ DUCKY_BRIEFING_ENABLED: 'true', DUCKY_OWNER_TIMEZONE: MANILA }, '2026-10-12T23:10:00.000Z');
    setPrefs(h);
    expect((await h.app.briefingNotifier.tick()).claimed).toBe(0); // 07:10 < the 07:30 default
    h.close();
  });
});

describe("the source's staleness rule for a pending briefing", () => {
  // Manila, Tuesday 2026-10-13. Configured slots are 07:00 and 21:00 by the preferences.
  const bootAt = (hhmm: string, selected = true) => {
    const { h, clock } = boot({
      DUCKY_BRIEFING_ENABLED: 'true', ...(selected ? { DUCKY_IMPORTED_PREFERENCES: 'true' } : {}),
    }, `2026-10-13T${hhmm}:00.000+08:00`);
    if (selected) setPrefs(h);
    return { h, clock };
  };

  it('still sends a morning briefing at 18:00, long after the native six hours, before the evening time', async () => {
    const { h } = bootAt('18:00');
    const out = await h.app.briefingNotifier.tick();
    expect(out.delivered).toBe(1);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-10-13')!.status).toBe('delivered');
    h.close();
  });

  it('records the morning briefing skipped once the evening time has been reached, and sends the evening one', async () => {
    const { h } = bootAt('21:05');
    const out = await h.app.briefingNotifier.tick();
    expect(out.skippedStale).toBe(1);
    expect(out.delivered).toBe(1);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-10-13')!.status).toBe('skipped');
    expect(h.store.briefings.bySlot(OWNER, 'evening', '2026-10-13')!.status).toBe('delivered');
    h.close();
  });

  it('keeps an evening briefing due until the end of its day', async () => {
    const { h } = bootAt('23:50');
    await h.app.briefingNotifier.tick();
    expect(h.store.briefings.bySlot(OWNER, 'evening', '2026-10-13')!.status).toBe('delivered');
    h.close();
  });

  it('never sends a pending briefing into a later day', async () => {
    const { h, clock } = bootAt('21:05');
    // Claimed, then the process was down past midnight, with the send still pending.
    h.app.briefingNotifier.claimDueSlots();
    clock.advance(4 * HOUR);
    const out = await h.app.briefingNotifier.deliverPending();
    expect(out.delivered).toBe(0);
    expect(out.skippedStale).toBe(2);
    h.close();
  });

  it('is only the rule when the profile selects imported preferences: the native six hours otherwise', async () => {
    const { h } = bootAt('18:00', false);
    const out = await h.app.briefingNotifier.tick();
    expect(out.skippedStale).toBeGreaterThanOrEqual(1);
    h.close();
  });
});
