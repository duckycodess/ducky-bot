import { describe, expect, it } from 'vitest';
import {
  BULK_CAPTURE_MAX_ITEMS, formatDeadline, isAllDayOverdue, isPrivateBindHost,
  looksLikeBulkTaskList, parseBulkDeadline, parseBulkTaskList, parseDeadlineInput,
  startOfZonedDay, zonedParts,
} from '../src/index.js';

const MANILA = 'Asia/Manila';
/** 2026-10-13 10:00 in Manila. The day the owner's own example was pasted. */
const NOW = Date.parse('2026-10-13T02:00:00.000Z');
const ctx = { nowMs: NOW, timeZone: MANILA };

const wall = (ms: number): string => {
  const p = zonedParts(ms, MANILA);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('the owner’s own example', () => {
  const PASTE = '1. ENG 30 Letters (October 13 11:59 PM)\n2. Speech 30 Letters (October 15)';

  it('parses both lines, with the time on one and not the other', () => {
    const out = parseBulkTaskList(PASTE, ctx);
    expect(out.problems).toEqual([]);
    expect(out.items).toHaveLength(2);

    const [first, second] = out.items;
    expect(first?.title).toBe('ENG 30 Letters');
    expect(first?.deadline?.allDay).toBe(false);
    expect(wall(first!.deadline!.atMs)).toBe('2026-10-13 23:59');

    expect(second?.title).toBe('Speech 30 Letters');
    // No time was typed, so none is invented: the instant is the start of the
    // civil day and the flag says the owner gave a date.
    expect(second?.deadline?.allDay).toBe(true);
    expect(wall(second!.deadline!.atMs)).toBe('2026-10-15 00:00');
  });

  it('is recognised as a list on sight, and ordinary prose is not', () => {
    expect(looksLikeBulkTaskList(PASTE)).toBe(true);
    expect(looksLikeBulkTaskList('1. just one thing (October 13)')).toBe(false);
    expect(looksLikeBulkTaskList('what is on today?')).toBe(false);
    expect(
      looksLikeBulkTaskList('I was thinking 1. we ship it 2. we tell people\nand then rest'),
    ).toBe(false);
  });

  it('never reads quoted text or a code block as a list', () => {
    // Quotes, code and anything a bot posted are DATA. A notification that
    // happens to contain a numbered list must not create tasks.
    expect(looksLikeBulkTaskList('> 1. ENG 30 Letters (October 13)\n> 2. Speech (October 15)'))
      .toBe(false);
    expect(looksLikeBulkTaskList('```\n1. ENG 30 Letters\n2. Speech 30 Letters\n```')).toBe(false);
  });
});

describe('deadlines', () => {
  const at = (raw: string) => parseBulkDeadline(raw, ctx);

  it('accepts a month name with or without a time, in either order', () => {
    expect(wall((at('October 13 11:59 PM') as { atMs: number }).atMs)).toBe('2026-10-13 23:59');
    expect(wall((at('Oct 13') as { atMs: number }).atMs)).toBe('2026-10-13 00:00');
    expect(wall((at('13 October 9am') as { atMs: number }).atMs)).toBe('2026-10-13 09:00');
    expect(wall((at('October 13, 2027 17:30') as { atMs: number }).atMs)).toBe('2027-10-13 17:30');
    expect(wall((at('2026-12-01 08:05') as { atMs: number }).atMs)).toBe('2026-12-01 08:05');
  });

  it('reads midnight and noon the way a person writes them', () => {
    expect(wall((at('October 13 12:00 AM') as { atMs: number }).atMs)).toBe('2026-10-13 00:00');
    expect(wall((at('October 13 12:00 PM') as { atMs: number }).atMs)).toBe('2026-10-13 12:00');
  });

  it('resolves a yearless date to its NEXT occurrence, counting today as today', () => {
    // January has gone this year, so it means next year.
    expect(wall((at('January 5') as { atMs: number }).atMs)).toBe('2027-01-05 00:00');
    // Today is still today even when the clock time has passed.
    expect(wall((at('October 13 9:00 AM') as { atMs: number }).atMs)).toBe('2026-10-13 09:00');
  });

  it('refuses a numeric date rather than guessing which half is the month', () => {
    expect(at('10/13')).toEqual({ problem: 'ambiguous_date' });
    expect(at('13-10-2026')).toEqual({ problem: 'ambiguous_date' });
  });

  it('refuses a day that does not exist, instead of rolling it over', () => {
    expect(at('February 30')).toEqual({ problem: 'impossible_date' });
    expect(at('2026-02-29 09:00')).toEqual({ problem: 'impossible_date' });
    // A real leap day is found by looking forward rather than refused.
    expect(wall((at('February 29') as { atMs: number }).atMs)).toBe('2028-02-29 00:00');
  });

  it('refuses anything it does not recognise as a date at all', () => {
    expect(at('draft')).toEqual({ problem: 'unknown_date' });
    expect(at('sometime next week')).toEqual({ problem: 'unknown_date' });
    expect(at('October 13 25:00')).toEqual({ problem: 'unknown_date' });
  });
});

describe('a pasted list', () => {
  it('reports the line that needs clarifying and saves nothing of the rest', () => {
    const out = parseBulkTaskList(
      '1. Fine one (October 20)\n2. Bad one (10/13)\n3. Also fine (October 21)',
      ctx,
    );
    expect(out.problems).toEqual([
      { lineNo: 2, kind: 'ambiguous_date', line: '2. Bad one (10/13)' },
    ]);
    // The readable lines are still parsed: the CALLER decides to refuse the
    // batch, so it can say exactly which line was the problem.
    expect(out.items.map((i) => i.title)).toEqual(['Fine one', 'Also fine']);
  });

  it('ignores a header before the first item and counts it', () => {
    const out = parseBulkTaskList('Homework:\n1. One (October 20)\n2. Two', ctx);
    expect(out.ignoredLeadingLines).toBe(1);
    expect(out.items.map((i) => i.title)).toEqual(['One', 'Two']);
    expect(out.problems).toEqual([]);
  });

  it('refuses an unnumbered line AFTER the list has started rather than dropping it', () => {
    const out = parseBulkTaskList('1. One (October 20)\nsomething else\n2. Two', ctx);
    expect(out.problems.map((p) => p.kind)).toEqual(['unnumbered']);
  });

  it('keeps a line with no brackets as a task with no deadline', () => {
    const out = parseBulkTaskList('1. Buy milk\n2. Call the dentist', ctx);
    expect(out.problems).toEqual([]);
    expect(out.items.every((i) => i.deadline === undefined)).toBe(true);
  });

  it('refuses a deadline with nothing to do', () => {
    const out = parseBulkTaskList('1. (October 20)\n2. Real one (October 21)', ctx);
    expect(out.problems.map((p) => p.kind)).toEqual(['empty_title']);
  });

  it('is bounded: a paste past the item limit reports it rather than truncating quietly', () => {
    const lines = Array.from(
      { length: BULK_CAPTURE_MAX_ITEMS + 2 },
      (_, i) => `${i + 1}. Task ${i + 1}`,
    );
    const out = parseBulkTaskList(lines.join('\n'), ctx);
    expect(out.items).toHaveLength(BULK_CAPTURE_MAX_ITEMS);
    expect(out.problems.map((p) => p.kind)).toEqual(['too_many_items', 'too_many_items']);
  });
});

describe('the Edit control’s own parse', () => {
  it('accepts the same forms, and `none` to clear a deadline', () => {
    expect(parseDeadlineInput('October 15 11:59 PM', ctx)?.allDay).toBe(false);
    expect(parseDeadlineInput('(October 15)', ctx)?.allDay).toBe(true);
    expect(parseDeadlineInput('none', ctx)).toBeUndefined();
    expect(parseDeadlineInput('   ', ctx)).toBeUndefined();
  });

  it('refuses rather than guessing, with the reason in the message', () => {
    expect(() => parseDeadlineInput('10/13', ctx)).toThrow(/will not guess/i);
    expect(() => parseDeadlineInput('whenever', ctx)).toThrow(/could not read as a date/i);
  });
});

describe('an all-day deadline is late only once its day has ended', () => {
  const dueDay = Date.parse('2026-10-12T16:00:00.000Z'); // 2026-10-13 00:00 Manila

  it('is not overdue at one second past midnight on the day itself', () => {
    const justAfterMidnight = dueDay + 1000;
    expect(isAllDayOverdue(dueDay, justAfterMidnight, MANILA)).toBe(false);
  });

  it('is not overdue late that same evening', () => {
    expect(isAllDayOverdue(dueDay, dueDay + 23 * 3_600_000, MANILA)).toBe(false);
  });

  it('is overdue once the next local day has begun', () => {
    const nextDay = startOfZonedDay(dueDay + 36 * 3_600_000, MANILA);
    expect(isAllDayOverdue(dueDay, nextDay, MANILA)).toBe(true);
  });
});

describe('how a deadline is shown back', () => {
  const iso = new Date(Date.parse('2026-10-13T15:59:00.000Z')).toISOString(); // 23:59 Manila

  it('names the month and the clock time, with no timezone label anywhere', () => {
    const shown = formatDeadline(iso, { timeZone: MANILA, allDay: false, nowMs: NOW });
    expect(shown).toBe('October 13, 11:59 PM');
    expect(shown).not.toMatch(/manila|gmt|utc|\+08/i);
  });

  it('shows a date-only deadline as a date, inventing no time', () => {
    const dateOnly = new Date(Date.parse('2026-10-14T16:00:00.000Z')).toISOString();
    expect(formatDeadline(dateOnly, { timeZone: MANILA, allDay: true, nowMs: NOW }))
      .toBe('October 15');
  });

  it('adds the year only when it is not the current one', () => {
    const nextYear = new Date(Date.parse('2027-01-04T16:00:00.000Z')).toISOString();
    expect(formatDeadline(nextYear, { timeZone: MANILA, allDay: true, nowMs: NOW }))
      .toBe('January 5, 2027');
  });

  it('never consults the ambient locale', () => {
    // Same instant, same string, whatever the host is set to.
    const shown = formatDeadline(iso, { timeZone: MANILA, allDay: false, nowMs: NOW });
    expect(shown).toBe('October 13, 11:59 PM');
  });
});

describe('which addresses the phone page may be served on', () => {
  it('accepts loopback, RFC1918 and the tailnet ranges', () => {
    for (const host of [
      '127.0.0.1', 'localhost', '::1',
      '10.0.0.4', '172.16.9.9', '172.31.0.1', '192.168.1.50',
      '100.64.0.1', '100.101.102.103', '100.127.255.254',
      'fd7a:115c:a1e0::1', '[fd7a:115c:a1e0:ab12::1]',
    ]) {
      expect(isPrivateBindHost(host), host).toBe(true);
    }
  });

  it('refuses every interface, and every public address', () => {
    for (const host of [
      '0.0.0.0', '::', '*', '', '8.8.8.8', '20.51.3.9',
      '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700::1111',
      'ducky.example.com',
    ]) {
      expect(isPrivateBindHost(host), host).toBe(false);
    }
  });
});
