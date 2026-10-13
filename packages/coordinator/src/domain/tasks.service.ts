import { randomUUID } from 'node:crypto';
import {
  DuckyError, MAX_OPEN_TASKS_PER_OWNER, PublicTaskIdSchema, REMINDER_MAX_HORIZON_MS,
  TASK_LIST_PAGE_SIZE, TaskAddInputSchema, newPublicTaskId, parseDeadlineInput, parseWhen,
  type BulkDeadline, type TaskListFilter, type TaskState,
} from '@ducky/contracts';
import { withTransaction, type ReminderRow, type Store, type TaskRow } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import { isoOf, type OwnerClock } from './owner-clock.js';
import type { TaskReminderLinker, TaskReminderSync } from './task-reminders.js';

export interface TasksServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly clock: OwnerClock;
  /**
   * The deadline-to-notification link.
   *
   * Required rather than optional: a task with a deadline and no reminders is
   * the bug this exists to fix, and an instance that quietly wired half of it
   * would look like the feature working.
   */
  readonly linker: TaskReminderLinker;
}

/**
 * Tasks: the owner's commitments.
 *
 * Owner-only in full. Every method calls `requireOwner` first, exactly like
 * captures, and every row lookup is scoped by owner id in SQL so another
 * account's task is *absent* rather than *forbidden* -- the same shape the
 * capture service uses, and one that leaks nothing about what exists.
 *
 * A task is deliberately not a capture with extra columns. A capture is an
 * unsorted thought; a task carries a due instant, a priority and a state that
 * can be completed. Promotion between them is a decision the owner makes, so
 * nothing here writes to `captures`.
 */
export class TasksService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly clock: OwnerClock;
  private readonly linker: TaskReminderLinker;

  constructor(deps: TasksServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.clock = deps.clock;
    this.linker = deps.linker;
  }

  get timeZone(): string {
    return this.clock.timeZone;
  }

  /** The assistant's single "now", for presenters that must render a deadline. */
  nowMs(): number {
    return this.clock.nowMs();
  }

  add(actor: ActorContext, raw: unknown): TaskRow {
    this.authz.requireOwner(actor);
    const input = TaskAddInputSchema.parse(raw);

    // Bounded per owner. A stuck client cannot grow the table without limit,
    // and the ceiling counts OPEN tasks only, so finished work never blocks
    // new work.
    if (this.store.tasks.countOpen(actor.discordUserId) >= MAX_OPEN_TASKS_PER_OWNER) {
      throw new DuckyError(
        'invalid_input',
        `You already have ${MAX_OPEN_TASKS_PER_OWNER} open tasks. Close some before adding more.`,
      );
    }

    const nowMs = this.clock.nowMs();
    let dueAt: string | null = null;
    let dueAllDay = false;
    if (input.due !== undefined) {
      // A due date in the past is ACCEPTED: "overdue" is a real state, and
      // refusing to record something already missed would just hide it.
      const when = parseWhen(input.due, { nowMs, timeZone: this.clock.timeZone });
      this.assertWithinHorizon(when.atMs, nowMs);
      dueAt = isoOf(when.atMs);
      dueAllDay = when.allDay;
    }

    // One transaction, because a task with a deadline owes notifications: a
    // crash between the insert and the reminders would leave a deadline
    // nothing will ever mention.
    return withTransaction(this.store.db, () => {
      const task = this.store.tasks.insert({
        id: randomUUID(),
        publicId: this.freshPublicId(),
        discordUserId: actor.discordUserId,
        title: input.title,
        dueAt,
        dueAllDay,
        priority: input.priority,
        createdAt: isoOf(nowMs),
      });
      this.linker.syncForTask(actor.discordUserId, task);
      return task;
    });
  }

  /**
   * Moves a task's deadline, and resynchronizes what will be said about it.
   *
   * The two happen together or not at all. `deadline` is already parsed by the
   * caller (the Edit control uses `parseDeadlineInput`, which accepts the same
   * forms a pasted line does and the word `none` to clear one), so this method
   * has one job and does not need a second grammar.
   */
  setDeadline(
    actor: ActorContext,
    publicId: string,
    deadline: BulkDeadline | undefined,
  ): { task: TaskRow; sync: TaskReminderSync } {
    this.authz.requireOwner(actor);
    const existing = this.owned(actor, publicId);
    if (existing.status !== 'open') {
      throw new DuckyError(
        'invalid_input',
        `Task \`${existing.publicId}\` is already ${existing.status}.`,
      );
    }
    const nowMs = this.clock.nowMs();
    if (deadline) this.assertWithinHorizon(deadline.atMs, nowMs);

    return withTransaction(this.store.db, () => {
      const moved = this.store.tasks.updateDue(
        actor.discordUserId,
        existing.id,
        deadline ? isoOf(deadline.atMs) : null,
        deadline?.allDay ?? false,
        isoOf(nowMs),
      );
      if (!moved) throw new DuckyError('not_found', 'No open task with that id.');
      const task = this.store.tasks.byId(actor.discordUserId, existing.id) ?? existing;
      return { task, sync: this.linker.syncForTask(actor.discordUserId, task) };
    });
  }

  /** The same parse the pasted list uses, so one grammar serves both. */
  parseDeadline(raw: string): BulkDeadline | undefined {
    return parseDeadlineInput(raw, {
      nowMs: this.clock.nowMs(),
      timeZone: this.clock.timeZone,
    });
  }

  /**
   * Postpones the notification without touching the deadline.
   *
   * Reported as what it is -- the task still says when it is actually due --
   * because a Snooze that quietly moved a real deadline would be the most
   * damaging kind of convenience.
   */
  snooze(actor: ActorContext, publicId: string): { task: TaskRow; reminder: ReminderRow } {
    this.authz.requireOwner(actor);
    const task = this.owned(actor, publicId);
    if (task.status !== 'open') {
      throw new DuckyError('invalid_input', 'That task is already closed.');
    }
    return withTransaction(this.store.db, () => ({
      task,
      reminder: this.linker.snooze(actor.discordUserId, task),
    }));
  }

  private assertWithinHorizon(atMs: number, nowMs: number): void {
    if (atMs > nowMs + REMINDER_MAX_HORIZON_MS) {
      throw new DuckyError('invalid_input', 'That due date is too far in the future.');
    }
  }

  /**
   * Turns one owner-owned open capture into a task and marks that capture done
   * in the same transaction. A capture longer than the task title limit is
   * refused rather than silently truncated; the owner can edit the capture
   * first.
   */
  promoteCapture(actor: ActorContext, captureId: string): TaskRow {
    this.authz.requireOwner(actor);
    const capture = this.store.captures.get(captureId);
    if (!capture || capture.discordUserId !== actor.discordUserId) {
      throw new DuckyError('not_found', 'That capture no longer exists.');
    }
    if (capture.status !== 'open') {
      throw new DuckyError('invalid_input', 'Only an open capture can become a task.');
    }
    if (this.store.tasks.countOpen(actor.discordUserId) >= MAX_OPEN_TASKS_PER_OWNER) {
      throw new DuckyError(
        'invalid_input',
        `You already have ${MAX_OPEN_TASKS_PER_OWNER} open tasks. Close some before promoting a capture.`,
      );
    }
    const input = TaskAddInputSchema.parse({ title: capture.content });
    const nowMs = this.clock.nowMs();
    return withTransaction(this.store.db, () => {
      const task = this.store.tasks.insert({
        id: randomUUID(),
        publicId: this.freshPublicId(),
        discordUserId: actor.discordUserId,
        title: input.title,
        dueAt: null,
        dueAllDay: false,
        priority: 'normal',
        createdAt: isoOf(nowMs),
      });
      this.store.captures.setStatus(capture.id, 'done');
      // A promoted capture has no deadline, so this schedules nothing today --
      // it is called anyway so there is ONE path that decides what a task
      // owes, rather than two that can drift.
      this.linker.syncForTask(actor.discordUserId, task);
      return task;
    });
  }

  list(actor: ActorContext, filter: TaskListFilter = 'open', limit = TASK_LIST_PAGE_SIZE): TaskRow[] {
    this.authz.requireOwner(actor);
    const owner = actor.discordUserId;
    switch (filter) {
      case 'today': {
        const day = this.clock.dayRange(0);
        return this.store.tasks.dueBetween(owner, isoOf(day.startMs), isoOf(day.endMs), limit);
      }
      case 'overdue':
        // Two different meanings of late, decided in one place: see
        // `TasksRepo.overdue`. A date-only task is late once its DAY has
        // ended, not from midnight that morning.
        return this.store.tasks.overdue(
          owner, this.clock.nowIso(), isoOf(this.clock.dayRange(0).startMs), limit,
        );
      case 'all':
        return this.store.tasks.listForOwner(owner, 'all', limit);
      default:
        return this.store.tasks.listForOwner(owner, filter satisfies TaskState, limit);
    }
  }

  get(actor: ActorContext, publicId: string): TaskRow {
    this.authz.requireOwner(actor);
    return this.owned(actor, publicId);
  }

  complete(actor: ActorContext, publicId: string): TaskRow {
    return this.close(actor, publicId, 'done');
  }

  cancel(actor: ActorContext, publicId: string): TaskRow {
    return this.close(actor, publicId, 'cancelled');
  }

  /**
   * The version a card's controls are signed against.
   *
   * `updated_at` moves whenever the task does, so a control minted for a card
   * showing one deadline stops verifying once that deadline has changed and
   * the owner is sent a refreshed card instead of acting on a stale one.
   * Returns undefined for anything that is not the owner's own open or closed
   * task -- an unknown id and somebody else's answer identically.
   */
  versionOf(actor: ActorContext, publicId: string): string | undefined {
    if (!this.authz.isOwner(actor)) return undefined;
    const parsed = PublicTaskIdSchema.safeParse(publicId.trim().toLowerCase());
    if (!parsed.success) return undefined;
    return this.store.tasks.byPublicId(actor.discordUserId, parsed.data)?.updatedAt;
  }

  countOpen(actor: ActorContext): number {
    this.authz.requireOwner(actor);
    return this.store.tasks.countOpen(actor.discordUserId);
  }

  /**
   * Closing is idempotent from the owner's point of view but honest about it:
   * a task already in the requested state is returned unchanged rather than
   * re-stamped, and a task closed the OTHER way is refused, because silently
   * flipping "cancelled" to "done" would rewrite a decision.
   */
  private close(actor: ActorContext, publicId: string, status: 'done' | 'cancelled'): TaskRow {
    this.authz.requireOwner(actor);
    const row = this.owned(actor, publicId);
    if (row.status === status) return row;
    if (row.status !== 'open') {
      throw new DuckyError(
        'invalid_input',
        `Task \`${row.publicId}\` is already ${row.status}.`,
      );
    }
    // Closing a task stops what it was going to say. A task marked done that
    // went on reminding the owner an hour later would be the clearest possible
    // sign that the two halves were not really linked.
    withTransaction(this.store.db, () => {
      this.store.tasks.close(actor.discordUserId, row.id, status, this.clock.nowIso());
      this.linker.cancelForTask(actor.discordUserId, row.id);
    });
    return this.store.tasks.byPublicId(actor.discordUserId, publicId) ?? row;
  }

  private owned(actor: ActorContext, publicId: string): TaskRow {
    const parsed = PublicTaskIdSchema.safeParse(publicId.trim().toLowerCase());
    // A malformed id and an unknown one answer identically: nothing about what
    // exists is inferable from the difference.
    const row = parsed.success
      ? this.store.tasks.byPublicId(actor.discordUserId, parsed.data)
      : undefined;
    if (!row) throw new DuckyError('not_found', 'No task with that id.');
    return row;
  }

  /** Bounded retry; a five-character handle collides rarely but not never. */
  private freshPublicId(): string {
    for (let i = 0; i < 5; i += 1) {
      const candidate = newPublicTaskId();
      if (!this.store.tasks.publicIdExists(candidate)) return candidate;
    }
    throw new DuckyError('invalid_input', 'Could not allocate a task id. Try again.');
  }
}
