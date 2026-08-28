import { describe, expect, it } from 'vitest';
import { ownerStateLabel } from '@ducky/contracts';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { SharedChannelPolicy } from '../src/domain/shared-visibility.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import { channelTarget, dmTarget } from '../src/discord/message.js';
import type { DiscordTransport } from '../src/discord/transport.js';
import type { OutboundMessage, SendTarget } from '../src/discord/message.js';
import { OWNER, implementedResult, makeHarness } from './helpers.js';

const SHARED_CHANNEL = '900000000000000001';
const GUILD = '800000000000000001';

const boot = (env: Record<string, string | undefined> = {}) =>
  makeHarness({ env: { DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED_CHANNEL, ...env } });

/** Submits from the shared channel, then claims, so the job is `running`. */
const startInChannel = (h: ReturnType<typeof boot>, channelId = SHARED_CHANNEL) => {
  h.app.jobs.submit(
    h.owner,
    { repoSlug: 'demo', task: 'private task text', context: 'private context', bootstrap: false },
    { sharedChannelId: channelId },
  );
  const c = h.app.jobs.claim(h.executorId, `k-${Math.random()}`);
  if (!c) throw new Error('claim failed');
  return c;
};

const notifierFor = (h: ReturnType<typeof boot>, transport: DiscordTransport = h.transport) =>
  new JobNotifier({
    store: h.store,
    transport,
    ownerId: OWNER,
    signer: h.app.signer,
    sharedPolicy: h.app.sharedPolicy,
    sharedJobs: h.app.sharedJobs,
  });

/** Fails only the sends aimed at a channel, leaving DMs working. */
class ChannelOutageTransport implements DiscordTransport {
  readonly kind = 'mock';
  readonly inner = new MockDiscordTransport();
  failChannelSends: number;

  constructor(failChannelSends: number) {
    this.failChannelSends = failChannelSends;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(target: SendTarget, message: OutboundMessage): Promise<void> {
    if (target.kind === 'channel' && this.failChannelSends > 0) {
      this.failChannelSends -= 1;
      throw new Error('simulated channel outage');
    }
    await this.inner.send(target, message);
  }
}

const bothTargets = (sent: readonly { target: SendTarget; message: OutboundMessage }[]) => ({
  dms: sent.filter((s) => s.target.kind === 'user'),
  channel: sent.filter((s) => s.target.kind === 'channel'),
});

describe('shared-channel job notifications', () => {
  it('delivers a transition to the owner DM and the originating channel, once each', async () => {
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', { detail: 'timed out' });

    const first = await notifierFor(h).deliverPending();
    // Two notifiable transitions (running, failed) times two targets.
    expect(first.deliveredByTarget).toEqual({ owner_dm: 2, shared_channel: 2 });

    const { dms, channel } = bothTargets(h.transport.sent);
    expect(dms).toHaveLength(2);
    expect(channel).toHaveLength(2);
    expect(channel[0]!.target).toEqual(channelTarget(SHARED_CHANNEL));
    expect(dms[0]!.target).toEqual(dmTarget(OWNER));

    // A second sweep sends nothing: the ledger is per target, so neither is
    // re-sent just because the other already went.
    const second = await notifierFor(h).deliverPending();
    expect(second).toMatchObject({ delivered: 0, failed: 0 });
    expect(h.transport.sent).toHaveLength(4);
    h.close();
  });

  it('never puts private data or a signed control into the channel message', async () => {
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({
        summary: 'rotated ghp_abcdefghijklmnopqrstuvwxyz012345',
        proposedActions: [],
      }),
      500,
    );

    await notifierFor(h).deliverPending();
    const { channel, dms } = bothTargets(h.transport.sent);
    const flat = JSON.stringify(channel);

    expect(flat).not.toContain('private task text');
    expect(flat).not.toContain('private context');
    expect(flat).not.toContain(OWNER);
    expect(flat).not.toContain('v1:'); // no signed component id
    expect(flat).not.toContain('src/a.ts'); // no changed-file list
    expect(flat).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    // The verdict and the redacted summary ARE shared, deliberately.
    expect(flat).toContain('implemented');

    // The owner's DM is unchanged and still carries the private detail.
    expect(JSON.stringify(dms)).toContain('Reason');
    h.close();
  });

  it('retries only the failed target, and never re-sends the one that succeeded', async () => {
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    // Both channel sends fail; both DMs succeed.
    const transport = new ChannelOutageTransport(2);
    const first = await notifierFor(h, transport).deliverPending();
    expect(first).toMatchObject({ delivered: 2, failed: 2 });
    expect(first.deliveredByTarget).toEqual({ owner_dm: 2, shared_channel: 0 });
    expect(bothTargets(transport.inner.sent).channel).toHaveLength(0);

    // The outage clears. Only the channel messages are retried.
    const second = await notifierFor(h, transport).deliverPending();
    expect(second.deliveredByTarget).toEqual({ owner_dm: 0, shared_channel: 2 });

    const { dms, channel } = bothTargets(transport.inner.sent);
    expect(dms).toHaveLength(2); // not duplicated by the retry
    expect(channel).toHaveLength(2);

    // Nothing outstanding.
    const third = await notifierFor(h, transport).deliverPending();
    expect(third).toMatchObject({ delivered: 0, failed: 0 });
    h.close();
  });

  it('sends only to the owner when the job did not come from a shared channel', async () => {
    const h = boot();
    // Submitted from a DM: no origin channel is recorded.
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    const result = await notifierFor(h).deliverPending();
    expect(result.deliveredByTarget).toEqual({ owner_dm: 2, shared_channel: 0 });
    // No shared target existed, so nothing was skipped either -- there was
    // never a ledger row to write.
    expect(result.skipped).toBe(0);
    expect(bothTargets(h.transport.sent).channel).toHaveLength(0);
    h.close();
  });

  it('stops posting when the channel is removed from configuration, without re-sending the DM', async () => {
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    // Configuration is the sole authority: the stored origin is re-checked at
    // send time, so unlisting the channel silences it immediately even for a
    // job already submitted from it.
    const unlisted = new JobNotifier({
      store: h.store,
      transport: h.transport,
      ownerId: OWNER,
      signer: h.app.signer,
      sharedPolicy: new SharedChannelPolicy([]),
      sharedJobs: h.app.sharedJobs,
    });
    const result = await unlisted.deliverPending();

    expect(result.deliveredByTarget).toEqual({ owner_dm: 2, shared_channel: 0 });
    expect(result.skipped).toBe(2); // the two shared targets, marked not sent
    expect(bothTargets(h.transport.sent).channel).toHaveLength(0);

    // And they stay silenced rather than being reconsidered every sweep.
    const again = await unlisted.deliverPending();
    expect(again).toMatchObject({ delivered: 0, skipped: 0, failed: 0 });
    h.close();
  });

  it('is disabled entirely when the notifier is wired without shared dependencies', async () => {
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    // Failing closed: an incompletely wired notifier loses visibility rather
    // than publishing something.
    const unwired = new JobNotifier({
      store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer,
    });
    const result = await unwired.deliverPending();
    expect(result.deliveredByTarget).toEqual({ owner_dm: 2, shared_channel: 0 });
    expect(bothTargets(h.transport.sent).channel).toHaveLength(0);
    h.close();
  });

  it('posts an owner-caused transition to the channel even though the DM is skipped', async () => {
    const h = boot();
    const c = startInChannel(h);
    // The owner cancels. They already got a synchronous ephemeral reply, so a
    // DM would be an echo -- but nobody in the channel saw that reply.
    h.store.jobs.transition(c.jobId, 'cancelled', 'cancelled_by_owner', `owner:${OWNER}`, {
      finishedAt: new Date().toISOString(),
    });

    const result = await notifierFor(h).deliverPending();
    const { dms, channel } = bothTargets(h.transport.sent);

    // 'running' notifies both; the owner-authored 'cancelled' only the channel.
    expect(result.deliveredByTarget).toEqual({ owner_dm: 1, shared_channel: 2 });
    expect(dms).toHaveLength(1);
    expect(channel).toHaveLength(2);
    expect(JSON.stringify(channel.at(-1))).toContain(ownerStateLabel('cancelled'));
    h.close();
  });

  it('notifies both targets across every notifiable state', async () => {
    const seen = new Set<string>();

    // needs_owner_input, then the answer requeues it, then needs_approval.
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which one?', proposedActions: [] }),
      500,
    );
    await notifierFor(h).deliverPending();
    h.app.jobs.submitOwnerInput(h.owner, c.publicId, 'that one');
    const c2 = h.app.jobs.claim(h.executorId, 'k2')!;
    h.app.jobs.submitResult(
      h.executorId, c2.jobId, c2.leaseId,
      implementedResult({
        proposedActions: [
          { kind: 'git_commit', description: 'commit it', details: { message: 'm', files: ['a'] } },
        ],
      }),
      500,
    );
    await notifierFor(h).deliverPending();

    for (const s of bothTargets(h.transport.sent).channel) {
      const description = s.message.embeds?.[0]?.fields?.find((f) => f.name === 'State')?.value;
      if (description) seen.add(description);
    }
    expect(seen).toContain(ownerStateLabel('running'));
    expect(seen).toContain(ownerStateLabel('needs_owner_input'));
    expect(seen).toContain(ownerStateLabel('needs_approval'));

    // A completed and a failed job round out the notifiable set.
    for (const [outcome, state] of [['completed', 'completed'], ['failed', 'failed']] as const) {
      const g = boot();
      const j = startInChannel(g);
      if (outcome === 'completed') {
        g.app.jobs.submitResult(g.executorId, j.jobId, j.leaseId, implementedResult(), 500);
      } else {
        g.app.jobs.reportFailure(g.executorId, j.jobId, j.leaseId, 'no_result', {});
      }
      await notifierFor(g).deliverPending();
      const labels = bothTargets(g.transport.sent).channel.map(
        (s) => s.message.embeds?.[0]?.fields?.find((f) => f.name === 'State')?.value,
      );
      expect(labels, outcome).toContain(ownerStateLabel(state));
      g.close();
    }
    h.close();
  });

  it('posts each job only to its own originating channel', async () => {
    const SECOND_CHANNEL = '900000000000000003';
    const h = makeHarness({
      env: { DUCKY_DEV_SHARED_CHANNEL_IDS: `${SHARED_CHANNEL},${SECOND_CHANNEL}` },
    });

    // Two jobs, two channels, plus one submitted privately.
    const first = h.app.jobs.submit(
      h.owner, { repoSlug: 'demo', task: 't1', bootstrap: false },
      { sharedChannelId: SHARED_CHANNEL },
    );
    const c1 = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.reportFailure(h.executorId, c1.jobId, c1.leaseId, 'no_result', {});

    const second = h.app.jobs.submit(
      h.owner, { repoSlug: 'other', task: 't2', bootstrap: false },
      { sharedChannelId: SECOND_CHANNEL },
    );
    const c2 = h.app.jobs.claim(h.executorId, 'k2')!;
    h.app.jobs.reportFailure(h.executorId, c2.jobId, c2.leaseId, 'no_result', {});

    const priv = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't3', bootstrap: false });

    await notifierFor(h).deliverPending();

    const posts = bothTargets(h.transport.sent).channel;
    const idsFor = (channelId: string) =>
      posts
        .filter((p) => p.target.kind === 'channel' && p.target.channelId === channelId)
        .map((p) => p.message.embeds![0]!.title!);

    // Each channel hears about its own job and no other, and the privately
    // submitted one is announced nowhere.
    expect(idsFor(SHARED_CHANNEL).every((t) => t.includes(first.publicId))).toBe(true);
    expect(idsFor(SECOND_CHANNEL).every((t) => t.includes(second.publicId))).toBe(true);
    expect(JSON.stringify(posts)).not.toContain(priv.publicId);
    h.close();
  });

  it('does not double-send when two sweeps overlap', async () => {
    const h = boot();
    const c = startInChannel(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    const notifier = notifierFor(h);
    // The second call must join the in-flight sweep rather than starting a
    // second pass over the same pending rows.
    const [a, b] = await Promise.all([notifier.deliverPending(), notifier.deliverPending()]);
    expect(a).toBe(b);
    expect(h.transport.sent).toHaveLength(4); // 2 transitions x 2 targets
    h.close();
  });

  it('records no origin for a job submitted outside a configured channel', () => {
    const h = boot();
    const fromDm = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: false });
    expect(fromDm.originSharedChannelId).toBeNull();

    const fromChannel = h.app.jobs.submit(
      h.owner,
      { repoSlug: 'other', task: 't', bootstrap: false },
      { sharedChannelId: SHARED_CHANNEL },
    );
    expect(fromChannel.originSharedChannelId).toBe(SHARED_CHANNEL);
    h.close();
  });

  it('records the origin when the OWNER submits from the shared channel via the router', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'submit', userId: OWNER,
      context: { channelId: SHARED_CHANNEL, guildId: GUILD },
      options: { repo: 'demo', task: 'a task' },
    });
    // Submitted from a DM whose channel id happens to match: still no origin,
    // because a DM is never a shared channel.
    await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'submit', userId: OWNER,
      context: { channelId: SHARED_CHANNEL, guildId: undefined },
      options: { repo: 'other', task: 'a task' },
    });

    // Looked up by repository, not by list order: both jobs are created in
    // the same millisecond, so created_at ordering between them is arbitrary.
    const byRepo = (slug: string) =>
      h.app.jobs.list(h.owner).find((j) => j.repoSlug === slug)!;
    expect(byRepo('demo').originSharedChannelId).toBe(SHARED_CHANNEL);
    expect(byRepo('other').originSharedChannelId).toBeNull();
    h.close();
  });
});
