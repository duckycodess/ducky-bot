import { describe, expect, it } from 'vitest';
import {
  assertValidTimeZone, discordTimestamp, discordWhen, formatZoned, isValidTimeZone,
  parseIntervalMinutes, parseStoredWallClock, parseWhen, startOfZonedDayPlus, zonedDateKey,
  zonedDayRange, zonedParts,
} from '../src/time.js';

const MANILA = 'Asia/Manila';
/** A zone with DST, so the day-boundary maths is exercised across a shift. */
const LONDON = 'Europe/London';

describe('timezone validation', () => {
  it('accepts IANA names and rejects anything the runtime cannot use', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone(MANILA)).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });

  it('fails loudly at startup rather than at first use', () => {
    expect(() => assertValidTimeZone('Mars/Olympus')).toThrow(/IANA timezone/);
    expect(assertValidTimeZone(MANILA)).toBe(MANILA);
  });
});

describe('civil days in the owner’s zone', () => {
  it('starts the day at local midnight, not UTC midnight', () => {
    // 2026-03-02T01:00Z is already 09:00 on the 2nd in Manila (UTC+8).
    const { startMs, endMs } = zonedDayRange(Date.parse('2026-03-02T01:00:00Z'), MANILA);
    expect(new Date(startMs).toISOString()).toBe('2026-03-01T16:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2026-03-02T16:00:00.000Z');
    expect(zonedDateKey(startMs, MANILA)).toBe('2026-03-02');
  });

  it('puts a late-evening UTC instant on the NEXT local day east of UTC', () => {
    // 23:30Z on the 1st is 07:30 on the 2nd in Manila.
    expect(zonedDateKey(Date.parse('2026-03-01T23:30:00Z'), MANILA)).toBe('2026-03-02');
    expect(zonedDateKey(Date.parse('2026-03-01T23:30:00Z'), 'UTC')).toBe('2026-03-01');
  });

  it('steps whole civil days across a DST change, not fixed 24-hour blocks', () => {
    // London springs forward on 2026-03-29. The day before it is 24h long,
    // that day is 23h; stepping must still land on local midnight each time.
    const start = Date.parse('2026-03-28T12:00:00Z');
    const keys = [0, 1, 2].map((n) => zonedDateKey(startOfZonedDayPlus(start, LONDON, n), LONDON));
    expect(keys).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    for (const n of [0, 1, 2]) {
      expect(zonedParts(startOfZonedDayPlus(start, LONDON, n), LONDON).hour).toBe(0);
    }
  });
});

describe('rendering', () => {
  it('emits Discord timestamps so each reader sees their own zone', () => {
    expect(discordTimestamp('2026-09-01T09:00:00Z', 'R')).toBe('<t:1788253200:R>');
    expect(discordWhen('2026-09-01T09:00:00Z', MANILA)).toBe('<t:1788253200:f> (<t:1788253200:R>)');
  });

  it('never produces a broken tag for an unusable instant', () => {
    expect(discordTimestamp('not a date')).toBe('');
    expect(discordWhen('not a date', MANILA)).toBe('unknown time');
  });

  it('formats the text fallback from numeric parts, with no locale involved', () => {
    expect(formatZoned('2026-09-01T01:00:00Z', MANILA)).toBe('2026-09-01 09:00');
    expect(formatZoned('2026-09-01T01:00:00Z', 'UTC')).toBe('2026-09-01 01:00');
    expect(formatZoned('2026-09-01T01:00:00Z', MANILA, false)).toBe('2026-09-01');
  });
});

describe('parseWhen', () => {
  const now = Date.parse('2026-09-01T02:00:00Z'); // 10:00 in Manila
  const ctx = { nowMs: now, timeZone: MANILA };

  it('accepts relative offsets', () => {
    expect(parseWhen('in 30m', ctx).atMs).toBe(now + 30 * 60_000);
    expect(parseWhen('in 2h', ctx).atMs).toBe(now + 2 * 3_600_000);
    expect(parseWhen('IN 3 days', ctx).atMs).toBe(now + 3 * 86_400_000);
    expect(parseWhen('in 1w', ctx).atMs).toBe(now + 7 * 86_400_000);
  });

  it('resolves a bare clock time in the owner’s zone, never in the past', () => {
    // 18:00 Manila today is 10:00Z the same day.
    expect(new Date(parseWhen('18:00', ctx).atMs).toISOString()).toBe('2026-09-01T10:00:00.000Z');
    // 09:00 Manila has already passed at 10:00 local, so it means tomorrow.
    expect(new Date(parseWhen('09:00', ctx).atMs).toISOString()).toBe('2026-09-02T01:00:00.000Z');
  });

  it('resolves today/tomorrow against the owner’s civil day', () => {
    expect(new Date(parseWhen('today 23:30', ctx).atMs).toISOString()).toBe(
      '2026-09-01T15:30:00.000Z',
    );
    expect(new Date(parseWhen('tomorrow 09:00', ctx).atMs).toISOString()).toBe(
      '2026-09-02T01:00:00.000Z',
    );
  });

  it('reads a bare date as an all-day instant at local midnight', () => {
    const parsed = parseWhen('2026-12-25', ctx);
    expect(parsed.allDay).toBe(true);
    expect(new Date(parsed.atMs).toISOString()).toBe('2026-12-24T16:00:00.000Z');
    expect(parseWhen('2026-12-25 07:30', ctx).allDay).toBe(false);
  });

  it('refuses anything it does not recognise instead of guessing', () => {
    for (const bad of ['next tuesday', 'soon', '', 'in 5 fortnights', '25:00', '2026-02-31']) {
      expect(() => parseWhen(bad, ctx), bad).toThrow(/not understood|not understood/i);
    }
  });

  it('quotes the accepted forms back so the owner can correct themselves', () => {
    expect(() => parseWhen('whenever', ctx)).toThrow(/tomorrow 09:00/);
  });
});

describe('parseIntervalMinutes', () => {
  it('accepts fixed intervals in the same vocabulary as parseWhen', () => {
    expect(parseIntervalMinutes('30m')).toBe(30);
    expect(parseIntervalMinutes('2h')).toBe(120);
    expect(parseIntervalMinutes('1d')).toBe(1440);
    expect(parseIntervalMinutes('1w')).toBe(10080);
    expect(parseIntervalMinutes('45')).toBe(45);
  });

  it('refuses a cron expression and anything else it cannot bound', () => {
    for (const bad of ['* * * * *', '0 9 * * 1', 'daily', '0', '-5m', '']) {
      expect(() => parseIntervalMinutes(bad), bad).toThrow(/repeat interval/);
    }
  });
});

describe('stored schedule timestamps', () => {
  it('reads the owner’s typed wall clock as a time in their zone', () => {
    const parsed = parseStoredWallClock('2026-09-01 09:00', MANILA);
    expect(parsed).toBeDefined();
    expect(new Date(parsed!.atMs).toISOString()).toBe('2026-09-01T01:00:00.000Z');
    expect(parsed!.allDay).toBe(false);
  });

  it('treats a bare date as an all-day entry', () => {
    expect(parseStoredWallClock('2026-09-01', MANILA)?.allDay).toBe(true);
  });

  it('returns undefined for anything else, so the raw text can be shown instead', () => {
    expect(parseStoredWallClock('sometime next week', MANILA)).toBeUndefined();
    expect(parseStoredWallClock('2026-09-01 99:99', MANILA)).toBeUndefined();
  });
});
