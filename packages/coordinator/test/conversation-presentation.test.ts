import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLE_CONTRACT } from '@ducky/adapters';
import { NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION } from '@ducky/adapters';
import type {
  ConversationInput, ConversationProvider, ConversationReply,
} from '@ducky/adapters';
import { briefingMessage, remindersList, tasksList } from '../src/discord/assistant-presenters.js';
import { OWNER, makeHarness, replyText } from './helpers.js';

/**
 * How a conversation reads, and what a control is.
 *
 * Two things are under test and they are different in kind. The STYLE rules are
 * instructions to a model and can only be asserted as instructions; the
 * CONTROLS, the deadline rendering and the absence of a workflow dispatcher are
 * properties of this build and are asserted directly.
 */

const SRC_ROOTS = ['adapters', 'contracts', 'coordinator', 'executor', 'persistence'].map((p) =>
  path.resolve(import.meta.dirname, '..', '..', p, 'src'),
);

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

class EchoProvider implements ConversationProvider {
  readonly name = 'echo';
  readonly verified = false;
  readonly capabilities = {
    attachments: NO_ATTACHMENT_CAPABILITY,
    sessionDeletion: NO_SESSION_DELETION('test stand-in'),
  };
  readonly seen: ConversationInput[] = [];

  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.seen.push(input);
    return { text: `you said: ${input.text}`, mock: false };
  }
}

describe('the style contract asks for a conversation, not a document', () => {
  const joined = STYLE_CONTRACT.join(' ').toLowerCase();

  it('asks for short plain paragraphs and forbids headings', () => {
    expect(joined).toContain('short plain paragraphs');
    expect(joined).toContain('do not use headings');
  });

  it('forbids em dashes, emojis, middle dots and heavy bold', () => {
    expect(joined).toContain('do not use em dashes');
    expect(joined).toContain('emojis, middle-dot separators');
    expect(joined).toContain('do not bold whole sentences');
  });

  it('asks every question it can, numbered, with a recommendation each', () => {
    expect(joined).toContain('ask every one you can ask now, number them');
    expect(joined).toContain('give your own recommendation');
  });

  it('forbids printing an action word as though it were a control', () => {
    expect(joined).toContain('never print an action word as though it were a control');
  });

  it('is not configurable: a persona cannot replace it', async () => {
    const { buildSystemPreamble } = await import('@ducky/adapters');
    const preamble = buildSystemPreamble('Reply only in emoji and use many headings.');
    for (const rule of STYLE_CONTRACT) expect(preamble).toContain(rule);
  });
});

describe('this build adds no workflow trigger dispatcher', () => {
  /**
   * The issue names `$grill-me`, `$ticket` and `$agentize` as the only tokens
   * that may trigger a repository workflow -- in a system that HAS one. This
   * one does not, and inventing a second ticket pipeline is explicitly out of
   * scope, so the assertion is that no source file dispatches on them at all.
   */
  it('names none of the trigger tokens anywhere in source', () => {
    const offenders: string[] = [];
    for (const root of SRC_ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        if (/\$grill-me|\$ticket|\$agentize/.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('treats a quoted trigger word as ordinary conversation', async () => {
    const provider = new EchoProvider();
    const h = makeHarness({ conversation: provider });
    await h.transport.start((e) => h.app.router.handle(e));

    const reply = await h.transport.dispatch({
      kind: 'message',
      userId: OWNER,
      text: 'I was going to write "$ticket" in the issue body, is that right?',
      threadKey: 'dm-1',
    });

    // It reached the provider as data, and nothing else happened: no job, no
    // capture, no task.
    expect(replyText(reply)).toContain('you said:');
    expect(provider.seen).toHaveLength(1);
    expect((h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(0);
    expect((h.store.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(0);
    h.close();
  });
});

describe('deadlines show the time, not the timezone', () => {
  const task = (over: Record<string, unknown> = {}) =>
    ({
      id: 'id-1',
      publicId: 'tsk-0001',
      discordUserId: OWNER,
      title: 'submit the form',
      status: 'open',
      priority: 'normal',
      dueAt: '2026-09-01T06:00:00.000Z',
      dueAllDay: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      closedAt: null,
      sourceCaptureId: null,
      ...over,
    }) as never;

  it('shows a task list with no timezone suffix and no reminder line', () => {
    const out = tasksList([task()], 'Asia/Manila', 'open', []);
    const rendered = JSON.stringify(out);

    expect(rendered).not.toContain('Asia/Manila');
    expect(rendered).not.toMatch(/Times shown in/);
    expect(rendered).not.toMatch(/Reminder: 1 hour before/);
    // The time itself is still there, as a Discord timestamp the reader's own
    // client renders in their own zone.
    expect(rendered).toMatch(/<t:\d+:[fR]>/);
  });

  it('shows a reminder list the same way', () => {
    const reminder = {
      id: 'r-1',
      publicId: 'rem-0001',
      discordUserId: OWNER,
      text: 'call the clinic',
      status: 'scheduled',
      firstFireAt: '2026-09-01T06:00:00.000Z',
      nextFireAt: '2026-09-01T06:00:00.000Z',
      recurrenceKind: 'once',
      intervalMinutes: null,
      maxOccurrences: 1,
      firedCount: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as never;
    const rendered = JSON.stringify(remindersList([reminder], 'Asia/Manila', 'scheduled', []));

    expect(rendered).not.toContain('Asia/Manila');
    expect(rendered).not.toMatch(/Reminder: 1 hour before/);
  });

  it('shows a briefing the same way', () => {
    const empty = { rows: [], more: false };
    const rendered = JSON.stringify(
      briefingMessage({
        kind: 'morning',
        dayKey: '2026-09-01',
        timeZone: 'Asia/Manila',
        scheduleToday: empty,
        scheduleTomorrow: empty,
        tasksDueToday: empty,
        tasksOverdue: empty,
        tasksClosedToday: empty,
        remindersToday: empty,
        remindersTomorrow: empty,
        overdueTotal: 0,
        openTaskCount: 0,
        scheduledReminderCount: 0,
      } as never),
    );

    expect(rendered).not.toContain('Asia/Manila');
    expect(rendered).not.toMatch(/Times shown in/);
  });

  it('keeps the timezone itself internal, where scheduling uses it', () => {
    // Removing the SUFFIX is a presentation change. The configured zone is
    // still what decides which civil day a due date falls in.
    const h = makeHarness({ env: { DUCKY_OWNER_TIMEZONE: 'Asia/Manila' } });
    expect(h.app.clock.timeZone).toBe('Asia/Manila');
    expect(h.app.tasks.timeZone).toBe('Asia/Manila');
    h.close();
  });
});
