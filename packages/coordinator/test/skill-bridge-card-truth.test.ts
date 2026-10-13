import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockFrontDoor, NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION,
  type ConversationCapabilities, type ConversationProvider, type ConversationReply,
} from '@ducky/adapters';
import { isLinkButton, type OutboundMessage } from '../src/discord/message.js';
import { makeHarness, OWNER } from './helpers.js';

class VerifiedProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = true;
  readonly capabilities: ConversationCapabilities = { attachments: NO_ATTACHMENT_CAPABILITY, sessionDeletion: NO_SESSION_DELETION('test stand-in') };
  async reply(): Promise<ConversationReply> {
    return { text: 'Q1', mock: false };
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const installedSkill = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'ducky-skills-'));
  temps.push(root);
  mkdirSync(path.join(root, 'grilling'), { recursive: true });
  const file = path.join(root, 'grilling', 'SKILL.md');
  writeFileSync(file, 'UPSTREAM GRILL METHOD: rounds on a design tree.');
  return file;
};

const boot = async (door = new MockFrontDoor()) => {
  const h = makeHarness({
    frontDoor: door,
    conversation: new VerifiedProvider(),
    env: {
      DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
      DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_GRILL_SKILL: installedSkill(),
    },
  });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, door };
};

const say = (h: Awaited<ReturnType<typeof boot>>['h'], text: string) =>
  h.transport.dispatch({ kind: 'message', userId: OWNER, text, threadKey: 'dm-1' });

const cards = (h: Awaited<ReturnType<typeof boot>>['h']): OutboundMessage[] =>
  [...h.transport.cards.values()].map((c) => c.message);

const lastCard = (h: Awaited<ReturnType<typeof boot>>['h']): OutboundMessage =>
  cards(h).at(-1)!;

const cardText = (m: OutboundMessage | undefined): string => JSON.stringify(m?.embeds ?? []);

/**
 * The card is the DURABLE record. The Details view is a thing the owner has to
 * press for; the card is what sits in the channel afterwards and what they
 * read six hours later. If the two disagree, the card is the one that misleads.
 */
describe('a card never contradicts what is known about the queue', () => {
  it('does not say nothing was queued when the queue state is unknown', async () => {
    const door = new MockFrontDoor({
      publish: {
        ok: false, queued: false, started: false, issue: 41,
        url: 'https://github.com/acme/demo/issues/41',
        error: 'agent:ready label verification failed; queue success unconfirmed',
      },
    });
    const { h } = await boot(door);
    await say(h, '$ticket --ready add a health endpoint');

    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('unknown');
    const text = cardText(lastCard(h));
    expect(text).not.toMatch(/Nothing was queued/i);
    expect(text).toMatch(/unknown/i);
    expect(text).toMatch(/check/i);
    h.close();
  });

  it('still says nothing was queued when that is actually true', async () => {
    const door = new MockFrontDoor({ validate: { ok: false, error: 'Invalid TicketSpec' } });
    const { h } = await boot(door);
    await say(h, '$ticket --ready add a health endpoint');

    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('not_queued');
    expect(cardText(lastCard(h))).toMatch(/Nothing was queued/i);
    h.close();
  });

  it('agrees with the Details view it sits beside', async () => {
    const door = new MockFrontDoor({
      publish: { ok: false, queued: false, started: false, error: 'read-back failed' },
    });
    const { h } = await boot(door);
    await say(h, '$ticket --ready add a health endpoint');

    const details = lastCard(h).rows?.[0]?.buttons.find((b) => b.label === 'Details')!;
    const shown = await h.transport.dispatch({
      kind: 'component',
      customId: 'customId' in details ? details.customId : '',
      userId: OWNER,
    });
    // Both surfaces, one answer.
    for (const text of [cardText(lastCard(h)), cardText(shown)]) {
      expect(text).toMatch(/unknown/i);
      expect(text).not.toMatch(/Nothing was queued/i);
    }
    h.close();
  });
});

/**
 * The owner is told what queueing can END in at the moment they queue. The
 * two-step reaches the same place by a different route, so it has to carry
 * the same warning: a policy stated only on one path is a policy the owner
 * learns about by accident.
 */
describe('the two-step authorization warns about the merge policy too', () => {
  it('warns when the registration permits the dispatcher to merge', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket --ready');

    expect(cardText(lastCard(h))).toMatch(/may merge the resulting pull request automatically/i);
    h.close();
  });

  it('says pr_only when that is what the registration carries', async () => {
    const door = new MockFrontDoor({ inspect: { completionPolicy: 'pr_only' } });
    const { h } = await boot(door);
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket --ready');

    expect(cardText(lastCard(h))).toMatch(/stops at a pull request and merges nothing/i);
    h.close();
  });

  it('says nothing about merging when the authorization did not complete', async () => {
    const door = new MockFrontDoor();
    const { h } = await boot(door);
    await say(h, '$ticket add a health endpoint');
    door.script.publish = { ok: false, queued: false, started: false, error: 'boom' };
    await say(h, '$ticket --ready');

    expect(cardText(lastCard(h))).not.toMatch(/may merge the resulting/i);
    h.close();
  });
});

describe('a card links only to the issue its own run touched', () => {
  it('does not inherit the previous run\'s View issue link', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    const published = lastCard(h);
    expect(published.rows?.[0]?.buttons.some(isLinkButton)).toBe(true);

    // A later, unrelated run in the same thread.
    await say(h, '$grill-me the retry policy');

    const grill = lastCard(h);
    const link = grill.rows?.[0]?.buttons.find(isLinkButton);
    expect(link).toBeUndefined();
    // ...and it does not claim an issue number either.
    expect(cardText(grill)).not.toMatch(/#41/);
    h.close();
  });

  it('still shows the link on the run that produced it', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    const link = lastCard(h).rows?.[0]?.buttons.find(isLinkButton);
    expect(link && isLinkButton(link) ? link.url : '')
      .toBe('https://github.com/acme/demo/issues/41');
    h.close();
  });

  it('keeps the issue binding a retry needs, even with no link to show', async () => {
    const door = new MockFrontDoor({
      publish: { ok: false, issue: 41, url: 'https://github.com/acme/demo/issues/41', error: 'transient' },
    });
    const { h } = await boot(door);
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket add a health endpoint');

    // The retry enriches the same issue: display and binding are different
    // questions, and fixing the first must not break the second.
    const retried = door.calls.filter((c) => c.kind === 'publish')[1]!;
    expect(retried.input['issue']).toBe(41);
    h.close();
  });
});

/**
 * The card's controls are an explicit acceptance criterion: Details, View
 * issue and Cancel, as REAL buttons. The two-step reaches a queued ticket by
 * a different route from the single step, so its card has to carry the same
 * controls -- a link that exists on one path and not the other is the owner
 * discovering the difference by its absence.
 */
describe('the two-step card carries the same controls as the single step', () => {
  const buttonLabels = (m: OutboundMessage): string[] =>
    (m.rows?.[0]?.buttons ?? []).map((b) => b.label);

  const linkUrl = (m: OutboundMessage): string | undefined => {
    const link = m.rows?.[0]?.buttons.find(isLinkButton);
    return link && isLinkButton(link) ? link.url : undefined;
  };

  it('links the issue it just authorized', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket --ready');

    const card = lastCard(h);
    expect(buttonLabels(card)).toContain('Details');
    expect(buttonLabels(card)).toContain('View issue');
    expect(linkUrl(card)).toBe('https://github.com/acme/demo/issues/41');
    // A finished run has nothing left to cancel.
    expect(buttonLabels(card)).not.toContain('Cancel');
    // ...and it names the issue it acted on.
    expect(cardText(card)).toMatch(/#41/);
    h.close();
  });

  it('links from the already-authorized notice', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket --ready add a health endpoint');

    await say(h, '$ticket --ready');

    // Re-applying a verified label is a GitHub write with nothing to gain.
    // A read-only scan still runs -- that is how the card knows the current
    // merge policy -- so it is PUBLISHES that must not grow.
    expect(door.calls.filter((c) => c.kind === 'publish')).toHaveLength(1);
    expect(linkUrl(lastCard(h))).toBe('https://github.com/acme/demo/issues/41');
    h.close();
  });

  it('links from the notice that a bare $ticket gives', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket');

    expect(linkUrl(lastCard(h))).toBe('https://github.com/acme/demo/issues/41');
    h.close();
  });

  it('does not carry the link into an unrelated later run', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket --ready');
    expect(linkUrl(lastCard(h))).toBeDefined();

    await say(h, '$grill-me the retry policy');

    expect(linkUrl(lastCard(h))).toBeUndefined();
    expect(cardText(lastCard(h))).not.toMatch(/#41/);
    h.close();
  });

  it('leaves no retry binding behind after authorizing', async () => {
    // The binding means "this attempt has not landed". It has.
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    await say(h, '$ticket --ready');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.issueNumber).toBeNull();

    await say(h, '$ticket add a logout endpoint');
    const latest = door.calls.filter((c) => c.kind === 'publish').at(-1)!;
    expect(latest.input['issue']).toBeUndefined();
    h.close();
  });
});
