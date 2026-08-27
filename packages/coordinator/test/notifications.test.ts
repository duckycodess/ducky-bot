import { describe, expect, it } from 'vitest';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import type { DiscordTransport } from '../src/discord/transport.js';
import type { OutboundMessage, SendTarget } from '../src/discord/message.js';
import { makeHarness, OWNER } from './helpers.js';

const start = (h: ReturnType<typeof makeHarness>) => {
  h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
  const c = h.app.jobs.claim(h.executorId, 'k1');
  if (!c) throw new Error('claim failed');
  return c;
};

/** Sends fail for a fixed number of calls, then succeed -- for retry tests. */
class FlakyTransport implements DiscordTransport {
  readonly kind = 'mock';
  readonly inner = new MockDiscordTransport();
  failNext: number;

  constructor(failNext = 0) {
    this.failNext = failNext;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(target: SendTarget, message: OutboundMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated Discord outage');
    }
    await this.inner.send(target, message);
  }
}

describe('job notification delivery', () => {
  it('notifies the owner on an executor-driven failure', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', { detail: 'ran out of time' });

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    const result = await notifier.deliverPending();

    // Two notifiable transitions land from claim+failure: 'claimed' -> running
    // and the failure itself -> failed. Both are executor-authored, so both
    // are delivered rather than skipped.
    expect(result).toEqual({ delivered: 2, skipped: 0, failed: 0 });
    expect(h.transport.sent).toHaveLength(2);
    expect(h.transport.sent[0]!.target).toEqual({ userId: OWNER });
    const last = h.transport.sent.at(-1)!.message;
    const embed = last.embeds![0]!;
    expect(embed.title).toContain(c.publicId);
    expect(embed.description).toContain('failed');
    h.close();
  });

  it('does not notify for a state transition the owner caused themselves', async () => {
    const h = makeHarness();
    // queued -> cancelled directly, so this is the ONLY pending transition.
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    // Owner-authored transitions carry an `owner:` actor and already produced
    // a synchronous reply; the notifier must not echo them.
    h.store.jobs.transition(job.id, 'cancelled', 'cancelled_by_owner', `owner:${OWNER}`, {
      finishedAt: new Date().toISOString(),
    });

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    const result = await notifier.deliverPending();
    expect(result).toEqual({ delivered: 0, skipped: 1, failed: 0 });
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('does not notify for a non-notifiable state (waiting_for_executor)', async () => {
    const h = makeHarness({ registerExecutor: false });
    // No live executor: the job is created queued, then immediately
    // transitioned to waiting_for_executor -- a state the notifier ignores.
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('is idempotent: a repeated sweep never redelivers the same transition', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();
    const afterFirst = h.transport.sent.length;
    expect(afterFirst).toBeGreaterThan(0);

    await notifier.deliverPending();
    await notifier.deliverPending();
    expect(h.transport.sent.length).toBe(afterFirst);
    h.close();
  });

  it('retries a failed send on the next sweep without duplicating it', async () => {
    const h = makeHarness();
    // queued -> failed directly, so the flaky transport's one-shot failure
    // lines up with exactly one send attempt.
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    h.store.jobs.transition(job.id, 'failed', 'no_result', `executor:${h.executorId}`, {
      finishedAt: new Date().toISOString(),
    });

    const flaky = new FlakyTransport(1);
    const notifier = new JobNotifier({ store: h.store, transport: flaky, ownerId: OWNER });

    const first = await notifier.deliverPending();
    expect(first).toEqual({ delivered: 0, skipped: 0, failed: 1 });
    expect(flaky.inner.sent).toHaveLength(0);

    const second = await notifier.deliverPending();
    expect(second).toEqual({ delivered: 1, skipped: 0, failed: 0 });
    expect(flaky.inner.sent).toHaveLength(1);

    const third = await notifier.deliverPending();
    expect(third).toEqual({ delivered: 0, skipped: 0, failed: 0 });
    expect(flaky.inner.sent).toHaveLength(1);
    h.close();
  });

  it('isolates one job failure from another job in the same sweep', async () => {
    const h = makeHarness();
    const a = start(h);
    h.app.jobs.reportFailure(h.executorId, a.jobId, a.leaseId, 'no_result', {});

    h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 'b', bootstrap: false });
    const b = h.app.jobs.claim(h.executorId, 'k2');
    if (!b) throw new Error('claim failed');
    h.app.jobs.reportFailure(h.executorId, b.jobId, b.leaseId, 'no_result', {});

    let calls = 0;
    class FailFirst implements DiscordTransport {
      readonly kind = 'mock';
      inner = new MockDiscordTransport();
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async send(target: SendTarget, message: OutboundMessage): Promise<void> {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        await this.inner.send(target, message);
      }
    }
    const transport = new FailFirst();
    const notifier = new JobNotifier({ store: h.store, transport, ownerId: OWNER });
    const result = await notifier.deliverPending();

    // Each job contributes two notifiable transitions (claimed, failed). Only
    // the very first send attempt fails; the batch keeps going regardless.
    expect(result).toEqual({ delivered: 3, skipped: 0, failed: 1 });
    expect(transport.inner.sent).toHaveLength(3);
    h.close();
  });

  it('never includes raw task/context text, only the fixed safe shape', async () => {
    const h = makeHarness();
    const secretTask = 'ghp_abcdefghijklmnopqrstuvwxyz012345 do the secret thing';
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: secretTask, bootstrap: false });
    const c = h.app.jobs.claim(h.executorId, 'k1');
    if (!c) throw new Error('claim failed');
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {
      detail: 'ghp_abcdefghijklmnopqrstuvwxyz012345 leaked in the detail too',
    });

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();

    const flat = JSON.stringify(h.transport.sent);
    expect(flat).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(flat).not.toContain('secret thing');
    expect(flat).not.toContain('leaked in the detail');
    h.close();
  });

  it('sends through transport.send, so sanitizeOutbound still applies as the last line of defense', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();

    // MockDiscordTransport.send runs every message through sanitizeOutbound;
    // an unsanitized message would still exceed limits or contain a raw
    // secret shape if the notifier had bypassed the transport boundary.
    const msg = h.transport.sent.at(-1)!.message;
    expect(msg.content).toBeUndefined();
    expect(msg.embeds!.length).toBeGreaterThan(0);
    h.close();
  });
});
