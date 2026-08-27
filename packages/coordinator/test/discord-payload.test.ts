import { describe, expect, it } from 'vitest';
import { EPHEMERAL_FLAG, toDiscordPayload, toModalPayload } from '../src/discord/payload.js';
import { sanitizeOutbound, isSafeCustomId } from '../src/discord/sanitize-outbound.js';
import { ComponentSigner } from '../src/security/component-signing.js';
import { secret } from './helpers.js';

const signer = new ComponentSigner(secret());
const id = (kind: string) =>
  signer.sign({ kind, entityId: 'abc-123', actorUserId: '100000000000000001' });

describe('Discord payload conversion', () => {
  it('preserves embeds, fields and footers rather than flattening them', () => {
    const payload = toDiscordPayload({
      content: 'hello',
      embeds: [
        {
          title: 'Job jabcde',
          description: 'running',
          fields: [{ name: 'Repository', value: 'demo', inline: true }],
          footer: 'read-only',
        },
      ],
    });
    expect(payload.content).toBe('hello');
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds![0]).toMatchObject({
      title: 'Job jabcde',
      description: 'running',
      fields: [{ name: 'Repository', value: 'demo', inline: true }],
      footer: { text: 'read-only' },
    });
  });

  it('emits real action rows with button styles, not text', () => {
    const payload = toDiscordPayload({
      rows: [
        {
          buttons: [
            { customId: id('approve'), label: 'approve', style: 'success' },
            { customId: id('reject'), label: 'reject', style: 'danger' },
          ],
        },
      ],
    });
    expect(payload.components).toHaveLength(1);
    expect(payload.components![0]!.type).toBe(1);
    expect(payload.components![0]!.components).toHaveLength(2);
    expect(payload.components![0]!.components[0]).toMatchObject({
      type: 2,
      label: 'approve',
      style: 3,
    });
    expect(payload.components![0]!.components[1]!.style).toBe(4);
  });

  it('drops a row that sanitization emptied, since Discord rejects it', () => {
    const safe = sanitizeOutbound({
      rows: [{ buttons: [{ customId: 'not a signed id', label: 'go' }] }],
    });
    expect(toDiscordPayload(safe).components).toBeUndefined();
  });

  it('defaults to ephemeral so private data is not left in a channel', () => {
    expect(toDiscordPayload({ content: 'x' }).flags).toBe(EPHEMERAL_FLAG);
    expect(toDiscordPayload({ content: 'x', ephemeral: false }).flags).toBeUndefined();
  });

  it('builds a modal carrying the current value for correction', () => {
    const modal = toModalPayload(id('sched_edit'), 'Correct the schedule', [
      { customId: 'entries', label: 'One per line', value: '2026-09-01 | Standup', paragraph: true },
    ]);
    expect(modal.title).toBe('Correct the schedule');
    expect(modal.components[0]!.components[0]).toMatchObject({
      type: 4,
      custom_id: 'entries',
      style: 2,
      value: '2026-09-01 | Standup',
    });
  });
});

describe('custom id safety', () => {
  it('accepts the ids this codebase signs', () => {
    for (const kind of ['approve', 'inbox_done', 'sched_edit', 'job_answer']) {
      expect(isSafeCustomId(id(kind)), kind).toBe(true);
    }
  });

  it('rejects anything that could smuggle text past the redactor', () => {
    for (const bad of [
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'v1:c1:approve:abc:short',
      'v1:c1:approve with space:abc:aaaaaaaaaaaaaaaaaaaaaa',
      'v1:c1:approve:abc:aaaaaaaaaaaaaaaaaaaaaa:extra',
      `v1:c1:approve:${'x'.repeat(200)}:aaaaaaaaaaaaaaaaaaaaaa`,
      'not-an-id',
      '',
    ]) {
      expect(isSafeCustomId(bad), bad).toBe(false);
    }
  });

  it('drops an unsafe id at the sanitization boundary', () => {
    const out = sanitizeOutbound({
      rows: [
        {
          buttons: [
            { customId: id('approve'), label: 'ok' },
            { customId: 'ghp_abcdefghijklmnopqrstuvwxyz012345', label: 'sneaky' },
          ],
        },
      ],
    });
    expect(out.rows![0]!.buttons).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('ghp_');
  });
});
