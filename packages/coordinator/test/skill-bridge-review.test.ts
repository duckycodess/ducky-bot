import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockFrontDoor, NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION,
  type ConversationCapabilities, type ConversationProvider, type ConversationReply,
  type FrontDoorPort, type FrontDoorPublication,
} from '@ducky/adapters';
import { STALE_RUN_AFTER_MS } from '@ducky/contracts';
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

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const installedSkill = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'ducky-skills-'));
  temps.push(root);
  mkdirSync(path.join(root, 'grilling'), { recursive: true });
  const file = path.join(root, 'grilling', 'SKILL.md');
  writeFileSync(file, 'UPSTREAM GRILL METHOD: work the design tree in rounds.');
  return file;
};

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

const boot = async (opts: { door?: FrontDoorPort; allowlistJson?: string } = {}) => {
  const door = opts.door ?? new MockFrontDoor();
  const h = makeHarness({
    frontDoor: door,
    conversation: new VerifiedProvider(),
    ...(opts.allowlistJson ? { allowlistJson: opts.allowlistJson } : {}),
    env: {
      DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
      DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_GRILL_SKILL: installedSkill(),
    },
  });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, door: door as MockFrontDoor };
};

const say = (h: Awaited<ReturnType<typeof boot>>['h'], text: string) =>
  h.transport.dispatch({ kind: 'message', userId: OWNER, text, threadKey: 'dm-1' });

const cards = (h: Awaited<ReturnType<typeof boot>>['h']): OutboundMessage[] =>
  [...h.transport.cards.values()].map((c) => c.message);

const cardText = (m: OutboundMessage | undefined): string => JSON.stringify(m?.embeds ?? []);

const pressDetails = async (h: Awaited<ReturnType<typeof boot>>['h']) => {
  for (const card of [...cards(h)].reverse()) {
    const button = card.rows?.[0]?.buttons.find((b) => b.label === 'Details');
    if (button) {
      return h.transport.dispatch({
        kind: 'component', customId: controlId(button), userId: OWNER,
      });
    }
  }
  throw new Error('no Details control');
};

// --- finding 1 -------------------------------------------------------------

describe('a queue whose outcome is unknown is never reported as not queued', () => {
  /**
   * The installed publisher applies `agent:ready` and THEN reads it back. A
   * failure after that write -- a read-back error, a network fault, our own
   * subprocess timeout -- means the label may well be on the issue. Reporting
   * "nothing was queued" there is a false negative about the one label that
   * authorizes an agent to start work.
   */
  it('says the queue state is unknown when the publisher failed after --ready', async () => {
    const door = new MockFrontDoor({
      publish: {
        ok: false, queued: false, started: false, issue: 41,
        url: 'https://github.com/acme/demo/issues/41',
        error: 'agent:ready label verification failed; queue success unconfirmed',
      },
    });
    const { h } = await boot({ door });
    const reply = await say(h, '$ticket --ready add a health endpoint');

    expect(replyText(reply)).not.toMatch(/nothing was queued/i);
    expect(replyText(reply)).toMatch(/unknown|could not be confirmed|may have/i);
    expect(replyText(reply)).toMatch(/check/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('unknown');
    h.close();
  });

  it('says the same when the helper never answered at all', async () => {
    const door = new MockFrontDoor();
    door.publish = async (): Promise<FrontDoorPublication> => {
      throw new Error('subprocess timed out');
    };
    const { h } = await boot({ door });
    const reply = await say(h, '$ticket --ready add a health endpoint');

    expect(replyText(reply)).not.toMatch(/nothing was queued/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('unknown');
    h.close();
  });

  it('Details does not claim nothing is authorized when it cannot know', async () => {
    const door = new MockFrontDoor({
      publish: { ok: false, queued: false, started: false, error: 'read-back failed' },
    });
    const { h } = await boot({ door });
    await say(h, '$ticket --ready add a health endpoint');

    const details = await pressDetails(h);
    expect(cardText(details)).not.toMatch(/Nothing is authorized/);
    expect(cardText(details)).toMatch(/unknown|could not be confirmed/i);
    h.close();
  });

  it('still reports a true negative when the failure was before any label', async () => {
    // Validation refused it, so no issue and no label can exist.
    const door = new MockFrontDoor({ validate: { ok: false, error: 'Invalid TicketSpec' } });
    const { h } = await boot({ door });
    const reply = await say(h, '$ticket --ready add a health endpoint');

    expect(replyText(reply)).toMatch(/nothing was queued/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('not_queued');
    h.close();
  });

  it('reports not_requested when the owner never asked to queue', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('not_requested');
    h.close();
  });
});

// --- finding 2 + minor 7 ---------------------------------------------------

describe('a published ticket does not capture the next one', () => {
  it('starts a NEW issue for a different ticket after a successful publication', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const first = door.calls.filter((c) => c.kind === 'publish')[0]!.input;

    await say(h, '$ticket add a logout endpoint');
    const second = door.calls.filter((c) => c.kind === 'publish')[1]!.input;

    // Rewriting the first issue with a different contract is the defect.
    expect(second['issue']).toBeUndefined();
    expect(second['id']).not.toBe(first['id']);
    h.close();
  });

  it('still reuses the binding for a retry BEFORE a success', async () => {
    const door = new MockFrontDoor({
      publish: { ok: false, issue: 41, url: 'https://github.com/acme/demo/issues/41', error: 'transient' },
    });
    const { h } = await boot({ door });
    await say(h, '$ticket add a health endpoint');
    const first = door.calls.filter((c) => c.kind === 'publish')[0]!.input;

    await say(h, '$ticket add a health endpoint');
    const second = door.calls.filter((c) => c.kind === 'publish')[1]!.input;

    expect(second['id']).toBe(first['id']);
    // MINOR 7: a failure that still reported an issue must be remembered, or
    // the retry opens a second one.
    expect(second['issue']).toBe(41);
    h.close();
  });
});

// --- finding 4 -------------------------------------------------------------

describe('a run left behind by a crash does not block the thread forever', () => {
  it('expires a stale run and reports its outcome as unknown', async () => {
    const { h } = await boot();
    /**
     * A coordinator that died mid-publish leaves exactly this row.
     *
     * Started well beyond the staleness ceiling, expressed as a real offset
     * from now rather than a fixed date, so the test does not quietly stop
     * exercising expiry depending on what time of day it runs.
     */
    const longAgo = new Date(Date.now() - 10 * STALE_RUN_AFTER_MS).toISOString();
    h.store.agentThreads.ensure(OWNER, 'dm-1', longAgo);
    h.store.agentThreads.startRun(
      OWNER, 'dm-1',
      { runId: 'a00001', command: '$ticket', status: 'publishing', ready: true, detail: null },
      longAgo,
    );
    expect(h.store.agentThreads.liveRun(OWNER, 'dm-1')).toBeDefined();

    const reply = await say(h, '$ticket add a health endpoint');

    // The thread is usable again...
    expect(replyText(reply)).not.toMatch(/already in flight/i);
    // ...and the run that was abandoned is terminal, with an honest outcome.
    expect(h.store.agentThreads.byRunId(OWNER, 'a00001')).toBeUndefined();
    const stale = cards(h).find((c) => cardText(c).includes('a00001'));
    expect(cardText(stale)).toMatch(/unknown/i);
    h.close();
  });

  it('leaves a run that is merely slow alone', async () => {
    const { h } = await boot();
    h.store.agentThreads.startRun(
      OWNER, 'dm-1',
      { runId: 'a00002', command: '$ticket', status: 'publishing', ready: false, detail: null },
      new Date().toISOString(),
    );
    const reply = await say(h, '$agentize');
    expect(replyText(reply)).toMatch(/already in flight/i);
    h.close();
  });
});

// --- finding 5 -------------------------------------------------------------

describe('a repository is addressed explicitly or not at all', () => {
  it('does not rebind because prose mentions a slug', async () => {
    const { h, door } = await boot({ allowlistJson: TWO_REPOS });
    await say(h, '$ticket acme/demo add a health endpoint');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.repository).toBe('acme/demo');

    // "widgets" here is a word in a sentence, not a target.
    await say(h, '$ticket fix the widgets rendering in the parser');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.repository).toBe('acme/demo');
    expect(door.calls.filter((c) => c.kind === 'publish')[1]!.input['repository'])
      .toBe('acme/demo');
    h.close();
  });

  it('asks when prose names nothing and nothing is bound', async () => {
    const { h, door } = await boot({ allowlistJson: TWO_REPOS });
    const reply = await say(h, '$ticket fix the demo rendering bug');
    expect(replyText(reply)).toMatch(/which repository/i);
    expect(door.calls).toHaveLength(0);
    h.close();
  });

  it('accepts owner/name as the leading token, and keeps it out of the intent', async () => {
    const { h, door } = await boot({ allowlistJson: TWO_REPOS });
    await say(h, '$ticket acme/widgets add a health endpoint');

    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.repository).toBe('acme/widgets');
    // The target is addressing, not part of what the work IS.
    const validated = door.calls.find((c) => c.kind === 'validate')!;
    expect(validated.input['title']).not.toMatch(/acme\/widgets/);
    h.close();
  });
});
