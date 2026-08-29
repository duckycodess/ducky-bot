import { describe, expect, it } from 'vitest';
import { detectIntent } from '@ducky/contracts';
import { makeHarness, OWNER, CHAT } from './helpers.js';

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

describe('detecting a coding job', () => {
  it('requires the repository in the grammar itself', () => {
    /**
     * The rule that matters. "fix the login bug" names no repository, and there
     * is no safe way to pick one: an assistant that guessed would eventually
     * point a real agent with edit capability at the wrong working tree.
     */
    expect(detectIntent('fix the login bug')).toBeUndefined();
    expect(detectIntent('code something for me')).toBeUndefined();
    expect(detectIntent('implement in : do a thing')).toBeUndefined();

    const found = detectIntent('implement in demo: add a health endpoint');
    expect(found?.kind).toBe('job_submit');
    expect(found?.repo).toBe('demo');
    expect(found?.subject).toBe('add a health endpoint');
  });

  it('accepts the forms a person actually types', () => {
    for (const text of [
      'fix in demo: the flaky test',
      'work on in demo, the flaky test',
      'submit a coding job in demo: the flaky test',
      'start job in demo: the flaky test',
    ]) {
      expect(detectIntent(text)?.kind, text).toBe('job_submit');
    }
  });

  it('lowercases the slug to the form the allowlist uses', () => {
    expect(detectIntent('code in DEMO: something')?.repo).toBe('demo');
  });

  it('is a WRITE, so it can never apply on inference alone', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await say(h, 'implement in demo: add a health endpoint');

    expect(reply?.content).toMatch(/nothing is saved yet|reply \*\*yes\*\*/i);
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });
});

describe('confirming a coding job', () => {
  it('submits through JobsService only after an explicit yes', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));

    await say(h, 'implement in demo: add a health endpoint');
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);

    const confirmed = await say(h, 'yes');
    expect(confirmed?.content).toMatch(/submitted/i);

    const jobs = h.store.jobs.listRecent(OWNER, 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.repoSlug).toBe('demo');
    expect(jobs[0]!.task).toBe('add a health endpoint');
    // Submitted, not started: every existing gate is still in front of it.
    expect(['queued', 'waiting_for_executor']).toContain(jobs[0]!.state);
    h.close();
  });

  it('drops the proposal on no, and saves nothing', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    await say(h, 'implement in demo: add a health endpoint');
    const dropped = await say(h, 'no');
    expect(dropped?.content).toMatch(/dropped/i);
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });

  it('refuses a repository that is not configured, before asking to confirm', async () => {
    /**
     * Refused at proposal time, so the owner is never asked to confirm
     * something that would fail a moment later -- and the message says only
     * that it is not configured, never which repositories are.
     */
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await say(h, 'implement in nothing-here: add an endpoint');

    expect(reply?.content).toMatch(/not a configured repository/i);
    expect(reply?.content).not.toMatch(/demo|other/);
    await say(h, 'yes');
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });

  it('refuses a watch-only repository through the same gate as the command', async () => {
    // `allowJobs: false` is enforced by `JobsService.submit`, which is the
    // whole point of routing through it rather than around it.
    const h = makeHarness({
      allowlistJson: JSON.stringify({
        version: 1,
        repos: [
          { slug: 'demo', absolutePath: '/tmp/ducky-demo', defaultBranch: 'main' },
          { slug: 'watched', allowJobs: false, github: { owner: 'acme', repo: 'watched' } },
        ],
      }),
    });
    await h.transport.start((e) => h.app.router.handle(e));

    await say(h, 'implement in watched: add an endpoint');
    const confirmed = await say(h, 'yes');
    expect(confirmed?.content).toMatch(/not saved|read-only observation/i);
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
    h.close();
  });

  it('is unreachable by a non-owner', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await say(h, 'implement in demo: add an endpoint', undefined, CHAT);
    // Ordinary conversation, exactly as before.
    expect(reply?.content).not.toMatch(/nothing is saved yet/i);
    expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
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

  it('proposes a coding job in the coding channel', async () => {
    const h = await roleHarness();
    const reply = await say(h, 'implement in demo: add an endpoint', CODING);
    expect(reply?.content).toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('does not propose a coding job in the TASK channel', async () => {
    // A coding job is not a note, and the task channel is for notes.
    const h = await roleHarness();
    const reply = await say(h, 'implement in demo: add an endpoint', TASK);
    expect(reply?.content ?? '').not.toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('does not propose a task in the CODING channel', async () => {
    const h = await roleHarness();
    const reply = await say(h, 'i need to renew the domain', CODING);
    expect(reply?.content ?? '').not.toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('leaves the GPT channel entirely to the provider', async () => {
    /**
     * Deterministic rules intercepting ordinary sentences is the opposite of
     * what a GPT channel is for. Even a bare "yes" belongs to whichever channel
     * proposed something, not to this one.
     */
    const h = await roleHarness();
    const reply = await say(h, 'i need to renew the domain', GPT);
    expect(reply?.content ?? '').not.toMatch(/nothing is saved yet/i);
    h.close();
  });

  it('keeps every rule live in a DM and in an unconfigured channel', async () => {
    // Nothing an owner relies on stops working because they configured a
    // channel for something else.
    const h = await roleHarness();
    expect((await say(h, 'i need to renew the domain'))?.content).toMatch(/nothing is saved yet/i);
    expect(
      (await say(h, 'implement in demo: add an endpoint', '900000000000000099'))?.content,
    ).toMatch(/nothing is saved yet/i);
    h.close();
  });
});
