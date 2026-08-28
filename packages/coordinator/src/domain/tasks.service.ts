import { randomUUID } from 'node:crypto';
import {
  DuckyError, MAX_OPEN_TASKS_PER_OWNER, PublicTaskIdSchema, REMINDER_MAX_HORIZON_MS,
  TASK_LIST_PAGE_SIZE, TaskAddInputSchema, newPublicTaskId, parseWhen,
  type TaskListFilter, type TaskState,
} from '@ducky/contracts';
import type { Store, TaskRow } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import { isoOf, type OwnerClock } from './owner-clock.js';

export interface TasksServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly clock: OwnerClock;
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

  constructor(deps: TasksServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.clock = deps.clock;
  }

  get timeZone(): string {
    return this.clock.timeZone;
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
      if (when.atMs > nowMs + REMINDER_MAX_HORIZON_MS) {
        throw new DuckyError('invalid_input', 'That due date is too far in the future.');
      }
      dueAt = isoOf(when.atMs);
      dueAllDay = when.allDay;
    }

    return this.store.tasks.insert({
      id: randomUUID(),
      publicId: this.freshPublicId(),
      discordUserId: actor.discordUserId,
      title: input.title,
      dueAt,
      dueAllDay,
      priority: input.priority,
      createdAt: isoOf(nowMs),
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
        return this.store.tasks.overdue(owner, this.clock.nowIso(), limit);
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
    this.store.tasks.close(actor.discordUserId, row.id, status, this.clock.nowIso());
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
