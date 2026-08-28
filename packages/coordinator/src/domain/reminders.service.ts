import { randomUUID } from 'node:crypto';
import {
  DuckyError, MAX_SCHEDULED_REMINDERS_PER_OWNER, PublicReminderIdSchema,
  REMINDER_DEFAULT_OCCURRENCES, REMINDER_LIST_PAGE_SIZE, REMINDER_MAX_HORIZON_MS,
  REMINDER_MAX_INTERVAL_MINUTES, REMINDER_MAX_OCCURRENCES, REMINDER_MIN_INTERVAL_MINUTES,
  ReminderAddInputSchema, newPublicReminderId, parseIntervalMinutes, parseWhen,
  type RecurrenceKind, type ReminderListFilter,
} from '@ducky/contracts';
import type { ReminderRow, Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import { isoOf, type OwnerClock } from './owner-clock.js';

export interface RemindersServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly clock: OwnerClock;
}

/**
 * Reminders: what the assistant will say, and when.
 *
 * Owner-only in full, and scoped by owner id in SQL on every read, exactly
 * like tasks and captures.
 *
 * Recurrence is a FIXED interval with an explicit occurrence count, and
 * nothing else. There is no cron grammar here and no unbounded schedule the
 * scheduler could be asked to walk forever: both bounds are validated at input
 * and enforced again by the table's own CHECK constraints, so a reminder that
 * repeats without end cannot be written by any path. See ADR 0013.
 */
export class RemindersService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly clock: OwnerClock;

  constructor(deps: RemindersServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.clock = deps.clock;
  }

  get timeZone(): string {
    return this.clock.timeZone;
  }

  add(actor: ActorContext, raw: unknown): ReminderRow {
    this.authz.requireOwner(actor);
    const input = ReminderAddInputSchema.parse(raw);
    const nowMs = this.clock.nowMs();

    if (this.store.reminders.countScheduled(actor.discordUserId) >= MAX_SCHEDULED_REMINDERS_PER_OWNER) {
      throw new DuckyError(
        'invalid_input',
        `You already have ${MAX_SCHEDULED_REMINDERS_PER_OWNER} scheduled reminders. Cancel some first.`,
      );
    }

    const when = parseWhen(input.at, { nowMs, timeZone: this.clock.timeZone });
    // Unlike a task's due date, a reminder in the past is refused: it would
    // fire on the very next tick, which is never what "remind me at 8am
    // yesterday" meant.
    if (when.atMs <= nowMs) {
      throw new DuckyError('invalid_input', 'That time has already passed. Give a future time.');
    }
    if (when.atMs > nowMs + REMINDER_MAX_HORIZON_MS) {
      throw new DuckyError('invalid_input', 'That time is too far in the future.');
    }

    let recurrenceKind: RecurrenceKind = 'once';
    let intervalMinutes: number | null = null;
    let maxOccurrences = 1;

    if (input.every !== undefined) {
      const minutes = parseIntervalMinutes(input.every);
      if (minutes < REMINDER_MIN_INTERVAL_MINUTES) {
        throw new DuckyError(
          'invalid_input',
          `The shortest repeat interval is ${REMINDER_MIN_INTERVAL_MINUTES} minutes.`,
        );
      }
      if (minutes > REMINDER_MAX_INTERVAL_MINUTES) {
        throw new DuckyError('invalid_input', 'The longest repeat interval is 365 days.');
      }
      recurrenceKind = 'interval';
      intervalMinutes = minutes;
      // Always bounded. An omitted count is a small default, never "forever".
      maxOccurrences = Math.min(input.count ?? REMINDER_DEFAULT_OCCURRENCES, REMINDER_MAX_OCCURRENCES);
    }

    return this.store.reminders.insert({
      id: randomUUID(),
      publicId: this.freshPublicId(),
      discordUserId: actor.discordUserId,
      text: input.text,
      recurrenceKind,
      intervalMinutes,
      maxOccurrences,
      firstFireAt: isoOf(when.atMs),
      createdAt: isoOf(nowMs),
    });
  }

  list(
    actor: ActorContext,
    filter: ReminderListFilter = 'scheduled',
    limit = REMINDER_LIST_PAGE_SIZE,
  ): ReminderRow[] {
    this.authz.requireOwner(actor);
    return this.store.reminders.listForOwner(
      actor.discordUserId,
      filter === 'all' ? 'all' : 'scheduled',
      limit,
    );
  }

  get(actor: ActorContext, publicId: string): ReminderRow {
    this.authz.requireOwner(actor);
    return this.owned(actor, publicId);
  }

  /**
   * Cancels a scheduled reminder. Nothing further is materialized, and any
   * occurrence already due but not yet delivered is abandoned in the same
   * transaction -- a cancelled reminder must not go on to send a message.
   */
  cancel(actor: ActorContext, publicId: string): ReminderRow {
    this.authz.requireOwner(actor);
    const row = this.owned(actor, publicId);
    if (row.status === 'cancelled') return row;
    if (row.status !== 'scheduled') {
      throw new DuckyError('invalid_input', `Reminder \`${row.publicId}\` has already finished.`);
    }
    this.store.reminders.cancel(actor.discordUserId, row.id, this.clock.nowIso());
    return this.store.reminders.byPublicId(actor.discordUserId, publicId) ?? row;
  }

  countScheduled(actor: ActorContext): number {
    this.authz.requireOwner(actor);
    return this.store.reminders.countScheduled(actor.discordUserId);
  }

  private owned(actor: ActorContext, publicId: string): ReminderRow {
    const parsed = PublicReminderIdSchema.safeParse(publicId.trim().toLowerCase());
    const row = parsed.success
      ? this.store.reminders.byPublicId(actor.discordUserId, parsed.data)
      : undefined;
    if (!row) throw new DuckyError('not_found', 'No reminder with that id.');
    return row;
  }

  private freshPublicId(): string {
    for (let i = 0; i < 5; i += 1) {
      const candidate = newPublicReminderId();
      if (!this.store.reminders.publicIdExists(candidate)) return candidate;
    }
    throw new DuckyError('invalid_input', 'Could not allocate a reminder id. Try again.');
  }
}
