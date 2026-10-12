import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DUCKY_COLORS, EMBED_DESC_MAX, isValidEmbedColor } from '@ducky/contracts';
import { sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { toDiscordPayload } from '../src/discord/payload.js';
import { conversationReply } from '../src/discord/assistant-presenters.js';
import { bulkPreview, deadlineLine, taskCard } from '../src/discord/task-cards.js';

describe('embed colour', () => {
  it('accepts only a plain 24-bit integer', () => {
    expect(isValidEmbedColor(DUCKY_COLORS.brand)).toBe(true);
    expect(isValidEmbedColor(0)).toBe(true);
    expect(isValidEmbedColor(0xffffff)).toBe(true);
    for (const bad of [-1, 0x1000000, 1.5, NaN, Infinity, '0xffffff', null, undefined]) {
      expect(isValidEmbedColor(bad), String(bad)).toBe(false);
    }
  });

  it('is DROPPED rather than clamped when invalid', () => {
    /**
     * Clamping turns a nonsense value into a plausible one, which is how a bug
     * becomes invisible. A colour is decoration; losing it costs nothing.
     */
    const out = sanitizeOutbound({
      embeds: [{ title: 'x', color: 999_999_999 }],
    });
    expect(out.embeds?.[0]).not.toHaveProperty('color');
  });

  it('survives sanitisation and reaches the Discord payload', () => {
    const out = sanitizeOutbound({ embeds: [{ title: 'x', color: DUCKY_COLORS.neutral }] });
    expect(toDiscordPayload(out).embeds?.[0]?.color).toBe(DUCKY_COLORS.neutral);
  });

  it('does not spend the character budget', () => {
    // Discord does not count a colour toward the 6000-character embed total,
    // and neither should the sanitizer: a coloured embed must not truncate
    // earlier than an uncoloured one.
    const long = 'a'.repeat(500);
    const withColor = sanitizeOutbound({ embeds: [{ description: long, color: 1 }] });
    const without = sanitizeOutbound({ embeds: [{ description: long }] });
    expect(withColor.embeds?.[0]?.description?.length)
      .toBe(without.embeds?.[0]?.description?.length);
  });
});

describe('a conversational reply', () => {
  it('puts the text in the embed and NOT also in content', () => {
    // Duplicating would double every message and push a long reply past
    // Discord's limits for no benefit.
    const reply = conversationReply('the answer', false);
    expect(reply.content).toBeUndefined();
    expect(reply.embeds?.[0]?.description).toBe('the answer');
  });

  it('uses the brand colour, chosen by the presenter', () => {
    expect(conversationReply('x', false).embeds?.[0]?.color).toBe(DUCKY_COLORS.brand);
  });

  it('marks a stand-in reply differently, because provenance is the point there', () => {
    const mock = conversationReply('[mock] x', true);
    expect(mock.embeds?.[0]?.color).toBe(DUCKY_COLORS.neutral);
    expect(mock.embeds?.[0]?.footer).toMatch(/stand-in/i);
    // A real reply carries no footer: a line under every answer is noise.
    expect(conversationReply('x', false).embeds?.[0]?.footer).toBeUndefined();
  });

  it('carries no emoji in its own chrome', () => {
    const reply = conversationReply('x', false);
    const chrome = `${reply.embeds?.[0]?.title ?? ''}${reply.embeds?.[0]?.footer ?? ''}`;
    expect(chrome).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('is truncated with a visible marker rather than rejected by Discord', () => {
    const huge = 'x'.repeat(EMBED_DESC_MAX + 500);
    const out = sanitizeOutbound(conversationReply(huge, false));
    const description = out.embeds?.[0]?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(EMBED_DESC_MAX);
    expect(description.endsWith('x')).toBe(false);
  });

  it('still passes model text through the redactor', () => {
    // The embed is a rendering change. It must not become a way around the
    // single egress choke point.
    const out = sanitizeOutbound(conversationReply('token ghp_' + 'a'.repeat(36), false));
    expect(out.embeds?.[0]?.description).not.toMatch(/ghp_a{36}/);
  });
});

describe('typing indication', () => {
  it('is best-effort and never blocks or alters routing', () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'discord', 'discordjs.transport.ts'),
      'utf8',
    );
    expect(src).toMatch(/sendTyping/);
    // Fired and forgotten: not awaited before routing, and its failure is
    // swallowed. A courtesy that can break the answer is not one.
    expect(src).toMatch(/void \(async \(\) => \{/);
    expect(src).not.toMatch(/await .*sendTyping\(\);\s*\n\s*void this\.route/);
  });

  it('sends no content of its own', () => {
    // No fake progress text. The platform affordance carries nothing.
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'discord', 'discordjs.transport.ts'),
      'utf8',
    );
    const near = src.slice(src.indexOf('sendTyping') - 800, src.indexOf('sendTyping') + 200);
    expect(near).not.toMatch(/thinking|working on it|one moment/i);
  });
});

/**
 * The compact actionable card.
 *
 * Every assertion here is something the owner asked for explicitly after
 * reading a draft, and every one of them is easy to undo by accident later.
 */
describe('a task card', () => {
  const MANILA = 'Asia/Manila';
  const NOW = Date.parse('2026-10-13T02:00:00.000Z');
  const task = {
    id: '6f1a4e0c-0c2b-4a3a-9f1e-2b4d6c8e0a11',
    publicId: 'tabcde',
    discordUserId: '100000000000000001',
    title: 'ENG 30 Letters',
    dueAt: '2026-10-13T15:59:00.000Z',
    dueAllDay: false,
    priority: 'normal' as const,
    status: 'open' as const,
    createdAt: '2026-10-13T02:00:00.000Z',
    updatedAt: '2026-10-13T02:00:00.000Z',
    closedAt: null,
  };
  const controls = {
    done: 'v1:c1:task_done:tabcde:' + 'a'.repeat(22),
    edit: 'v1:c1:task_edit:tabcde:' + 'b'.repeat(22),
    snooze: 'v1:c1:task_snooze:tabcde:' + 'c'.repeat(22),
  };

  it('shows the title and the deadline, and nothing else', () => {
    const card = taskCard(task, { timeZone: MANILA, nowMs: NOW, controls });
    expect(card.embeds?.[0]?.title).toBe('ENG 30 Letters');
    expect(card.embeds?.[0]?.description).toBe('Due October 13, 11:59 PM');
  });

  it('carries no timezone label', () => {
    const flat = JSON.stringify(taskCard(task, { timeZone: MANILA, nowMs: NOW, controls }));
    expect(flat).not.toMatch(/manila|utc|gmt|\+08/i);
  });

  it('carries no reminder schedule line: when Ducky speaks is Ducky’s business', () => {
    const flat = JSON.stringify(taskCard(task, { timeZone: MANILA, nowMs: NOW, controls }));
    expect(flat).not.toMatch(/reminder:/i);
    expect(flat).not.toMatch(/1 hour before|24 hours before/i);
  });

  it('prints the short handle and never the internal UUID', () => {
    const flat = JSON.stringify(taskCard(task, { timeZone: MANILA, nowMs: NOW, controls }));
    expect(flat).toContain('tabcde');
    expect(flat).not.toContain(task.id);
  });

  it('uses real buttons rather than words that look like buttons', () => {
    const card = taskCard(task, { timeZone: MANILA, nowMs: NOW, controls });
    expect(card.rows?.[0]?.buttons.map((b) => b.label)).toEqual(['Done', 'Edit', 'Snooze 60m']);
    // Nothing in the text asks the owner to type anything back.
    expect(JSON.stringify(card.embeds)).not.toMatch(/reply (done|snooze)|type (done|snooze)/i);
  });

  it('survives the egress choke point with its controls intact', () => {
    const out = sanitizeOutbound(taskCard(task, { timeZone: MANILA, nowMs: NOW, controls }));
    expect(out.rows?.[0]?.buttons).toHaveLength(3);
    expect(toDiscordPayload(out).components?.[0]?.components).toHaveLength(3);
  });

  it('says plainly when there is no deadline, inventing none', () => {
    expect(deadlineLine({ dueAt: null, dueAllDay: false }, MANILA, NOW)).toBe('No deadline');
  });

  it('shows a date-only deadline as a date', () => {
    expect(deadlineLine({ dueAt: '2026-10-14T16:00:00.000Z', dueAllDay: true }, MANILA, NOW))
      .toBe('Due October 15');
  });
});

describe('a pasted-list preview', () => {
  it('says nothing is saved yet, and offers the three real controls', () => {
    const message = bulkPreview(
      {
        items: [
          { title: 'ENG 30 Letters', dueAt: '2026-10-13T15:59:00.000Z', dueAllDay: false, priority: 'normal' },
          { title: 'Speech 30 Letters', dueAt: '2026-10-14T16:00:00.000Z', dueAllDay: true, priority: 'normal' },
        ],
        ignoredLeadingLines: 0,
      },
      {
        save: 'v1:c1:bulk_save:abc:' + 'a'.repeat(22),
        edit: 'v1:c1:bulk_edit:abc:' + 'b'.repeat(22),
        discard: 'v1:c1:bulk_discard:abc:' + 'c'.repeat(22),
      },
      'Asia/Manila',
      Date.parse('2026-10-13T02:00:00.000Z'),
    );
    expect(message.embeds?.[0]?.footer).toBe('Nothing is saved yet.');
    // Numbered and bracketed the way the owner typed it, so checking the
    // preview against the paste is a comparison rather than a translation --
    // and with no separator dash, because this is a list and not a sentence.
    expect(message.embeds?.[0]?.description).toContain('1. ENG 30 Letters (October 13, 11:59 PM)');
    expect(message.embeds?.[0]?.description).toContain('2. Speech 30 Letters (October 15)');
    expect(message.embeds?.[0]?.description).not.toContain('—');
    expect(message.rows?.[0]?.buttons.map((b) => b.label)).toEqual([
      'Save tasks', 'Edit', 'Discard',
    ]);
  });
});
