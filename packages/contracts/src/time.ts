import { DuckyError } from './errors.js';

/**
 * Owner-facing time.
 *
 * Three rules hold everywhere in this file, and everything else follows from
 * them:
 *
 * 1. **Every instant is stored as an ISO-8601 UTC string.** Nothing persisted
 *    carries a zone offset or a wall-clock reading, so changing the configured
 *    timezone re-renders existing rows and never rewrites them. Phase 1's
 *    `schedules.starts_at` rows are already exactly this shape and are read
 *    back unchanged.
 * 2. **A timezone is only ever used to decide which civil day an instant falls
 *    in, and to turn a typed wall-clock time into an instant.** It is a
 *    projection, never storage.
 * 3. **No formatting depends on the ambient locale.** The preferred rendering
 *    is a Discord timestamp (`<t:…:f>`), which Discord itself renders in each
 *    viewer's own locale and zone, so a message stays correct without being
 *    re-sent. The text fallback is assembled from numeric parts by hand rather
 *    than through `toLocaleString`, so a host with a different default locale
 *    cannot change what the owner reads.
 */

export const DEFAULT_OWNER_TIMEZONE = 'UTC';

/**
 * IANA zone names, plus `UTC`. Deliberately not a regex over "anything with a
 * slash": the real check is whether the runtime's own ICU data accepts it,
 * because that is what every later conversion will use.
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validated once at startup so a typo fails loudly at boot rather than at the
 * first briefing, months later, as a silently wrong day boundary.
 */
export function assertValidTimeZone(tz: string, variableName = 'DUCKY_OWNER_TIMEZONE'): string {
  if (!isValidTimeZone(tz)) {
    throw new DuckyError(
      'invalid_input',
      `${variableName} must be an IANA timezone name such as UTC or Asia/Manila.`,
    );
  }
  return tz;
}

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (tz: string): Intl.DateTimeFormat => {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatter.set(tz, f);
  }
  return f;
};

/** The wall-clock reading in `tz` at instant `ms`. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds report midnight as hour 24 under h23; normalize rather
    // than let a whole day shift by one.
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** How far ahead of UTC `tz` is at instant `ms`. DST-correct by construction. */
export function zoneOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * The instant at which the given wall-clock reading occurs in `tz`.
 *
 * Solved by iteration rather than by a single offset lookup: the offset that
 * applies depends on the instant, which is what we are solving for, so a
 * naive one-shot conversion is wrong for an hour twice a year. Three passes
 * converge for every real zone, including the 30- and 45-minute ones.
 *
 * A wall-clock time that does not exist (the skipped hour on a spring-forward
 * day) resolves to the instant the clock jumps to, and one that occurs twice
 * resolves to the first. Both are deterministic, and neither can throw.
 */
export function instantOfZonedWallClock(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let t = wall - zoneOffsetMs(wall, tz);
  t = wall - zoneOffsetMs(t, tz);
  t = wall - zoneOffsetMs(t, tz);
  return t;
}

/** Midnight, in `tz`, of the civil day containing `ms`. */
export function startOfZonedDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return instantOfZonedWallClock(tz, p.year, p.month, p.day);
}

/**
 * `n` civil days after the day containing `ms`, at midnight.
 *
 * Steps through midday rather than adding 24 hours, so a day that is 23 or 25
 * hours long does not land on the wrong date.
 */
export function startOfZonedDayPlus(ms: number, tz: string, n: number): number {
  const start = startOfZonedDay(ms, tz);
  return startOfZonedDay(start + n * 86_400_000 + 43_200_000, tz);
}

export interface ZonedRange {
  /** Inclusive. */
  readonly startMs: number;
  /** Exclusive, so two consecutive days neither overlap nor leave a gap. */
  readonly endMs: number;
}

/** The civil day containing `ms`, in `tz`. */
export const zonedDayRange = (ms: number, tz: string): ZonedRange => ({
  startMs: startOfZonedDay(ms, tz),
  endMs: startOfZonedDayPlus(ms, tz, 1),
});

/** The civil day `n` days after the one containing `ms`. */
export const zonedDayRangeOffset = (ms: number, tz: string, n: number): ZonedRange => ({
  startMs: startOfZonedDayPlus(ms, tz, n),
  endMs: startOfZonedDayPlus(ms, tz, n + 1),
});

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * `YYYY-MM-DD HH:MM` in `tz`, assembled from numeric parts.
 *
 * Used for the plain-text fallback and for anything a test needs to assert on.
 * It never consults the ambient locale, so the string is identical on every
 * host.
 */
export function formatZoned(iso: string, tz: string, withTime = true): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown time';
  const p = zonedParts(ms, tz);
  const date = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  return withTime ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date;
}

/**
 * Discord's timestamp markup styles. `R` is relative ("in 3 hours"), `f` is a
 * short absolute date and time.
 */
export type DiscordTimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/**
 * `<t:seconds:style>`.
 *
 * Rendered by each viewer's own client in their own zone and locale, which is
 * why it is preferred over any string we could format: a stored message stays
 * correct as time passes and needs no re-send. An unparseable instant yields
 * an empty string rather than a broken tag.
 */
export function discordTimestamp(iso: string, style: DiscordTimestampStyle = 'f'): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/**
 * The standard readback: an absolute timestamp with the relative one beside
 * it, falling back to hand-formatted zoned text if the instant is unusable.
 */
export function discordWhen(iso: string, tz: string, style: DiscordTimestampStyle = 'f'): string {
  const absolute = discordTimestamp(iso, style);
  if (absolute === '') return formatZoned(iso, tz);
  return `${absolute} (${discordTimestamp(iso, 'R')})`;
}

/** `YYYY-MM-DD` in `tz`. The key a civil day is addressed by. */
export function zonedDateKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Reads a stored SCHEDULE timestamp.
 *
 * Phase 1 stores `schedules.starts_at` exactly as the owner typed it -- a bare
 * wall-clock reading like `2026-09-01 09:00`, with no zone and no offset. That
 * is what it has always meant: the time where the owner is. So it is read back
 * as a wall clock in the configured zone rather than reinterpreted as UTC,
 * and the stored text is never rewritten. Changing the configured zone
 * re-renders those rows; it does not migrate them.
 *
 * Anything that is not one of the recognised shapes returns undefined, and the
 * presenter shows the raw stored text rather than inventing an instant for it.
 */
export function parseStoredWallClock(
  raw: string,
  tz: string,
): { readonly atMs: number; readonly allDay: boolean } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
  if (!m) return undefined;
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  if (hour > 23 || minute > 59) return undefined;
  return {
    atMs: instantOfZonedWallClock(
      tz,
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      hour,
      minute,
      m[6] === undefined ? 0 : Number(m[6]),
    ),
    allDay: m[4] === undefined,
  };
}

// ---------------------------------------------------------------- parsing --

export interface WhenContext {
  readonly nowMs: number;
  readonly timeZone: string;
}

export interface ParsedWhen {
  readonly atMs: number;
  /**
   * True when the owner gave a date with no time of day. The instant is that
   * day's midnight in their zone; presenters render it as a date so no
   * precision is invented that the owner never typed.
   */
  readonly allDay: boolean;
}

/**
 * The accepted forms, written out because the error message quotes them
 * verbatim and both must stay in step.
 */
export const WHEN_FORMATS = [
  'in 30m / in 2h / in 3d / in 1w',
  '15:30 (the next time it is that clock time)',
  'today 18:00',
  'tomorrow 09:00',
  '2026-09-01',
  '2026-09-01 09:00',
] as const;

export const WHEN_HELP = `Use one of: ${WHEN_FORMATS.join('; ')}. Times are in your configured timezone.`;

const UNIT_MS: Record<string, number> = {
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

const RELATIVE = /^in\s+(\d{1,5})\s*([a-z]+)$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const DAY_CLOCK = /^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/;

const invalidWhen = (): DuckyError =>
  new DuckyError('invalid_input', `That time was not understood. ${WHEN_HELP}`);

const clockOrThrow = (h: number, m: number): [number, number] => {
  if (h > 23 || m > 59) throw invalidWhen();
  return [h, m];
};

/**
 * Turns what the owner typed into an instant.
 *
 * Deliberately a small, closed grammar rather than a natural-language date
 * parser: every accepted form is listed in `WHEN_FORMATS`, an unrecognised
 * input is refused with those forms quoted back, and nothing is ever guessed.
 * A wrong reminder time is worse than a rejected one.
 *
 * Every relative and wall-clock form is resolved against the OWNER'S zone, so
 * "tomorrow 09:00" means nine in the morning where they are, whatever the host
 * clock is set to.
 */
export function parseWhen(raw: string, ctx: WhenContext): ParsedWhen {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') throw invalidWhen();
  const tz = ctx.timeZone;

  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2] ?? ''];
    if (unit === undefined || amount <= 0) throw invalidWhen();
    return { atMs: ctx.nowMs + amount * unit, allDay: false };
  }

  const dayClock = DAY_CLOCK.exec(text);
  if (dayClock) {
    const [h, m] = clockOrThrow(Number(dayClock[2]), Number(dayClock[3]));
    const base = startOfZonedDayPlus(ctx.nowMs, tz, dayClock[1] === 'tomorrow' ? 1 : 0);
    const p = zonedParts(base, tz);
    return { atMs: instantOfZonedWallClock(tz, p.year, p.month, p.day, h, m), allDay: false };
  }

  const clock = CLOCK.exec(text);
  if (clock) {
    const [h, m] = clockOrThrow(Number(clock[1]), Number(clock[2]));
    const today = zonedParts(ctx.nowMs, tz);
    const candidate = instantOfZonedWallClock(tz, today.year, today.month, today.day, h, m);
    // A clock time that has already passed today means the next one, not one
    // in the past -- a reminder for a moment that is gone is never what was
    // meant.
    if (candidate > ctx.nowMs) return { atMs: candidate, allDay: false };
    const next = zonedParts(startOfZonedDayPlus(ctx.nowMs, tz, 1), tz);
    return {
      atMs: instantOfZonedWallClock(tz, next.year, next.month, next.day, h, m),
      allDay: false,
    };
  }

  const dateClock = DATE_CLOCK.exec(text);
  if (dateClock) {
    const [h, m] = clockOrThrow(Number(dateClock[4]), Number(dateClock[5]));
    return {
      atMs: calendarInstant(tz, dateClock[1], dateClock[2], dateClock[3], h, m),
      allDay: false,
    };
  }

  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    return {
      atMs: calendarInstant(tz, dateOnly[1], dateOnly[2], dateOnly[3], 0, 0),
      allDay: true,
    };
  }

  throw invalidWhen();
}

/**
 * Rejects a calendar date the zone conversion would silently roll over --
 * `2026-02-31` must be an error, not the third of March.
 */
function calendarInstant(
  tz: string,
  y: string | undefined,
  mo: string | undefined,
  d: string | undefined,
  hour: number,
  minute: number,
): number {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw invalidWhen();
  const at = instantOfZonedWallClock(tz, year, month, day, hour, minute);
  const check = zonedParts(at, tz);
  if (check.year !== year || check.month !== month || check.day !== day) throw invalidWhen();
  return at;
}

/**
 * A fixed recurrence interval, in minutes.
 *
 * Accepts the same unit vocabulary as `in <n><unit>` plus a bare number of
 * minutes. Deliberately NOT a cron expression: a cron field is a parsing
 * surface, an unbounded schedule and a support burden all at once, and a fixed
 * interval with an explicit occurrence count is something the owner can read
 * back and reason about. See ADR 0013.
 */
export function parseIntervalMinutes(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/\s+/g, '');
  const bare = /^(\d{1,7})$/.exec(text);
  if (bare) return numericMinutes(Number(bare[1]));

  const withUnit = /^(\d{1,7})([a-z]+)$/.exec(text);
  if (!withUnit) throw invalidInterval();
  const unit = UNIT_MS[withUnit[2] ?? ''];
  if (unit === undefined) throw invalidInterval();
  const ms = Number(withUnit[1]) * unit;
  if (ms % 60_000 !== 0) throw invalidInterval();
  return numericMinutes(ms / 60_000);
}

const numericMinutes = (minutes: number): number => {
  if (!Number.isInteger(minutes) || minutes <= 0) throw invalidInterval();
  return minutes;
};

const invalidInterval = (): DuckyError =>
  new DuckyError(
    'invalid_input',
    'That repeat interval was not understood. Use a fixed interval such as 30m, 2h, 1d or 1w.',
  );
