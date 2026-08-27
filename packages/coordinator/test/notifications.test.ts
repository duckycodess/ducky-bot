import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, MIGRATIONS, createStore } from '@ducky/persistence';
import { JobNotifier } from '../src/domain/notifications.service.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import type { DiscordTransport } from '../src/discord/transport.js';
import type { OutboundMessage, SendTarget } from '../src/discord/message.js';
import { makeHarness, implementedResult, commitAction, OWNER } from './helpers.js';

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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('is idempotent: a repeated sweep never redelivers the same transition', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'no_result', {});

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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
    const notifier = new JobNotifier({ store: h.store, transport: flaky, ownerId: OWNER, signer: h.app.signer });

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
    const notifier = new JobNotifier({ store: h.store, transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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
    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: rogueOwner, signer: h.app.signer });
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
    const notifier = new JobNotifier({ store: h.store, transport, ownerId: OWNER, signer: h.app.signer });

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

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
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
    const h = makeHarness();
    const brokenStore = {
      notifications: {
        pending: () => {
          throw new Error('db unavailable');
        },
        markDelivered: () => undefined,
      },
      results: { byJobId: () => undefined },
    } as unknown as import('@ducky/persistence').Store;

    const notifier = new JobNotifier({ store: brokenStore, transport: new MockDiscordTransport(), ownerId: OWNER, signer: h.app.signer });
    const sweep = notifier.deliverPending();
    // Call waitForIdle while the (about-to-reject) sweep is still in flight,
    // exactly as shutdown would race against it.
    const idle = notifier.waitForIdle();
    await expect(sweep).rejects.toThrow('db unavailable');
    await expect(idle).resolves.toBeUndefined();
    h.close();
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
    const notifier = new JobNotifier({ store: h.store, transport, ownerId: OWNER, signer: h.app.signer });

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

describe('job notification delivery: interactive components', () => {
  it('attaches a signed Answer button and the redacted question on needs_owner_input', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({
        verdict: 'needs_owner_input',
        question: 'Which database, and is ghp_abcdefghijklmnopqrstuvwxyz012345 still valid?',
        proposedActions: [],
      }),
      500,
    );
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('needs_owner_input');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs owner input'));
    expect(sent).toBeDefined();
    const question = sent!.message.embeds![0]!.fields!.find((f) => f.name === 'Question');
    expect(question).toBeDefined();
    expect(question!.value).toContain('Which database');
    // The redactor already ran when the question was persisted.
    expect(question!.value).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');

    const row = sent!.message.rows?.find((r) => r.buttons.some((b) => b.label === 'Answer'));
    expect(row).toBeDefined();
    const button = row!.buttons[0]!;
    // Signed for the configured owner, kind job_answer, entity = the job's public id --
    // the EXACT shape the router's job_answer handler (and the modal auto-open
    // matcher) expect, so a click from this DM is verified identically to one
    // from an interactive `/job status` reply.
    const verified = h.app.signer.verify(button.customId, OWNER);
    expect(verified).toEqual({ kind: 'job_answer', entityId: c.publicId });
    h.close();
  });

  it('does not attach an Answer button once the job has moved past needs_owner_input by send time', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'q?', proposedActions: [] }),
      500,
    );
    // The owner already answered through the interactive path before the
    // sweep got a chance to run -- the transition to needs_owner_input is
    // still sitting undelivered in job_transitions.
    h.app.jobs.submitOwnerInput(h.owner, c.publicId, 'postgres');
    expect(h.store.jobs.byId(c.jobId)?.state).not.toBe('needs_owner_input');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const stale = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs owner input'));
    expect(stale).toBeDefined();
    expect(stale!.message.rows ?? []).toHaveLength(0);
    h.close();
  });

  it('attaches signed Approve/Reject buttons per pending action on needs_approval', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({
        proposedActions: [
          { kind: 'git_commit', description: 'commit feat a', details: { message: 'feat: add a', files: ['src/a.ts'] } },
          { kind: 'git_commit', description: 'commit feat b', details: { message: 'feat: add b', files: ['src/b.ts'] } },
        ],
      }),
      500,
    );
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('needs_approval');
    const approvals = h.store.approvals.forJob(c.jobId);
    expect(approvals).toHaveLength(2);

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs approval'));
    expect(sent).toBeDefined();
    expect(sent!.message.rows).toHaveLength(2);

    const actionsField = sent!.message.embeds![0]!.fields!.find((f) => f.name === 'Proposed actions');
    expect(actionsField).toBeDefined();
    expect(actionsField!.value).toContain('commit feat a');
    expect(actionsField!.value).toContain('commit feat b');

    for (const [i, approval] of approvals.entries()) {
      const row = sent!.message.rows![i]!;
      expect(row.buttons).toHaveLength(2);
      const approve = row.buttons.find((b) => b.label.startsWith('approve'))!;
      const reject = row.buttons.find((b) => b.label.startsWith('reject'))!;
      expect(h.app.signer.verify(approve.customId, OWNER)).toEqual({ kind: 'approve', entityId: approval.id });
      expect(h.app.signer.verify(reject.customId, OWNER)).toEqual({ kind: 'reject', entityId: approval.id });
    }
    h.close();
  });

  it('bounds approval buttons to at most 4 rows, mirroring the /job status presenter', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({
        proposedActions: [
          commitAction('a'), commitAction('b'), commitAction('c'), commitAction('d'), commitAction('e'),
        ],
      }),
      500,
    );
    expect(h.store.approvals.forJob(c.jobId)).toHaveLength(5);

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs approval'))!;
    expect(sent.message.rows).toHaveLength(4);
    h.close();
  });

  it('omits a stale, already-decided approval from both the buttons and the action list', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({
        proposedActions: [
          { kind: 'git_commit', description: 'keep this one', details: { message: 'feat: keep', files: ['src/a.ts'] } },
          { kind: 'git_commit', description: 'gone before the sweep', details: { message: 'feat: gone', files: ['src/b.ts'] } },
        ],
      }),
      500,
    );
    const [first, second] = h.store.approvals.forJob(c.jobId);
    // The owner already decided the second action through the interactive
    // path before this sweep ran; it must not resurface as a clickable
    // button or in the action list, but the job is still in needs_approval
    // because the FIRST action is still pending -- the still-actionable one
    // must still get its button.
    h.app.approvals.decide(h.owner, second!.id, 'approved');
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('needs_approval');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs approval'));
    expect(sent).toBeDefined();
    expect(sent!.message.rows).toHaveLength(1);
    const only = sent!.message.rows![0]!.buttons[0]!;
    expect(h.app.signer.verify(only.customId, OWNER)).toEqual({ kind: 'approve', entityId: first!.id });

    const actionsField = sent!.message.embeds![0]!.fields!.find((f) => f.name === 'Proposed actions');
    expect(actionsField!.value).toContain('keep this one');
    expect(actionsField!.value).not.toContain('gone before the sweep');
    h.close();
  });

  it('a stale button click is still rejected by the same server-side re-check /job status relies on', async () => {
    const h = makeHarness();
    const c = start(h);
    // Two actions, so deciding the first one leaves the job in
    // needs_approval (the second is still pending) -- the resulting
    // "already decided" error therefore comes from the approval-state check,
    // not a job-no-longer-awaiting-approval short circuit.
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({ proposedActions: [commitAction('a'), commitAction('b')] }),
      500,
    );
    const [approval] = h.store.approvals.forJob(c.jobId);

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();
    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs approval'))!;
    const approveButton = sent.message.rows![0]!.buttons.find((b) => b.label.startsWith('approve'))!;

    // The owner decides through the interactive path first...
    h.app.approvals.decide(h.owner, approval!.id, 'approved');
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('needs_approval');
    // ...then clicks the (now stale) button from the DM. The notifier issued
    // no special authorization for this button; it is the SAME
    // ApprovalsService.decide re-check every click goes through, and it must
    // still reject cleanly.
    const verified = h.app.signer.verify(approveButton.customId, OWNER);
    expect(verified).toEqual({ kind: 'approve', entityId: approval!.id });
    expect(() => h.app.approvals.decide(h.owner, verified!.entityId, 'approved')).toThrow(/already/);
    h.close();
  });

  it('includes both the redacted result summary and the verdict on completion', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult({ summary: 'All done.' }), 500);
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('completed');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('completed'))!;
    const fields = sent.message.embeds![0]!.fields!;
    expect(fields.find((f) => f.name === 'Result')!.value).toContain('All done.');
    expect(fields.find((f) => f.name === 'Verdict')!.value).toBe('implemented');
    h.close();
  });

  it('includes the verdict on a failed result, distinct from the executor-failure reason', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId,
      c.jobId,
      c.leaseId,
      implementedResult({ verdict: 'failed', summary: 'Could not reproduce the issue.', proposedActions: [] }),
      500,
    );
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('failed');

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('failed'))!;
    const fields = sent.message.embeds![0]!.fields!;
    expect(fields.find((f) => f.name === 'Result')!.value).toContain('Could not reproduce');
    expect(fields.find((f) => f.name === 'Verdict')!.value).toBe('failed');
    h.close();
  });

  it('never attaches components to a plain running/cancelled notification', async () => {
    const h = makeHarness();
    start(h);

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]!.message.rows ?? []).toHaveLength(0);
    h.close();
  });

  it('every component still passes through sanitizeOutbound (custom ids are validated, not just built)', async () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult({ proposedActions: [commitAction()] }), 500);

    const notifier = new JobNotifier({ store: h.store, transport: h.transport, ownerId: OWNER, signer: h.app.signer });
    await notifier.deliverPending();

    const sent = h.transport.sent.find((s) => s.message.embeds?.[0]?.description?.includes('needs approval'))!;
    // MockDiscordTransport.send runs every message through sanitizeOutbound,
    // which drops any button whose customId does not match the exact signed
    // shape -- if these buttons survived, they passed that check too.
    expect(sent.message.rows).toHaveLength(1);
    expect(sent.message.rows![0]!.buttons).toHaveLength(2);
    h.close();
  });
});
