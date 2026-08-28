import { z } from 'zod';
import { cleanUntrusted } from './discord.js';
import {
  REMINDER_MAX_OCCURRENCES, REMINDER_MIN_OCCURRENCES, REMINDER_TEXT_MAX, REMINDER_TEXT_MIN,
  TASK_TITLE_MAX, TASK_TITLE_MIN, WHEN_INPUT_MAX,
} from './limits.js';
import { PUBLIC_REMINDER_ID_RE, PUBLIC_TASK_ID_RE } from './ids.js';

/**
 * The daily assistant's vocabulary.
 *
 * Everything here is OWNER-ONLY personal data. There is deliberately no
 * projection type beside these, the way `SharedJobProjection` sits beside
 * `JobRow`: a task, a reminder and a briefing have no safe shared shape, so
 * none exists to be reached for by mistake. Nothing in this file is reachable
 * from `SHARED_READABLE_ROUTES`.
 */

// ------------------------------------------------------------------ tasks --

/**
 * A task is a COMMITMENT, and is deliberately a different record from a
 * capture. A capture is an unsorted thought with no time and no priority; a
 * task has a state that can be completed. Keeping them separate is what makes
 * the inbox meaningful -- promoting one to the other is a decision, not a
 * rename.
 */
export const TASK_STATES = ['open', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATE_LABEL = {
  open: 'Open',
  done: 'Done',
  cancelled: 'Cancelled',
} as const satisfies Record<TaskState, string>;

const cleanText = (min: number, max: number) =>
  z.string().transform(cleanUntrusted).pipe(z.string().min(min).max(max));

const whenText = z.string().transform(cleanUntrusted).pipe(z.string().min(1).max(WHEN_INPUT_MAX));

export const PublicTaskIdSchema = z.string().regex(PUBLIC_TASK_ID_RE, 'not a task id');
export const PublicReminderIdSchema = z
  .string()
  .regex(PUBLIC_REMINDER_ID_RE, 'not a reminder id');

/**
 * `due` stays a raw string here on purpose: turning it into an instant needs
 * the owner's timezone and the current time, which are runtime configuration,
 * not contract. The service resolves it through `parseWhen`.
 */
export const TaskAddInputSchema = z.strictObject({
  title: cleanText(TASK_TITLE_MIN, TASK_TITLE_MAX),
  due: whenText.optional(),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
});
export type TaskAddInput = z.infer<typeof TaskAddInputSchema>;

export const TASK_LIST_FILTERS = ['open', 'done', 'cancelled', 'today', 'overdue', 'all'] as const;
export type TaskListFilter = (typeof TASK_LIST_FILTERS)[number];

export const isTaskListFilter = (v: unknown): v is TaskListFilter =>
  typeof v === 'string' && (TASK_LIST_FILTERS as readonly string[]).includes(v);

// -------------------------------------------------------------- reminders --

export const REMINDER_STATES = ['scheduled', 'completed', 'cancelled'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

/**
 * `once` fires exactly one occurrence. `interval` fires a FIXED number of
 * occurrences a FIXED number of minutes apart.
 *
 * There is no third kind, and in particular no cron expression: a bounded
 * interval is the whole grammar. See ADR 0013 for why.
 */
export const RECURRENCE_KINDS = ['once', 'interval'] as const;
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

export const REMINDER_STATE_LABEL = {
  scheduled: 'Scheduled',
  completed: 'Finished',
  cancelled: 'Cancelled',
} as const satisfies Record<ReminderState, string>;

export const ReminderAddInputSchema = z
  .strictObject({
    text: cleanText(REMINDER_TEXT_MIN, REMINDER_TEXT_MAX),
    at: whenText,
    /** A fixed interval such as `30m`, `2h`, `1d`. Absent means a one-shot. */
    every: whenText.optional(),
    /** How many times in total, including the first. Only valid with `every`. */
    count: z.coerce
      .number()
      .int()
      .min(REMINDER_MIN_OCCURRENCES)
      .max(REMINDER_MAX_OCCURRENCES)
      .optional(),
  })
  .superRefine((value, ctx) => {
    // A count without an interval would silently become a one-shot, which is
    // not what was asked for. Refuse rather than reinterpret.
    if (value.count !== undefined && value.every === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['count'],
        message: 'count only applies to a repeating reminder; give every: as well.',
      });
    }
  });
export type ReminderAddInput = z.infer<typeof ReminderAddInputSchema>;

export const REMINDER_LIST_FILTERS = ['scheduled', 'all'] as const;
export type ReminderListFilter = (typeof REMINDER_LIST_FILTERS)[number];

// --------------------------------------------------------------- briefing --

/**
 * Which slice of the day a briefing covers.
 *
 * `morning` looks forward at today, `evening` closes today and looks at
 * tomorrow, `today` is the full picture. All three are assembled from stored
 * records ONLY -- see `BRIEFING_PROVENANCE`.
 */
export const BRIEFING_KINDS = ['morning', 'evening', 'today'] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];

export const isBriefingKind = (v: unknown): v is BriefingKind =>
  typeof v === 'string' && (BRIEFING_KINDS as readonly string[]).includes(v);

export const BRIEFING_TITLE = {
  morning: 'Morning briefing',
  evening: 'Evening briefing',
  today: 'Today',
} as const satisfies Record<BriefingKind, string>;

/**
 * Printed on every briefing.
 *
 * A briefing that hallucinates a deadline is worse than no briefing, so the
 * assembly is entirely deterministic: it reads tasks, reminders and schedule
 * rows and counts them. No provider is consulted, so there is no path by which
 * a generated sentence could become a fact the owner then acts on.
 */
export const BRIEFING_PROVENANCE =
  'Assembled from your stored tasks, reminders and schedule. Nothing here is generated.';
