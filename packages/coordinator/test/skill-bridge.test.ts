import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockFrontDoor, NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from '@ducky/adapters';
import { controlId, isLinkButton, type OutboundMessage } from '../src/discord/message.js';
import { makeHarness, CHAT, OWNER, replyText, type HarnessOptions } from './helpers.js';

const GUILD = '800000000000000001';
const CODING = '900000000000000012';
const SHARED = '900000000000000055';

/**
 * A provider that is VERIFIED, so the grill can run, and that records the
 * instructions it was handed.
 *
 * The shipped mock reports `verified: false`, which is the honest answer for a
 * host with no backend -- and `$grill-me` refuses against it, which is one of
 * the properties tested below.
 */
class RecordingProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = true;
  readonly capabilities: ConversationCapabilities = { attachments: NO_ATTACHMENT_CAPABILITY, sessionDeletion: NO_SESSION_DELETION('test stand-in') };
  readonly turns: ConversationInput[] = [];

  constructor(private readonly answer = 'Q1 - what is the smallest version of this?') {}

  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.turns.push(input);
    return { text: this.answer, mock: false };
  }
}

const TWO_REPOS = JSON.stringify({
  version: 1,
  repos: [
    {
      slug: 'demo', absolutePath: '/tmp/ducky-demo', defaultBranch: 'main',
      github: { owner: 'acme', repo: 'demo' }, enabled: true,
    },
    {
      slug: 'widgets', absolutePath: '/tmp/ducky-widgets', defaultBranch: 'main',
      github: { owner: 'acme', repo: 'widgets' }, enabled: true,
    },
  ],
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skillFile = (body: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ducky-skill-'));
  temps.push(dir);
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, body);
  return file;
};

interface BridgeOptions extends HarnessOptions {
  readonly door?: MockFrontDoor;
  readonly provider?: RecordingProvider;
  readonly mutation?: boolean;
  readonly grillSkillPath?: string;
}

/** The installed method on disk. `$grill-me` fails closed without one. */
const defaultSkill = (): string => skillFile('UPSTREAM GRILL METHOD: rounds on a design tree.');

const boot = async (opts: BridgeOptions = {}) => {
  // The mock reports its own availability, so a test that turns publishing off
  // has to say so to BOTH halves: the configuration and the stand-in helper.
  const door =
    opts.door ??
    new MockFrontDoor(
      opts.mutation === false ? { availability: { mutationEnabled: false } } : {},
    );
  const provider = opts.provider ?? new RecordingProvider();
  const h = makeHarness({
    ...opts,
    frontDoor: door,
    conversation: provider,
    env: {
      DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
      ...(opts.mutation === false ? {} : { DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1' }),
      DUCKY_DEV_WORKFLOW_GRILL_SKILL: opts.grillSkillPath ?? defaultSkill(),
      ...opts.env,
    },
  });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, door, provider };
};

const say = (
  h: Awaited<ReturnType<typeof boot>>['h'],
  text: string,
  options: { channelId?: string; userId?: string } = {},
): Promise<OutboundMessage | undefined> =>
  h.transport.dispatch({
    kind: 'message',
    userId: options.userId ?? OWNER,
    text,
    threadKey: options.channelId ?? 'dm-1',
    ...(options.channelId ? { context: { channelId: options.channelId, guildId: GUILD } } : {}),
  });

/** Every card the run posted or edited, newest last. */
const cards = (h: Awaited<ReturnType<typeof boot>>['h']): OutboundMessage[] =>
  [...h.transport.cards.values()].map((c) => c.message);

const cardText = (m: OutboundMessage | undefined): string =>
  JSON.stringify(m?.embeds ?? []);

describe('only the three selected commands reach the workflow', () => {
  it('recognises each one as the first unquoted token', async () => {
    const { h, door } = await boot();
    await say(h, '$agentize');
    expect(door.calls.map((c) => c.kind)).toContain('agentize');
    h.close();
  });

  it('treats a quoted, fenced or mid-sentence mention as data', async () => {
    const { h, door } = await boot();
    for (const text of [
      '> $ticket do the thing',
      '```\n$ticket do the thing\n```',
      '`$agentize`',
      'we should $ticket this later',
      'implement this',
      'ticket it',
      'queue it',
    ]) {
      await say(h, text);
    }
    expect(door.calls).toHaveLength(0);
    h.close();
  });

  it('never creates a Ducky executor job, by any route', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    await say(h, 'implement in demo: add a health endpoint');
    await say(h, 'yes');
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });
});

describe('an authorized friend stays on general chat', () => {
  it('reaches no helper and gets ordinary conversation', async () => {
    const { h, door, provider } = await boot();
    const reply = await say(h, '$ticket publish something', { userId: CHAT });

    expect(door.calls).toHaveLength(0);
    // Their message went to the provider as ordinary conversation.
    expect(provider.turns.at(-1)?.text).toBe('$ticket publish something');
    expect(replyText(reply)).not.toMatch(/repository/i);
    h.close();
  });

  it('cannot press an owner control', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const control = controlId(cards(h).at(-1)?.rows?.[0]?.buttons?.[0]);
    expect(control).not.toBe('');

    const stolen = await h.transport.dispatch({
      kind: 'component', customId: control, userId: CHAT,
    });
    expect(replyText(stolen)).toMatch(/not authorized|no longer valid/i);
    // Nothing was cancelled, and no second publication happened.
    expect(door.calls.filter((c) => c.kind === 'publish')).toHaveLength(1);
    h.close();
  });
});

describe('a shared channel is never a place to publish from', () => {
  it('reads a command there as ordinary conversation', async () => {
    const { h, door } = await boot({ env: { DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED } });
    await say(h, '$ticket publish something', { channelId: SHARED });
    expect(door.calls).toHaveLength(0);
    h.close();
  });
});

describe('binding a repository', () => {
  it('binds the single configured one and shows its identity', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    expect(cardText(cards(h).at(-1))).toContain('acme/demo');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.repository).toBe('acme/demo');
    h.close();
  });

  it('asks rather than guessing when several are configured', async () => {
    const { h, door } = await boot({ allowlistJson: TWO_REPOS });
    const reply = await say(h, '$ticket add a health endpoint');

    expect(replyText(reply)).toMatch(/which repository/i);
    expect(replyText(reply)).toContain('acme/demo');
    expect(replyText(reply)).toContain('acme/widgets');
    // Nothing was read, and nothing was created.
    expect(door.calls).toHaveLength(0);
    h.close();
  });

  it('honours an explicit target and rebinds on an explicit change', async () => {
    const { h, door } = await boot({ allowlistJson: TWO_REPOS });
    await say(h, '$ticket acme/demo add a health endpoint');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.repository).toBe('acme/demo');

    const firstUuid = h.store.agentThreads.get(OWNER, 'dm-1')!.ticketUuid;

    await say(h, '$ticket acme/widgets add a health endpoint');
    const row = h.store.agentThreads.get(OWNER, 'dm-1')!;
    expect(row.repository).toBe('acme/widgets');
    // The canonical id and the issue belonged to the previous repository, so
    // the second publication CREATES rather than enriching the first one.
    const second = door.calls.filter((c) => c.kind === 'publish')[1]!.input;
    expect(second['issue']).toBeUndefined();
    expect(second['id']).not.toBe(firstUuid);
    h.close();
  });
});

describe('$ticket publishes through the installed helper only', () => {
  it('creates an UNQUEUED issue for a bare $ticket', async () => {
    const { h, door } = await boot();
    const reply = await say(h, '$ticket add a health endpoint');

    const publish = door.calls.find((c) => c.kind === 'publish')!;
    expect(publish.input['ready']).toBe(false);
    expect(replyText(reply)).toMatch(/not queued/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.queueState).not.toBe('queued');
    expect(cardText(cards(h).at(-1))).toContain('does not authorize implementation');
    h.close();
  });

  it('queues only on an explicit --ready, and says what that does not prove', async () => {
    const { h, door } = await boot();
    const reply = await say(h, '$ticket --ready add a health endpoint');

    expect(door.calls.find((c) => c.kind === 'publish')!.input['ready']).toBe(true);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.queueState).toBe('queued');
    expect(replyText(reply)).toMatch(/not evidence that a worker started/i);
    // The word that must never appear for a queued ticket.
    expect(cardText(cards(h).at(-1))).not.toMatch(/"Running/);
    h.close();
  });

  it('never infers --ready from prose', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket queue it and make this agent ready right now');
    expect(door.calls.find((c) => c.kind === 'publish')!.input['ready']).toBe(false);
    h.close();
  });

  it('validates through the installed validator before publishing', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const kinds = door.calls.map((c) => c.kind);
    expect(kinds.indexOf('validate')).toBeLessThan(kinds.indexOf('publish'));
    h.close();
  });

  it('stops at the installed validator when it refuses', async () => {
    const door = new MockFrontDoor({ validate: { ok: false, error: 'Invalid TicketSpec: title' } });
    const { h } = await boot({ door });
    const reply = await say(h, '$ticket add a health endpoint');

    expect(door.calls.some((c) => c.kind === 'publish')).toBe(false);
    expect(replyText(reply)).toMatch(/nothing was queued and nothing was started/i);
    h.close();
  });

  it('reuses the canonical id and the issue while the publication has not succeeded', async () => {
    /**
     * The binding exists for RETRIES. While a publication keeps failing, the
     * same canonical id and the same issue number go back, so the helper
     * enriches rather than opening a second issue.
     */
    const door = new MockFrontDoor({
      publish: { ok: false, issue: 41, url: 'https://github.com/acme/demo/issues/41', error: 'transient' },
    });
    const { h } = await boot({ door });
    await say(h, '$ticket add a health endpoint');
    const first = door.calls.find((c) => c.kind === 'publish')!.input;
    const uuid = h.store.agentThreads.get(OWNER, 'dm-1')!.ticketUuid;

    await say(h, '$ticket add a health endpoint');
    const second = door.calls.filter((c) => c.kind === 'publish')[1]!.input;

    expect(second['id']).toBe(first['id']);
    expect(second['id']).toBe(uuid);
    expect(second['issue']).toBe(41);
    h.close();
  });

  it('releases the binding once a publication succeeds', async () => {
    /**
     * ...and releases it the moment one succeeds. Keeping it meant the next,
     * DIFFERENT ticket in the thread inherited the issue and rewrote it with
     * an unrelated contract.
     */
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const row = h.store.agentThreads.get(OWNER, 'dm-1')!;

    expect(row.ticketUuid).toBeNull();
    expect(row.issueNumber).toBeNull();
    // The URL survives, because the card's View issue link is about what this
    // run produced rather than about what the next one should enrich.
    expect(row.issueUrl).toBe('https://github.com/acme/demo/issues/41');

    await say(h, '$ticket add a logout endpoint');
    const second = door.calls.filter((c) => c.kind === 'publish')[1]!.input;
    expect(second['issue']).toBeUndefined();
    h.close();
  });

  it('reports a publisher failure as failed, never as queued or started', async () => {
    const door = new MockFrontDoor({
      publish: { ok: false, queued: false, started: false, url: undefined, error: 'Repository is not enabled in existing dispatcher' },
    });
    const { h } = await boot({ door });
    const reply = await say(h, '$ticket --ready add a health endpoint');

    expect(replyText(reply)).toMatch(/not enabled in existing dispatcher/);
    // Never queued, never started -- and, because the owner HAD asked and the
    // publisher writes the label before it reads it back, never a flat
    // "nothing was queued" either. See the review suite for that distinction.
    expect(replyText(reply)).toMatch(/nothing was started/i);
    const row = h.store.agentThreads.get(OWNER, 'dm-1')!;
    expect(row.runStatus).toBe('failed');
    expect(row.queueState).not.toBe('queued');
    h.close();
  });

  it('reports a queue that did not complete as published, never as queued', async () => {
    // The helper answered ok but did not verify the label. Asking is not
    // authorization; verification is.
    const door = new MockFrontDoor({ publish: { queued: false, queueVerified: false } });
    const { h } = await boot({ door });
    await say(h, '$ticket --ready add a health endpoint');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.queueState).not.toBe('queued');
    expect(cardText(cards(h).at(-1))).toContain('did NOT complete');
    h.close();
  });

  it('asks for the work rather than inventing it', async () => {
    const { h, door } = await boot();
    const reply = await say(h, '$ticket');
    expect(replyText(reply)).toMatch(/nothing in this thread says what the work is/i);
    expect(door.calls.some((c) => c.kind === 'publish')).toBe(false);
    h.close();
  });

  it('builds the spec only from lines the owner typed', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint to the API');
    // The mock records the id and repository; the spec itself is asserted by
    // what the validator was handed.
    const validated = door.calls.find((c) => c.kind === 'validate')!;
    expect(validated.input['repository']).toBe('acme/demo');
    h.close();
  });
});

describe('publishing is a separate opt-in', () => {
  it('validates and creates nothing when it is not enabled', async () => {
    const { h, door } = await boot({ mutation: false });
    const reply = await say(h, '$ticket --ready add a health endpoint');

    expect(door.calls.some((c) => c.kind === 'publish')).toBe(false);
    expect(replyText(reply)).toMatch(/publishing is not enabled/i);
    expect(replyText(reply)).toMatch(/nothing was queued/i);
    h.close();
  });

  it('refuses onboarding without reading anything', async () => {
    const { h, door } = await boot({ mutation: false });
    const reply = await say(h, '$agentize');
    expect(door.calls).toHaveLength(0);
    expect(replyText(reply)).toMatch(/not enabled/i);
    h.close();
  });

  it('says the workflow is off rather than sending the command to the model', async () => {
    /**
     * An honest one-liner, on the same terms `/forget` answers when deletion
     * is unconfigured. Letting `$ticket ...` fall through to the provider
     * would spend a model turn producing a guess about a feature this
     * instance does not have.
     */
    const door = new MockFrontDoor();
    const provider = new RecordingProvider();
    const h = makeHarness({ frontDoor: door, conversation: provider });
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: '$ticket add a health endpoint', threadKey: 'dm-1',
    });

    expect(door.calls).toHaveLength(0);
    expect(provider.turns).toHaveLength(0);
    expect(replyText(reply)).toMatch(/not enabled on this instance/i);
    expect(h.store.agentThreads.countForOwner(OWNER)).toBe(0);
    h.close();
  });
});

describe('$agentize onboards and starts nothing', () => {
  it('reports what changed and that no service was started', async () => {
    const { h, door } = await boot();
    const reply = await say(h, '$agentize');

    expect(door.calls.some((c) => c.kind === 'agentize')).toBe(true);
    expect(replyText(reply)).toMatch(/no service was started/i);
    expect(replyText(reply)).toMatch(/no label authorizes work/i);
    expect(cardText(cards(h).at(-1))).toContain('No service was started or restarted');
    h.close();
  });

  it('reuses the registered host checkout rather than naming a new one', async () => {
    const { h, door } = await boot();
    await say(h, '$agentize');
    const call = door.calls.find((c) => c.kind === 'agentize')!;
    expect(call.input['path']).toBe('/tmp/ducky-demo');
    expect(call.input['repository']).toBe('acme/demo');
    h.close();
  });

  it('reports an incomplete onboarding as failed', async () => {
    const door = new MockFrontDoor({
      agentize: { ok: false, error: 'Active worker owns this checkout; onboarding deferred without mutation' },
    });
    const { h } = await boot({ door });
    const reply = await say(h, '$agentize');
    expect(replyText(reply)).toMatch(/active worker owns this checkout/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.runStatus).toBe('failed');
    h.close();
  });
});

describe('$grill-me is a conversation and nothing else', () => {
  it('refuses against an unverified provider rather than faking an interview', async () => {
    const door = new MockFrontDoor();
    const h = makeHarness({
      frontDoor: door,
      env: {
        DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
        DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
      },
    });
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: '$grill-me', threadKey: 'dm-1',
    });
    expect(replyText(reply)).toMatch(/verified assistant provider/i);
    expect(door.calls).toHaveLength(0);
    h.close();
  });

  it('reads the repository and creates nothing', async () => {
    const { h, door } = await boot();
    await say(h, '$grill-me the retry policy');

    const inspected = door.calls.filter((c) => c.kind === 'inspect');
    expect(inspected).toHaveLength(1);
    // A local read: a conversation does not need GitHub.
    expect(inspected[0]!.input['network']).toBeUndefined();
    expect(door.calls.some((c) => c.kind === 'publish' || c.kind === 'agentize')).toBe(false);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.grilling).toBe(true);
    h.close();
  });

  it('hands the provider the INSTALLED skill text, read from its configured path', async () => {
    const file = skillFile('UPSTREAM GRILL METHOD: work the design tree in rounds.');
    const provider = new RecordingProvider();
    const { h } = await boot({ provider, grillSkillPath: file });
    await say(h, '$grill-me the retry policy');

    const instructions = (provider.turns.at(-1)?.instructions ?? []).join('\n');
    expect(instructions).toContain('UPSTREAM GRILL METHOD');
    expect(instructions).toContain('acme/demo');
    expect(instructions).toMatch(/conversation only/i);
    h.close();
  });

  it('continues the interview on a plain reply, and only while it is open', async () => {
    const provider = new RecordingProvider();
    const { h } = await boot({ provider });
    await say(h, '$grill-me the retry policy');
    const after = provider.turns.length;

    await say(h, 'three attempts, then stop');
    expect(provider.turns.length).toBe(after + 1);
    expect(provider.turns.at(-1)?.text).toBe('three attempts, then stop');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.intentNotes)
      .toContain('three attempts, then stop');
    h.close();
  });

  it('continues a grill in a coding channel, where conversation is otherwise silent', async () => {
    const provider = new RecordingProvider();
    const { h } = await boot({
      provider,
      env: {
        DUCKY_DEV_CODING_CHANNEL_ID: CODING,
        DUCKY_DEV_GPT_CHANNEL_ID: '900000000000000013',
      },
    });
    await say(h, '$grill-me the retry policy', { channelId: CODING });
    const reply = await say(h, 'three attempts, then stop', { channelId: CODING });
    // Without the grill, a guild channel that is not the gpt channel is silent.
    expect(reply).toBeDefined();
    h.close();
  });

  it('feeds the grill lines into the ticket as the settled intent', async () => {
    const { h, door } = await boot();
    await say(h, '$grill-me the retry policy');
    await say(h, 'three attempts, then stop');
    await say(h, '$ticket');

    expect(door.calls.some((c) => c.kind === 'publish')).toBe(true);
    // ...and publishing settles the thread, so the next ticket starts clean.
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.intentNotes).toEqual([]);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.grilling).toBe(false);
    h.close();
  });
});

describe('the job card', () => {
  it('edits ONE message through the run and sends a fresh one at the end', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');

    // One card message exists, whatever the number of status changes...
    expect(h.transport.cards.size).toBe(2);
    const ids = [...h.transport.cards.keys()];
    // ...the first being the progress card, edited in place, and the second
    // the fresh terminal notification.
    expect(ids).toHaveLength(2);
    expect(cardText(h.transport.card(ids[1]!))).toContain('Issue created, not queued');
    h.close();
  });

  it('posts a fresh card when the owner deleted the one it was editing', async () => {
    const { h } = await boot();
    await say(h, '$grill-me the retry policy');
    const before = h.transport.cards.size;
    h.transport.missingCardIds = new Set(h.transport.cards.keys());

    await say(h, '$ticket');
    expect(h.transport.cards.size).toBeGreaterThan(before);
    h.close();
  });

  it('carries real controls: Details, View issue and Cancel', async () => {
    const { h } = await boot();
    await say(h, '$grill-me the retry policy');
    const running = cards(h).at(-1)!;
    const labels = running.rows?.[0]?.buttons.map((b) => b.label) ?? [];
    expect(labels).toContain('Details');
    // Cancel exists while the run is live.
    expect(labels).toContain('Cancel');

    await say(h, '$ticket add a health endpoint');
    const finished = cards(h).at(-1)!;
    const buttons = finished.rows?.[0]?.buttons ?? [];
    const link = buttons.find(isLinkButton);
    expect(link?.label).toBe('View issue');
    expect(link?.url).toBe('https://github.com/acme/demo/issues/41');
    // ...and Cancel is gone, because it could no longer act.
    expect(buttons.map((b) => b.label)).not.toContain('Cancel');
    h.close();
  });

  it('answers Details with the owner\'s own private view', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    const details = cards(h).at(-1)!.rows![0]!.buttons.find((b) => b.label === 'Details')!;

    const shown = await h.transport.dispatch({
      kind: 'component', customId: controlId(details), userId: OWNER,
    });
    expect(shown?.ephemeral).toBe(true);
    expect(cardText(shown)).toContain('Ducky never starts, stops or observes a worker');
    h.close();
  });

  it('closes an open interview, and keeps the notes it settled', async () => {
    /**
     * A grill stops being a RUN as soon as its scan is done -- there is no
     * further step to stop, and holding the thread would block the `$ticket`
     * the grill exists to lead to. Its Cancel therefore means "close the
     * interview", which is the only thing left that it could mean.
     */
    const { h } = await boot();
    await say(h, '$grill-me the retry policy');
    await say(h, 'three attempts, then stop');
    const cancel = cards(h).at(-1)!.rows![0]!.buttons.find((b) => b.label === 'Cancel')!;

    const reply = await h.transport.dispatch({
      kind: 'component', customId: controlId(cancel), userId: OWNER,
    });
    expect(replyText(reply)).toMatch(/closed the interview/i);
    const row = h.store.agentThreads.get(OWNER, 'dm-1')!;
    expect(row.grilling).toBe(false);
    // The notes are the owner's settled intent; closing the interview is not
    // throwing away the work it established.
    expect(row.intentNotes).toContain('three attempts, then stop');
    h.close();
  });

  it('frees the thread once a grill opens, so $ticket can follow it', async () => {
    const { h, door } = await boot();
    await say(h, '$grill-me the retry policy');
    await say(h, 'three attempts, then stop');

    // No "already in flight" refusal: the grill holds no pending step.
    const reply = await say(h, '$ticket');
    expect(replyText(reply)).not.toMatch(/already in flight/i);
    expect(door.calls.some((c) => c.kind === 'publish')).toBe(true);
    h.close();
  });

  it('never renders a host path', async () => {
    const { h } = await boot();
    await say(h, '$grill-me the retry policy');
    await say(h, '$ticket add a health endpoint');
    for (const card of cards(h)) {
      expect(JSON.stringify(card)).not.toContain('/tmp/ducky-demo');
    }
    h.close();
  });
});

describe('the owner can delete what the workflow stored', () => {
  it('/forget conversation removes the thread records and says what it did not delete', async () => {
    const { h } = await boot({ env: { DUCKY_CONVERSATION_MEMORY_ENABLED: '1' } });
    await say(h, '$grill-me the retry policy');
    await say(h, 'three attempts, then stop');
    expect(h.store.agentThreads.countForOwner(OWNER)).toBe(1);

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'forget', userId: OWNER, options: { target: 'conversation' },
    });

    expect(h.store.agentThreads.countForOwner(OWNER)).toBe(0);
    expect(replyText(reply)).toMatch(/repository-workflow thread record/i);
    // Honest about its reach: a published issue is not Ducky's to delete.
    expect(replyText(reply)).toMatch(/does not delete published work/i);
    h.close();
  });
});

describe('the card says what queueing can end in', () => {
  it('warns when the registration permits the dispatcher\'s automatic merge', async () => {
    // No `completion` on the registration is the automatic-merge-permitted
    // default, and ticket prose cannot change it.
    const { h } = await boot();
    await say(h, '$ticket --ready add a health endpoint');
    expect(cardText(cards(h).at(-1))).toMatch(/may merge the resulting pull request automatically/i);
    h.close();
  });

  it('says so plainly when the registration is pr_only', async () => {
    const door = new MockFrontDoor({ inspect: { completionPolicy: 'pr_only' } });
    const { h } = await boot({ door });
    await say(h, '$ticket --ready add a health endpoint');
    expect(cardText(cards(h).at(-1))).toMatch(/stops at a pull request and merges nothing/i);
    h.close();
  });

  it('says nothing about merging when nothing was queued', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    expect(cardText(cards(h).at(-1))).not.toMatch(/merge/i);
    h.close();
  });
});

describe('classification labels', () => {
  it('passes only the labels the owner named, and reports them verified', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket --label enhancement add a health endpoint');

    const publish = door.calls.find((c) => c.kind === 'publish')!;
    expect(publish.input['labels']).toEqual(['enhancement']);
    expect(cardText(cards(h).at(-1))).toMatch(/Classified enhancement, verified on the issue/);
    expect(cardText(cards(h).at(-1))).toMatch(/A classification authorizes nothing/);
    h.close();
  });

  it('passes none when the owner named none', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    expect(door.calls.find((c) => c.kind === 'publish')!.input['labels']).toEqual([]);
    h.close();
  });

  it('fails the run when a requested label was not verified', async () => {
    // The publisher reads its own labels back. A ticket reported as published
    // while a classification the owner asked for is missing would be a partial
    // success dressed as a whole one.
    const door = new MockFrontDoor({ publish: { classificationVerified: false } });
    const { h } = await boot({ door });
    const reply = await say(h, '$ticket --label enhancement add a health endpoint');

    expect(replyText(reply)).toMatch(/classification label you asked for was not verified/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.runStatus).toBe('failed');
    h.close();
  });
});
