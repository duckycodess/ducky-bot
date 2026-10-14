import { DuckyError } from './errors.js';
import { SCHEDULE_WINDOW_MAX_DAYS } from './limits.js';

/**
 * Indefinite weekly schedules, and the dated exceptions that cancel part of one.
 *
 * Nothing here is materialized. A rule says "every Tuesday 09:00 to 10:30"; an
 * occurrence only exists for a civil-date window somebody asks about, and is
 * computed on the spot. That is the whole point: there is no horizon to run out
 * of and no refresh job to forget (ADR 0030).
 *
 * Rules are WALL-CLOCK, not instants, exactly like a confirmed one-off row
 * (`schedules.starts_at`): "09:00" means 09:00 where the owner is. So expansion
 * is pure civil-date arithmetic and the owner's zone only decides which dates a
 * window covers -- which the caller already did when it computed the window.
 * A DST change therefore cannot move or drop a class.
 */

export const SCHEDULE_EXCEPTION_KINDS = ['cancelled'] as const;
export type ScheduleExceptionKind = (typeof SCHEDULE_EXCEPTION_KINDS)[number];

/** Monday is 0 and Sunday is 6, the convention of the audited source. */
export const WEEKDAY_NAMES = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

export interface ScheduleRuleInput {
  readonly id: string;
  /** 0 = Monday ... 6 = Sunday. */
  readonly weekday: number;
  /** `HH:MM`, 24-hour wall clock. */
  readonly startTime: string;
  readonly endTime: string;
  readonly label: string;
  readonly courseCode: string | null;
  readonly section: string | null;
  readonly room: string | null;
  readonly uncertain: readonly string[];
  /** Inclusive civil dates, or null for unbounded on that side. */
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
}

export interface ScheduleExceptionInput {
  readonly id: string;
  /** The civil date the exception applies to, `YYYY-MM-DD`. */
  readonly date: string;
  readonly courseCode: string | null;
  readonly label: string | null;
  readonly kind: ScheduleExceptionKind;
  readonly note: string | null;
}

export interface ScheduleOccurrence {
  readonly ruleId: string;
  readonly date: string;
  /** Wall-clock `YYYY-MM-DDTHH:MM`, the same family a confirmed row stores. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly label: string;
  readonly courseCode: string | null;
  readonly section: string | null;
  readonly room: string | null;
  readonly uncertain: readonly string[];
}

export interface ScheduleWindow {
  readonly occurrences: readonly ScheduleOccurrence[];
  /** Exceptions that fall inside the window, so a reader can say what changed. */
  readonly exceptions: readonly ScheduleExceptionInput[];
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date. `2026-02-30` is not one. */
export function isCivilDate(s: string): boolean {
  const m = CIVIL_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Monday = 0 weekday of a civil date. Valid for any real date, any century. */
export function weekdayOfCivilDate(date: string): number {
  const m = CIVIL_DATE.exec(date);
  if (!m) throw new DuckyError('invalid_input', 'Not a calendar date.');
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return (day + 6) % 7;
}

/** The civil date `n` days after `date`. Pure calendar arithmetic, no zone. */
export function addCivilDays(date: string, n: number): string {
  const m = CIVIL_DATE.exec(date);
  if (!m) throw new DuckyError('invalid_input', 'Not a calendar date.');
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return t.toISOString().slice(0, 10);
}

const norm = (s: string | null): string => (s ?? '').trim().toLowerCase();

/**
 * Whether an exception removes a given rule on its date.
 *
 * An exception with NEITHER a course nor a label cancels every class that day.
 * Otherwise it removes the rules whose course code equals its course, or whose
 * label equals its label, both trimmed and case-insensitive. A rule with no
 * course never matches a course-targeted exception.
 */
export function exceptionCancels(ex: ScheduleExceptionInput, rule: ScheduleRuleInput): boolean {
  if (ex.kind !== 'cancelled') return false;
  const course = norm(ex.courseCode);
  const label = norm(ex.label);
  if (course === '' && label === '') return true;
  if (course !== '' && norm(rule.courseCode) === course) return true;
  if (label !== '' && norm(rule.label) === label) return true;
  return false;
}

/**
 * Every occurrence of the given rules in `[startDate, endDateExclusive)`, with
 * the exceptions applied.
 *
 * The window is bounded. A read that asks for more than
 * `SCHEDULE_WINDOW_MAX_DAYS` days is REFUSED rather than silently truncated,
 * because a schedule that stops at an invisible line looks exactly like one
 * that has nothing further in it. Results are ordered by date, then start.
 */
export function expandScheduleWindow(
  rules: readonly ScheduleRuleInput[],
  exceptions: readonly ScheduleExceptionInput[],
  startDate: string,
  endDateExclusive: string,
): ScheduleWindow {
  if (!isCivilDate(startDate) || !isCivilDate(endDateExclusive)) {
    throw new DuckyError('invalid_input', 'A schedule window needs real calendar dates.');
  }
  if (endDateExclusive <= startDate) return { occurrences: [], exceptions: [] };

  const span = Math.round(
    (Date.parse(`${endDateExclusive}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000,
  );
  if (span > SCHEDULE_WINDOW_MAX_DAYS) {
    throw new DuckyError(
      'invalid_input',
      `Ask for at most ${SCHEDULE_WINDOW_MAX_DAYS} days of the schedule at a time.`,
    );
  }

  const byWeekday = new Map<number, ScheduleRuleInput[]>();
  for (const rule of rules) {
    const list = byWeekday.get(rule.weekday) ?? [];
    list.push(rule);
    byWeekday.set(rule.weekday, list);
  }

  const out: ScheduleOccurrence[] = [];
  const inWindow = exceptions.filter((e) => e.date >= startDate && e.date < endDateExclusive);

  for (let i = 0; i < span; i += 1) {
    const date = addCivilDays(startDate, i);
    const todays = byWeekday.get(weekdayOfCivilDate(date));
    if (!todays) continue;
    const dayExceptions = inWindow.filter((e) => e.date === date);
    for (const rule of todays) {
      if (rule.effectiveFrom !== null && date < rule.effectiveFrom) continue;
      if (rule.effectiveUntil !== null && date > rule.effectiveUntil) continue;
      if (dayExceptions.some((e) => exceptionCancels(e, rule))) continue;
      out.push({
        ruleId: rule.id,
        date,
        startsAt: `${date}T${rule.startTime}`,
        endsAt: `${date}T${rule.endTime}`,
        label: rule.label,
        courseCode: rule.courseCode,
        section: rule.section,
        room: rule.room,
        uncertain: rule.uncertain,
      });
    }
  }
  out.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
  return { occurrences: out, exceptions: inWindow };
}
