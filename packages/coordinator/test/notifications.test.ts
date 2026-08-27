import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, MIGRATIONS, createStore } from '@ducky/persistence';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import type { DiscordTransport } from '../src/discord/transport.js';
import type { OutboundMessage, SendTarget } from '../src/discord/message.js';
import { makeHarness, implementedResult, OWNER } from './helpers.js';

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

  it('includes the sanitized final-result summary on completion, still redacted', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({ summary: 'Refactored the widget module and ghp_abcdefghijklmnopqrstuvwxyz012345 done' }),
      500,
    );
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('completed');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();

    const completed = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('completed'));
    expect(completed).toBeDefined();
    const resultField = completed!.message.embeds![0]!.fields!.find((f) => f.name === 'Result');
    expect(resultField).toBeDefined();
    expect(resultField!.value).toContain('Refactored the widget module');
    // The redactor already ran when the result was persisted; the field must
    // never carry the raw secret shape through to the owner.
    expect(resultField!.value).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    h.close();
  });

  it('omits the Result field entirely when no result has been recorded yet (e.g. the claim -> running transition)', async () => {
    const h = makeHarness();
    const c = start(h);
    void c;

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();

    expect(h.transport.sent).toHaveLength(1);
    const fields = h.transport.sent[0]!.message.embeds![0]!.fields!;
    expect(fields.some((f) => f.name === 'Result')).toBe(false);
    h.close();
  });

  it('never includes the repo absolute path or the retained workspace id, only the redacted summary', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    const job = h.store.jobs.byId(c.jobId)!;
    expect(job.state).toBe('completed');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await notifier.deliverPending();

    // The repo's real, on-disk absolute path (from REPOS_JSON) must never
    // reach the owner through this channel -- the notifier only ever reads
    // publicId/repoSlug/state/reason/summary_redacted, never the repo config
    // or the job's retained_workspace_id.
    const flat = JSON.stringify(h.transport.sent);
    expect(flat).not.toContain('/tmp/ducky-demo');
    h.close();
  });

  it('always targets the currently configured owner, never a stale per-row discord_user_id', async () => {
    const h = makeHarness();
    start(h);

    // Even if a row's stored owner id were somehow different from the
    // currently configured owner, delivery must still go to the configured
    // owner -- authorization never reads the database (AGENTS.md).
    const rogueOwner = '999999999999999999';
    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: rogueOwner });
    await notifier.deliverPending();

    expect(h.transport.sent.length).toBeGreaterThan(0);
    for (const sent of h.transport.sent) {
      expect(sent.target).toEqual({ userId: rogueOwner });
    }
    h.close();
  });

  it('is re-entrancy safe: overlapping calls share one sweep instead of double-sending', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    let inFlight = 0;
    let maxConcurrent = 0;
    class SlowTransport implements DiscordTransport {
      readonly kind = 'mock';
      inner = new MockDiscordTransport();
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async send(target: SendTarget, message: OutboundMessage): Promise<void> {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        await this.inner.send(target, message);
        inFlight -= 1;
      }
    }
    const transport = new SlowTransport();
    const notifier = new JobNotifier({ store: h.store, transport, ownerId: OWNER });

    const [a, b, c2] = await Promise.all([
      notifier.deliverPending(),
      notifier.deliverPending(),
      notifier.deliverPending(),
    ]);

    // All three callers observe the exact same sweep result -- there was
    // only ever one pass over the pending rows.
    expect(a).toEqual(b);
    expect(b).toEqual(c2);
    expect(transport.inner.sent).toHaveLength(2);
    // The transport was never asked to send the same row concurrently with
    // itself from a second overlapping sweep.
    expect(maxConcurrent).toBe(1);
    h.close();
  });

  it('waitForIdle resolves immediately when nothing is in flight, and after an in-flight sweep settles', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER });
    await expect(notifier.waitForIdle()).resolves.toBeUndefined();

    const sweep = notifier.deliverPending();
    await notifier.waitForIdle();
    // Once waitForIdle resolves, the sweep itself must already be settled --
    // this is what shutdown relies on before closing the store.
    await expect(sweep).resolves.toBeDefined();
    h.close();
  });

  it('waitForIdle never rejects, even when the sweep it is waiting on does', async () => {
    // A sweep can reject outright (not just a per-row send failure) if, say,
    // the pending-rows query itself throws. waitForIdle must still resolve
    // rather than propagate that rejection to a caller (shutdown) that isn't
    // expecting one.
    const brokenStore = {
      notifications: {
        pending: () => {
          throw new Error('db unavailable');
        },
        markDelivered: () => undefined,
      },
      results: { byJobId: () => undefined },
    } as unknown as import('@ducky/persistence').Store;

    const notifier = new JobNotifier({ store: brokenStore, transport: new MockDiscordTransport(), ownerId: OWNER });
    const sweep = notifier.deliverPending();
    // Call waitForIdle while the (about-to-reject) sweep is still in flight,
    // exactly as shutdown would race against it.
    const idle = notifier.waitForIdle();
    await expect(sweep).rejects.toThrow('db unavailable');
    await expect(idle).resolves.toBeUndefined();
  });
});

describe('job notification delivery: startup/shutdown ordering', () => {
  it('a sweep started just before shutdown finishes writing before waitForIdle resolves', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    let sendResolved = false;
    class DelayedTransport implements DiscordTransport {
      readonly kind = 'mock';
      inner = new MockDiscordTransport();
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async send(target: SendTarget, message: OutboundMessage): Promise<void> {
        await new Promise((r) => setTimeout(r, 15));
        await this.inner.send(target, message);
        sendResolved = true;
      }
    }
    const transport = new DelayedTransport();
    const notifier = new JobNotifier({ store: h.store, transport, ownerId: OWNER });

    // Simulate main.ts: kick off a sweep, then immediately begin shutdown.
    void notifier.deliverPending();
    expect(sendResolved).toBe(false);
    await notifier.waitForIdle();
    // waitForIdle must not resolve until the in-flight sweep -- including its
    // sends -- has actually settled, or shutdown would close the store out
    // from under it.
    expect(sendResolved).toBe(true);
    h.close();
  });
});

describe('job_notifications baseline backfill on migration', () => {
  it('does not resurface transitions that already existed before the notifications feature was added', () => {
    const db = openDatabase({ location: ':memory:' });
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    // Apply every migration except the one that introduces job_notifications,
    // simulating an existing deployment upgrading into this feature.
    const preExisting = MIGRATIONS.filter((m) => m.name !== 'job_notifications');
    for (const m of preExisting) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    }

    const store = createStore(db);
    store.repos.upsert({
      slug: 'demo',
      absolutePath: '/tmp/demo',
      defaultBranch: 'main',
      githubOwner: null,
      githubRepo: null,
      allowWorktree: true,
      allowBootstrap: false,
      bootstrapAllowedEntries: ['.git'],
      enabled: true,
    });
    const job = store.jobs.create({
      id: 'j1',
      publicId: 'p1',
      discordUserId: OWNER,
      repoSlug: 'demo',
      task: 't',
      context: null,
      bootstrap: false,
      maxAttempts: 3,
      maxOwnerInputRounds: 3,
      state: 'queued',
    });
    // A pre-upgrade transition history the owner already knows about.
    store.jobs.transition(job.id, 'failed', 'no_result', 'executor:e1', {
      finishedAt: new Date().toISOString(),
    });

    // Now apply the migration that introduces the notifications feature.
    runMigrations(db);

    // The historical transition must be treated as already delivered.
    expect(store.notifications.pending(10)).toHaveLength(0);

    // But a NEW transition recorded after the upgrade is still pending.
    const job2 = store.jobs.create({
      id: 'j2',
      publicId: 'p2',
      discordUserId: OWNER,
      repoSlug: 'demo',
      task: 't2',
      context: null,
      bootstrap: false,
      maxAttempts: 3,
      maxOwnerInputRounds: 3,
      state: 'queued',
    });
    store.jobs.transition(job2.id, 'failed', 'no_result', 'executor:e1', {
      finishedAt: new Date().toISOString(),
    });
    const pending = store.notifications.pending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.jobId).toBe(job2.id);

    db.close();
  });
});
