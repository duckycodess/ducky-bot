import { describe, expect, it } from 'vitest';
import { checkCommandAllowed } from '@ducky/contracts';
import { GatewayOpenClawProvider } from '../src/openclaw/openclaw.gateway.js';
import { OpenClawReplySchema, replyTextFrom } from '../src/openclaw/openclaw.schema.js';

const provider = (): GatewayOpenClawProvider =>
  new GatewayOpenClawProvider('ws://127.0.0.1:19001', { profile: 'dev' });

describe('the OpenClaw reply schema', () => {
  /** The envelope shape the probe actually recorded, with values filled in. */
  const observed = {
    payloads: [{ text: 'pong', mediaUrl: null }],
    meta: {
      durationMs: 4210,
      agentMeta: { sessionId: 's', provider: 'openai', model: 'openai/gpt-5.6-sol' },
      finalAssistantVisibleText: 'pong',
      systemPromptReport: { workspaceDir: '/home/someone/somewhere' },
    },
  };

  it('parses the envelope that was observed', () => {
    const parsed = OpenClawReplySchema.parse(observed);
    expect(replyTextFrom(parsed)).toEqual({ text: 'pong' });
  });

  it('reads the answer from payloads, joining several rather than dropping any', () => {
    const parsed = OpenClawReplySchema.parse({
      payloads: [{ text: 'first' }, { text: 'second' }],
    });
    expect(replyTextFrom(parsed)).toEqual({ text: 'first\n\nsecond' });
  });

  it('tolerates unknown keys, because they are somebody else\'s diagnostics', () => {
    // These are internals of a tool that is not ours and they will change
    // between versions. A required field disappearing must not turn a working
    // reply into a parse failure.
    expect(() =>
      OpenClawReplySchema.parse({
        payloads: [{ text: 'hi', somethingNew: 1 }],
        meta: {},
        aFieldFromNextYear: true,
      }),
    ).not.toThrow();
  });

  it('refuses an envelope with no text rather than answering with silence', () => {
    const parsed = OpenClawReplySchema.parse({ payloads: [{ text: '   ' }] });
    const out = replyTextFrom(parsed);
    expect('refusal' in out && out.refusal).toMatch(/no text/i);
  });

  it('recognises the documented in_flight case', () => {
    // A well-formed envelope that deliberately carries no answer. Rendering it
    // as an empty reply would read as Ducky ignoring the owner.
    const parsed = OpenClawReplySchema.parse({ payloads: [], status: 'in_flight' });
    const out = replyTextFrom(parsed);
    expect('refusal' in out && out.refusal).toMatch(/still being generated/i);
  });

  it('refuses a shape this build does not recognise', () => {
    // Not "guess what the assistant said": the alternative to refusing is
    // rendering whatever happened to be in the JSON as if it were an answer.
    expect(() => OpenClawReplySchema.parse({ payloads: 'not an array' })).toThrow();
    expect(() => OpenClawReplySchema.parse({ payloads: [{ notText: 1 }] })).toThrow();
  });
});

describe('the argv the adapter builds', () => {
  it('never puts the owner\'s words on the command line', () => {
    /**
     * The defect this design exists to avoid, demonstrated at its real size.
     *
     * `checkCommandAllowed` scans every argv element for forbidden verbs, and
     * `isVerbWord` matches a WHOLE element -- so "how do I push to main?" is
     * one element and passes. A one-word message does not: "push", "login" and
     * "auth" are each a forbidden verb on their own, and the owner's message
     * would be refused before it reached a subprocess.
     *
     * That is a narrow failure, and narrow is what makes it worth avoiding
     * structurally rather than remembering: it would strike rarely, look
     * arbitrary, and be reported as "Ducky ignored me".
     */
    const withOneWord = [
      '--dev', '--no-color', 'agent', '--local', '--json',
      '--session-key', 'agent:ducky:1', '--message', 'push',
    ];
    expect(checkCommandAllowed('openclaw', withOneWord)?.reason).toBe('forbidden_verb');

    // A longer message survives the scan, which is precisely why the narrow
    // case would be so confusing in practice.
    const withSentence = [...withOneWord.slice(0, -1), 'how do I push to main?'];
    expect(checkCommandAllowed('openclaw', withSentence)).toBeUndefined();

    // What the adapter actually builds carries a PATH, so every message --
    // one word or a paragraph -- passes the policy untouched.
    const built = provider().buildArgv('agent:ducky:1', '/tmp/ducky-openclaw-x/message.txt');
    expect(built).not.toContain('--message');
    expect(built).toContain('--message-file');
    expect(checkCommandAllowed('openclaw', built)).toBeUndefined();
  });

  it('is classified and permitted by the central policy', () => {
    // The frozen argv decides what can be constructed; the policy decides
    // whether it may run. Both, always.
    expect(checkCommandAllowed('openclaw', provider().buildArgv('agent:ducky:1', '/tmp/m.txt')))
      .toBeUndefined();
  });

  it('never constructs --deliver, in any profile', () => {
    for (const profile of ['dev', 'default'] as const) {
      const argv = new GatewayOpenClawProvider('ws://127.0.0.1:19001', { profile })
        .buildArgv('agent:ducky:1', '/tmp/m.txt');
      expect(argv, profile).not.toContain('--deliver');
    }
  });

  it('carries the profile flag only when the dev profile is selected', () => {
    // The recorded contract lives in the `--dev` store, which is why it is the
    // default; a host signed in under its own default profile sets `default`.
    expect(provider().buildArgv('k', '/tmp/m.txt')).toContain('--dev');
    expect(
      new GatewayOpenClawProvider('ws://127.0.0.1:19001', { profile: 'default' })
        .buildArgv('k', '/tmp/m.txt'),
    ).not.toContain('--dev');
  });
});

describe('the provider refuses before it spawns anything', () => {
  it('refuses an attachment as a CAPABILITY refusal, not a missing integration', () => {
    const attachment = {
      metadata: { filename: 'a.png', contentType: 'image/png', byteLength: 1 },
      read: async () => new Uint8Array(),
    };
    return expect(
      provider().reply({
        userId: 'u', text: 'hi', threadKey: 't', attachment,
      }),
    ).rejects.toThrow(/attachment/i);
  });

  it('refuses a public gateway URL at construction', () => {
    expect(() => new GatewayOpenClawProvider('wss://openclaw.example.com')).toThrow();
  });

  it('checks the TOOL POLICY before it will spawn a turn at all', async () => {
    /**
     * Ordering matters, and it changed deliberately. A CLI that cannot run is
     * now reported as an unprovable tool policy rather than as a failed turn,
     * because the policy check comes first -- the point is to refuse BEFORE
     * the owner's sentence is handed to anything.
     *
     * `false` exits non-zero and writes nothing, standing in for a CLI that
     * cannot answer. Either way the message names what an owner can act on.
     */
    const broken = new GatewayOpenClawProvider('ws://127.0.0.1:19001', {
      bin: '/usr/bin/false',
      timeoutMs: 10_000,
    });
    await expect(
      broken.reply({ userId: 'u', text: 'hi', threadKey: 't' }),
    ).rejects.toThrow(/provably text-only/i);
  });
});

describe('the provider session is isolated by user AND thread', () => {
  /**
   * Ducky's own SQLite history has always been per (user, thread) -- every
   * repository method puts the user id in the WHERE clause. The PROVIDER keeps
   * its own transcript under the session key, and that key used to be the
   * thread alone: two people talking in one channel shared one OpenClaw
   * session. Ducky's isolation was real and the layer underneath it was not,
   * which is the worse half to get wrong because it is the half nobody looks
   * at.
   */
  const keyFor = (userId: string, threadKey: string): string => {
    const p = provider() as unknown as {
      sessionKeyFor: (i: { userId: string; threadKey: string }) => string;
    };
    return p.sessionKeyFor({ userId, threadKey });
  };

  it('gives two users in the SAME channel two different sessions', () => {
    expect(keyFor('user-a', 'chan-1')).not.toBe(keyFor('user-b', 'chan-1'));
  });

  it('gives one user in two channels two different sessions', () => {
    expect(keyFor('user-a', 'chan-1')).not.toBe(keyFor('user-a', 'chan-2'));
  });

  it('is stable, so a conversation continues', () => {
    expect(keyFor('user-a', 'chan-1')).toBe(keyFor('user-a', 'chan-1'));
  });

  it('never puts a raw Discord id into another tool\'s storage', () => {
    // A session key ends up in file names and a database that is not ours.
    const id = '100000000000000001';
    const key = keyFor(id, '900000000000000013');
    expect(key).not.toContain(id);
    expect(key).not.toContain('900000000000000013');
    expect(key).toMatch(/^agent:ducky:[0-9a-f]{32}$/);
  });
});

describe('the persona is instructions, not stored turns', () => {
  const promptFor = (text: string, persona?: string): string => {
    const p = new GatewayOpenClawProvider('ws://127.0.0.1:19001', {
      ...(persona === undefined ? {} : { persona }),
    }) as unknown as { promptFrom: (i: { text: string; history?: unknown }) => string };
    return p.promptFrom({ text });
  };

  it('carries the style contract on every turn', () => {
    const prompt = promptFor('hello');
    expect(prompt).toMatch(/Do not use emojis/i);
    expect(prompt).toMatch(/Avoid em dashes/i);
    expect(prompt).toMatch(/Never claim to remember/i);
    expect(prompt).toMatch(/Do not take actions/i);
  });

  it('uses the configured persona, and still cannot drop the style rules', () => {
    // Persona is the voice and an operator may set it. The rules that keep
    // replies readable and honest are appended after it and are not
    // configurable, so a persona cannot quietly undo them.
    const prompt = promptFor('hello', 'You are Quackers, a pirate.');
    expect(prompt).toContain('Quackers');
    expect(prompt).toMatch(/Do not use emojis/i);
  });

  it('bounds the persona rather than letting a prompt grow without limit', () => {
    const prompt = promptFor('hello', 'x'.repeat(5_000));
    expect(prompt.length).toBeLessThan(3_000);
  });

  it('falls back to the default when the persona is blank', () => {
    expect(promptFor('hello', '   ')).toMatch(/You are Ducky/i);
  });
});
