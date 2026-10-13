import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockFrontDoor, NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION,
  type ConversationCapabilities, type ConversationProvider, type ConversationReply,
  type FrontDoorPort, type FrontDoorPublication,
} from '@ducky/adapters';
import { controlId, type OutboundMessage } from '../src/discord/message.js';
import { makeHarness, OWNER, replyText } from './helpers.js';

class VerifiedProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = true;
  readonly capabilities: ConversationCapabilities = { attachments: NO_ATTACHMENT_CAPABILITY, sessionDeletion: NO_SESSION_DELETION('test stand-in') };
  async reply(): Promise<ConversationReply> {
    return { text: 'Q1 - what is the smallest version of this?', mock: false };
  }
}

/**
 * A publisher that BLOCKS until the test releases it.
 *
 * The whole class of defect here lives in the window between "the owner
 * pressed Cancel" and "the helper came back", and that window cannot be
 * observed with a helper that answers instantly.
 */
class BlockingFrontDoor extends MockFrontDoor {
  #release: (() => void) | undefined;
  readonly entered: Promise<void>;
  #entered!: () => void;

  constructor(private readonly onPublish?: (p: FrontDoorPublication) => FrontDoorPublication) {
    super();
    this.entered = new Promise<void>((resolve) => {
      this.#entered = resolve;
    });
  }

  release(): void {
    this.#release?.();
  }

  override async publish(
    input: Parameters<FrontDoorPort['publish']>[0],
  ): Promise<FrontDoorPublication> {
    const held = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    this.#entered();
    await held;
    const result = await super.publish(input);
    return this.onPublish ? this.onPublish(result) : result;
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real installed skill on disk.
 *
 * `$grill-me` fails closed without one, so a suite that drives a grill has to
 * supply the method rather than relying on a fallback -- which is the point of
 * the fail-closed change and is worth a suite having to notice.
 */
const installedSkill = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'ducky-skills-'));
  temps.push(root);
  mkdirSync(path.join(root, 'grilling'), { recursive: true });
  const file = path.join(root, 'grilling', 'SKILL.md');
  writeFileSync(file, 'UPSTREAM GRILL METHOD: work the design tree in rounds.');
  return file;
};

const boot = async (door: FrontDoorPort) => {
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
  return h;
};

const say = (h: Awaited<ReturnType<typeof boot>>, text: string) =>
  h.transport.dispatch({ kind: 'message', userId: OWNER, text, threadKey: 'dm-1' });

const cards = (h: Awaited<ReturnType<typeof boot>>): OutboundMessage[] =>
  [...h.transport.cards.values()].map((c) => c.message);

const cardText = (m: OutboundMessage | undefined): string => JSON.stringify(m?.embeds ?? []);

const liveCancelId = (h: Awaited<ReturnType<typeof boot>>): string => {
  for (const card of [...cards(h)].reverse()) {
    const button = card.rows?.[0]?.buttons.find((b) => b.label === 'Cancel');
    if (button) return controlId(button);
  }
  throw new Error('no live Cancel control on any card');
};

describe('cancelling a run that is already in flight', () => {
  it('never reports success for a run the owner cancelled', async () => {
    const door = new BlockingFrontDoor();
    const h = await boot(door);

    const publishing = say(h, '$ticket --ready add a health endpoint');
    await door.entered;

    const cancelled = await h.transport.dispatch({
      kind: 'component', customId: liveCancelId(h), userId: OWNER,
    });
    expect(replyText(cancelled)).toMatch(/cancelled/i);

    door.release();
    await publishing;

    const row = h.store.agentThreads.get(OWNER, 'dm-1')!;
    // The cancellation stands. A run the owner stopped must not come back as
    // queued because a subprocess happened to finish afterwards.
    expect(row.runStatus).toBe('cancelled');
    expect(row.queueState).not.toBe('queued');
    for (const card of cards(h)) {
      expect(cardText(card)).not.toMatch(/Queued for implementation/);
    }
    h.close();
  });

  it('still tells the owner what the publisher had already done', async () => {
    const door = new BlockingFrontDoor();
    const h = await boot(door);

    const publishing = say(h, '$ticket add a health endpoint');
    await door.entered;
    await h.transport.dispatch({
      kind: 'component', customId: liveCancelId(h), userId: OWNER,
    });
    door.release();
    const reply = await publishing;

    // Silence here would be the other half of the lie: the issue exists.
    expect(replyText(reply)).toMatch(/already created|had already/i);
    expect(replyText(reply)).toContain('https://github.com/acme/demo/issues/41');
    // ...and the thread remembers it, so a retry enriches rather than
    // opening a second issue.
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.issueNumber).toBe(41);
    h.close();
  });

  it('does not run the bookkeeping that belongs to a successful publication', async () => {
    const door = new BlockingFrontDoor();
    const h = await boot(door);

    // Settle some intent first, so there is something a cancelled run could
    // wrongly throw away.
    await say(h, '$grill-me the retry policy');
    await say(h, 'three attempts, then stop');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.intentNotes).toHaveLength(2);

    const publishing = say(h, '$ticket');
    await door.entered;
    await h.transport.dispatch({
      kind: 'component', customId: liveCancelId(h), userId: OWNER,
    });
    door.release();
    await publishing;

    /**
     * Clearing the notes is what a SETTLED ticket does. A run the owner
     * stopped must not do it, or the intent they spent a grill establishing
     * is gone and the next `$ticket` has nothing to describe.
     */
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.intentNotes).toHaveLength(2);
    h.close();
  });
});

describe('one run at a time per thread', () => {
  it('refuses a second command while one is still in flight', async () => {
    const door = new BlockingFrontDoor();
    const h = await boot(door);

    const first = say(h, '$ticket add a health endpoint');
    await door.entered;

    const second = await say(h, '$agentize');
    expect(replyText(second)).toMatch(/already running|still running|in flight/i);
    // The in-flight run still owns the thread.
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.runCommand).toBe('$ticket');
    expect(door.calls.some((c) => c.kind === 'agentize')).toBe(false);

    door.release();
    await first;
    h.close();
  });

  it('never attaches one run\'s issue to another run\'s thread', async () => {
    const door = new BlockingFrontDoor();
    const h = await boot(door);

    const first = say(h, '$ticket add a health endpoint');
    await door.entered;
    // Cancel frees the thread, so a second command may start...
    await h.transport.dispatch({
      kind: 'component', customId: liveCancelId(h), userId: OWNER,
    });
    await say(h, '$grill-me the retry policy');
    const grillRunId = h.store.agentThreads.get(OWNER, 'dm-1')!.runId;

    // ...and the first run finishing afterwards must not move the card the
    // grill now owns.
    door.release();
    await first;

    const row = h.store.agentThreads.get(OWNER, 'dm-1')!;
    expect(row.runId).toBe(grillRunId);
    expect(row.runCommand).toBe('$grill-me');
    expect(row.runStatus).toBe('grilling');
    /**
     * And the publication the cancelled run completed must not be written
     * onto the thread the GRILL now owns. An issue number landing on a run
     * that never published one is how a later retry enriches the wrong issue.
     */
    expect(row.issueNumber).toBeNull();
    expect(row.issueUrl).toBeNull();
    h.close();
  });
});
