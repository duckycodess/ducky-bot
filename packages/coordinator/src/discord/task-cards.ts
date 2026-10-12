import {
  DUCKY_COLORS, TASK_SNOOZE_MINUTES, formatDeadline,
} from '@ducky/contracts';
import type { TaskPreviewItem, TaskRow } from '@ducky/persistence';
import type { OutboundMessage, OutboundRow } from './message.js';

/**
 * The actionable cards: one task, one deadline, three real buttons.
 *
 * Four rules, each of them something the owner asked for explicitly and each
 * of them easy to undo by accident:
 *
 * 1. **No timezone label.** The owner lives in one zone and configured it
 *    once; printing "Asia/Manila" under every deadline tells them nothing they
 *    did not already know. This is the one place that departs from ADR 0014's
 *    default of Discord timestamps, which render in the READER's zone -- see
 *    docs/decisions/0026 for why a card is the exception.
 * 2. **No schedule line.** "Reminder: 1 hour before" was rejected: when Ducky
 *    will speak is Ducky's business, and a card that explains its own plumbing
 *    is a card the eye has to skip past.
 * 3. **Real buttons, never words that look like buttons.** "Reply DONE to
 *    close this" is a thing a person has to obey; a button is a thing they
 *    press. Every one is signed and bound to the owner.
 * 4. **No internal UUID.** The short public handle is what the owner can type
 *    back, and the outbound redactor rewrites a bare GUID anyway.
 */

const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export interface TaskCardControls {
  readonly done: string;
  readonly edit: string;
  readonly snooze: string;
}

/** `Due October 13, 11:59 PM`, or an honest blank. */
export function deadlineLine(
  task: Pick<TaskRow, 'dueAt' | 'dueAllDay'>,
  timeZone: string,
  nowMs: number,
): string {
  if (!task.dueAt) return 'No deadline';
  return `Due ${formatDeadline(task.dueAt, { timeZone, allDay: task.dueAllDay, nowMs })}`;
}

export const taskCardRow = (controls: TaskCardControls): OutboundRow => ({
  buttons: [
    { customId: controls.done, label: 'Done', style: 'success' },
    { customId: controls.edit, label: 'Edit', style: 'primary' },
    { customId: controls.snooze, label: `Snooze ${TASK_SNOOZE_MINUTES}m`, style: 'secondary' },
  ],
});

/**
 * One task, as a card.
 *
 * `mention` is supplied only for a channel delivery, where the owner is not
 * necessarily looking. It is the owner's own id from frozen configuration,
 * never a parsed one, and it is the ONLY thing outside the embed.
 */
export function taskCard(
  task: TaskRow,
  opts: {
    readonly timeZone: string;
    readonly nowMs: number;
    readonly controls?: TaskCardControls;
    readonly mention?: string;
    readonly heading?: string;
    readonly ephemeral?: boolean;
  },
): OutboundMessage {
  return {
    ...(opts.mention === undefined ? {} : { content: `<@${opts.mention}>` }),
    embeds: [
      {
        title: short(task.title, 200),
        description: [opts.heading, deadlineLine(task, opts.timeZone, opts.nowMs)]
          .filter(Boolean)
          .join('\n'),
        color: DUCKY_COLORS.brand,
        footer: task.publicId,
      },
    ],
    ...(opts.controls ? { rows: [taskCardRow(opts.controls)] } : {}),
    ephemeral: opts.ephemeral ?? false,
  };
}

export interface BulkPreviewControls {
  readonly save: string;
  readonly edit: string;
  readonly discard: string;
}

/**
 * What Ducky read, before anything is kept.
 *
 * Numbered the way the owner numbered it, so a wrong line is found by
 * counting rather than by re-reading, and plain about the fact that nothing
 * has been saved -- because a preview that looks like a receipt is how an
 * owner walks away believing a list is stored.
 */
export function bulkPreview(
  preview: {
    readonly items: readonly TaskPreviewItem[];
    readonly ignoredLeadingLines: number;
  },
  controls: BulkPreviewControls,
  timeZone: string,
  nowMs: number,
): OutboundMessage {
  const lines = preview.items.map(
    (item, i) =>
      `${i + 1}. ${short(item.title, 120)} — ${
        item.dueAt
          ? formatDeadline(item.dueAt, { timeZone, allDay: item.dueAllDay, nowMs })
          : 'no deadline'
      }`,
  );
  const notes: string[] = [];
  if (preview.ignoredLeadingLines > 0) {
    notes.push(
      `-# ${preview.ignoredLeadingLines} line(s) before the first item were not read as tasks.`,
    );
  }

  return {
    embeds: [
      {
        title: `Save ${preview.items.length} task${preview.items.length === 1 ? '' : 's'}?`,
        description: [...lines, ...notes].join('\n'),
        color: DUCKY_COLORS.attention,
        footer: 'Nothing is saved yet.',
      },
    ],
    rows: [
      {
        buttons: [
          { customId: controls.save, label: 'Save tasks', style: 'success' },
          { customId: controls.edit, label: 'Edit', style: 'primary' },
          { customId: controls.discard, label: 'Discard', style: 'secondary' },
        ],
      },
    ],
    ephemeral: false,
  };
}

/** The list as plain text, for the Edit modal to pre-fill. */
export const bulkPreviewText = (
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
