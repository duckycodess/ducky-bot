import {
  BRIEFING_SECTION_MAX, zonedParts,
  type BriefingKind,
} from '@ducky/contracts';
import type { ReminderRow, ScheduleRow, Store, TaskRow } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import { isoOf, type OwnerClock } from './owner-clock.js';

export interface BriefingServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly clock: OwnerClock;
}

/**
 * One section of a briefing, and whether it is the whole of it.
 *
 * A section is capped so a briefing cannot outgrow one Discord embed, but a
 * capped section must SAY it was capped. A briefing that quietly omits the
 * eleventh meeting of the day is exactly the kind of confident-but-incomplete
 * answer this milestone is supposed to avoid, so the cap is fetched with one
 * extra row and the overflow is reported rather than dropped in silence.
 */
export interface BriefingSection<T> {
  readonly rows: readonly T[];
  readonly more: boolean;
}

/**
 * Everything a briefing says, and nothing else.
 *
 * Deliberately a data structure rather than prose: the service COUNTS and
 * SELECTS, the presenter renders. That split is what makes "no AI-generated
 * facts" a structural property instead of a promise -- there is no field here
 * that could hold a generated sentence, and no provider is reachable from the
 * assembly path at all.
 */
export interface Briefing {
  readonly kind: BriefingKind;
  readonly timeZone: string;
  readonly generatedAt: string;
  /** The civil day the briefing is about, `YYYY-MM-DD` in the owner's zone. */
  readonly dayKey: string;
  readonly nextDayKey: string;
  readonly scheduleToday: BriefingSection<ScheduleRow>;
  readonly scheduleTomorrow: BriefingSection<ScheduleRow>;
  readonly tasksDueToday: BriefingSection<TaskRow>;
  readonly tasksOverdue: BriefingSection<TaskRow>;
  /** Total overdue, which can exceed what `tasksOverdue` lists. */
  readonly overdueTotal: number;
  readonly tasksClosedToday: BriefingSection<TaskRow>;
  readonly remindersToday: BriefingSection<ReminderRow>;
  readonly remindersTomorrow: BriefingSection<ReminderRow>;
  readonly openTaskCount: number;
  readonly scheduledReminderCount: number;
  /** True when every section is empty: the presenter says so plainly. */
  readonly empty: boolean;
}

/**
 * Assembles the morning and evening summary from STORED RECORDS ONLY.
 *
 * The rule is worth stating in the code and not only in the roadmap: a
 * briefing that hallucinates a deadline is worse than no briefing. So this
 * service reads `tasks`, `reminders` and `schedules`, filters them by the
 * owner's own civil day, and counts. It holds no provider, calls nothing that
 * could generate text, and cannot fabricate an entry that is not in the
 * database. When there is nothing to report it says nothing rather than
 * padding.
 *
 * Owner-only, like everything else in 2B.
 */
export class BriefingService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly clock: OwnerClock;

  constructor(deps: BriefingServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.clock = deps.clock;
  }

  get timeZone(): string {
    return this.clock.timeZone;
  }

  /**
   * Which briefing the owner most likely meant when they did not say.
   *
   * Decided from the hour in THEIR zone, not the host's: before noon is a
   * morning briefing, from noon onwards an evening one.
   */
  defaultKind(): BriefingKind {
    return zonedParts(this.clock.nowMs(), this.clock.timeZone).hour < 12 ? 'morning' : 'evening';
  }

  build(actor: ActorContext, kind?: BriefingKind): Briefing {
    this.authz.requireOwner(actor);
    const owner = actor.discordUserId;
    const resolved = kind ?? this.defaultKind();

    const today = this.clock.dayRange(0);
    const tomorrow = this.clock.dayRange(1);
    const dayKey = this.clock.dayKey(0);
    const nextDayKey = this.clock.dayKey(1);
    const dayAfterKey = this.clock.dayKey(2);
    const nowIso = this.clock.nowIso();
    // One more than the cap, so an overflow can be REPORTED rather than
    // silently dropped. `section` trims it back and sets the flag.
    const probe = BRIEFING_SECTION_MAX + 1;

    const scheduleToday = section(
      this.store.schedules.listForOwnerBetweenDates(owner, dayKey, nextDayKey, probe),
    );
    const scheduleTomorrow = section(
      this.store.schedules.listForOwnerBetweenDates(owner, nextDayKey, dayAfterKey, probe),
    );
    const tasksDueToday = section(
      this.store.tasks.dueBetween(owner, isoOf(today.startMs), isoOf(today.endMs), probe),
    );
    // Overdue means "due before now", so a task due later today is not yet
    // late. It is deliberately not "due before today": a 09:00 task at 17:00
    // is overdue and saying otherwise would be wrong.
    const tasksOverdue = section(this.store.tasks.overdue(owner, nowIso, probe));
    const overdueTotal = this.store.tasks.countOverdue(owner, nowIso);
    const tasksClosedToday = section(
      this.store.tasks.closedBetween(owner, 'done', isoOf(today.startMs), isoOf(today.endMs), probe),
    );
    const remindersToday = section(
      this.store.reminders.scheduledBetween(owner, nowIso, isoOf(today.endMs), probe),
    );
    const remindersTomorrow = section(
      this.store.reminders.scheduledBetween(
        owner, isoOf(tomorrow.startMs), isoOf(tomorrow.endMs), probe,
      ),
    );

    const forThisKind =
      resolved === 'evening'
        ? [scheduleTomorrow, tasksDueToday, tasksOverdue, tasksClosedToday, remindersTomorrow]
        : [scheduleToday, tasksDueToday, tasksOverdue, remindersToday, tasksClosedToday];

    return {
      kind: resolved,
      timeZone: this.clock.timeZone,
      generatedAt: nowIso,
      dayKey,
      nextDayKey,
      scheduleToday,
      scheduleTomorrow,
      tasksDueToday,
      tasksOverdue,
      overdueTotal,
      tasksClosedToday,
      remindersToday,
      remindersTomorrow,
      openTaskCount: this.store.tasks.countOpen(owner),
      scheduledReminderCount: this.store.reminders.countScheduled(owner),
      empty: forThisKind.every((s) => s.rows.length === 0),
    };
  }
}

/** Trims a probe read back to the cap and records whether anything was cut. */
const section = <T>(rows: readonly T[]): BriefingSection<T> => ({
  rows: rows.slice(0, BRIEFING_SECTION_MAX),
  more: rows.length > BRIEFING_SECTION_MAX,
});
