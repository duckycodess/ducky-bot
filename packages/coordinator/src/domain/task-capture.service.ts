import { randomUUID } from 'node:crypto';
import {
  BULK_CAPTURE_MAX_INPUT, BULK_CAPTURE_MAX_ITEMS, BULK_PROBLEM_MESSAGE, formatDeadline,
  DuckyError, MAX_OPEN_TASKS_PER_OWNER, MAX_PENDING_TASK_PREVIEWS_PER_OWNER,
  MAX_SCHEDULED_REMINDERS_PER_OWNER, REMINDER_MAX_HORIZON_MS,
  TASK_PREVIEW_TTL_MS, TaskAddInputSchema,
  newPublicTaskId, parseBulkTaskList,
  type BulkParseResult, type BulkProblem,
} from '@ducky/contracts';
import {
  withTransaction,
  type Store, type TaskPreviewItem, type TaskPreviewRow, type TaskPreviewSource, type TaskRow,
} from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import { isoOf, type OwnerClock } from './owner-clock.js';
import { planTaskReminderFires, type TaskReminderLinker } from './task-reminders.js';

export interface TaskCaptureServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly clock: OwnerClock;
  readonly linker: TaskReminderLinker;
}

/** A preview the owner can act on, with everything the presenters need. */
export interface TaskCapturePreview {
  readonly previewId: string;
  readonly items: readonly TaskPreviewItem[];
  readonly source: TaskPreviewSource;
  readonly ignoredLeadingLines: number;
  readonly expiresAt: string;
}

/** What a paste produced: a preview, or the lines that need clarifying. */
export type TaskCaptureOutcome =
  | { readonly kind: 'preview'; readonly preview: TaskCapturePreview }
  | { readonly kind: 'empty' }
  | { readonly kind: 'needs_clarification'; readonly problems: readonly BulkProblem[] };

export interface TaskCaptureSaveResult {
  readonly tasks: readonly TaskRow[];
  /** True when this press saved nothing because an earlier one already had. */
  readonly replayed: boolean;
  readonly remindersScheduled: number;
}

/**
 * Pasting a list of deadlines, from a phone or from Discord.
 *
 * ONE service for both surfaces, deliberately. The phone page and the Discord
 * message are two ways of handing over the same text, and a second save path
 * would be a second set of bounds to get wrong -- so the HTTP adapter is a
 * transport in front of these methods and nothing more.
 *
 * The shape is the same one `/schedule` uses -- preview, then an explicit
 * keep -- with two differences the phone makes necessary:
 *
 * 1. **The preview is DURABLE.** A phone parses on one request and saves on
 *    the next, possibly minutes later and possibly after a restart. An
 *    in-memory draft would be gone, and "your preview expired" after every
 *    deploy is not a usable phone app.
 * 2. **Saving is IDEMPOTENT on the preview.** A flaky mobile connection
 *    retries; a thumb double-taps. The preview id is the idempotency key --
 *    it is unguessable, owner-scoped and single-use by construction -- so the
 *    second attempt reports the SAME tasks rather than creating a second set.
 *
 * And one rule that is neither: **a batch is all or nothing.** The caps and
 * every item are validated inside the transaction before the first insert, so
 * a save that fails leaves no task, no reminder and a preview the owner can
 * still act on. A half-saved list the owner believed was whole is the failure
 * mode this shape exists to prevent.
 */
export class TaskCaptureService {
  constructor(private readonly deps: TaskCaptureServiceDeps) {}

  get timeZone(): string {
    return this.deps.clock.timeZone;
  }

  /**
   * Reads a paste and stores what it read, without creating a single task.
   *
   * A list with ANY unreadable line produces no preview at all. The
   * alternative -- previewing the nine lines that parsed and quietly dropping
   * the tenth -- is how an owner ends up believing something is saved that
   * never was, and the whole point of a preview is that it tells the truth
   * about what Ducky understood.
   */
  preview(actor: ActorContext, text: string, source: TaskPreviewSource): TaskCaptureOutcome {
    this.deps.authz.requireOwner(actor);
    if (text.length > BULK_CAPTURE_MAX_INPUT) {
      throw new DuckyError(
        'invalid_input',
        `That is longer than ${BULK_CAPTURE_MAX_INPUT} characters. Send it in smaller lists.`,
      );
    }
    const nowMs = this.deps.clock.nowMs();
    const parsed = parseBulkTaskList(text, { nowMs, timeZone: this.deps.clock.timeZone });
    return this.previewFromParse(actor, parsed, source, nowMs);
  }

  /**
   * Re-parses a corrected list into the SAME preview.
   *
   * A correction goes through the identical parser rather than being written
   * into the draft, so an edit cannot introduce a deadline the parser would
   * never have produced -- the same discipline `/schedule` corrections follow.
   */
  correct(actor: ActorContext, previewId: string, text: string): TaskCaptureOutcome {
    this.deps.authz.requireOwner(actor);
    const existing = this.pending(actor, previewId);
    const nowMs = this.deps.clock.nowMs();
    const parsed = parseBulkTaskList(text, { nowMs, timeZone: this.deps.clock.timeZone });
    if (parsed.problems.length > 0) {
      return { kind: 'needs_clarification', problems: parsed.problems };
    }
    if (parsed.items.length === 0) return { kind: 'empty' };

    const items = parsed.items.map(toItem);
    const replaced = this.deps.store.taskPreviews.replaceItems(
      actor.discordUserId, existing.id, items, isoOf(nowMs),
    );
    if (!replaced) throw this.expired();
    return {
      kind: 'preview',
      preview: {
        previewId: existing.id,
        items,
        source: existing.source,
        ignoredLeadingLines: parsed.ignoredLeadingLines,
        expiresAt: existing.expiresAt,
      },
    };
  }

  /** What is still pending under this id, for a pre-filled edit. */
  pendingPreview(actor: ActorContext, previewId: string): TaskCapturePreview | undefined {
    this.deps.authz.requireOwner(actor);
    const row = this.deps.store.taskPreviews.get(actor.discordUserId, previewId);
    if (!row || row.status !== 'pending' || !row.items) return undefined;
    if (Date.parse(row.expiresAt) <= this.deps.clock.nowMs()) return undefined;
    return {
      previewId: row.id,
      items: row.items,
      source: row.source,
      ignoredLeadingLines: 0,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Keeps the previewed list: every task and every reminder, or nothing.
   *
   * A second press on a preview that is already saved REPLAYS it -- the same
   * tasks, reported the same way, with nothing written. That is what makes a
   * retry safe on a connection that drops after the write but before the
   * response, which is exactly the case a phone hits.
   */
  save(actor: ActorContext, previewId: string): TaskCaptureSaveResult {
    this.deps.authz.requireOwner(actor);
    const owner = actor.discordUserId;
    const row = this.deps.store.taskPreviews.get(owner, previewId);
    if (!row) throw this.expired();

    if (row.status === 'saved') {
      const tasks = (row.savedPublicIds ?? [])
        .map((id) => this.deps.store.tasks.byPublicId(owner, id))
        .filter((t): t is TaskRow => t !== undefined);
      return { tasks, replayed: true, remindersScheduled: 0 };
    }
    if (row.status === 'discarded') throw this.discarded();
    if (!row.items || row.items.length === 0) throw this.expired();
    if (Date.parse(row.expiresAt) <= this.deps.clock.nowMs()) throw this.expired();

    const items = row.items;
    const nowMs = this.deps.clock.nowMs();
    const nowIso = isoOf(nowMs);

    return withTransaction(this.deps.store.db, () => {
      // Both caps, counted before the first insert, so the refusal is a clean
      // one: nothing written, the preview still there to retry or edit.
      this.assertCapacity(owner, items, nowMs);

      const tasks = items.map((item) =>
        this.deps.store.tasks.insert({
          id: randomUUID(),
          publicId: this.freshPublicId(),
          discordUserId: owner,
          // Validated AGAIN here, through the same schema `/task add` uses, so
          // a stored preview cannot be the one path that writes a task nothing
          // else would accept.
          title: TaskAddInputSchema.parse({ title: item.title }).title,
          dueAt: item.dueAt,
          dueAllDay: item.dueAllDay,
          priority: item.priority,
          createdAt: nowIso,
        }),
      );

      let remindersScheduled = 0;
      for (const task of tasks) {
        remindersScheduled += this.deps.linker.syncForTask(owner, task).scheduled;
      }

      // Loses to a concurrent save rather than racing it: if another request
      // already settled this preview, nothing here is committed.
      const settled = this.deps.store.taskPreviews.markSaved(
        owner, row.id, tasks.map((t) => t.publicId), nowIso,
      );
      if (!settled) throw this.expired();

      return { tasks, replayed: false, remindersScheduled };
    });
  }

  /** Drops a preview. Nothing was ever saved, and now nothing is kept either. */
  discard(actor: ActorContext, previewId: string): boolean {
    this.deps.authz.requireOwner(actor);
    return this.deps.store.taskPreviews.markDiscarded(
      actor.discordUserId, previewId, this.deps.clock.nowIso(),
    );
  }

  // ------------------------------------------------------------- internals --

  private previewFromParse(
    actor: ActorContext,
    parsed: BulkParseResult,
    source: TaskPreviewSource,
    nowMs: number,
  ): TaskCaptureOutcome {
    if (parsed.problems.length > 0) {
      return { kind: 'needs_clarification', problems: parsed.problems };
    }
    if (parsed.items.length === 0) return { kind: 'empty' };

    const horizon = nowMs + REMINDER_MAX_HORIZON_MS;
    for (const item of parsed.items) {
      if (item.deadline && item.deadline.atMs > horizon) {
        throw new DuckyError('invalid_input', 'One of those deadlines is too far in the future.');
      }
    }

    const items = parsed.items.map(toItem);
    const row = withTransaction(this.deps.store.db, () => {
      this.evictOldestPending(actor.discordUserId, nowMs);
      return this.deps.store.taskPreviews.insert({
        id: randomUUID(),
        discordUserId: actor.discordUserId,
        source,
        items,
        createdAt: isoOf(nowMs),
        expiresAt: isoOf(nowMs + TASK_PREVIEW_TTL_MS),
      });
    });

    return {
      kind: 'preview',
      preview: {
        previewId: row.id,
        items,
        source,
        ignoredLeadingLines: parsed.ignoredLeadingLines,
        expiresAt: row.expiresAt,
      },
    };
  }

  /**
   * Keeps the number of pending previews bounded by dropping the OLDEST.
   *
   * Dropping the oldest rather than refusing the newest is the kinder failure:
   * the owner is looking at the paste they just made, and a draft from twenty
   * minutes ago that they never confirmed is the one they have forgotten.
   */
  private evictOldestPending(ownerId: string, nowMs: number): void {
    const nowIso = isoOf(nowMs);
    let pending = this.deps.store.taskPreviews.countPending(ownerId, nowIso);
    if (pending < MAX_PENDING_TASK_PREVIEWS_PER_OWNER) return;
    for (const old of this.deps.store.taskPreviews.oldestPending(ownerId, pending)) {
      if (pending < MAX_PENDING_TASK_PREVIEWS_PER_OWNER) break;
      this.deps.store.taskPreviews.delete(ownerId, old.id);
      pending -= 1;
    }
  }

  private assertCapacity(ownerId: string, items: readonly TaskPreviewItem[], nowMs: number): void {
    if (items.length > BULK_CAPTURE_MAX_ITEMS) {
      throw new DuckyError('invalid_input', `One paste may carry ${BULK_CAPTURE_MAX_ITEMS} items.`);
    }
    const open = this.deps.store.tasks.countOpen(ownerId);
    if (open + items.length > MAX_OPEN_TASKS_PER_OWNER) {
      throw new DuckyError(
        'invalid_input',
        `Saving those would pass the limit of ${MAX_OPEN_TASKS_PER_OWNER} open tasks. ` +
          'Nothing was saved. Close some first.',
      );
    }

    // The reminders the batch will ask for, counted the same way the linker
    // will schedule them -- offsets already in the past cost nothing, so a
    // list of deadlines that have passed is not refused for a budget it never
    // spends.
    const wanted = items.reduce(
      (n, item) =>
        n +
        planTaskReminderFires(
          { dueAt: item.dueAt, dueAllDay: item.dueAllDay },
          nowMs,
          this.deps.clock.timeZone,
        ).length,
      0,
    );
    const scheduled = this.deps.store.reminders.countScheduled(ownerId);
    if (scheduled + wanted > MAX_SCHEDULED_REMINDERS_PER_OWNER) {
      throw new DuckyError(
        'invalid_input',
        `Saving those would pass the limit of ${MAX_SCHEDULED_REMINDERS_PER_OWNER} scheduled ` +
          'reminders. Nothing was saved. Cancel some first.',
      );
    }
  }

  private pending(actor: ActorContext, previewId: string): TaskPreviewRow {
    const row = this.deps.store.taskPreviews.get(actor.discordUserId, previewId);
    if (!row || row.status !== 'pending') throw this.expired();
    if (Date.parse(row.expiresAt) <= this.deps.clock.nowMs()) throw this.expired();
    return row;
  }

  private freshPublicId(): string {
    for (let i = 0; i < 5; i += 1) {
      const candidate = newPublicTaskId();
      if (!this.deps.store.tasks.publicIdExists(candidate)) return candidate;
    }
    throw new DuckyError('invalid_input', 'Could not allocate a task id. Try again.');
  }

  private expired(): DuckyError {
    return new DuckyError(
      'extraction_expired',
      'That list is no longer waiting to be saved. Send it again.',
    );
  }

  private discarded(): DuckyError {
    return new DuckyError('extraction_expired', 'That list was discarded. Nothing was saved.');
  }
}

const toItem = (draft: {
  title: string;
  deadline?: { atMs: number; allDay: boolean };
}): TaskPreviewItem => ({
  title: draft.title,
  dueAt: draft.deadline ? isoOf(draft.deadline.atMs) : null,
  dueAllDay: draft.deadline?.allDay ?? false,
  priority: 'normal',
});

/**
 * The preview as text the owner can edit, in the form the parser reads back.
 *
 * It lives HERE, beside the parser's caller, rather than with the presenters,
 * because its one hard requirement is a PARSING one: what this emits must
 * parse to exactly the items it was given. Both Edit paths -- the Discord
 * modal and the phone textarea -- pre-fill from this, so a correction is a
 * re-parse of a familiar shape rather than a free-form edit that could
 * introduce a deadline the parser would never have produced.
 */
export const editableListText = (
  items: readonly TaskPreviewItem[],
  timeZone: string,
  nowMs: number,
): string =>
  items
    .map(
      (item, i) =>
        `${i + 1}. ${item.title}` +
        (item.dueAt
          ? ` (${formatDeadline(item.dueAt, { timeZone, allDay: item.dueAllDay, nowMs })})`
          : ''),
    )
    .join('\n');

/** The clarification a refused paste answers with. Lists lines, never guesses. */
export function clarificationMessage(problems: readonly BulkProblem[]): string {
  const lines = problems
    .slice(0, 5)
    .map((p) => `Line ${p.lineNo} ${BULK_PROBLEM_MESSAGE[p.kind]}`);
  const more = problems.length > lines.length ? `\n…and ${problems.length - lines.length} more.` : '';
  return (
    'Nothing was saved. I will not guess at these:\n' +
    lines.map((l) => `• ${l}`).join('\n') +
    more +
    '\nFix them and send the list again.'
  );
}
