import { describe, expect, it } from 'vitest';
import {
  JOB_PHASES, JOB_STATES, JOB_STATE_PHASE, OWNER_NEXT_STEP, SHARED_JOB_PROJECTION_KEYS,
  SHARED_NEXT_STEP, UNLISTED_REPO_SLUG, isSharedReadableRoute, ownerNextStep, ownerStateLabel,
  phaseOf, type JobState,
} from '@ducky/contracts';
import { SharedChannelPolicy } from '../src/domain/shared-visibility.js';
import { loadEnv, resolveSharedChannelIds } from '../src/config.js';
import { CHAT, OWNER, STRANGER, implementedResult, makeHarness } from './helpers.js';
import type { IncomingContext } from '../src/discord/transport.js';

const SHARED_CHANNEL = '900000000000000001';
const OTHER_CHANNEL = '900000000000000002';
const GUILD = '800000000000000001';

/** A request from the configured shared channel. */
const inShared: IncomingContext = { channelId: SHARED_CHANNEL, guildId: GUILD };
/** A guild channel nobody configured. */
const inOther: IncomingContext = { channelId: OTHER_CHANNEL, guildId: GUILD };
/** A DM. Note the channel id deliberately collides with the configured one. */
const inDm: IncomingContext = { channelId: SHARED_CHANNEL, guildId: undefined };

const boot = async (env: Record<string, string | undefined> = {}) => {
  const h = makeHarness({ env: { DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED_CHANNEL, ...env } });
  await h.transport.start((e) => h.app.router.handle(e));
  return h;
};

const flat = (m: unknown): string => JSON.stringify(m);

/** Everything a shared reply must never contain, whoever asked for it. */
const assertNoPrivateData = (message: unknown, extras: string[] = []): void => {
  const s = flat(message);
  for (const secret of [OWNER, ...extras]) expect(s, secret).not.toContain(secret);
  // No signed control ever reaches a channel other people can read.
  expect(s).not.toContain('customId');
  expect(s).not.toContain('v1:');
};

describe('shared channel policy', () => {
  it('is off by default and treats every ambiguous case as private', () => {
    const off = new SharedChannelPolicy();
    expect(off.enabled).toBe(false);
    expect(off.isSharedRequest(inShared)).toBe(false);

    const on = new SharedChannelPolicy([SHARED_CHANNEL]);
    expect(on.isSharedRequest(inShared)).toBe(true);
    // An unconfigured guild channel.
    expect(on.isSharedRequest(inOther)).toBe(false);
    // A DM, even with a channel id that matches a configured one exactly.
    expect(on.isSharedRequest(inDm)).toBe(false);
    // No context at all.
    expect(on.isSharedRequest(undefined)).toBe(false);
    expect(on.isSharedRequest({ channelId: undefined, guildId: GUILD })).toBe(false);
  });

  it('refuses a configured channel id that is not a snowflake, at boot', () => {
    expect(() => makeHarness({ env: { DUCKY_DEV_SHARED_CHANNEL_IDS: 'not-an-id' } })).toThrow(
      /not a Discord channel id/,
    );
  });

  it('never lets production inherit the development or unscoped variable', () => {
    // Read straight from the resolver: this is a configuration rule, and
    // booting a whole production app would drag in its credential file.
    const base = {
      OWNER_DISCORD_USER_ID: OWNER,
      DUCKY_DEV_COMPONENT_SIGNING_KEY: 'x'.repeat(43),
      DUCKY_PROD_COMPONENT_SIGNING_KEY: 'y'.repeat(43),
    };

    // Development may still use the unscoped name, which keeps a
    // single-profile local box simple.
    expect(
      resolveSharedChannelIds(
        loadEnv({ ...base, DUCKY_SHARED_CHANNEL_IDS: SHARED_CHANNEL } as NodeJS.ProcessEnv),
      ),
    ).toEqual([SHARED_CHANNEL]);

    // Production sees neither the unscoped nor the development value.
    expect(
      resolveSharedChannelIds(
        loadEnv({
          ...base,
          DUCKY_PROFILE: 'production',
          DUCKY_SHARED_CHANNEL_IDS: SHARED_CHANNEL,
          DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED_CHANNEL,
        } as NodeJS.ProcessEnv),
      ),
    ).toEqual([]);

    // Only its own.
    expect(
      resolveSharedChannelIds(
        loadEnv({
          ...base,
          DUCKY_PROFILE: 'production',
          DUCKY_PROD_SHARED_CHANNEL_IDS: OTHER_CHANNEL,
        } as NodeJS.ProcessEnv),
      ),
    ).toEqual([OTHER_CHANNEL]);
  });
});

describe('shared channel reads', () => {
  it('lets any member of a configured channel see the safe job list', async () => {
    const h = await boot();
    h.app.jobs.submit(h.owner, {
      repoSlug: 'demo',
      task: 'rotate the production database credentials',
      context: 'the old one is in 1password',
      bootstrap: false,
    });

    // A stranger: not the owner, not even on the chat whitelist.
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'jobs', userId: STRANGER, context: inShared, options: {},
    });

    // Visible on purpose. This is the only non-ephemeral command reply.
    expect(reply?.ephemeral).toBe(false);
    expect(flat(reply)).toContain('demo');
    assertNoPrivateData(reply, [
      'rotate the production database credentials',
      'the old one is in 1password',
    ]);
    h.close();
  });

  it('serves the shared view to the OWNER too, so the private view is never posted publicly', async () => {
    const h = await boot();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'secret task text', bootstrap: false });

    const inChannel = await h.transport.dispatch({
      kind: 'command', name: 'jobs', userId: OWNER, context: inShared, options: {},
    });
    expect(inChannel?.ephemeral).toBe(false);
    expect(flat(inChannel)).not.toContain('secret task text');

    // The same owner, in a DM, still gets the full private view.
    const inPrivate = await h.transport.dispatch({
      kind: 'command', name: 'jobs', userId: OWNER, context: inDm, options: {},
    });
    expect(inPrivate?.ephemeral).toBe(true);
    expect(flat(inPrivate)).toContain('secret task text');
    h.close();
  });

  it('shows a single job with a state label and next step, and nothing else', async () => {
    const h = await boot();
    const job = h.app.jobs.submit(h.owner, {
      repoSlug: 'demo', task: 'private task', bootstrap: false,
    });

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'status', userId: CHAT,
      context: inShared, options: { id: job.publicId },
    });

    const fields = reply!.embeds![0]!.fields!;
    expect(reply!.embeds![0]!.title).toContain(job.publicId);
    expect(fields.find((f) => f.name === 'State')!.value).toBe(ownerStateLabel(job.state));
    expect(fields.find((f) => f.name === 'What happens next')!.value).toBe(
      SHARED_NEXT_STEP[phaseOf(job.state)],
    );
    expect(reply!.rows).toBeUndefined();
    assertNoPrivateData(reply, ['private task']);
    h.close();
  });

  it('answers a stale, foreign or malformed job id identically, revealing nothing', async () => {
    const h = await boot();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });

    const asked = async (id: string) =>
      h.transport.dispatch({
        kind: 'command', name: 'job', subcommand: 'status', userId: STRANGER,
        context: inShared, options: { id },
      });

    // A well-formed id that never existed, and one that is not an id at all.
    const unknown = await asked('jzzzzz');
    const malformed = await asked('../../etc/passwd');
    expect(unknown?.content).toBe('No job with that id.');
    expect(malformed?.content).toBe(unknown?.content);
    // The refusal is ephemeral: a shared channel is not a place to leave
    // other people's typos lying around.
    expect(unknown?.ephemeral).toBe(true);
    h.close();
  });

  it('reports a repository no longer in the allowlist as unlisted, not by name', async () => {
    const h = await boot();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });

    // A curated slug is shared as itself.
    expect(h.app.sharedJobs.project(job).repoSlug).toBe('demo');

    // One the operator has stopped listing is not named at all. `disabled` is
    // in the test allowlist but not enabled, so it exercises the real
    // `resolve` refusal rather than a missing key.
    for (const slug of ['since-removed', 'disabled']) {
      expect(h.app.sharedJobs.project({ ...job, repoSlug: slug }).repoSlug).toBe(
        UNLISTED_REPO_SLUG,
      );
    }
    h.close();
  });

  it('shares the redacted result summary and verdict, never the raw snapshot', async () => {
    const h = await boot();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'private task', bootstrap: false });
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ summary: 'token ghp_abcdefghijklmnopqrstuvwxyz012345 rotated' }),
      500,
    );

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'status', userId: STRANGER,
      context: inShared, options: { id: c.publicId },
    });

    const s = flat(reply);
    expect(s).toContain('implemented');
    // Redacted at intake, and the redaction survives the projection.
    expect(s).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    // The snapshot's file list is never shared.
    expect(s).not.toContain('src/a.ts');
    assertNoPrivateData(reply, ['private task']);
    h.close();
  });
});

describe('shared channels never widen what anyone may DO', () => {
  const writes = [
    { name: 'job', subcommand: 'submit', options: { repo: 'demo', task: 'x' } },
    { name: 'job', subcommand: 'cancel', options: { id: 'jaaaaa' } },
    { name: 'job', subcommand: 'answer', options: { id: 'jaaaaa', answer: 'x' } },
    { name: 'job', subcommand: 'cleanup', options: { id: 'jaaaaa' } },
    { name: 'capture', subcommand: undefined, options: { text: 'x' } },
    { name: 'inbox', subcommand: undefined, options: {} },
    { name: 'schedule', subcommand: undefined, options: { text: 'x' } },
    { name: 'repo', subcommand: undefined, options: { slug: 'demo' } },
    { name: 'status', subcommand: undefined, options: {} },
  ] as const;

  it('refuses every non-owner command in a configured shared channel', async () => {
    const h = await boot();
    for (const w of writes) {
      const reply = await h.transport.dispatch({
        kind: 'command', name: w.name, userId: STRANGER, context: inShared,
        options: w.options, ...(w.subcommand ? { subcommand: w.subcommand } : {}),
      });
      expect(reply?.content, `${w.name} ${w.subcommand ?? ''}`).toBe(
        'You are not authorized to do that.',
      );
      expect(reply?.ephemeral).toBe(true);
    }
    // Nothing was written.
    expect(h.app.jobs.list(h.owner)).toHaveLength(0);
    expect(h.app.captures.list(h.owner)).toHaveLength(0);
    h.close();
  });

  it('refuses a non-owner in an UNCONFIGURED channel, including the read routes', async () => {
    const h = await boot();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });

    for (const event of [
      { name: 'jobs', options: {} },
      { name: 'job', subcommand: 'status', options: { id: 'jaaaaa' } },
    ] as const) {
      const reply = await h.transport.dispatch({
        kind: 'command', userId: STRANGER, context: inOther, ...event,
      });
      expect(reply?.content).toBe('You are not authorized to do that.');
    }
    h.close();
  });

  it('refuses a non-owner in a DM whose channel id matches a configured shared channel', async () => {
    const h = await boot();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'jobs', userId: STRANGER, context: inDm, options: {},
    });
    expect(reply?.content).toBe('You are not authorized to do that.');
    h.close();
  });

  it('refuses a non-owner when no shared channel is configured at all', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'jobs', userId: STRANGER, context: inShared, options: {},
    });
    expect(reply?.content).toBe('You are not authorized to do that.');
    h.close();
  });

  it('lets the OWNER still write from a shared channel, with an ephemeral reply', async () => {
    const h = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'submit', userId: OWNER,
      context: inShared, options: { repo: 'demo', task: 'a task' },
    });
    // Owner writes are unchanged, and the acknowledgement is not made public
    // merely because it was typed in a visible channel.
    expect(reply?.ephemeral).toBe(true);
    expect(h.app.jobs.list(h.owner)).toHaveLength(1);
    h.close();
  });
});

describe('deterministic state labels', () => {
  it('covers every persisted state with a phase, a label and both next steps', () => {
    for (const state of JOB_STATES) {
      const phase = phaseOf(state);
      expect(JOB_PHASES, state).toContain(phase);
      expect(ownerStateLabel(state), state).toBeTruthy();
      expect(OWNER_NEXT_STEP[phase], state).toBeTruthy();
      expect(SHARED_NEXT_STEP[phase], state).toBeTruthy();
      // A raw state identifier must never reach either audience as the label.
      expect(ownerStateLabel(state)).not.toBe(state);
    }
    // Every phase is reachable, so none is dead copy.
    expect(new Set(Object.values(JOB_STATE_PHASE)).size).toBe(JOB_PHASES.length);
  });

  it('gives the two audiences different next-step copy for the states that need a decision', () => {
    for (const state of ['needs_owner_input', 'needs_approval'] as JobState[]) {
      const phase = phaseOf(state);
      // The owner is told which control to use; a collaborator has none, so
      // telling them to press Approve would be an invitation to try.
      expect(OWNER_NEXT_STEP[phase]).not.toBe(SHARED_NEXT_STEP[phase]);
      expect(SHARED_NEXT_STEP[phase]).toMatch(/private/i);
    }
  });

  it("shows the owner's list and detail in plain language, not raw identifiers", async () => {
    const h = await boot();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });

    for (const event of [
      { name: 'jobs', options: {} },
      { name: 'job', subcommand: 'status', options: { id: job.publicId } },
    ] as const) {
      const reply = await h.transport.dispatch({
        kind: 'command', userId: OWNER, context: inDm, ...event,
      });
      const s = flat(reply);
      expect(s).toContain(ownerStateLabel(job.state));
      expect(s).toContain(ownerNextStep(job.state));
      expect(s).not.toContain('waiting_for_executor');
      expect(s).not.toContain('needs_owner_input');
    }
    h.close();
  });
});

describe('the shared surface cannot grow by accident', () => {
  it('shares exactly the projection fields, and only the two read routes', () => {
    const h = makeHarness();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });
    const projection = h.app.sharedJobs.project(job);
    expect(Object.keys(projection).sort()).toEqual([...SHARED_JOB_PROJECTION_KEYS].sort());

    expect(isSharedReadableRoute('jobs')).toBe(true);
    expect(isSharedReadableRoute('job', 'status')).toBe(true);
    // A bare /job means status, which is why it is accepted.
    expect(isSharedReadableRoute('job')).toBe(true);
    for (const write of ['submit', 'cancel', 'answer', 'cleanup']) {
      expect(isSharedReadableRoute('job', write), write).toBe(false);
    }
    for (const cmd of ['capture', 'inbox', 'schedule', 'repo', 'status', 'approve']) {
      expect(isSharedReadableRoute(cmd), cmd).toBe(false);
    }
    h.close();
  });

  it('never reaches the owner-only services from the shared projection', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'private task', bootstrap: false });
    // The projection service has no ActorContext parameter at all, so there
    // is no identity to escalate and no owner-only method it can call.
    const s = flat(h.app.sharedJobs.list());
    expect(s).not.toContain('private task');
    expect(s).not.toContain(OWNER);
    h.close();
  });
});
