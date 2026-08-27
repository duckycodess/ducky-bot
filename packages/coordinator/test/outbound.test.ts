import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOM_ID_MAX, DISCORD_CONTENT_MAX, EMBED_FIELD_VALUE_MAX } from '@ducky/contracts';
import { sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { DiscordJsTransport } from '../src/discord/discordjs.transport.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import type { DiscordSink } from '../src/discord/transport.js';
import type { OutboundMessage } from '../src/discord/message.js';

const SECRETS = [
  'ghp_abcdefghijklmnopqrstuvwxyz012345',
  'sk-ant-api03-abcdefghijklmnopqrstuvwx',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  '/home/tj/projects/secret',
];

const poisoned = (): OutboundMessage => ({
  content: SECRETS.join(' '),
  embeds: [
    {
      title: SECRETS[0],
      description: SECRETS.join('\n'),
      fields: [{ name: SECRETS[1]!, value: 'x'.repeat(4000) }],
      footer: SECRETS[3],
    },
  ],
  rows: [{ buttons: [{ customId: 'v1:c1:approve:abc:sig', label: SECRETS[0]! }] }],
});

const flatten = (m: OutboundMessage): string => JSON.stringify(m);

describe('outbound sanitization', () => {
  it('scrubs every secret-shaped value in every part of the payload', () => {
    const out = flatten(sanitizeOutbound(poisoned()));
    for (const s of SECRETS) expect(out, s).not.toContain(s);
    expect(out).toContain('[REDACTED:github-token]');
  });

  it('enforces Discord limits with a visible truncation marker', () => {
    const out = sanitizeOutbound({
      content: 'y'.repeat(5000),
      embeds: [{ fields: [{ name: 'n', value: 'z'.repeat(5000) }] }],
    });
    expect(out.content!.length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
    expect(out.content).toContain('…[truncated]');
    expect(out.embeds![0]!.fields![0]!.value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_MAX);
  });

  it('drops a component id that exceeds the Discord limit', () => {
    const out = sanitizeOutbound({
      rows: [{ buttons: [{ customId: 'x'.repeat(CUSTOM_ID_MAX + 1), label: 'go' }] }],
    });
    expect(out.rows![0]!.buttons).toHaveLength(0);
  });

  it('is idempotent', () => {
    const once = sanitizeOutbound(poisoned());
    expect(sanitizeOutbound(once)).toEqual(once);
  });
});

describe('no transport can bypass the choke point', () => {
  it('the real transport never hands raw values to its client', async () => {
    const seen: OutboundMessage[] = [];
    const sink: DiscordSink = {
      deliver: async (_t, m) => {
        seen.push(m);
      },
    };
    const transport = new DiscordJsTransport('token-not-used', () => sink, sink);

    await transport.send({ userId: '1' }, poisoned());
    await transport.start(async () => poisoned());

    expect(seen).toHaveLength(1);
    for (const message of seen) {
      const flat = flatten(message);
      for (const s of SECRETS) expect(flat, s).not.toContain(s);
    }
  });

  it('the mock transport sanitizes identically', async () => {
    const transport = new MockDiscordTransport();
    await transport.start(async () => poisoned());
    await transport.send({ userId: '1' }, poisoned());
    const replied = await transport.dispatch({ kind: 'message', userId: '1', text: 'x', threadKey: 't' });

    for (const message of [...transport.sent.map((s) => s.message), replied!]) {
      const flat = flatten(message);
      for (const s of SECRETS) expect(flat, s).not.toContain(s);
    }
  });

  it('imports discord.js from exactly one module', () => {
    const packagesDir = path.resolve(import.meta.dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && readFileSync(full, 'utf8').includes("'discord.js'")) {
          offenders.push(path.relative(packagesDir, full));
        }
      }
    };
    walk(packagesDir);
    expect(offenders).toEqual(['coordinator/src/discord/discordjs.transport.ts']);
  });
});

describe('executor package has no inbound surface', () => {
  it('declares no server dependency and creates no listener', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', 'executor');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const forbidden of ['fastify', 'express', 'koa', 'hono', 'ws']) {
      expect(deps, forbidden).not.toContain(forbidden);
    }

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          if (/createServer\s*\(|\.listen\s*\(/.test(src)) offenders.push(full);
        }
      }
    };
    walk(path.join(root, 'src'));
    expect(offenders).toEqual([]);
  });
});
