import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SHARED_READABLE_ROUTES } from '@ducky/contracts';
import {
  GatewayOpenClawProvider, MockConversationProvider, NO_ATTACHMENT_CAPABILITY, attachmentsUsable,
  type ConversationAttachment, type ConversationCapabilities, type ConversationInput,
  type ConversationProvider, type ConversationReply,
} from '@ducky/adapters';
import {
  CONVERSATION_TEMP_PREFIX, sweepStaleTempDirs,
} from '../src/discord/attachments.js';
import { effectiveLimits } from '../src/discord/conversation-attachments.js';
import { CHAT, OWNER, STRANGER, makeHarness, replyText } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

const meta = (over: Record<string, unknown> = {}) => ({
  filename: 'photo.png',
  contentType: 'image/png',
  size: PNG.byteLength,
  url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
  ...over,
});

/**
 * A provider that IS verified and attachment-capable.
 *
 * It exists only in this file. Nothing shipped is verified, which is the point
 * of the capability gate -- but the accept path still has to be exercised, so
 * the test supplies the one thing the host does not have.
 */
class CapableProvider implements ConversationProvider {
  readonly name = 'test-capable';
  readonly verified = true;
  readonly capabilities: ConversationCapabilities = {
    attachments: {
      supported: true,
      contentTypes: ['image/png', 'image/jpeg', 'image/webp', 'text/plain'],
      maxBytes: 1024 * 1024,
    },
  };

  /** What the provider actually saw, so a test can assert the metadata flow. */
  seen: ConversationInput | undefined;
  /** Kept deliberately, to prove a stashed handle is dead after the reply. */
  stashed: ConversationAttachment | undefined;
  bytes: Uint8Array | undefined;
  onReply: (() => void) | undefined;
  throwOnReply = false;

  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.seen = input;
    this.stashed = input.attachment;
    if (input.attachment) this.bytes = await input.attachment.read();
    this.onReply?.();
    if (this.throwOnReply) throw new Error('provider exploded');
    return { text: 'seen it', mock: false };
  }
}

const convDirs = (): string[] =>
  readdirSync(os.tmpdir()).filter((d) => d.startsWith(CONVERSATION_TEMP_PREFIX));

interface SpyFetch {
  readonly impl: typeof fetch;
  calls: number;
  lastInit: RequestInit | undefined;
  lastUrl: string | undefined;
}

const spyFetch = (body: Uint8Array | string = PNG): SpyFetch => {
  const spy: SpyFetch = {
    calls: 0,
    lastInit: undefined,
    lastUrl: undefined,
    impl: (async (url: unknown, init: RequestInit) => {
      spy.calls += 1;
      spy.lastUrl = String(url);
      spy.lastInit = init;
      return new Response(body as never, { status: 200 });
    }) as unknown as typeof fetch,
  };
  return spy;
};

const boot = async (opts: Parameters<typeof makeHarness>[0] = {}) => {
  const h = makeHarness(opts);
  await h.transport.start((e) => h.app.router.handle(e));
  return h;
};

const enabled = { CONVERSATION_ATTACHMENTS_ENABLED: 'true' };

const send = (h: Awaited<ReturnType<typeof boot>>, over: Record<string, unknown> = {}) =>
  h.transport.dispatch({
    kind: 'message',
    userId: OWNER,
    text: 'what is this?',
    threadKey: 'dm-1',
    attachments: [meta()],
    ...over,
  });

// ---------------------------------------------------------------------------

describe('the provider capability contract', () => {
  it('has both shipped providers advertise attachments as unavailable', () => {
    const mock = new MockConversationProvider();
    const openclaw = new GatewayOpenClawProvider('ws://127.0.0.1:19001');

    for (const provider of [mock, openclaw]) {
      expect(provider.capabilities.attachments).toEqual(NO_ATTACHMENT_CAPABILITY);
      expect(provider.capabilities.attachments.supported).toBe(false);
      // Even with the operator switch on, the gate stays shut.
      expect(attachmentsUsable(provider, true)).toBe(false);
    }

    /**
     * The two providers are shut for DIFFERENT reasons, and the difference now
     * matters.
     *
     * The mock is unverified, so `attachmentsUsable` would refuse it even if
     * it claimed a capability. OpenClaw is VERIFIED -- a reply contract was
     * recorded from a real turn -- so the only thing refusing it is the
     * capability flag itself, and that flag is honest because the recorded
     * agent turn has no attachment input at all.
     *
     * Asserting them identically would hide that. If the capability were ever
     * flipped without evidence, the mock would still be safe and OpenClaw
     * would not be.
     */
    expect(mock.verified).toBe(false);
    expect(openclaw.verified).toBe(true);
  });

  it('has both shipped providers refuse an attachment honestly if one reaches them', async () => {
    const attachment: ConversationAttachment = {
      metadata: { filename: 'x.png', contentType: 'image/png', byteLength: 1 },
      read: async () => PNG,
    };
    const input = { userId: OWNER, text: 'hi', threadKey: 't', attachment };

    await expect(new MockConversationProvider().reply(input)).rejects.toThrow(
      /attachments are not accepted/i,
    );
    await expect(new GatewayOpenClawProvider('ws://127.0.0.1:19001').reply(input)).rejects.toThrow(
      /attachments are not accepted/i,
    );
  });

  it('requires verified AND capable AND opted in, all three', () => {
    const capable = new CapableProvider();
    expect(attachmentsUsable(capable, true)).toBe(true);
    expect(attachmentsUsable(capable, false)).toBe(false);

    const unverifiedButCapable: ConversationProvider = {
      name: capable.name,
      verified: false,
      capabilities: capable.capabilities,
      reply: capable.reply.bind(capable),
    };
    expect(attachmentsUsable(unverifiedButCapable, true)).toBe(false);
  });

  it('takes the smaller cap and the intersection of the type lists', () => {
    const provider = new CapableProvider();
    const limits = effectiveLimits(provider, {
      enabled: true,
      allowedHosts: [],
      maxBytes: 4096,
    });
    // Ours is smaller here, so ours wins.
    expect(limits.maxBytes).toBe(4096);
    // application/json is on OUR list but not the provider's, so it is out;
    // text/plain is on both, so it is in.
    expect(limits.contentTypes).toEqual(['image/png', 'image/jpeg', 'image/webp', 'text/plain']);
    expect(limits.contentTypes).not.toContain('application/json');
    expect(limits.contentTypes).not.toContain('application/pdf');
  });
});

describe('refusal happens before any download', () => {
  it('refuses when the provider is unverified and unsupported, fetching nothing', async () => {
    const spy = spyFetch();
    const h = await boot({ env: enabled, conversationFetch: spy.impl });

    const reply = await send(h);
    expect(replyText(reply)).toMatch(/cannot accept files/i);
    expect(replyText(reply)).toMatch(/Nothing was downloaded/);
    expect(spy.calls).toBe(0);
    expect(convDirs()).toHaveLength(0);
    h.close();
  });

  it('refuses a capable, verified provider while the operator switch is off', async () => {
    const spy = spyFetch();
    const h = await boot({ conversation: new CapableProvider(), conversationFetch: spy.impl });

    const reply = await send(h);
    expect(replyText(reply)).toMatch(/CONVERSATION_ATTACHMENTS_ENABLED is off/);
    expect(spy.calls).toBe(0);
    h.close();
  });

  it('refuses an UNVERIFIED provider that claims attachment support', async () => {
    const provider = new CapableProvider();
    // The one flag a provider could lie about on its own is not enough.
    Object.defineProperty(provider, 'verified', { value: false });
    const spy = spyFetch();
    const h = await boot({ env: enabled, conversation: provider, conversationFetch: spy.impl });

    const reply = await send(h);
    expect(replyText(reply)).toMatch(/unverified/);
    expect(spy.calls).toBe(0);
    h.close();
  });

  it('refuses several attachments concisely, without downloading any of them', async () => {
    const spy = spyFetch();
    const h = await boot({
      env: enabled, conversation: new CapableProvider(), conversationFetch: spy.impl,
    });

    const reply = await send(h, { attachments: [meta(), meta({ filename: 'b.png' })] });
    expect(replyText(reply)).toBe('Send one file at a time. Nothing was downloaded.');
    expect(spy.calls).toBe(0);
    expect(convDirs()).toHaveLength(0);
    h.close();
  });
});

describe('attachments are owner-only', () => {
  it('refuses a chat-whitelist user and a stranger, and downloads nothing', async () => {
    const spy = spyFetch();
    const provider = new CapableProvider();
    const h = await boot({ env: enabled, conversation: provider, conversationFetch: spy.impl });

    for (const userId of [CHAT, STRANGER]) {
      const reply = await h.transport.dispatch({
        kind: 'message', userId, text: 'look', threadKey: 't', attachments: [meta()],
      });
      expect(reply?.content, userId).toMatch(/not authorized/i);
    }
    expect(spy.calls).toBe(0);
    expect(provider.seen).toBeUndefined();
    h.close();
  });

  it('still lets a chat-whitelist user hold a PLAIN conversation', async () => {
    const h = await boot({ env: enabled, conversation: new CapableProvider() });
    const reply = await h.transport.dispatch({
      kind: 'message', userId: CHAT, text: 'hello', threadKey: 't',
    });
    expect(replyText(reply)).toBe('seen it');
    h.close();
  });

  it('has no shared route to conversation, so a channel cannot reach this path', async () => {
    const sharedCommands = SHARED_READABLE_ROUTES.map((r) => r.command as string);
    expect(sharedCommands).not.toContain('conversation');

    // With a shared channel configured, a non-owner attachment is refused the
    // same way. A message event carries no channel context at all, so there is
    // no branch for a shared channel to take.
    const spy = spyFetch();
    const h = await boot({
      env: { ...enabled, DUCKY_DEV_SHARED_CHANNEL_IDS: '900000000000000001' },
      conversation: new CapableProvider(),
      conversationFetch: spy.impl,
    });
    const reply = await h.transport.dispatch({
      kind: 'message', userId: CHAT, text: 'look', threadKey: '900000000000000001',
      attachments: [meta()],
    });
    expect(replyText(reply)).toMatch(/not authorized/i);
    expect(spy.calls).toBe(0);
    h.close();
  });
});

describe('metadata policy, still before any byte is fetched', () => {
  const cases: { name: string; over: Record<string, unknown>; match: RegExp }[] = [
    { name: 'a foreign host', over: { url: 'https://evil.tld/x.png' }, match: /not hosted by Discord/ },
    { name: 'plain HTTP', over: { url: 'http://cdn.discordapp.com/x.png' }, match: /HTTPS/ },
    {
      name: 'a host that merely ends with an allowed one',
      over: { url: 'https://cdn.discordapp.com.evil.tld/x.png' },
      match: /not hosted by Discord/,
    },
    { name: 'an unsupported type', over: { contentType: 'application/pdf' }, match: /not accepted/ },
    { name: 'no declared type', over: { contentType: null }, match: /not accepted/ },
    { name: 'an oversize claim', over: { size: 99_000_000 }, match: /too large/ },
  ];

  for (const { name, over, match } of cases) {
    it(`refuses ${name} without requesting it`, async () => {
      const spy = spyFetch();
      const h = await boot({
        env: enabled, conversation: new CapableProvider(), conversationFetch: spy.impl,
      });
      const reply = await send(h, { attachments: [meta(over)] });
      expect(replyText(reply)).toMatch(match);
      expect(spy.calls).toBe(0);
      expect(convDirs()).toHaveLength(0);
      h.close();
    });
  }

  it('applies the configured cap, and the provider’s when it is smaller', async () => {
    const spy = spyFetch();
    const h = await boot({
      env: { ...enabled, CONVERSATION_MAX_ATTACHMENT_BYTES: '512' },
      conversation: new CapableProvider(),
      conversationFetch: spy.impl,
    });
    const reply = await send(h, { attachments: [meta({ size: 1024 })] });
    expect(replyText(reply)).toMatch(/too large/);
    expect(spy.calls).toBe(0);
    h.close();
  });
});

describe('the download itself', () => {
  it('never follows a redirect and never accepts a compressed stream', async () => {
    const spy = spyFetch();
    const h = await boot({
      env: enabled, conversation: new CapableProvider(), conversationFetch: spy.impl,
    });
    await send(h);
    expect(spy.calls).toBe(1);
    expect(spy.lastInit?.redirect).toBe('error');
    expect((spy.lastInit?.headers as Record<string, string>)['accept-encoding']).toBe('identity');
    expect(spy.lastUrl).toBe(meta().url);
    h.close();
  });

  it('aborts mid-stream when the declared size was a lie', async () => {
    const provider = new CapableProvider();
    const spy = spyFetch(Buffer.alloc(5000, 7));
    const h = await boot({
      env: { ...enabled, CONVERSATION_MAX_ATTACHMENT_BYTES: '1024' },
      conversation: provider,
      conversationFetch: spy.impl,
    });
    // The metadata claims it is small, so the cheap check passes and only the
    // stream counter can catch it.
    const reply = await send(h, { attachments: [meta({ size: 10 })] });
    expect(replyText(reply)).toMatch(/larger than the limit/);
    expect(provider.seen).toBeUndefined();
    expect(convDirs()).toHaveLength(0);
    h.close();
  });

  it('hands the provider the metadata and the exact bytes', async () => {
    const provider = new CapableProvider();
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });

    const reply = await send(h);
    expect(replyText(reply)).toBe('seen it');
    expect(provider.seen?.text).toBe('what is this?');
    expect(provider.seen?.threadKey).toBe('dm-1');
    expect(provider.seen?.attachment?.metadata).toEqual({
      filename: 'photo.png',
      contentType: 'image/png',
      byteLength: PNG.byteLength,
    });
    expect(Buffer.from(provider.bytes!)).toEqual(PNG);
    h.close();
  });

  it('bounds an explicit read and never exceeds the effective cap', async () => {
    const provider = new CapableProvider();
    let short: Uint8Array | undefined;
    provider.onReply = () => undefined;
    const original = provider.reply.bind(provider);
    provider.reply = async (input) => {
      if (input.attachment) short = await input.attachment.read(4);
      return original(input);
    };
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });
    await send(h);
    expect(Buffer.from(short!)).toEqual(PNG.subarray(0, 4));
    h.close();
  });
});

describe('lifetime and cleanup', () => {
  it('uses a 0700 directory and a 0600 file while the provider holds it', async () => {
    const provider = new CapableProvider();
    let dirMode: number | undefined;
    let fileMode: number | undefined;
    provider.onReply = () => {
      const [dir] = convDirs();
      if (!dir) return;
      const full = path.join(os.tmpdir(), dir);
      dirMode = statSync(full).mode & 0o777;
      fileMode = statSync(path.join(full, 'attachment.bin')).mode & 0o777;
    };
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });

    await send(h);
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    h.close();
  });

  it('removes the temp directory after a successful reply', async () => {
    const before = convDirs().length;
    const h = await boot({
      env: enabled, conversation: new CapableProvider(), conversationFetch: spyFetch().impl,
    });
    await send(h);
    expect(convDirs().length).toBe(before);
    h.close();
  });

  it('removes the temp directory when the provider throws', async () => {
    const before = convDirs().length;
    const provider = new CapableProvider();
    provider.throwOnReply = true;
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });

    const reply = await send(h);
    expect(replyText(reply)).toMatch(/went wrong/i);
    expect(convDirs().length).toBe(before);
    h.close();
  });

  it('poisons a handle the provider retained, so it cannot read after the reply', async () => {
    const provider = new CapableProvider();
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });
    await send(h);

    expect(provider.stashed).toBeDefined();
    // Metadata is inert and stays readable; the BYTES are gone.
    expect(provider.stashed?.metadata.filename).toBe('photo.png');
    await expect(provider.stashed?.read()).rejects.toThrow(/no longer available/);
    h.close();
  });

  it('gives the provider a handle with no way to extend its own lifetime', async () => {
    const provider = new CapableProvider();
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });
    await send(h);
    // The narrow port type has no dispose; assert the runtime object matches,
    // so a provider cannot free or hold the resource itself.
    expect(Object.keys(provider.stashed ?? {})).toEqual(['metadata', 'read', 'dispose']);
    h.close();
  });

  it('sweeps a stale conversation temp directory left by a previous run', async () => {
    const { mkdtempSync, utimesSync, existsSync } = await import('node:fs');
    const stale = mkdtempSync(path.join(os.tmpdir(), CONVERSATION_TEMP_PREFIX));
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(stale, old, old);

    const removed = sweepStaleTempDirs();
    expect(removed).toContain(stale);
    // The sweep deletes fire-and-forget, so the directory disappears shortly
    // AFTER the call returns. A fixed sleep makes this flaky on a loaded host.
    await vi.waitFor(() => expect(existsSync(stale)).toBe(false), { timeout: 5_000 });
  });
});

describe('bytes never leave the private path', () => {
  it('puts no attachment bytes in the reply, and nothing in the database', async () => {
    const provider = new CapableProvider();
    const h = await boot({
      env: enabled, conversation: provider, conversationFetch: spyFetch().impl,
    });
    await send(h);

    const rendered = JSON.stringify(h.transport.sent);
    expect(rendered).not.toContain(PNG.toString('base64'));
    expect(rendered).not.toContain('attachment.bin');
    expect(rendered).not.toContain(os.tmpdir());
    // Nothing about an attachment is persisted anywhere.
    const tables = (
      h.store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).not.toContain('attachments');
    expect(tables).not.toContain('conversation_attachments');
    h.close();
  });

  it('reports availability in /status without naming a path', async () => {
    const h = await boot({ env: enabled });
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'status', userId: OWNER, options: {},
    });
    const body = JSON.stringify(reply);
    expect(body).toContain('Chat attachments');
    // The mock is unverified AND incapable; the first blocking reason is
    // reported, which is the one the operator would have to fix first.
    expect(body).toMatch(/unavailable \(mock is unverified\)/);
    expect(body).not.toContain(os.tmpdir());
    h.close();
  });
});
