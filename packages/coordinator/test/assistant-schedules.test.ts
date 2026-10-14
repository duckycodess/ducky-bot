import { describe, expect, it } from 'vitest';
import { RetentionService } from '../src/domain/retention.service.js';
import { briefingMessage } from '../src/discord/assistant-presenters.js';
import { OWNER, STRANGER, TestClock, makeHarness, type Harness } from './helpers.js';

/**
 * Indefinite weekly schedules, through the real briefing, deletion and
 * retention paths. Invented data only.
 */
const MANILA = 'Asia/Manila';
/** Tuesday 2026-10-13 08:00 in Manila. */
const TUESDAY_MORNING = '2026-10-13T00:00:00.000Z';
const T0 = '2026-10-01T00:00:00.000Z';

const boot = (startIso = TUESDAY_MORNING, env: Record<string, string | undefined> = {}) => {
  const clock = new TestClock(startIso, MANILA);
  const h = makeHarness({ clock, env });
  return { h, clock };
};

const rule = (h: Harness, id: string, over: Partial<Parameters<Harness['store']['scheduleRules']['insertRule']>[0]> = {}) =>
  h.store.scheduleRules.insertRule({
    id, discordUserId: OWNER, batchKey: 'b1', active: true, weekday: 1, startTime: '09:00',
    endTime: '10:30', label: 'Algebra', courseCode: 'MATH 1', section: null, room: 'Room 4',
    uncertain: [], effectiveFrom: null, effectiveUntil: null, createdAt: T0, ...over,
  });
const exception = (h: Harness, id: string, over: Partial<Parameters<Harness['store']['scheduleRules']['insertException']>[0]> = {}) =>
  h.store.scheduleRules.insertException({
    id, discordUserId: OWNER, date: '2026-10-13', courseCode: null, label: null, kind: 'cancelled',
    note: null, createdAt: T0, ...over,
  });
const text = (m: unknown): string => JSON.stringify(m);

describe('weekly rules in the briefing', () => {
  it('shows today’s class from a rule that was never materialized', () => {
    const { h } = boot();
    rule(h, 'k1');
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows.map((r) => r.title)).toEqual(['Algebra']);
    expect(b.scheduleToday.rows[0]).toMatchObject({
      startsAt: '2026-10-13T09:00', endsAt: '2026-10-13T10:30', location: 'Room 4', sourceKind: 'recurring',
    });
    expect(b.empty).toBe(false);
    // Nothing was written: the table still holds exactly the rule.
    expect((h.store.db.prepare('SELECT COUNT(*) n FROM schedules').get() as { n: number }).n).toBe(0);
    h.close();
  });

  it('shows nothing on a day the rule does not name', () => {
    const { h, clock } = boot();
    rule(h, 'k1');
    clock.set('2026-10-14T00:00:00.000Z'); // Wednesday
    expect(h.app.briefing.build(h.owner, 'morning').scheduleToday.rows).toEqual([]);
    h.close();
  });

  it('still produces the class thirty years later, with no reimport', () => {
    const { h, clock } = boot();
    rule(h, 'k1');
    clock.set('2056-03-07T00:00:00.000Z'); // a Tuesday, 08:00 Manila
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.dayKey).toBe('2056-03-07');
    expect(b.scheduleToday.rows.map((r) => r.startsAt)).toEqual(['2056-03-07T09:00']);
    h.close();
  });

  it('uses tomorrow’s classes in the evening briefing', () => {
    const { h, clock } = boot();
    rule(h, 'k1', { weekday: 2, label: 'Drawing', startTime: '13:00', endTime: '14:00' });
    clock.set('2026-10-13T12:00:00.000Z'); // Tuesday 20:00 Manila; Wednesday has Drawing
    const b = h.app.briefing.build(h.owner, 'evening');
    expect(b.scheduleTomorrow.rows.map((r) => r.title)).toEqual(['Drawing']);
    expect(b.scheduleToday.rows).toEqual([]);
    h.close();
  });

  it('merges a confirmed one-off row with a computed occurrence in start order', () => {
    const { h } = boot();
    rule(h, 'k1');
    h.store.schedules.insertMany(OWNER, [
      { title: 'Dentist', startsAt: '2026-10-13 08:15', endsAt: null, location: null, notes: null },
      { title: 'Study group', startsAt: '2026-10-13 15:00', endsAt: null, location: null, notes: null },
    ], 'text', ['one-1', 'one-2']);
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows.map((r) => r.title)).toEqual(['Dentist', 'Algebra', 'Study group']);
    h.close();
  });

  it('keeps a replaced batch inert', () => {
    const { h } = boot();
    rule(h, 'k-old', { active: false, batchKey: 'b0', label: 'Old class' });
    rule(h, 'k-new');
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows.map((r) => r.title)).toEqual(['Algebra']);
    h.close();
  });

  it('respects effective bounds', () => {
    const { h } = boot();
    rule(h, 'k1', { effectiveUntil: '2026-10-12' });
    expect(h.app.briefing.build(h.owner, 'morning').scheduleToday.rows).toEqual([]);
    h.close();
  });

  it('does not show one owner’s rules to another', () => {
    const { h } = boot();
    rule(h, 'k1', { discordUserId: STRANGER });
    expect(h.app.briefing.build(h.owner, 'morning').scheduleToday.rows).toEqual([]);
    h.close();
  });

  it('says a section was cut rather than hiding the rest', () => {
    const { h } = boot();
    for (let i = 0; i < 12; i += 1) {
      rule(h, `k${i}`, { label: `Class ${i}`, startTime: `${String(8 + (i % 12)).padStart(2, '0')}:00`, endTime: `${String(8 + (i % 12)).padStart(2, '0')}:50` });
    }
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows).toHaveLength(10);
    expect(b.scheduleToday.more).toBe(true);
    h.close();
  });
});

describe('exceptions in the briefing', () => {
  it('an untargeted cancellation empties the day and is explained', () => {
    const { h } = boot();
    rule(h, 'k1');
    rule(h, 'k2', { label: 'Drawing', courseCode: 'ART 2', startTime: '13:00', endTime: '14:00' });
    exception(h, 'x1', { note: 'storm' });
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows).toEqual([]);
    expect(b.scheduleExceptions!.rows).toHaveLength(1);
    const rendered = text(briefingMessage(b));
    expect(rendered).toContain('Schedule changes');
    expect(rendered).toContain('All classes: cancelled');
    expect(rendered).toContain('storm');
    h.close();
  });

  it('a course-targeted cancellation removes only that course', () => {
    const { h } = boot();
    rule(h, 'k1');
    rule(h, 'k2', { label: 'Drawing', courseCode: 'ART 2', startTime: '13:00', endTime: '14:00' });
    exception(h, 'x1', { courseCode: ' art 2 ' });
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows.map((r) => r.title)).toEqual(['Algebra']);
    const rendered = text(briefingMessage(b));
    expect(rendered).toContain('Schedule changes');
    expect(rendered).toContain('art 2');
    expect(rendered).toContain('cancelled');
    h.close();
  });

  it('an exception on another date changes nothing today', () => {
    const { h } = boot();
    rule(h, 'k1');
    exception(h, 'x1', { date: '2026-10-20' });
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.scheduleToday.rows).toHaveLength(1);
    expect(b.scheduleExceptions!.rows).toEqual([]);
    h.close();
  });

  it('reports tomorrow’s exceptions in the evening and not today’s', () => {
    const { h, clock } = boot();
    rule(h, 'k1', { weekday: 2 });
    exception(h, 'x-today', { date: '2026-10-13' });
    exception(h, 'x-tomorrow', { date: '2026-10-14' });
    clock.set('2026-10-13T12:00:00.000Z');
    const b = h.app.briefing.build(h.owner, 'evening');
    expect(b.scheduleExceptions!.rows.map((e) => e.date)).toEqual(['2026-10-14']);
    expect(b.scheduleTomorrow.rows).toEqual([]);
    h.close();
  });

  it('is not disturbed by a leap day', () => {
    const { h, clock } = boot();
    rule(h, 'k1');
    exception(h, 'x1', { date: '2028-02-29' });
    clock.set('2028-02-29T00:00:00.000Z'); // a Tuesday
    expect(h.app.briefing.build(h.owner, 'morning').scheduleToday.rows).toEqual([]);
    clock.set('2028-03-07T00:00:00.000Z');
    expect(h.app.briefing.build(h.owner, 'morning').scheduleToday.rows).toHaveLength(1);
    h.close();
  });
});

describe('the owner’s delete control reaches rules and exceptions', () => {
  it('lists every kind of schedule record the owner can delete', () => {
    const { h } = boot();
    rule(h, 'aaaaaaaa-rule');
    rule(h, 'bbbbbbbb-old', { active: false });
    exception(h, 'cccccccc-exc');
    h.store.schedules.insertMany(OWNER, [{ title: 'One-off', startsAt: '2026-11-01 10:00', endsAt: null, location: null, notes: null }], 'text', ['dddddddd-one']);
    const records = h.app.schedules.listRecords(h.owner, 25);
    expect(records.map((r) => r.id).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']);
    expect(records.find((r) => r.id === 'bbbbbbbb')!.describes).toContain('replaced batch');
    expect(records.find((r) => r.id === 'aaaaaaaa')!.describes).toContain('every Tuesday 09:00');
    h.close();
  });

  it('deletes a rule by its handle and leaves a tombstone for an imported one', () => {
    const { h } = boot();
    rule(h, 'aaaaaaaa-rule');
    h.store.assistantImport.recordLive({
      namespace: 'fx', category: 'schedule_rule', sourceId: 'src-1', targetId: 'aaaaaaaa-rule',
      fingerprint: 'f'.repeat(64), at: T0,
    });
    const preview = h.app.forget.previewEntity(h.owner, 'schedule', 'aaaaaaaa');
    expect(preview).toMatchObject({ found: true, id: 'aaaaaaaa-rule' });
    const out = h.app.forget.forgetEntity(h.owner, 'schedule', 'aaaaaaaa');
    expect(out.deleted).toBe(true);
    expect(out.rowsDeleted).toBe(1);
    expect(h.store.scheduleRules.activeRules(OWNER)).toEqual([]);
    expect(h.store.assistantImport.identity('fx', 'schedule_rule', 'src-1')).toMatchObject({
      state: 'tombstone', targetId: null, fingerprint: null,
    });
    // Audited by count and never by content.
    const audit = JSON.stringify(h.store.db.prepare('SELECT * FROM audit_log').all());
    expect(audit).toContain('schedule:aaaaaaaa-rule');
    expect(audit).not.toContain('Algebra');
    h.close();
  });

  it('deletes an exception by its handle', () => {
    const { h } = boot();
    exception(h, 'cccccccc-exc');
    expect(h.app.forget.forgetEntity(h.owner, 'schedule', 'cccccccc').deleted).toBe(true);
    expect(h.store.scheduleRules.listExceptionsForOwner(OWNER, 5)).toEqual([]);
    h.close();
  });

  it('refuses a prefix that fits a rule and an exception, and deletes neither', () => {
    const { h } = boot();
    rule(h, 'abcd1111-rule');
    exception(h, 'abcd2222-exc');
    const out = h.app.forget.forgetEntity(h.owner, 'schedule', 'abcd');
    expect(out.deleted).toBe(false);
    expect(out.message).toMatch(/More than one/);
    expect(h.store.scheduleRules.countRules(OWNER)).toBe(1);
    expect(h.store.scheduleRules.countExceptions(OWNER)).toBe(1);
    // A longer handle is unambiguous.
    expect(h.app.forget.forgetEntity(h.owner, 'schedule', 'abcd1').deleted).toBe(true);
    h.close();
  });

  it('answers a stranger’s record exactly like a missing one', () => {
    const { h } = boot();
    rule(h, 'eeeeeeee-rule', { discordUserId: STRANGER });
    const out = h.app.forget.forgetEntity(h.owner, 'schedule', 'eeeeeeee');
    expect(out.deleted).toBe(false);
    expect(out.message).toBe(h.app.forget.forgetEntity(h.owner, 'schedule', 'ffffffff').message);
    expect(h.store.scheduleRules.countRules(STRANGER)).toBe(1);
    h.close();
  });
});

describe('retention', () => {
  it('never removes a live rule or exception, however old', async () => {
    const { h } = boot();
    rule(h, 'k1', { createdAt: '2000-01-01T00:00:00.000Z' });
    exception(h, 'x1', { date: '2000-01-05', createdAt: '2000-01-01T00:00:00.000Z' });
    const service = new RetentionService({
      store: h.store,
      policy: {
        enabled: true, jobMetadataDays: 1, jobDetailDays: 1, doneCaptureDays: 1, closedTaskDays: 1,
        closedReminderDays: 1, pastScheduleDays: 1, auditDays: 1, watchEventDays: 1,
        idempotencyDays: 1, cancelledWatchDays: 1, runLogDays: 1, conversationOwnerDays: 1,
        conversationOtherDays: 1, closedThreadDays: 1, batch: 200,
      },
    });
    await service.tick();
    expect(h.store.scheduleRules.countRules(OWNER)).toBe(1);
    expect(h.store.scheduleRules.countExceptions(OWNER)).toBe(1);
    h.close();
  });

  it('leaves a tombstone, not a resurrection path, when it removes an old imported task', async () => {
    const { h } = boot();
    h.store.assistantImport.insertTask({
      id: 'old-task', publicId: 'told11', discordUserId: OWNER, title: 'Old', dueAt: null, dueAllDay: false,
      priority: 'normal', status: 'done', createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-02T00:00:00.000Z', closedAt: '2000-01-02T00:00:00.000Z', reminderPolicy: null,
    });
    h.store.assistantImport.recordLive({
      namespace: 'fx', category: 'task', sourceId: 'src-old', targetId: 'old-task', fingerprint: 'f'.repeat(64), at: T0,
    });
    const service = new RetentionService({
      store: h.store,
      policy: {
        enabled: true, jobMetadataDays: 90, jobDetailDays: 30, doneCaptureDays: 365, closedTaskDays: 1,
        closedReminderDays: 90, pastScheduleDays: 180, auditDays: 90, watchEventDays: 90,
        idempotencyDays: 7, cancelledWatchDays: 365, runLogDays: 365, conversationOwnerDays: 30,
        conversationOtherDays: 7, closedThreadDays: 14, batch: 200,
      },
    });
    await service.tick();
    expect(h.store.tasks.byId(OWNER, 'old-task')).toBeUndefined();
    expect(h.store.assistantImport.identity('fx', 'task', 'src-old')).toMatchObject({
      state: 'tombstone', targetId: null, fingerprint: null,
    });
    h.close();
  });
});
