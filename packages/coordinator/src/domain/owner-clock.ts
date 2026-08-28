import { assertValidTimeZone, zonedDateKey, zonedDayRangeOffset, type ZonedRange } from '@ducky/contracts';

/**
 * The assistant's single source of "now" and "where".
 *
 * Every 2B service takes one of these rather than reading `Date.now()` or a
 * timezone of its own. That is what makes reminders, due dates and briefing
 * day boundaries testable without waiting for real time to pass, and what
 * guarantees the three of them can never disagree about which day it is.
 *
 * The timezone is validated once, at construction, so a typo in configuration
 * fails at startup rather than months later as a silently wrong day boundary.
 */
export interface OwnerClock {
  readonly timeZone: string;
  nowMs(): number;
  nowIso(): string;
  /** The civil day `offsetDays` from today, in the owner's zone. */
  dayRange(offsetDays: number): ZonedRange;
  /** `YYYY-MM-DD` for that civil day, in the owner's zone. */
  dayKey(offsetDays: number): string;
}

export class ConfiguredOwnerClock implements OwnerClock {
  readonly timeZone: string;

  constructor(
    timeZone: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.timeZone = assertValidTimeZone(timeZone);
  }

  nowMs(): number {
    return this.now();
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  dayRange(offsetDays: number): ZonedRange {
    return zonedDayRangeOffset(this.now(), this.timeZone, offsetDays);
  }

  dayKey(offsetDays: number): string {
    return zonedDateKey(this.dayRange(offsetDays).startMs, this.timeZone);
  }
}

export const isoOf = (ms: number): string => new Date(ms).toISOString();
