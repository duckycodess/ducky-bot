import {
  BRIEFING_PROVENANCE, BRIEFING_TITLE, REMINDER_STATE_LABEL, TASK_STATE_LABEL,
  discordTimestamp, discordWhen, formatZoned, parseStoredWallClock,
  type ReminderState, type TaskPriority,
} from '@ducky/contracts';
import type {
  PendingReminderOccurrenceRow, ReminderRow, ScheduleRow, TaskRow,
} from '@ducky/persistence';
import type { Briefing, BriefingSection } from '../domain/briefing.service.js';
import type { OutboundEmbed, OutboundEmbedField, OutboundMessage, OutboundRow } from './message.js';

/**
 * The daily assistant's owner-facing rendering.
 *
 * Two rules run through every function here:
 *
 * 1. **Every reply is ephemeral.** Tasks, reminders and briefings are personal
 *    data with no shared projection; the one message that is not ephemeral is
 *    the reminder DM, which is a DM.
 * 2. **Times are rendered as Discord timestamps** (`<t:…:f>` beside
 *    `<t:…:R>`), so each is shown in the reader's own zone and locale and a
 *    stored message stays correct as time passes. The hand-formatted zoned
 *    fallback is used only where a timestamp cannot be built.
 */

const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const PRIORITY_MARK = {
  high: '!!',
  normal: '·',
  low: '↓',
} as const satisfies Record<TaskPriority, string>;

/**
 * A task's due time, or nothing at all.
 *
 * An all-day task shows a DATE. The stored instant is that day's midnight, but
 * the owner never typed a time, so showing them "00:00" would be inventing
 * precision they did not give.
 */
export function taskDue(task: TaskRow, tz: string): string {
  if (!task.dueAt) return '';
  if (task.dueAllDay) {
    const day = discordTimestamp(task.dueAt, 'D');
    return day === '' ? formatZoned(task.dueAt, tz, false) : `${day} (${discordTimestamp(task.dueAt, 'R')})`;
  }
  return discordWhen(task.dueAt, tz);
}

const taskLine = (task: TaskRow, tz: string): string => {
  const due = taskDue(task, tz);
  return [
    `\`${task.publicId}\` ${PRIORITY_MARK[task.priority]} ${short(task.title, 120)}`,
    due === '' ? null : `-# due ${due}`,
  ]
    .filter(Boolean)
    .join('\n');
};

export function taskAdded(task: TaskRow, tz: string): OutboundMessage {
  const due = taskDue(task, tz);
  return {
    content:
      `Task \`${task.publicId}\` added (${task.priority} priority)` +
      (due === '' ? ', no due date.' : `, due ${due}.`),
    ephemeral: true,
  };
}

export function taskClosed(task: TaskRow): OutboundMessage {
  return {
    content: `Task \`${task.publicId}\` is now ${TASK_STATE_LABEL[task.status].toLowerCase()}.`,
    ephemeral: true,
  };
}

/**
 * The owner's task list.
 *
 * Controls are attached to the first few OPEN rows only: a Done button on a
 * cancelled task would be a control that cannot do anything, and Discord
 * allows five action rows at most in any case.
 */
export function tasksList(
  rows: readonly TaskRow[],
  tz: string,
  filterLabel: string,
  buttons: OutboundRow[],
): OutboundMessage {
  if (rows.length === 0) {
    return { content: `No ${filterLabel} tasks.`, ephemeral: true };
  }
  const embed: OutboundEmbed = {
    title: `Tasks — ${filterLabel} (${rows.length})`,
    fields: rows.slice(0, 20).map((t) => ({
      name: `${TASK_STATE_LABEL[t.status]} · ${t.publicId}`,
      value: taskLine(t, tz),
    })),
    footer: `Times shown in ${tz}.`,
  };
  return { embeds: [embed], rows: buttons, ephemeral: true };
}

// ------------------------------------------------------------- reminders --

/** "every 2 hours, 3 of 10" -- readable, and honest that it is bounded. */
export function recurrenceLabel(r: {
  recurrenceKind: ReminderRow['recurrenceKind'];
  intervalMinutes: number | null;
  maxOccurrences: number;
  firedCount?: number;
}): string {
  if (r.recurrenceKind === 'once') return 'once';
  const minutes = r.intervalMinutes ?? 0;
  const every =
    minutes % 1440 === 0
      ? `${minutes / 1440}d`
      : minutes % 60 === 0
        ? `${minutes / 60}h`
        : `${minutes}m`;
  const fired = r.firedCount ?? 0;
  return `every ${every}, ${fired} of ${r.maxOccurrences} sent`;
}

export function reminderAdded(row: ReminderRow, tz: string): OutboundMessage {
  return {
    content:
      `Reminder \`${row.publicId}\` set for ${discordWhen(row.firstFireAt, tz)} ` +
      `(${recurrenceLabel(row)}).`,
    ephemeral: true,
  };
}

export function reminderCancelled(row: ReminderRow): OutboundMessage {
  return { content: `Reminder \`${row.publicId}\` cancelled.`, ephemeral: true };
}

export function remindersList(
  rows: readonly ReminderRow[],
  tz: string,
  filterLabel: string,
  buttons: OutboundRow[],
): OutboundMessage {
  if (rows.length === 0) return { content: `No ${filterLabel} reminders.`, ephemeral: true };
  const embed: OutboundEmbed = {
    title: `Reminders — ${filterLabel} (${rows.length})`,
    fields: rows.slice(0, 20).map((r) => ({
      name: `${REMINDER_STATE_LABEL[r.status satisfies ReminderState]} · ${r.publicId}`,
      value: [
        short(r.text, 120),
        r.nextFireAt
          ? `-# next ${discordWhen(r.nextFireAt, tz)} · ${recurrenceLabel(r)}`
          : `-# ${recurrenceLabel(r)}`,
      ].join('\n'),
    })),
    footer: `Times shown in ${tz}.`,
  };
  return { embeds: [embed], rows: buttons, ephemeral: true };
}

/**
 * The proactive reminder DM.
 *
 * `ephemeral` is deliberately false: a DM has no interaction to be ephemeral
 * against. It carries no control, because a reminder has nothing to approve.
 *
 * When occurrences were collapsed after an outage the message SAYS SO, with
 * the count and the instant this one stands for. A late reminder that
 * pretended to be on time would be worse than one that is plainly late.
 */
export function reminderDm(row: PendingReminderOccurrenceRow, tz: string): OutboundMessage {
  const fields: OutboundEmbedField[] = [
    { name: 'Scheduled for', value: discordWhen(row.scheduledFor, tz) },
  ];
  if (row.recurrenceKind === 'interval') {
    fields.push({
      name: 'Repeat',
      value:
        `occurrence ${row.occurrenceNo} of ${row.maxOccurrences}` +
        (row.nextFireAt ? ` · next ${discordWhen(row.nextFireAt, tz)}` : ' · this was the last one'),
    });
  }
  if (row.missedCount > 0) {
    fields.push({
      name: 'Catch-up',
      value:
        `${row.missedCount} earlier occurrence${row.missedCount === 1 ? '' : 's'} ` +
        'came due while the assistant was not running. They are collapsed into this one message.',
    });
  }
  return {
    embeds: [{ title: 'Reminder', description: short(row.text, 1000), fields }],
    ephemeral: false,
  };
}

// -------------------------------------------------------------- briefing --

/**
 * A schedule entry's time.
 *
 * `schedules.starts_at` holds the wall-clock text the owner typed, with no
 * zone, so it is read as a wall clock in the configured zone. Anything that
 * does not parse is shown VERBATIM rather than guessed at -- the owner's own
 * words are better than a wrong instant.
 */
export function scheduleWhen(entry: ScheduleRow, tz: string): string {
  const parsed = parseStoredWallClock(entry.startsAt, tz);
  if (!parsed) return entry.startsAt;
  const iso = new Date(parsed.atMs).toISOString();
  return parsed.allDay
    ? `${discordTimestamp(iso, 'D')} (all day)`
    : discordWhen(iso, tz, 't');
}

const scheduleLine = (e: ScheduleRow, tz: string): string =>
  [scheduleWhen(e, tz), short(e.title, 100), e.location ? `@ ${short(e.location, 60)}` : null]
    .filter(Boolean)
    .join(' · ');

const bullets = (lines: readonly string[]): string =>
  lines.map((l) => `• ${l}`).join('\n');

/**
 * Renders a briefing.
 *
 * Every field comes from a counted, stored record. No sentence here is
 * generated, no section is padded when it is empty, and the footer says so on
 * every briefing so the owner never has to wonder which parts were invented.
 */
export function briefingMessage(b: Briefing): OutboundMessage {
  const tz = b.timeZone;
  const fields: OutboundEmbedField[] = [];

  /**
   * A capped section says so. Silently showing ten of fourteen meetings would
   * read as a complete answer and be a wrong one.
   */
  const add = <T>(
    name: string,
    section: BriefingSection<T>,
    line: (row: T) => string,
    extra?: string,
  ): void => {
    if (section.rows.length === 0) return;
    fields.push({
      name,
      value:
        bullets(section.rows.map(line)) +
        (extra ?? '') +
        (section.more ? `\n-# only the first ${section.rows.length} are shown` : ''),
    });
  };

  const taskText = (t: TaskRow): string => taskLine(t, tz).replace(/\n-# /, ' — ');
  const scheduleText = (e: ScheduleRow): string => scheduleLine(e, tz);
  const reminderText = (r: ReminderRow): string =>
    `${r.nextFireAt ? discordWhen(r.nextFireAt, tz, 't') : 'unscheduled'} · ${short(r.text, 90)}`;

  const overflowNote = (b: Briefing): string | undefined =>
    b.overdueTotal > b.tasksOverdue.rows.length
      ? `\n-# and ${b.overdueTotal - b.tasksOverdue.rows.length} more overdue`
      : undefined;

  if (b.kind === 'evening') {
    add('Completed today', b.tasksClosedToday, taskText);
    add('Still open, due today', b.tasksDueToday, taskText);
    add('Overdue', b.tasksOverdue, taskText, overflowNote(b));
    add('Tomorrow', b.scheduleTomorrow, scheduleText);
    add('Reminders tomorrow', b.remindersTomorrow, reminderText);
  } else {
    add('Today', b.scheduleToday, scheduleText);
    add('Due today', b.tasksDueToday, taskText);
    add('Overdue', b.tasksOverdue, taskText, overflowNote(b));
    add('Reminders still to come today', b.remindersToday, reminderText);
    if (b.kind === 'today') add('Completed today', b.tasksClosedToday, taskText);
  }

  if (fields.length === 0) {
    fields.push({
      name: 'Nothing scheduled',
      // Says what was actually looked at, so an empty briefing reads as a
      // real answer rather than as a failure.
      value:
        'No schedule entries, tasks or reminders for this part of the day. ' +
        `${b.openTaskCount} open task(s), ${b.scheduledReminderCount} scheduled reminder(s) in total.`,
    });
  } else {
    fields.push({
      name: 'Totals',
      value: `${b.openTaskCount} open task(s) · ${b.scheduledReminderCount} scheduled reminder(s)`,
    });
  }

  return {
    embeds: [
      {
        title: `${BRIEFING_TITLE[b.kind]} — ${b.dayKey}`,
        description: `Times shown in ${tz}.`,
        fields,
        footer: BRIEFING_PROVENANCE,
      },
    ],
    ephemeral: true,
  };
}
