import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_ROLES } from '@ducky/contracts';
import {
  ChannelRolePolicy, assertNoChannelRoleConflicts,
} from '../src/domain/channel-roles.js';
import { makeHarness, OWNER } from './helpers.js';

const BRIEFING = '900000000000000010';
const TASK = '900000000000000011';
const CODING = '900000000000000012';
const GPT = '900000000000000013';
const GUILD = '800000000000000001';

const guild = (channelId: string): { channelId: string; guildId: string | undefined } =>
  ({ channelId, guildId: GUILD });
const dm = (channelId: string): { channelId: string; guildId: string | undefined } =>
  ({ channelId, guildId: undefined });

describe('the channel role policy', () => {
  const policy = new ChannelRolePolicy({
    briefing: BRIEFING, task: TASK, coding: CODING, gpt: GPT,
  });

  it('maps a configured guild channel to its role', () => {
    expect(policy.roleOf(guild(BRIEFING))).toBe('briefing');
    expect(policy.roleOf(guild(TASK))).toBe('task');
    expect(policy.roleOf(guild(CODING))).toBe('coding');
    expect(policy.roleOf(guild(GPT))).toBe('gpt');
    expect(policy.channelFor('gpt')).toBe(GPT);
  });

  it('fails closed on every ambiguous case', () => {
    // The same list `SharedChannelPolicy` refuses, for the same reasons.
    expect(policy.roleOf(undefined)).toBeUndefined();
    expect(policy.roleOf(guild('900000000000000099'))).toBeUndefined();
    expect(policy.roleOf({ channelId: undefined, guildId: GUILD })).toBeUndefined();
    // A DM channel has an id like any other. Matching on channel id alone
    // would let a configured role collide with a private conversation.
    expect(policy.roleOf(dm(BRIEFING))).toBeUndefined();
  });

  it('is off entirely when nothing is configured', () => {
    const empty = new ChannelRolePolicy();
    expect(empty.enabled).toBe(false);
    expect(empty.configured).toEqual([]);
    for (const role of CHANNEL_ROLES) expect(empty.channelFor(role)).toBeUndefined();
    expect(empty.roleOf(guild(BRIEFING))).toBeUndefined();
  });

  it('treats an empty string as unconfigured, not as a channel', () => {
    const blank = new ChannelRolePolicy({ briefing: '', task: TASK });
    expect(blank.channelFor('briefing')).toBeUndefined();
    expect(blank.channelFor('task')).toBe(TASK);
  });
});

describe('conflicting configuration is refused at boot', () => {
  const nameOf = (role: string): string => `DUCKY_DEV_${role.toUpperCase()}_CHANNEL_ID`;

  it('refuses a channel that is both a role and a shared channel', () => {
    /**
     * The collision that matters. Shared means other people read a narrow
     * projection; role means the owner's replies persist in full. Resolving it
     * by precedence would put the owner's whole task list in a channel
     * somebody configured for coarse job status, silently.
     */
    expect(() =>
      assertNoChannelRoleConflicts({ task: TASK }, [TASK], nameOf as never),
    ).toThrow(/cannot be both/i);
  });

  it('refuses one channel serving two roles', () => {
    // Not dangerous, but certainly a typo -- and one that would send briefings
    // to the coding channel forever without anybody noticing.
    expect(() =>
      assertNoChannelRoleConflicts({ task: TASK, coding: TASK }, [], nameOf as never),
    ).toThrow(/same channel/i);
  });

  it('accepts a clean configuration', () => {
    expect(() =>
      assertNoChannelRoleConflicts(
        { briefing: BRIEFING, task: TASK, coding: CODING, gpt: GPT },
        ['900000000000000098'],
        nameOf as never,
      ),
    ).not.toThrow();
  });
});

describe('role configuration through the app', () => {
  it('resolves the scoped development names', () => {
    const h = makeHarness({
      env: {
        DUCKY_DEV_BRIEFING_CHANNEL_ID: BRIEFING,
        DUCKY_DEV_GPT_CHANNEL_ID: GPT,
      },
    });
    expect(h.app.channelRoles.channelFor('briefing')).toBe(BRIEFING);
    expect(h.app.channelRoles.channelFor('gpt')).toBe(GPT);
    expect(h.app.channelRoles.channelFor('task')).toBeUndefined();
    h.close();
  });

  it('accepts the unscoped name on a development box', () => {
    const h = makeHarness({ env: { DUCKY_TASK_CHANNEL_ID: TASK } });
    expect(h.app.channelRoles.channelFor('task')).toBe(TASK);
    h.close();
  });

  it('refuses a value that is not a channel id', () => {
    expect(() => makeHarness({ env: { DUCKY_DEV_TASK_CHANNEL_ID: 'the-tasks-channel' } }))
      .toThrow(/not a Discord channel id/i);
  });

  it('refuses a role/shared overlap at boot', () => {
    expect(() =>
      makeHarness({
        env: {
          DUCKY_DEV_SHARED_CHANNEL_IDS: TASK,
          DUCKY_DEV_TASK_CHANNEL_ID: TASK,
        },
      }),
    ).toThrow(/cannot be both/i);
  });

  it('reports configured roles in /status by NAME, not by id', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_TASK_CHANNEL_ID: TASK } });
    const status = h.app.status();
    expect(status.channelRoles).toContain('task');
    // `/status` is a health readout, not a configuration dump.
    expect(status.channelRoles).not.toContain(TASK);
    h.close();
  });

  it('says plainly when nothing is configured', () => {
    const h = makeHarness();
    expect(h.app.status().channelRoles).toMatch(/none configured/i);
    h.close();
  });
});

describe('a role grants nobody anything', () => {
  it('still refuses a non-owner an owner-only command in a role channel', async () => {
    /**
     * The property the whole design rests on. A role decides where output
     * belongs and whether it persists; `Authorizer` decides who may act, from
     * frozen configuration, exactly as before.
     */
    const h = makeHarness({ env: { DUCKY_DEV_TASK_CHANNEL_ID: TASK } });
    await h.transport.start((e) => h.app.router.handle(e));

    const reply = await h.transport.dispatch({
      kind: 'command',
      name: 'task',
      subcommand: 'list',
      userId: '100000000000000002', // the chat whitelist, not the owner
      context: { channelId: TASK, guildId: GUILD },
      options: {},
    });
    expect(reply?.content).toMatch(/not authorized/i);
    // And the refusal stays ephemeral: a refusal is not owner output.
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('does not make an owner-only command reachable from a role channel', async () => {
    const h = makeHarness({ env: { DUCKY_DEV_TASK_CHANNEL_ID: TASK } });
    await h.transport.start((e) => h.app.router.handle(e));

    const reply = await h.transport.dispatch({
      kind: 'command',
      name: 'task',
      subcommand: 'list',
      userId: OWNER,
      context: { channelId: TASK, guildId: GUILD },
      options: {},
    });
    // The owner gets their tasks, as they always did.
    expect(reply).toBeDefined();
    h.close();
  });
});

describe('persistent replies, and only in a role channel', () => {
  const bootWithRole = async () => {
    const h = makeHarness({ env: { DUCKY_DEV_TASK_CHANNEL_ID: TASK } });
    await h.transport.start((e) => h.app.router.handle(e));
    return h;
  };

  const taskList = (context?: { channelId: string; guildId: string | undefined }) => ({
    kind: 'command' as const,
    name: 'task',
    subcommand: 'list',
    userId: OWNER,
    ...(context ? { context } : {}),
    options: {},
  });

  it('persists the owner reply in the configured role channel', async () => {
    const h = await bootWithRole();
    const reply = await h.transport.dispatch(taskList(guild(TASK)));
    expect(reply?.ephemeral).toBe(false);
    h.close();
  });

  it('keeps an UNCONFIGURED guild channel ephemeral', async () => {
    // The conservative default the whole feature is measured against.
    const h = await bootWithRole();
    const reply = await h.transport.dispatch(taskList(guild('900000000000000077')));
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('leaves a request with no context ephemeral', async () => {
    const h = await bootWithRole();
    const reply = await h.transport.dispatch(taskList());
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('never persists for a non-owner, even in the role channel', async () => {
    const h = await bootWithRole();
    const reply = await h.transport.dispatch({
      ...taskList(guild(TASK)),
      userId: '100000000000000002',
    });
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('can only REMOVE ephemerality, never add it', async () => {
    /**
     * The direction of the rule matters as much as the rule. A presenter that
     * deliberately chose a visible reply must not be made ephemeral by a
     * channel setting -- so the boundary only ever downgrades.
     */
    const h = await bootWithRole();
    // `/briefing` is already non-ephemeral where it is delivered; a role
    // channel leaves it exactly as the presenter chose.
    const reply = await h.transport.dispatch({
      kind: 'command',
      name: 'briefing',
      userId: OWNER,
      context: guild(TASK),
      options: {},
    });
    expect(reply?.ephemeral).toBe(false);
    h.close();
  });

  it('keeps the /forget confirm step ephemeral, by documented exception', async () => {
    /**
     * The one exemption. Not because the signature is weak -- it refuses
     * anybody but the owner, like every other control -- but because a durable
     * one-press DELETE in scrollback is a different class of object from a task
     * list, and the owner is the one who scrolls back through their own
     * channel.
     */
    const h = await bootWithRole();
    const reply = await h.transport.dispatch({
      kind: 'command',
      name: 'forget',
      userId: OWNER,
      context: guild(TASK),
      options: { target: 'conversation' },
    });
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });

  it('does nothing at all when no role channel is configured', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch(taskList(guild(TASK)));
    expect(reply?.ephemeral).toBe(true);
    h.close();
  });
});

describe('the authorization path never reads a channel role', () => {
  it('is structural: authz imports nothing about channels', () => {
    /**
     * ADR 0009 says frozen environment configuration is the sole authority for
     * who may act, and ADR 0023 says a channel role is presentation. This
     * asserts the two cannot blur: the authorizer must not know channel roles
     * exist.
     *
     * `Authorizer` has its own `roleOf(discordUserId)` -- owner or chat -- and
     * the name collision with `ChannelRolePolicy.roleOf(context)` is exactly
     * why this test is worth having rather than trusting a reader to notice.
     */
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'security', 'authz.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/channel-roles/);
    expect(src).not.toMatch(/ChannelRolePolicy/);
    expect(src).not.toMatch(/channelId/);
    expect(src).not.toMatch(/guildId/);
  });

  it('keeps the role policy out of every service that grants a capability', () => {
    /**
     * The policy belongs to PRESENTATION. A service that decides what somebody
     * may do reaching for it would be the first step toward a capability that
     * depends on where a message was typed.
     *
     * Two files are allowed to know about it, and both are presentation:
     * `channel-roles.ts` defines it, and `reply-persistence.ts` answers "should
     * this reply be visible?" -- a question about rendering, not about rights.
     * Naming them explicitly is the point: adding a third is a visible change
     * to this list rather than a quiet import.
     */
    const PRESENTATION = new Set(['channel-roles.ts', 'reply-persistence.ts']);
    const domain = path.resolve(import.meta.dirname, '..', 'src', 'domain');
    const offenders: string[] = [];
    for (const entry of readdirSync(domain)) {
      if (!entry.endsWith('.ts') || PRESENTATION.has(entry)) continue;
      const text = readFileSync(path.join(domain, entry), 'utf8');
      if (text.includes('ChannelRolePolicy')) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the persistence policy itself free of anything that grants rights', () => {
    // It may read the owner id and the channel role. It must not reach an
    // authorizer, a job, a task or an approval: deciding visibility is not a
    // place where capability decisions belong.
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'reply-persistence.ts'),
      'utf8',
    );
    // IMPORTS, not the whole file: the doc comment names `Authorizer` to say
    // what this is NOT, and asserting on prose would forbid explaining itself.
    // What matters is that it does not DEPEND on any of them.
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    for (const forbidden of ['Authorizer', 'JobsService', 'TasksService', 'ApprovalsService']) {
      expect(imports, forbidden).not.toMatch(new RegExp(forbidden));
    }
    // What it may depend on, stated positively so the test says what it means.
    expect(imports).toMatch(/ChannelRolePolicy/);
  });
});
