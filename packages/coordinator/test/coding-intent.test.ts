import { describe, expect, it } from 'vitest';
import { INTENT_KINDS, WRITE_INTENTS, detectIntent } from '@ducky/contracts';
import { makeHarness, OWNER, CHAT, replyText } from './helpers.js';

const CODING = '900000000000000012';
const TASK = '900000000000000011';
const GPT = '900000000000000013';
const GUILD = '800000000000000001';

const inChannel = (channelId: string) => ({ channelId, guildId: GUILD as string | undefined });

const say = (
  h: ReturnType<typeof makeHarness>,
  text: string,
  channelId?: string,
  userId = OWNER,
) =>
  h.transport.dispatch({
    kind: 'message',
    userId,
    text,
    threadKey: channelId ?? 'dm-1',
    ...(channelId ? { context: inChannel(channelId) } : {}),
  });

/**
 * The entry-point contract from issue #7, tested from the outside.
 *
 * Engineering work starts at `$grill-me`, `$ticket` and `$agentize` and
 * nowhere else. These tests exist to make the ABSENCE of a prose path
 * structural: a future rule that reintroduces one fails here rather than
 * shipping as a convenience.
 */
describe('prose cannot start engineering work', () => {
  it('has no job-submitting intent left in the rule table', () => {
    expect(INTENT_KINDS).not.toContain('job_submit');
    expect(WRITE_INTENTS).not.toContain('job_submit');
  });

  it('reads every old coding phrase as ordinary text', () => {
    for (const text of [
      'implement in demo: add a health endpoint',
      'code in demo: something',
      'fix in demo: the flaky test',
      'work on in demo, the flaky test',
      'submit a coding job in demo: the flaky test',
      'start job in demo: the flaky test',
      'implement this',
      'fix the login bug',
    ]) {
      expect(detectIntent(text), text).toBeUndefined();
    }
  });

  it('creates no job however the owner phrases it, and never asks to confirm one', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));

    const reply = await say(h, 'implement in demo: add a health endpoint');
    expect(replyText(reply)).not.toMatch(/nothing is saved yet/i);
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);

    // ...and a later bare "yes" has nothing to confirm, so it still creates
    // nothing. A stale affirmative must never find a coding proposal waiting.
    await say(h, 'yes');
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });

  it('is equally inert for a whitelist user', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    await say(h, 'implement in demo: add an endpoint', undefined, CHAT);
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });
});

describe('the personal-record rules are untouched', () => {
  it('still proposes a task and applies it only on an explicit yes', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));

    const proposal = await say(h, 'i need to renew the domain');
    expect(replyText(proposal)).toMatch(/nothing is saved yet/i);
    expect(h.store.tasks.listForOwner(OWNER, 'open', 10)).toHaveLength(0);

    await say(h, 'yes');
    expect(h.store.tasks.listForOwner(OWNER, 'open', 10)).toHaveLength(1);
    h.close();
  });
});

describe('a role narrows which rules may fire', () => {
  const roleHarness = async () => {
    const h = makeHarness({
      env: {
        DUCKY_DEV_CODING_CHANNEL_ID: CODING,
        DUCKY_DEV_TASK_CHANNEL_ID: TASK,
        DUCKY_DEV_GPT_CHANNEL_ID: GPT,
      },
    });
    await h.transport.start((e) => h.app.router.handle(e));
    return h;
  };

  it('fires no deterministic rule in the coding channel', async () => {
    /**
     * The coding channel is the repository-WORKFLOW channel now. The commands
     * that belong there are handled before the intent table is consulted, and
     * nothing else there means anything.
     */
    const h = await roleHarness();
    const reply = await say(h, 'i need to renew the domain', CODING);
    expect(replyText(reply)).not.toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('still proposes a task in the task channel', async () => {
    const h = await roleHarness();
    const reply = await say(h, 'i need to renew the domain', TASK);
    expect(replyText(reply)).toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('leaves the GPT channel entirely to the provider', async () => {
    const h = await roleHarness();
    const reply = await say(h, 'i need to renew the domain', GPT);
    expect(replyText(reply)).not.toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('keeps every rule live in a DM and in an unconfigured channel', async () => {
    const h = await roleHarness();
    expect((await say(h, 'i need to renew the domain'))?.content).toMatch(/nothing is saved yet/i);
    expect(
      (await say(h, 'remember: the deploy key rotates in March', '900000000000000099'))?.content,
    ).toMatch(/nothing is saved yet/i);
    h.close();
  });
});

describe('conversation is contained once a gpt channel exists', () => {
  const OTHER = '900000000000000099';

  it('answers everywhere when no gpt channel is configured', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    expect(await say(h, 'hello there')).toBeDefined();
    expect(await say(h, 'hello there', OTHER)).toBeDefined();
    h.close();
  });

  it('answers in the gpt channel and stays silent in other guild channels', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GPT_CHANNEL_ID: GPT } });
    await h.transport.start((e) => h.app.router.handle(e));

    expect(await say(h, 'hello there', GPT)).toBeDefined();
    expect(await say(h, 'hello there', OTHER)).toBeUndefined();
    h.close();
  });

  it('never silences a DM', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GPT_CHANNEL_ID: GPT } });
    await h.transport.start((e) => h.app.router.handle(e));
    expect(await say(h, 'hello there')).toBeDefined();
    h.close();
  });

  it('silences a non-owner in the same way', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GPT_CHANNEL_ID: GPT } });
    await h.transport.start((e) => h.app.router.handle(e));
    expect(await say(h, 'hello there', OTHER, CHAT)).toBeUndefined();
    expect(await say(h, 'hello there', GPT, CHAT)).toBeDefined();
    h.close();
  });

  it('leaves slash commands alone entirely', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GPT_CHANNEL_ID: GPT } });
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'command',
      name: 'status',
      userId: OWNER,
      context: inChannel(OTHER),
      options: {},
    });
    expect(reply).toBeDefined();
    h.close();
  });
});

describe('containment does not swallow the other role channels', () => {
  it('still answers task reads in the task channel while gpt is configured', async () => {
    const h = makeHarness({
      env: { DUCKY_DEV_TASK_CHANNEL_ID: TASK, DUCKY_DEV_GPT_CHANNEL_ID: GPT },
    });
    await h.transport.start((e) => h.app.router.handle(e));
    const proposal = await say(h, 'i need to renew the domain', TASK);
    expect(replyText(proposal)).toMatch(/nothing is saved yet/i);
    h.close();
  });
});
