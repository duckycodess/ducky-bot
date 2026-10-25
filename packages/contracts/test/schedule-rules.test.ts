import { describe, expect, it } from 'vitest';
import { SCHEDULE_WINDOW_MAX_DAYS } from '../src/limits.js';
import {
  addCivilDays, exceptionCancels, expandScheduleWindow, isCivilDate, weekdayOfCivilDate,
  type ScheduleExceptionInput, type ScheduleRuleInput,
} from '../src/schedule-rules.js';
import { zonedDateKey } from '../src/time.js';

const rule = (over: Partial<ScheduleRuleInput> = {}): ScheduleRuleInput => ({
  id: 'r1',
  weekday: 1, // Tuesday
  startTime: '09:00',
  endTime: '10:30',
  label: 'Algebra',
  courseCode: 'MATH 1',
  section: null,
  room: null,
  uncertain: [],
  effectiveFrom: null,
  effectiveUntil: null,
  ...over,
});
const ex = (over: Partial<ScheduleExceptionInput> = {}): ScheduleExceptionInput => ({
  id: 'e1',
  date: '2026-03-03',
  courseCode: null,
  label: null,
  kind: 'cancelled',
  note: null,
  ...over,
});

describe('civil date arithmetic', () => {
  it('uses Monday as day zero, in any century', () => {
    expect(weekdayOfCivilDate('2026-03-02')).toBe(0); // a Monday
    expect(weekdayOfCivilDate('2026-03-08')).toBe(6); // a Sunday
    // A known far date: 2100-01-01 is a Friday.
    expect(weekdayOfCivilDate('2100-01-01')).toBe(4);
  });

  it('knows leap days and rejects impossible dates', () => {
    expect(isCivilDate('2028-02-29')).toBe(true);
    expect(isCivilDate('2027-02-29')).toBe(false);
    expect(isCivilDate('2100-02-29')).toBe(false); // not a leap year
    expect(isCivilDate('2026-13-01')).toBe(false);
    expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCivilDays('2027-02-28', 1)).toBe('2027-03-01');
  });
});

describe('indefinite weekly occurrences', () => {
  it('produces the right occurrence decades after any import, with no horizon', () => {
    // 2056-03-07 is a Tuesday, thirty years on, with no reimport.
    expect(weekdayOfCivilDate('2056-03-07')).toBe(1);
    const w = expandScheduleWindow([rule()], [], '2056-03-04', '2056-03-11');
    expect(w.occurrences.map((o) => o.date)).toEqual(['2056-03-07']);
    expect(w.occurrences[0]).toMatchObject({
      startsAt: '2056-03-07T09:00',
      endsAt: '2056-03-07T10:30',
      label: 'Algebra',
    });
  });

  it('orders by start time within and across days', () => {
    const w = expandScheduleWindow(
      [rule({ id: 'late', startTime: '14:00', endTime: '15:00' }), rule({ id: 'early' }),
       rule({ id: 'mon', weekday: 0, startTime: '08:00', endTime: '09:00' })],
      [], '2026-03-02', '2026-03-09',
    );
    expect(w.occurrences.map((o) => o.ruleId)).toEqual(['mon', 'early', 'late']);
  });

  it('refuses a window past the bound instead of silently truncating it', () => {
    expect(() => expandScheduleWindow([rule()], [], '2026-01-01', '2027-01-01')).toThrow(
      new RegExp(`at most ${SCHEDULE_WINDOW_MAX_DAYS} days`),
    );
    // Exactly the bound is allowed.
    expect(() =>
      expandScheduleWindow([rule()], [], '2026-01-01', addCivilDays('2026-01-01', SCHEDULE_WINDOW_MAX_DAYS)),
    ).not.toThrow();
  });

  it('honours effective bounds on either side, inclusively', () => {
    const r = rule({ effectiveFrom: '2026-03-10', effectiveUntil: '2026-03-17' });
    const w = expandScheduleWindow([r], [], '2026-03-01', '2026-04-01');
    expect(w.occurrences.map((o) => o.date)).toEqual(['2026-03-10', '2026-03-17']);
  });

  it('is unaffected by a DST change, because rules are wall-clock', () => {
    // Europe/London springs forward on 2026-03-29. The windows come from the
    // owner's civil days, and the 09:00 class stays at 09:00 on both sides.
    const tz = 'Europe/London';
    const before = zonedDateKey(Date.parse('2026-03-24T12:00:00Z'), tz);
    const after = zonedDateKey(Date.parse('2026-03-31T12:00:00Z'), tz);
    const w = expandScheduleWindow([rule()], [], before, addCivilDays(after, 1));
    expect(w.occurrences.map((o) => `${o.date} ${o.startsAt.slice(11)}`)).toEqual([
      '2026-03-24 09:00', '2026-03-31 09:00',
    ]);
  });

  it('finds the rule on a leap day', () => {
    // 2028-02-29 is a Tuesday.
    expect(weekdayOfCivilDate('2028-02-29')).toBe(1);
    const w = expandScheduleWindow([rule()], [], '2028-02-28', '2028-03-01');
    expect(w.occurrences.map((o) => o.date)).toEqual(['2028-02-29']);
  });
});

describe('exceptions', () => {
  it('an untargeted cancellation removes every class that day and no other', () => {
    const rules = [rule(), rule({ id: 'r2', courseCode: 'ART 2', label: 'Drawing', startTime: '13:00', endTime: '14:00' })];
    const w = expandScheduleWindow(rules, [ex()], '2026-03-02', '2026-03-17');
    // Tuesday the 3rd is gone for both; Tuesday the 10th keeps both.
    expect(w.occurrences.map((o) => o.date)).toEqual(['2026-03-10', '2026-03-10']);
    expect(w.exceptions).toHaveLength(1);
  });

  it('a course-targeted cancellation matches trimmed and case-insensitively', () => {
    const r = rule({ courseCode: 'MATH 1' });
    expect(exceptionCancels(ex({ courseCode: '  math 1 ' }), r)).toBe(true);
    expect(exceptionCancels(ex({ courseCode: 'MATH 2' }), r)).toBe(false);
  });

  it('a label-targeted cancellation matches the label, not the course', () => {
    const r = rule({ label: 'Algebra' });
    expect(exceptionCancels(ex({ label: ' ALGEBRA' }), r)).toBe(true);
    expect(exceptionCancels(ex({ label: 'Drawing' }), r)).toBe(false);
  });

  it('a course-targeted exception never matches a rule that has no course', () => {
    expect(exceptionCancels(ex({ courseCode: 'MATH 1' }), rule({ courseCode: null }))).toBe(false);
  });

  it('only cancels the date it names, leaving unrelated occurrences intact', () => {
    const w = expandScheduleWindow(
      [rule(), rule({ id: 'r2', courseCode: 'ART 2', label: 'Drawing' })],
      [ex({ date: '2026-03-03', courseCode: 'ART 2' })],
      '2026-03-02', '2026-03-09',
    );
    expect(w.occurrences.map((o) => o.ruleId)).toEqual(['r1']);
  });

  it('applies on the leap day and across a DST boundary like any other date', () => {
    const w = expandScheduleWindow([rule()], [ex({ date: '2028-02-29' })], '2028-02-22', '2028-03-08');
    expect(w.occurrences.map((o) => o.date)).toEqual(['2028-02-22', '2028-03-07']);
    const dst = expandScheduleWindow([rule()], [ex({ date: '2026-03-31' })], '2026-03-24', '2026-04-08');
    expect(dst.occurrences.map((o) => o.date)).toEqual(['2026-03-24', '2026-04-07']);
  });

  it('reports only exceptions inside the window', () => {
    const w = expandScheduleWindow([rule()], [ex({ date: '2030-01-01' })], '2026-03-02', '2026-03-09');
    expect(w.exceptions).toHaveLength(0);
  });
});
