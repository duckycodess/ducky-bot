import { expandScheduleWindow, type ScheduleOccurrence } from '@ducky/contracts';
import type { ScheduleExceptionRow, ScheduleRow, Store } from '@ducky/persistence';

/** A computed occurrence, shaped like the confirmed row every reader already renders. */
export function occurrenceAsRow(o: ScheduleOccurrence, ownerId: string): ScheduleRow {
  return {
    id: `rule:${o.ruleId}:${o.date}`,
    discordUserId: ownerId,
    title: o.label,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    location: o.room,
    notes: null,
    sourceKind: 'recurring',
    confirmedAt: '',
  };
}

/** Sorts wall-clock text of either stored shape (`T` or a space) by when it starts. */
const startKey = (s: string): string => s.replace(' ', 'T');

export interface ScheduleWindowResult {
  /** Confirmed one-off rows and computed occurrences, merged and in order. */
  readonly rows: readonly ScheduleRow[];
  /** Exceptions that fall inside the window, so a reader can say what changed. */
  readonly exceptions: readonly ScheduleExceptionRow[];
}

/**
 * Everything on the owner's schedule inside `[startDate, endDateExclusive)`.
 *
 * Confirmed rows come from the table as they always did; weekly rules are
 * expanded for the window ONLY, so nothing is materialized and no horizon
 * exists. `limit` bounds how many merged rows come back and callers ask for one
 * more than they will show, so a cut section can say it was cut.
 *
 * Only ACTIVE rules are read: a replaced batch is inert data and never drives
 * what the owner is told about their day.
 */
export function scheduleWindow(
  store: Store,
  ownerId: string,
  startDate: string,
  endDateExclusive: string,
  limit: number,
): ScheduleWindowResult {
  const oneOff = store.schedules.listForOwnerBetweenDates(ownerId, startDate, endDateExclusive, limit);
  const rules = store.scheduleRules.activeRules(ownerId);
  const exceptions = store.scheduleRules.exceptionsBetween(ownerId, startDate, endDateExclusive);
  const expanded = expandScheduleWindow(rules, exceptions, startDate, endDateExclusive);
  const rows = [...oneOff, ...expanded.occurrences.map((o) => occurrenceAsRow(o, ownerId))].sort(
    (a, b) => (startKey(a.startsAt) < startKey(b.startsAt) ? -1 : startKey(a.startsAt) > startKey(b.startsAt) ? 1 : 0),
  );
  return { rows: rows.slice(0, limit), exceptions };
}
