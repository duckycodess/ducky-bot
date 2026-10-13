import { DuckyError } from './errors.js';
import { TASK_TITLE_MAX } from './limits.js';
import { cleanUntrusted } from './discord.js';
import {
  instantOfZonedWallClock, startOfZonedDay, zonedParts, type WhenContext,
} from './time.js';

/**
 * Pasting a list of deadlines, exactly as a phone keyboard produces one.
 *
 * This is a SECOND, deliberately separate grammar from `parseWhen`, and the
 * separation is the point. `parseWhen` answers "when is this one reminder?"
 * for a single typed expression and its forms are quoted back verbatim in
 * `WHEN_HELP`; widening it would change what every existing caller accepts.
 * What a pasted list needs is different in kind: many lines at once, a title
 * beside each date, month NAMES rather than ISO, and an optional clock time.
 *
 * Three rules hold everywhere below, and everything else follows from them:
 *
 * 1. **Nothing is guessed.** `10/13` could be October 13 or the 10th of
 *    December depending on where you grew up, so it is REFUSED with a
 *    clarification rather than resolved by a default nobody chose. The same
 *    goes for a trailing parenthesis that is not a date at all.
 * 2. **Nothing is silently dropped.** Every non-blank line is either an item
 *    or a reported problem. A header before the first item is ignored, and the
 *    preview says how many lines that was.
 * 3. **A time is optional and a missing one is not invented.** A date with no
 *    clock time is an ALL-DAY deadline, which means the end of that civil day
 *    -- not midnight at its start. See `isAllDayOverdue`.
 */

/** How many items one paste may carry. A list, not an import. */
export const BULK_CAPTURE_MAX_ITEMS = 25;
/** How much text is ever read. Bounds the parser's work on any surface. */
export const BULK_CAPTURE_MAX_INPUT = 4000;
/**
 * How many numbered lines a Discord MESSAGE must have before it is read as a
 * task list at all. Two, so a sentence that happens to start "1." is still
 * ordinary conversation.
 */
export const BULK_CAPTURE_MIN_DETECTED_ITEMS = 2;

/** Why one line could not become a task. Each maps to a fixed message. */
export const BULK_PROBLEM_KINDS = [
  'unnumbered',
  'ambiguous_date',
  'unknown_date',
  'impossible_date',
  'empty_title',
  'too_many_items',
] as const;
export type BulkProblemKind = (typeof BULK_PROBLEM_KINDS)[number];

export const BULK_PROBLEM_MESSAGE: Record<BulkProblemKind, string> = {
  unnumbered: 'is not numbered. Number every item, like `1. Title (October 13)`.',
  ambiguous_date:
    'has a date I will not guess at: a numeric date can mean two different days. ' +
    'Write the month name, like `(October 13)` or `(October 13 11:59 PM)`.',
  unknown_date:
    'ends in brackets I could not read as a date. Use `(October 13)`, ' +
    '`(October 13 11:59 PM)` or `(2026-10-13)`, or leave the brackets off for no deadline.',
  impossible_date: 'names a day that does not exist.',
  empty_title: 'has a deadline but nothing to do.',
  too_many_items: `is past the ${BULK_CAPTURE_MAX_ITEMS}-item limit for one paste.`,
};

export interface BulkDeadline {
  readonly atMs: number;
  /** True when the owner gave a date with no clock time. */
  readonly allDay: boolean;
}

export interface BulkTaskDraft {
  /** 1-based line number in what the owner pasted, so a problem is findable. */
  readonly lineNo: number;
  readonly title: string;
  readonly deadline?: BulkDeadline;
}

export interface BulkProblem {
  readonly lineNo: number;
  readonly kind: BulkProblemKind;
  /** The owner's own line, cleaned and clipped. Never anything invented. */
  readonly line: string;
}

export interface BulkParseResult {
  readonly items: readonly BulkTaskDraft[];
  readonly problems: readonly BulkProblem[];
  /** Non-blank lines before the first numbered item: a pasted header. */
  readonly ignoredLeadingLines: number;
}

const NUMBERED = /^\s*(\d{1,2})\s*[.)]\s+(.+)$/;
const TRAILING_PARENS = /\(([^()]{1,80})\)\s*$/;

const MONTHS: readonly string[] = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Month names as they are PRINTED back. Hand-held so no locale can change them. */
export const MONTH_NAMES: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthNumber(word: string): number | undefined {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w === 'sept') return 9;
  const exact = MONTHS.indexOf(w);
  if (exact >= 0) return exact + 1;
  if (w.length === 3) {
    const i = MONTHS.findIndex((m) => m.startsWith(w));
    if (i >= 0) return i + 1;
  }
  return undefined;
}

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const tidy = (s: string): string => cleanUntrusted(s).replace(/\s+/g, ' ').trim();

/**
 * Whether a whole message should be read as a pasted task list.
 *
 * Deliberately conservative, because the cost of a false positive is an
 * assistant that answers a question with a task preview:
 *
 * - quotes (`>`) and fenced code are DATA, never instructions, so a message
 *   containing either is never a list;
 * - at least two numbered lines, so one sentence beginning "1." is not one;
 * - every non-blank line from the first item onwards must be numbered, so a
 *   paragraph with a numbered aside is not one either.
 *
 * A header BEFORE the first item is allowed and ignored; `parseBulkTaskList`
 * counts it so the preview can say so.
 */
export function looksLikeBulkTaskList(raw: string): boolean {
  const text = raw.trim();
  if (text === '' || text.length > BULK_CAPTURE_MAX_INPUT) return false;
  if (text.includes('```')) return false;

  const lines = text.split(/\r?\n/);
  let items = 0;
  let started = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (/^\s*>/.test(line)) return false;
    if (NUMBERED.test(line)) {
      items += 1;
      started = true;
      continue;
    }
    // A non-numbered line after the list has begun means this is prose.
    if (started) return false;
  }
  return items >= BULK_CAPTURE_MIN_DETECTED_ITEMS;
}

/**
 * Reads a pasted list into drafts and problems.
 *
 * It NEVER throws for bad content: a line it cannot read becomes a problem the
 * caller shows the owner, because a list of twelve items with one unreadable
 * date should say which line, not fail as a whole. The caller decides what to
 * do with problems -- the services in this repository refuse the whole batch,
 * so nothing is half-saved and nothing is guessed.
 */
export function parseBulkTaskList(raw: string, ctx: WhenContext): BulkParseResult {
  const items: BulkTaskDraft[] = [];
  const problems: BulkProblem[] = [];
  const text = raw.slice(0, BULK_CAPTURE_MAX_INPUT);
  const lines = text.split(/\r?\n/);

  let started = false;
  let ignoredLeadingLines = 0;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (line === '') return;

    const numbered = NUMBERED.exec(line);
    if (!numbered) {
      if (started) problems.push({ lineNo, kind: 'unnumbered', line: clip(tidy(line), 120) });
      else ignoredLeadingLines += 1;
      return;
    }
    started = true;

    if (items.length >= BULK_CAPTURE_MAX_ITEMS) {
      problems.push({ lineNo, kind: 'too_many_items', line: clip(tidy(line), 120) });
      return;
    }

    const body = numbered[2] ?? '';
    const parens = TRAILING_PARENS.exec(body);
    const titleRaw = parens ? body.slice(0, parens.index) : body;
    const title = clip(tidy(titleRaw).replace(/[-–—:,]+$/, '').trim(), TASK_TITLE_MAX);

    let deadline: BulkDeadline | undefined;
    if (parens) {
      const parsed = parseBulkDeadline(parens[1] ?? '', ctx);
      if ('problem' in parsed) {
        problems.push({ lineNo, kind: parsed.problem, line: clip(tidy(line), 120) });
        return;
      }
      deadline = parsed;
    }

    if (title === '') {
      problems.push({ lineNo, kind: 'empty_title', line: clip(tidy(line), 120) });
      return;
    }

    items.push({ lineNo, title, ...(deadline ? { deadline } : {}) });
  });

  return { items, problems, ignoredLeadingLines };
}

type DeadlineOutcome = BulkDeadline | { readonly problem: BulkProblemKind };

const NUMERIC_DATE = /^\d{1,2}\s*[/.\\-]\s*\d{1,2}(\s*[/.\\-]\s*\d{2,4})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/;
const CLOCK_24 = /^(\d{1,2}):(\d{2})$/;

/**
 * One deadline expression: `October 13 11:59 PM`, `October 15`, `2026-10-13`.
 *
 * A yearless date resolves to the NEXT civil occurrence at or after today in
 * the owner's zone, compared by calendar date rather than by instant -- so a
 * deadline typed at 11:00 PM for 11:59 PM tonight is tonight, not a year away.
 * A date whose day does not exist in the next five years (`February 30`) is a
 * problem rather than a rolled-over March.
 */
export function parseBulkDeadline(raw: string, ctx: WhenContext): DeadlineOutcome {
  const text = tidy(raw).toLowerCase().replace(/^(due|by|on|at)\s+/, '').replace(/\s*,\s*/g, ' ');
  if (text === '') return { problem: 'unknown_date' };

  // Split a trailing clock time off, whatever the date form was.
  const timeMatch =
    /\s(\d{1,2}(?::\d{2})?\s*(?:am|pm))$/.exec(text) ?? /\s(\d{1,2}:\d{2})$/.exec(text);
  const datePart = timeMatch ? text.slice(0, timeMatch.index).trim() : text;
  const clock = timeMatch ? readClock(timeMatch[1] ?? '') : undefined;
  if (timeMatch && clock === undefined) return { problem: 'unknown_date' };

  const iso = ISO_DATE.exec(datePart);
  if (iso) {
    return resolveCalendar(
      ctx,
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      clock,
      false,
    );
  }

  // `10/13`, `13-10-2026`: two readings, so it is refused rather than guessed.
  if (NUMERIC_DATE.test(datePart)) return { problem: 'ambiguous_date' };

  const named = /^([a-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(datePart)
    ?? /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9}\.?)(?:\s+(\d{4}))?$/.exec(datePart);
  if (!named) return { problem: 'unknown_date' };

  const monthFirst = /^[a-z]/.test(named[1] ?? '');
  const month = monthNumber((monthFirst ? named[1] : named[2]) ?? '');
  const day = Number((monthFirst ? named[2] : named[1]) ?? '');
  const year = named[3] === undefined ? undefined : Number(named[3]);
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
    return { problem: 'unknown_date' };
  }
  if (year !== undefined) return resolveCalendar(ctx, year, month, day, clock, false);

  return resolveCalendar(ctx, zonedParts(ctx.nowMs, ctx.timeZone).year, month, day, clock, true);
}

interface Clock {
  readonly hour: number;
  readonly minute: number;
}

function readClock(raw: string): Clock | undefined {
  const text = raw.replace(/\s+/g, '');
  const twelve = CLOCK_12.exec(text);
  if (twelve) {
    const h = Number(twelve[1]);
    const m = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (h < 1 || h > 12 || m > 59) return undefined;
    const pm = twelve[3] === 'pm';
    return { hour: pm ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h, minute: m };
  }
  const twentyFour = CLOCK_24.exec(text);
  if (twentyFour) {
    const h = Number(twentyFour[1]);
    const m = Number(twentyFour[2]);
    if (h > 23 || m > 59) return undefined;
    return { hour: h, minute: m };
  }
  return undefined;
}

/**
 * Turns a calendar reading into an instant, refusing a date the zone
 * conversion would roll over, and rolling a YEARLESS date forward to its next
 * real occurrence.
 */
function resolveCalendar(
  ctx: WhenContext,
  year: number,
  month: number,
  day: number,
  clock: Clock | undefined,
  rollForward: boolean,
): DeadlineOutcome {
  const today = zonedParts(ctx.nowMs, ctx.timeZone);
  const attempts = rollForward ? 5 : 1;

  for (let i = 0; i < attempts; i += 1) {
    const y = year + i;
    const at = instantOfZonedWallClock(
      ctx.timeZone, y, month, day, clock?.hour ?? 0, clock?.minute ?? 0,
    );
    const check = zonedParts(at, ctx.timeZone);
    const real = check.year === y && check.month === month && check.day === day;
    if (!real) continue;
    // Compared as a CALENDAR day, not as an instant: a deadline later today
    // that has already passed by the clock is still today's.
    const beforeToday =
      y < today.year ||
      (y === today.year && (month < today.month || (month === today.month && day < today.day)));
    if (rollForward && beforeToday) continue;
    return { atMs: at, allDay: clock === undefined };
  }
  return { problem: 'impossible_date' };
}

/**
 * One typed deadline, for the Edit control.
 *
 * Accepts the same forms a pasted line accepts, plus the word `none` to clear
 * a deadline. Throws rather than returning a problem, because here there is
 * exactly one answer to report and the caller is a single interaction.
 */
export function parseDeadlineInput(
  raw: string,
  ctx: WhenContext,
): BulkDeadline | undefined {
  const text = tidy(raw);
  if (text === '' || /^(none|no deadline|clear|-)$/i.test(text)) return undefined;
  const parsed = parseBulkDeadline(text.replace(/^\(|\)$/g, ''), ctx);
  if ('problem' in parsed) {
    throw new DuckyError(
      'invalid_input',
      `That deadline ${BULK_PROBLEM_MESSAGE[parsed.problem]}`,
    );
  }
  return parsed;
}

/**
 * Whether an ALL-DAY deadline has actually been missed.
 *
 * A date-only task is stored as that day's midnight, because that is the
 * instant the civil day begins -- but the owner meant the whole day. Treating
 * the stored instant as the moment it becomes late marked every task due today
 * as overdue from one second past midnight, which is the bug this exists to
 * fix. It is late once the day it names has ENDED.
 */
export const isAllDayOverdue = (dueAtMs: number, nowMs: number, tz: string): boolean =>
  dueAtMs < startOfZonedDay(nowMs, tz);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A deadline as the owner reads it: `October 13, 11:59 PM` or `October 15`.
 *
 * Deliberately NOT a Discord timestamp, and this is the one place in the
 * codebase that departs from ADR 0014's default. The owner asked for the
 * deadline they typed, shown back plainly, with no timezone suffix and no
 * viewer-relative rendering -- see docs/decisions/0026. It is assembled from
 * numeric parts and a hand-held month table, so no host locale can change it.
 *
 * The year is printed only when it is not the current one, because a year on
 * every line is noise on the eleven months where it says nothing.
 */
export function formatDeadline(
  iso: string,
  opts: { readonly timeZone: string; readonly allDay: boolean; readonly nowMs?: number },
): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const p = zonedParts(ms, opts.timeZone);
  const nowYear = zonedParts(opts.nowMs ?? Date.now(), opts.timeZone).year;
  const date =
    `${MONTH_NAMES[p.month - 1] ?? '?'} ${p.day}` + (p.year === nowYear ? '' : `, ${p.year}`);
  if (opts.allDay) return date;
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${date}, ${hour12}:${pad2(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}
