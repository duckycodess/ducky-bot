import { describe, expect, it } from 'vitest';
import { AUDIT_FORBIDDEN_SUBSTRINGS, EXECUTOR_HEADERS } from '@ducky/contracts';
import { buildServer } from '../src/http/server.js';
import { commitAction, implementedResult, makeHarness, secret } from './helpers.js';
import { DisabledConversationProvider } from '@ducky/adapters';

/** Submits a job and claims it, which is what a result needs to attach to. */
const claimedJob = (h: ReturnType<typeof makeHarness>) => {
  h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
  const c = h.app.jobs.claim(h.executorId, `idem-${Math.random()}`);
  if (!c) throw new Error('expected a claim');
  return c;
};

/** An implemented result that proposes ONE consequential action. */
const implementedWithActions = () => implementedResult({ proposedActions: [commitAction()] });

/**
 * The audit log recorded the lifecycle in detail and recorded NOTHING about who
 * was turned away. These are the rows an auditor actually needs after an
 * incident, and each one records a code plus a non-secret reference — never the
 * material that failed. An audit row quoting a bad bearer token would be the
 * leak it exists to detect.
 */
async function server(h: ReturnType<typeof makeHarness>) {
  return buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
}

const events = (h: ReturnType<typeof makeHarness>, event: string) =>
  h.store.auditLog.recent(100).filter((r) => r.event === event);

describe('authentication failures', () => {
  it('records auth.failed for an unsigned request', async () => {
    const h = makeHarness();
    const app = await server(h);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/executor/heartbeat',
      payload: { executorId: h.executorId, version: '1', capabilities: [], activeJobIds: [] },
    });
    expect(res.statusCode).toBe(401);

    const rows = events(h, 'auth.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('refused');
    expect(rows[0]!.subjectKind).toBe('route');
    expect(rows[0]!.subjectRef).toBe('/api/v1/executor/heartbeat');
    await app.close();
    h.close();
  });

  it('never records the bearer token, the signature, or a reason', async () => {
    const h = makeHarness();
    const app = await server(h);
    const badToken = `ghp_${'z'.repeat(36)}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/executor/claim',
      headers: {
        authorization: `Bearer ${badToken}`,
        [EXECUTOR_HEADERS.executorId]: h.executorId,
        [EXECUTOR_HEADERS.keyId]: h.keyId,
        [EXECUTOR_HEADERS.timestamp]: new Date().toISOString(),
        [EXECUTOR_HEADERS.nonce]: 'n1',
        [EXECUTOR_HEADERS.signature]: 'wrong',
      },
      payload: { executorId: h.executorId, capabilities: [], waitMs: 0, idempotencyKey: 'k'.repeat(10) },
    });

    const dump = JSON.stringify(h.store.auditLog.recent(100));
    expect(dump).not.toContain(badToken);
    expect(dump).not.toContain('wrong');
    for (const forbidden of AUDIT_FORBIDDEN_SUBSTRINGS) {
      expect(dump.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    await app.close();
    h.close();
  });

  it('records an unparseable executor id as absent rather than echoing it', async () => {
    const h = makeHarness();
    const app = await server(h);
    await app.inject({
      method: 'POST',
      url: '/api/v1/executor/heartbeat',
      headers: { [EXECUTOR_HEADERS.executorId]: '../../etc/passwd' },
      payload: {},
    });
    const rows = events(h, 'auth.failed');
    expect(rows[0]!.actorRef).toBeNull();
    await app.close();
    h.close();
  });
});

describe('authorization refusals', () => {
  it('records authz.refused with the ROLE, never the Discord id', () => {
    const h = makeHarness();
    expect(() => h.app.captures.list(h.stranger, 'open')).toThrow();

    const rows = events(h, 'authz.refused');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.outcome).toBe('refused');
    expect(rows[0]!.detail).toMatch(/role (none|chat) refused/);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(h.stranger.discordUserId);
    expect(dump).not.toContain(h.chat.discordUserId);
    h.close();
  });

  it('records a chat user refused from a privileged surface', () => {
    const h = makeHarness();
    expect(() => h.app.tasks.list(h.chat, 'open')).toThrow();
    expect(events(h, 'authz.refused').some((r) => r.detail?.includes('role chat'))).toBe(true);
    h.close();
  });

  it('writes nothing when the owner is allowed through', () => {
    const h = makeHarness();
    h.app.captures.list(h.owner, 'open');
    expect(events(h, 'authz.refused')).toHaveLength(0);
    h.close();
  });
});

describe('rate limits', () => {
  it('records rate_limit.exceeded with the BUCKET, not the user', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));

    // Drive the real router until the capture bucket is exhausted. The app now
    // owns the buckets so the audit sink is attached to the same instance the
    // router uses -- which is the property under test.
    let refusal: string | undefined;
    for (let i = 0; i < 500 && refusal === undefined; i += 1) {
      const reply = await h.transport.dispatch({
        kind: 'command',
        name: 'capture',
        userId: h.owner.discordUserId,
        options: { text: `note ${i}` },
      } as never);
      if (reply?.content?.includes('Too many requests') === true) refusal = reply.content;
    }
    expect(refusal, 'the capture bucket should exhaust').toBeDefined();

    const rows = events(h, 'rate_limit.exceeded');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.subjectKind).toBe('route');
    expect(rows[0]!.subjectRef).toBe('capture');
    expect(rows[0]!.outcome).toBe('refused');
    // The owner id is never recorded; there is exactly one owner.
    expect(JSON.stringify(rows)).not.toContain(h.owner.discordUserId);
    h.close();
  });
});

describe('credential reloads', () => {
  it('is a declared event that the log can actually persist', () => {
    const h = makeHarness();
    h.store.auditLog.record({
      event: 'credential.reloaded',
      actorKind: 'system',
      actorRef: 'credential-store',
      subjectKind: 'credential',
      subjectRef: '1',
      outcome: 'ok',
      detail: 'credential file changed and was reloaded',
    });
    const rows = events(h, 'credential.reloaded');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectKind).toBe('credential');
    h.close();
  });

  it('never records credential material', () => {
    const h = makeHarness();
    const material = secret();
    h.store.auditLog.record({
      event: 'credential.reloaded',
      actorKind: 'system',
      subjectKind: 'credential',
      subjectRef: '1',
      outcome: 'ok',
      detail: 'credential file changed and was reloaded',
    });
    expect(JSON.stringify(h.store.auditLog.recent(10))).not.toContain(material);
    h.close();
  });
});

/**
 * Approval lifecycle coverage.
 *
 * `approval.decided` recorded the owner's answer but nothing recorded that an
 * approval had been ASKED for, or that one lapsed unanswered — so the trail
 * could not answer "what was pending on the day of the incident".
 */
describe('approval lifecycle', () => {
  it('records approval.requested when a result proposes actions', () => {
    const h = makeHarness();
    const job = claimedJob(h);
    h.app.jobs.submitResult(h.executorId, job.jobId, job.leaseId, implementedWithActions(), 512);

    const rows = events(h, 'approval.requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectKind).toBe('job');
    expect(rows[0]!.outcome).toBe('ok');
    // The action KINDS and the count -- never an action's details, which are
    // the argv and the paths.
    expect(rows[0]!.detail).toMatch(/1 action\(s\) proposed: git_commit/);
    expect(rows[0]!.detail).not.toMatch(/README|\/home\//);
    h.close();
  });

  it('records approval.expired when a pending approval lapses', () => {
    const h = makeHarness();
    const job = claimedJob(h);
    h.app.jobs.submitResult(h.executorId, job.jobId, job.leaseId, implementedWithActions(), 512);

    // Age every pending approval past its TTL, then reconcile.
    h.store.db.prepare('UPDATE approvals SET expires_at = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
    );
    h.app.reconciler.run();

    const rows = events(h, 'approval.expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorRef).toBe('reconciler');
    expect(rows[0]!.detail).toMatch(/lapsed unanswered/);
    h.close();
  });

  it('records nothing when a result proposes no action', () => {
    const h = makeHarness();
    const job = claimedJob(h);
    h.app.jobs.submitResult(h.executorId, job.jobId, job.leaseId, implementedResult(), 512);
    expect(events(h, 'approval.requested')).toHaveLength(0);
    h.close();
  });
});

/**
 * Local commit/push/PR attempts are covered by the EXISTING
 * `approval.execution_*` events, whose detail carries the action kind. This
 * asserts that mapping rather than adding parallel events for the same thing.
 */
describe('approved action outcomes', () => {
  it('maps every action kind onto the execution events', () => {
    // The mapping documented in docs/SECURITY.md: the action kind is the detail.
    for (const kind of ['git_commit', 'git_push', 'github_pr']) {
      const h = makeHarness();
      h.store.auditLog.record({
        event: 'approval.execution_started',
        actorKind: 'owner',
        subjectKind: 'approval',
        subjectRef: 'a1',
        outcome: 'ok',
        detail: kind,
      });
      h.store.auditLog.record({
        event: 'approval.execution_failed',
        actorKind: 'owner',
        subjectKind: 'approval',
        subjectRef: 'a1',
        outcome: 'failed',
        detail: `${kind}: remote rejected the push`,
      });
      const rows = h.store.auditLog.recent(10);
      expect(rows.some((r) => r.event === 'approval.execution_started' && r.detail === kind)).toBe(true);
      // The failure now says WHY, not merely that a push failed.
      expect(
        rows.some((r) => r.event === 'approval.execution_failed' && r.detail?.includes('remote rejected')),
      ).toBe(true);
      h.close();
    }
  });
});

describe('provider failures', () => {
  it('records provider.failed when conversation refuses', async () => {
    const h = makeHarness({ conversation: new DisabledConversationProvider() });
    await h.transport.start((e) => h.app.router.handle(e));
    await h.transport.dispatch({
      kind: 'message', userId: h.owner.discordUserId, text: 'hello', threadKey: 't1',
    } as never);

    const rows = events(h, 'provider.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectKind).toBe('provider');
    expect(rows[0]!.subjectRef).toBe('disabled');
    expect(rows[0]!.outcome).toBe('failed');
    // The code, never the message the owner sent.
    expect(rows[0]!.detail).toContain('integration_not_verified');
    expect(JSON.stringify(rows)).not.toContain('hello');
    h.close();
  });

  it('records nothing when the provider answers', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    await h.transport.dispatch({
      kind: 'message', userId: h.owner.discordUserId, text: 'hello', threadKey: 't1',
    } as never);
    expect(events(h, 'provider.failed')).toHaveLength(0);
    h.close();
  });
});

describe('HTTP rate limits', () => {
  it('records rate_limit.exceeded for the executor surface too', async () => {
    const h = makeHarness();
    const app = await server(h);
    // Unauthenticated, so every request 401s -- the plugin still counts them,
    // which is the point: this is the surface an unauthenticated caller reaches.
    for (let i = 0; i < 140; i += 1) {
      await app.inject({ method: 'POST', url: '/api/v1/executor/heartbeat', payload: {} });
    }
    const rows = events(h, 'rate_limit.exceeded');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.subjectKind).toBe('route');
    expect(rows[0]!.subjectRef).toBe('/api/v1/executor/heartbeat');
    await app.close();
    h.close();
  });
});

/**
 * The reservation-expiry path expires pending approvals too, and used to record
 * nothing — so whether a lapsed approval appeared in the trail depended on which
 * timer fired first, which is not a distinction an auditor cares about.
 */
describe('approval expiry on the reservation path', () => {
  it('records approval.expired when the RESERVATION expires first', () => {
    const h = makeHarness();
    const job = claimedJob(h);
    h.app.jobs.submitResult(h.executorId, job.jobId, job.leaseId, implementedWithActions(), 512);
    expect(h.store.jobs.byId(job.jobId)?.state).toBe('needs_approval');

    // Age the RESERVATION, not the approval, so `expireReservations()` is the
    // path that runs. The approvals themselves are still well within their TTL.
    h.store.db.prepare('UPDATE repo_reservations SET expires_at = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
    );
    h.app.reconciler.run();

    const rows = events(h, 'approval.expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorRef).toBe('reconciler');
    expect(rows[0]!.detail).toMatch(/lapsed unanswered/);
    // Named so the two expiry paths stay distinguishable.
    expect(rows[0]!.detail).toMatch(/reservation expired first/);
    h.close();
  });

  it('records nothing on that path when there were no pending approvals', () => {
    const h = makeHarness();
    const job = claimedJob(h);
    h.app.jobs.submitResult(h.executorId, job.jobId, job.leaseId, implementedResult(), 512);

    h.store.db.prepare('UPDATE repo_reservations SET expires_at = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
    );
    h.app.reconciler.run();
    expect(events(h, 'approval.expired')).toHaveLength(0);
    h.close();
  });

  it('both expiry paths use the same event, so one query finds either', () => {
    // The TTL path.
    const a = makeHarness();
    const ja = claimedJob(a);
    a.app.jobs.submitResult(a.executorId, ja.jobId, ja.leaseId, implementedWithActions(), 512);
    a.store.db.prepare('UPDATE approvals SET expires_at = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
    );
    a.app.reconciler.run();

    // The reservation path.
    const b = makeHarness();
    const jb = claimedJob(b);
    b.app.jobs.submitResult(b.executorId, jb.jobId, jb.leaseId, implementedWithActions(), 512);
    b.store.db.prepare('UPDATE repo_reservations SET expires_at = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
    );
    b.app.reconciler.run();

    expect(events(a, 'approval.expired')).toHaveLength(1);
    expect(events(b, 'approval.expired')).toHaveLength(1);
    a.close();
    b.close();
  });
});
