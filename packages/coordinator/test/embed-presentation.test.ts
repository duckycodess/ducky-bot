import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DUCKY_COLORS, EMBED_DESC_MAX, isValidEmbedColor } from '@ducky/contracts';
import { sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { toDiscordPayload } from '../src/discord/payload.js';
import { conversationReply } from '../src/discord/assistant-presenters.js';

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
