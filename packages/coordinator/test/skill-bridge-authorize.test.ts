import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockFrontDoor, NO_ATTACHMENT_CAPABILITY,
  type ConversationCapabilities, type ConversationProvider, type ConversationReply,
  type FrontDoorPort,
} from '@ducky/adapters';
import { createStore, openDatabase, runMigrations, type Store } from '@ducky/persistence';
import { makeHarness, OWNER, replyText } from './helpers.js';

class VerifiedProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = true;
  readonly capabilities: ConversationCapabilities = { attachments: NO_ATTACHMENT_CAPABILITY };
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

/**
 * A harness that can be torn down and rebuilt on the SAME database, which is
 * what a coordinator restart looks like from the outside.
 */
const boot = async (opts: { door?: FrontDoorPort; store?: Store } = {}) => {
  const door = opts.door ?? new MockFrontDoor();
  const h = makeHarness({
    frontDoor: door,
    conversation: new VerifiedProvider(),
    ...(opts.store ? { store: opts.store } : {}),
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

const publishes = (door: MockFrontDoor) => door.calls.filter((c) => c.kind === 'publish');

/**
 * The two-step the issue requires: a bare `$ticket` creates unqueued GitHub
 * work, and `$ticket --ready` SEPARATELY authorizes queueing. The second step
 * has to reach the issue the first one made -- the same canonical id, the
 * same spec, the same issue -- or the owner is retyping a settled ticket and
 * minting a duplicate.
 */
describe('authorizing the ticket this thread just published', () => {
  it('queues the existing canonical issue, with no new issue and no new id', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const created = publishes(door)[0]!.input;
    expect(created['ready']).toBe(false);

    const reply = await say(h, '$ticket --ready');

    const authorized = publishes(door)[1]!;
    expect(authorized.input['ready']).toBe(true);
    // The SAME canonical ticket, not a second one.
    expect(authorized.input['id']).toBe(created['id']);
    expect(authorized.input['issue']).toBe(41);
    expect(replyText(reply)).toMatch(/queued/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('queued');
    h.close();
  });

  it('sends the publisher the original spec, not a rebuilt one', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint for the load balancer');
    const created = door.calls.find((c) => c.kind === 'validate')!.input;

    await say(h, '$ticket --ready');
    const reValidated = door.calls.filter((c) => c.kind === 'validate')[1]!.input;

    // Byte-for-byte the settled contract. The helper refuses to change the
    // execution contract of an authorized issue, so anything else would fail.
    expect(reValidated['title']).toBe(created['title']);
    expect(reValidated['goal']).toBe(created['goal']);
    expect(reValidated['acceptance_criteria']).toEqual(created['acceptance_criteria']);
    h.close();
  });

  it('survives a restart, because the settled ticket is on disk', async () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    const store = createStore(db);

    const first = await boot({ store });
    await say(first.h, '$ticket add a health endpoint');
    const created = publishes(first.door)[0]!.input;

    // A new coordinator over the same database: new service, new in-memory
    // everything, same rows.
    const second = await boot({ store });
    await say(second.h, '$ticket --ready');

    const authorized = publishes(second.door)[0]!;
    expect(authorized.input['ready']).toBe(true);
    expect(authorized.input['id']).toBe(created['id']);
    expect(authorized.input['issue']).toBe(41);
    db.close();
  });

  it('is never implicit: a bare $ticket authorizes nothing', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');

    const reply = await say(h, '$ticket');

    // No second publish at all, and the reply points at the explicit step.
    expect(publishes(door)).toHaveLength(1);
    expect(replyText(reply)).toMatch(/--ready/);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).not.toBe('queued');
    h.close();
  });

  it('says so plainly when it is already queued, and publishes nothing', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket --ready add a health endpoint');
    expect(publishes(door)).toHaveLength(1);

    const reply = await say(h, '$ticket --ready');
    expect(publishes(door)).toHaveLength(1);
    expect(replyText(reply)).toMatch(/already (queued|authorized)/i);
    h.close();
  });
});

describe('a different ticket is a different ticket', () => {
  it('mints a new canonical id and a new issue when the intent is new', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const created = publishes(door)[0]!.input;

    await say(h, '$ticket add a logout endpoint');
    const second = publishes(door)[1]!.input;

    expect(second['id']).not.toBe(created['id']);
    expect(second['issue']).toBeUndefined();
    h.close();
  });

  it('treats new settled intent as a new ticket even with --ready', async () => {
    /**
     * The authorize step is the NO-ARGUMENT form. Once the owner has said
     * something new -- in the command or in a grill -- there is a new ticket
     * to make, and silently queueing it onto the previous issue would rewrite
     * a contract somebody may already be acting on.
     */
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const created = publishes(door)[0]!.input;

    await say(h, '$ticket --ready add a logout endpoint');
    const second = publishes(door)[1]!.input;

    expect(second['ready']).toBe(true);
    expect(second['id']).not.toBe(created['id']);
    expect(second['issue']).toBeUndefined();
    h.close();
  });

  it('prefers new grill notes over the settled ticket', async () => {
    const { h, door } = await boot();
    await say(h, '$ticket add a health endpoint');
    const created = publishes(door)[0]!.input;

    await say(h, '$grill-me');
    await say(h, 'the logout path needs a redirect');
    await say(h, '$ticket --ready');

    const second = publishes(door)[1]!.input;
    expect(second['id']).not.toBe(created['id']);
    expect(second['issue']).toBeUndefined();
    h.close();
  });
});

describe('a failed authorization can be retried', () => {
  it('keeps the settled ticket when authorizing fails, and reports unknown', async () => {
    const door = new MockFrontDoor();
    const { h } = await boot({ door });
    await say(h, '$ticket add a health endpoint');
    const created = publishes(door)[0]!.input;

    // The authorization attempt fails after the label write.
    door.script.publish = {
      ok: false, queued: false, started: false, issue: 41,
      url: 'https://github.com/acme/demo/issues/41',
      error: 'agent:ready label verification failed; queue success unconfirmed',
    };
    const failed = await say(h, '$ticket --ready');
    expect(replyText(failed)).not.toMatch(/nothing was queued/i);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.queueState).toBe('unknown');

    // ...and the SAME authorization can be tried again, unchanged.
    door.script.publish = undefined;
    await say(h, '$ticket --ready');
    const retried = publishes(door)[2]!;
    expect(retried.input['ready']).toBe(true);
    expect(retried.input['id']).toBe(created['id']);
    expect(retried.input['issue']).toBe(41);
    h.close();
  });
});

describe('the settled ticket belongs to its own repository', () => {
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

  it('does not authorize the previous repository\'s issue after a rebind', async () => {
    const door = new MockFrontDoor();
    const h = makeHarness({
      frontDoor: door,
      conversation: new VerifiedProvider(),
      allowlistJson: TWO_REPOS,
      env: {
        DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
        DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
        DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
        DUCKY_DEV_WORKFLOW_GRILL_SKILL: installedSkill(),
      },
    });
    await h.transport.start((e) => h.app.router.handle(e));

    await say(h, '$ticket acme/demo add a health endpoint');
    expect(publishes(door)).toHaveLength(1);

    // The thread moves to another repository, then asks to authorize.
    const reply = await say(h, '$ticket acme/widgets --ready');

    // Whatever it does, it must not queue acme/demo's issue from here.
    for (const call of publishes(door).slice(1)) {
      expect(call.input['issue']).toBeUndefined();
    }
    expect(replyText(reply)).not.toMatch(/acme\/demo/);
    h.close();
  });
});

describe('the settled ticket is the owner\'s own data', () => {
  it('goes with /forget conversation, like every other stored word', async () => {
    const { h } = await boot();
    await say(h, '$ticket add a health endpoint');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')!.publishedSpec).not.toBeNull();

    await h.transport.dispatch({
      kind: 'command', name: 'forget', userId: OWNER, options: { target: 'conversation' },
    });
    expect(h.store.agentThreads.get(OWNER, 'dm-1')).toBeUndefined();
    h.close();
  });
});
