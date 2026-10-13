import { describe, expect, it } from 'vitest';
import { CHANNEL_ROLES, PROFILE_ENV } from '@ducky/contracts';
import { MockConversationProvider } from '@ducky/adapters';
import { ChannelRolePolicy, DELIVERY_ONLY_ROLES } from '../src/domain/channel-roles.js';
import { ReplyPersistencePolicy } from '../src/domain/reply-persistence.js';
import {
  loadEnv, resolveChannelRoles, resolveGitHubFeed, resolveThreadParentChannelIds,
} from '../src/config.js';
import { makeHarness, OWNER, replyText, secret } from './helpers.js';

const GITHUB = '900000000000000021';
const TASK = '900000000000000011';
const GPT = '900000000000000013';
const GUILD = '800000000000000001';
const CHAT = '100000000000000002';

const guild = (channelId: string): { channelId: string; guildId: string } => ({ channelId, guildId: GUILD });

const base = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OWNER_DISCORD_USER_ID: OWNER,
    DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
    DUCKY_PROD_COMPONENT_SIGNING_KEY: secret(),
    DUCKY_EXECUTOR_CREDENTIALS: '{"version":1,"executors":[]}',
    ...over,
  }) as NodeJS.ProcessEnv;

describe('the github channel role is profile-isolated', () => {
  it('has its own scoped name per profile and an unscoped development alias', () => {
    expect(CHANNEL_ROLES).toContain('github');
    expect(PROFILE_ENV.development.roleChannels.github).toBe('DUCKY_DEV_GITHUB_CHANNEL_ID');
    expect(PROFILE_ENV.production.roleChannels.github).toBe('DUCKY_PROD_GITHUB_CHANNEL_ID');
  });

  it('development reads its scoped name, then the unscoped alias', () => {
    const scoped = loadEnv(base({ DUCKY_PROFILE: 'development', DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB }));
    expect(resolveChannelRoles(scoped).github).toBe(GITHUB);
    const unscoped = loadEnv(base({ DUCKY_PROFILE: 'development', DUCKY_GITHUB_CHANNEL_ID: GITHUB }));
    expect(resolveChannelRoles(unscoped).github).toBe(GITHUB);
  });

  it('production reads ONLY its own name, never the unscoped or development one', () => {
    const env = loadEnv(base({
      DUCKY_PROFILE: 'production',
      DUCKY_GITHUB_CHANNEL_ID: GITHUB,
      DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB,
    }));
    expect(resolveChannelRoles(env).github).toBeUndefined();
    expect(resolveGitHubFeed(env).channelId).toBeUndefined();
    const own = loadEnv(base({ DUCKY_PROFILE: 'production', DUCKY_PROD_GITHUB_CHANNEL_ID: GITHUB }));
    expect(resolveChannelRoles(own).github).toBe(GITHUB);
  });

  it('refuses a value that is not a channel id, and a clash at boot', () => {
    expect(() => resolveChannelRoles(loadEnv(base({ DUCKY_DEV_GITHUB_CHANNEL_ID: 'updates' }))))
      .toThrow(/not a Discord channel id/i);
    expect(() => resolveChannelRoles(loadEnv(base({
      DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB, DUCKY_DEV_TASK_CHANNEL_ID: GITHUB,
    })))).toThrow(/same channel/i);
    expect(() => resolveChannelRoles(loadEnv(base({
      DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB, DUCKY_DEV_SHARED_CHANNEL_IDS: GITHUB,
    })))).toThrow(/cannot be both/i);
  });

  it('refuses the channel as a conversation-thread parent', () => {
    expect(() => resolveThreadParentChannelIds(loadEnv(base({
      DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB, DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS: GITHUB,
    })))).toThrow(/delivery only/i);
  });
});

describe('the github role is delivery only', () => {
  it('is the one entry on the delivery-only list', () => {
    expect(DELIVERY_ONLY_ROLES).toEqual(['github']);
    const roles = new ChannelRolePolicy({ github: GITHUB, task: TASK });
    expect(roles.isDeliveryOnly(guild(GITHUB))).toBe(true);
    expect(roles.isDeliveryOnly(guild(TASK))).toBe(false);
    // A DM never is, whatever its channel id happens to be.
    expect(roles.isDeliveryOnly({ channelId: GITHUB, guildId: undefined })).toBe(false);
    // A thread under it inherits the role.
    expect(roles.isDeliveryOnly({ ...guild('900000000000000099'), parentChannelId: GITHUB } as never)).toBe(true);
  });

  it('never makes an owner reply persist, where a task channel does', () => {
    const roles = new ChannelRolePolicy({ github: GITHUB, task: TASK });
    const policy = new ReplyPersistencePolicy(roles, OWNER);
    for (const kind of ['command', 'message', 'component'] as const) {
      expect(policy.persists({ userId: OWNER, context: guild(GITHUB), kind }), kind).toBe(false);
    }
    expect(policy.persists({ userId: OWNER, context: guild(TASK), kind: 'command' })).toBe(true);
  });

  it('keeps an owner command reply ephemeral there, end to end', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB, DUCKY_DEV_TASK_CHANNEL_ID: TASK } });
    await h.transport.start((e) => h.app.router.handle(e));
    const ask = (channelId: string) => h.transport.dispatch({
      kind: 'command', name: 'task', subcommand: 'list', userId: OWNER,
      context: guild(channelId), options: {},
    });
    expect((await ask(TASK))?.ephemeral).toBe(false);
    expect((await ask(GITHUB))?.ephemeral).toBe(true);
    h.close();
  });

  it('answers nothing typed there, writes nothing, starts no workflow and stores no turn', async () => {
    // Counts every turn it is asked to take, so "no model capacity spent" is a number.
    class Counting extends MockConversationProvider {
      turns = 0;
      override async reply(input: Parameters<MockConversationProvider['reply']>[0]) {
        this.turns += 1;
        return super.reply(input);
      }
    }
    const provider = new Counting();
    const h = makeHarness({
      env: {
        DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB,
        DUCKY_CONVERSATION_MEMORY_ENABLED: 'true',
      },
      conversation: provider,
    });
    await h.transport.start((e) => h.app.router.handle(e));
    const say = (userId: string, text: string) => h.transport.dispatch({
      kind: 'message', userId, text, threadKey: GITHUB, context: guild(GITHUB),
    });

    // A write intent, a repository workflow trigger, a pasted list and chat.
    for (const text of [
      'remind me to renew the domain tomorrow',
      'add a task to buy milk',
      '$ticket make the thing',
      '$grill-me about a thing',
      '1. first task by friday\n2. second task by monday',
      'hello there',
    ]) {
      expect(await say(OWNER, text), text).toBeUndefined();
      expect(await say(CHAT, text), `${text} (chat)`).toBeUndefined();
    }
    // Nothing was written anywhere a rule or a workflow could have written it.
    for (const table of ['tasks', 'captures', 'reminders', 'conversation_turns', 'jobs', 'agent_threads']) {
      expect(h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(provider.turns).toBe(0);
    h.close();
  });

  it('still answers the same message in an ordinary channel (the silence is the role)', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB } });
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: 'hello there', threadKey: '900000000000000055',
      context: guild('900000000000000055'),
    });
    expect(replyText(reply).length).toBeGreaterThan(0);
    h.close();
  });

  it('grants nothing: a non-owner command there is refused like anywhere else', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB } });
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'task', subcommand: 'list', userId: CHAT,
      context: guild(GITHUB), options: {},
    });
    expect(reply?.content).toMatch(/not authorized/i);
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('names the role in /status and says it is delivery only', () => {
    const h = makeHarness({ env: { DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB } });
    const s = h.app.status().channelRoles;
    expect(s).toContain('github');
    expect(s).toMatch(/delivery only/i);
    expect(s).not.toMatch(/replies persist/i);
    expect(s).not.toContain(GITHUB);
    h.close();
  });
});
