import {
  BRIEFING_SECTION_MAX, zonedParts,
  type BriefingKind,
} from '@ducky/contracts';
import type {
  CaptureRow, ReminderRow, ScheduleExceptionRow, ScheduleRow, Store, TaskRow,
} from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import { isoOf, type OwnerClock } from './owner-clock.js';
import type { WeatherReport } from '@ducky/adapters';
import type { AssistantWatchService, WatchDigest } from './assistant-watch.service.js';
import type { OwnerPreferencesService } from './owner-preferences.service.js';
import type { WeatherBriefing } from './weather-briefing.js';
import { scheduleWindow } from './schedule-window.js';

export interface BriefingServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly clock: OwnerClock;
  /**
   * Imported preferences. Omitted, or not selected by the profile, means the
   * native briefing exactly as it was: no section below is ever added by default.
   */
  readonly prefs?: OwnerPreferencesService | undefined;
  /**
   * The notification-only targets, for the GitHub digest an imported preference
   * asks for. A getter, because the service is wired after this one and only
   * ever read while a briefing is being built.
   */
  readonly watch?: (() => AssistantWatchService | undefined) | undefined;
  /** The forecast, when a location is configured. */
  readonly weather?: WeatherBriefing | undefined;
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
  /** Exceptions on the day this briefing is about, so a cancelled class is explained. */
  readonly scheduleExceptions?: BriefingSection<ScheduleExceptionRow> | undefined;
  /**
   * Tasks due in the next few days, from tomorrow. Present only when an imported
   * preference asks for a lookahead on a morning or daily briefing.
   */
  readonly lookahead?: { readonly days: number; readonly tasks: BriefingSection<TaskRow> } | undefined;
  /** Unresolved captures, when an imported preference includes them. */
  readonly captures?:
    | { readonly total: number; readonly rows: readonly CaptureRow[]; readonly listed: boolean }
    | undefined;
  /** The forecast for the day this briefing is about, when one was asked for and fetched. */
  readonly weather?: WeatherReport | undefined;
  /**
   * What happened in the owner's watched repositories since the last briefing.
   * A digest is a read: carrying it settles nothing, and the notifier settles
   * `eventIds` only after the briefing has actually been sent.
   */
  readonly github?: WatchDigest | undefined;
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
  private readonly prefs: OwnerPreferencesService | undefined;
  private readonly watch: (() => AssistantWatchService | undefined) | undefined;
  private readonly weather: WeatherBriefing | undefined;

  constructor(deps: BriefingServiceDeps) {
    this.watch = deps.watch;
    this.weather = deps.weather;
    this.store = deps.store;
    this.authz = deps.authz;
    this.clock = deps.clock;
    this.prefs = deps.prefs;
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

  /**
   * `build` plus the one thing that needs the network: the forecast, when an
   * imported preference asks for it and a location is configured. A failed
   * fetch leaves the briefing without a weather section, never without a
   * briefing.
   */
  async assemble(actor: ActorContext, kind?: BriefingKind): Promise<Briefing> {
    this.authz.requireOwner(actor);
    const resolved = kind ?? this.defaultKind();
    const prefs = this.prefs?.effective();
    const weather =
      prefs?.includeWeather && this.weather ? ((await this.weather.forecastFor(resolved)) ?? undefined) : undefined;
    return this.build(actor, resolved, { weather });
  }

  build(
    actor: ActorContext,
    kind?: BriefingKind,
    extras: { readonly weather?: WeatherReport | undefined } = {},
  ): Briefing {
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

    // Confirmed one-off rows AND the computed occurrences of weekly rules, with
    // exceptions applied, merged in start order (ADR 0030).
    const todayWindow = scheduleWindow(this.store, owner, dayKey, nextDayKey, probe);
    const tomorrowWindow = scheduleWindow(this.store, owner, nextDayKey, dayAfterKey, probe);
    const scheduleToday = section(todayWindow.rows);
    const scheduleTomorrow = section(tomorrowWindow.rows);
    const scheduleExceptions = section(
      resolved === 'evening' ? tomorrowWindow.exceptions : todayWindow.exceptions,
    );
    const tasksDueToday = section(
      this.store.tasks.dueBetween(owner, isoOf(today.startMs), isoOf(today.endMs), probe),
    );
    // Overdue means "due before now" for a TIMED deadline, so a 09:00 task at
    // 17:00 is late and saying otherwise would be wrong. A DATE-ONLY deadline
    // is late only once its day has ended -- the briefing used to list every
    // task due today as overdue from midnight, which made the section useless
    // on exactly the mornings it mattered.
    const dayStartIso = isoOf(today.startMs);
    const tasksOverdue = section(this.store.tasks.overdue(owner, nowIso, dayStartIso, probe));
    const overdueTotal = this.store.tasks.countOverdue(owner, nowIso, dayStartIso);
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

    const prefs = this.prefs?.effective();
    const lookahead =
      prefs && prefs.lookaheadDays > 0 && resolved !== 'evening'
        ? {
            days: prefs.lookaheadDays,
            tasks: section(
              lookaheadTasks(
                this.store.tasks.dueBetween(
                  owner,
                  isoOf(tomorrow.startMs),
                  isoOf(this.clock.dayRange(prefs.lookaheadDays).endMs),
                  probe * 4,
                ),
              ),
            ),
          }
        : undefined;
    const captures =
      prefs && prefs.includeCaptures
        ? {
            total: this.store.captures.countOpen(owner),
            // The evening review lists items; the morning one reports the count.
            listed: resolved === 'evening',
            rows:
              resolved === 'evening'
                ? this.store.captures.listForOwner(owner, 'open', CAPTURE_REVIEW_MAX)
                : [],
          }
        : undefined;

    const github = prefs?.includeGithub ? this.watch?.()?.digest() : undefined;

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
      scheduleExceptions,
      lookahead,
      captures,
      weather: extras.weather,
      github,
      openTaskCount: this.store.tasks.countOpen(owner),
      // The reminders the owner set, not the ones a deadline earned: the
      // tasks they belong to are already named in their own sections.
      scheduledReminderCount: this.store.reminders.countScheduledUnlinked(owner),
      empty: forThisKind.every((s) => s.rows.length === 0),
    };
  }
}

/** Trims a probe read back to the cap and records whether anything was cut. */
const section = <T>(rows: readonly T[]): BriefingSection<T> => ({
  rows: rows.slice(0, BRIEFING_SECTION_MAX),
  more: rows.length > BRIEFING_SECTION_MAX,
});

/** How many captures an evening review lists before it says "and N more". */
export const CAPTURE_REVIEW_MAX = 6;

/**
 * The lookahead shows what needs attention first: the high-priority tasks if
 * there are any, otherwise the next few. A busy week is not a wall of text.
 */
const LOOKAHEAD_FALLBACK = 5;
function lookaheadTasks(rows: readonly TaskRow[]): TaskRow[] {
  const high = rows.filter((t) => t.priority === 'high');
  return high.length > 0 ? high : rows.slice(0, LOOKAHEAD_FALLBACK);
}
