import { randomUUID } from 'node:crypto';
import {
  DuckyError, MAX_SCHEDULED_REMINDERS_PER_OWNER, REMINDER_TEXT_MAX,
  TASK_ALL_DAY_REMINDER_HOUR, TASK_REMINDER_OFFSETS_MS, TASK_SNOOZE_MINUTES,
  instantOfZonedWallClock, newPublicReminderId, zonedParts,
} from '@ducky/contracts';
import type { ReminderRow, Store, TaskRow } from '@ducky/persistence';
import { isoOf, type OwnerClock } from './owner-clock.js';

/**
 * When a task's deadline should be announced.
 *
 * Pure and clock-injected, so every branch is testable without waiting: the
 * two offsets of a timed deadline, the morning-of a date-only one, and the
 * ones that are already in the past.
 *
 * **A past offset is SKIPPED, never fired.** Saving a task an hour before it
 * is due must not produce an immediate "due in 24 hours" message, and a
 * date-only task saved at 10am must not announce an 08:00 that has gone. The
 * save succeeds with fewer reminders rather than failing or back-dating one --
 * the deadline is the real record, and a notification for a moment that has
 * passed is noise at best and wrong at worst.
 */
export function planTaskReminderFires(
  task: Pick<TaskRow, 'dueAt' | 'dueAllDay'>,
  nowMs: number,
  timeZone: string,
): number[] {
  if (!task.dueAt) return [];
  const dueMs = Date.parse(task.dueAt);
  if (Number.isNaN(dueMs)) return [];

  const candidates = task.dueAllDay
    ? [allDayFireMs(dueMs, timeZone)]
    : TASK_REMINDER_OFFSETS_MS.map((offset) => dueMs - offset);

  return [...new Set(candidates.filter((ms) => ms > nowMs))].sort((a, b) => a - b);
}

/** 08:00 on the civil day a date-only deadline names, in the owner's zone. */
function allDayFireMs(dueMs: number, timeZone: string): number {
  const p = zonedParts(dueMs, timeZone);
  return instantOfZonedWallClock(
    timeZone, p.year, p.month, p.day, TASK_ALL_DAY_REMINDER_HOUR, 0,
  );
}

export interface TaskReminderSync {
  /** Reminders now scheduled for this task. */
  readonly scheduled: number;
  /** Pending reminders withdrawn because the deadline moved or the task closed. */
  readonly cancelled: number;
}

export interface TaskReminderLinkerDeps {
  readonly store: Store;
  readonly clock: OwnerClock;
}

/**
 * The link between a task's deadline and the notifications it earns.
 *
 * **Every method here assumes the caller has already opened a transaction and
 * has already checked that the actor is the owner.** Both are deliberate:
 *
 * - a resync is a cancel AND an insert, and a crash between them would leave a
 *   task whose notifications describe a deadline it no longer has, so the two
 *   must commit together with whatever moved the deadline in the first place;
 * - `withTransaction` opens `BEGIN IMMEDIATE` and SQLite does not nest, so a
 *   method that opened its own could never be called from a batch save.
 *
 * Owner scoping is still enforced in SQL on every statement, so a mistaken
 * caller cannot reach another account's rows even inside its own transaction.
 */
export class TaskReminderLinker {
  constructor(private readonly deps: TaskReminderLinkerDeps) {}

  /**
   * Makes the stored reminders match the task's CURRENT deadline.
   *
   * Cancel-then-insert rather than diff-and-patch: the offsets are derived
   * entirely from the deadline, so recomputing them is both simpler and
   * exactly right, and an occurrence that was already delivered is a record of
   * a message that really was sent and is never withdrawn.
   */
  syncForTask(ownerId: string, task: TaskRow): TaskReminderSync {
    const nowMs = this.deps.clock.nowMs();
    const nowIso = isoOf(nowMs);
    const cancelled = this.deps.store.reminders.cancelForTask(ownerId, task.id, nowIso);

    if (task.status !== 'open') return { scheduled: 0, cancelled };

    const fires = planTaskReminderFires(task, nowMs, this.deps.clock.timeZone);
    if (fires.length === 0) return { scheduled: 0, cancelled };

    this.assertCapacity(ownerId, fires.length);
    for (const fireAtMs of fires) this.insertLinked(ownerId, task, fireAtMs, nowIso);
    return { scheduled: fires.length, cancelled };
  }

  /** Withdraws every pending notification for a task. Delivered ones stay. */
  cancelForTask(ownerId: string, taskId: string): number {
    return this.deps.store.reminders.cancelForTask(ownerId, taskId, this.deps.clock.nowIso());
  }

  /**
   * Postpones the NOTIFICATION, and nothing else.
   *
   * The task keeps the deadline it has: snoozing is the owner saying "tell me
   * again later", not "this is due later", and silently moving a real deadline
   * because somebody pressed a button would be the worst kind of helpful. The
   * new reminder is one more bounded one-shot, counted against the same cap as
   * every other.
   */
  snooze(ownerId: string, task: TaskRow, minutes = TASK_SNOOZE_MINUTES): ReminderRow {
    const nowMs = this.deps.clock.nowMs();
    this.assertCapacity(ownerId, 1);
    return this.insertLinked(ownerId, task, nowMs + minutes * 60_000, isoOf(nowMs));
  }

  private assertCapacity(ownerId: string, wanted: number): void {
    const scheduled = this.deps.store.reminders.countScheduled(ownerId);
    if (scheduled + wanted > MAX_SCHEDULED_REMINDERS_PER_OWNER) {
      throw new DuckyError(
        'invalid_input',
        `That would pass the limit of ${MAX_SCHEDULED_REMINDERS_PER_OWNER} scheduled ` +
          'reminders. Cancel some, or close some tasks, first.',
      );
    }
  }

  private insertLinked(
    ownerId: string,
    task: TaskRow,
    fireAtMs: number,
    nowIso: string,
  ): ReminderRow {
    return this.deps.store.reminders.insert({
      id: randomUUID(),
      publicId: this.freshPublicId(),
      discordUserId: ownerId,
      // The task's own title, so a DM fallback still says what it is about.
      // The CARD is rendered from the task row itself, not from this text.
      text: task.title.slice(0, REMINDER_TEXT_MAX),
      recurrenceKind: 'once',
      intervalMinutes: null,
      maxOccurrences: 1,
      firstFireAt: isoOf(fireAtMs),
      createdAt: nowIso,
      taskId: task.id,
    });
  }

  /** Bounded retry; a five-character handle collides rarely but not never. */
  private freshPublicId(): string {
    for (let i = 0; i < 5; i += 1) {
      const candidate = newPublicReminderId();
      if (!this.deps.store.reminders.publicIdExists(candidate)) return candidate;
    }
    throw new DuckyError('invalid_input', 'Could not allocate a reminder id. Try again.');
  }
}
