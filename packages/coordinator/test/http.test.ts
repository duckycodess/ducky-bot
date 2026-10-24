import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTOR_HEADERS, canonicalRequest } from '@ducky/contracts';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { implementedResult, makeHarness } from './helpers.js';

let server: FastifyInstance | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(h: ReturnType<typeof makeHarness>): Promise<FastifyInstance> {
  server = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
  await server.ready();
  return server;
}

function sign(h: ReturnType<typeof makeHarness>, url: string, payload: unknown) {
  const body = JSON.stringify(payload ?? {});
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString('base64url');
  const signature = createHmac('sha256', h.hmac)
    .update(
      canonicalRequest({
        method: 'POST',
        path: url,
        timestamp,
        nonce,
        bodySha256Hex: createHash('sha256').update(Buffer.from(body)).digest('hex'),
      }),
    )
    .digest('base64url');
  return {
    method: 'POST' as const,
    url,
    payload: body,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${h.bearer}`,
      [EXECUTOR_HEADERS.executorId]: h.executorId,
      [EXECUTOR_HEADERS.keyId]: h.keyId,
      [EXECUTOR_HEADERS.timestamp]: timestamp,
      [EXECUTOR_HEADERS.nonce]: nonce,
      [EXECUTOR_HEADERS.signature]: signature,
    },
  };
}

describe('executor HTTP surface', () => {
  it('serves health endpoints without authentication', async () => {
    const h = makeHarness();
    const app = await boot(h);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    h.close();
  });

  it('answers every unauthenticated call with a bare 401', async () => {
    const h = makeHarness();
    const app = await boot(h);
    for (const url of [
      '/api/v1/executor/heartbeat',
      '/api/v1/executor/claim',
      '/api/v1/executor/jobs/x/result',
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
      expect(res.headers['www-authenticate']).toBeUndefined();
    }
    h.close();
  });

  it('accepts a signed heartbeat and refuses its replay', async () => {
    const h = makeHarness();
    const app = await boot(h);
    const req = sign(h, '/api/v1/executor/heartbeat', {
      executorId: h.executorId, version: '0.1.0', capabilities: [], activeJobIds: [],
    });
    expect((await app.inject(req)).statusCode).toBe(200);
    const replayed = await app.inject(req);
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toEqual({ error: 'replay_detected' });
    h.close();
  });

  it('returns 204 when a claim finds nothing', async () => {
    const h = makeHarness();
    const app = await boot(h);
    const res = await app.inject(
      sign(h, '/api/v1/executor/claim', {
        executorId: h.executorId, capabilities: [], waitMs: 0, idempotencyKey: 'abcdefgh',
      }),
    );
    expect(res.statusCode).toBe(204);
    h.close();
  });

  it('runs a full claim and result round trip', async () => {
    const h = makeHarness();
    const app = await boot(h);
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });

    const claimRes = await app.inject(
      sign(h, '/api/v1/executor/claim', {
        executorId: h.executorId, capabilities: [], waitMs: 0, idempotencyKey: 'abcdefgh',
      }),
    );
    expect(claimRes.statusCode).toBe(200);
    const claim = claimRes.json() as { jobId: string; leaseId: string };

    const resultRes = await app.inject(
      sign(h, `/api/v1/executor/jobs/${claim.jobId}/result`, {
        leaseId: claim.leaseId, result: implementedResult(),
      }),
    );
    expect(resultRes.statusCode).toBe(200);
    expect(resultRes.json()).toMatchObject({ accepted: true, duplicate: false, state: 'completed' });
    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    h.close();
  });

  it('reports a conflicting result on the same lease as 409', async () => {
    const h = makeHarness();
    const app = await boot(h);
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const claim = (
      await app.inject(
        sign(h, '/api/v1/executor/claim', {
          executorId: h.executorId, capabilities: [], waitMs: 0, idempotencyKey: 'abcdefgh',
        }),
      )
    ).json() as { jobId: string; leaseId: string };

    await app.inject(
      sign(h, `/api/v1/executor/jobs/${claim.jobId}/result`, {
        leaseId: claim.leaseId, result: implementedResult(),
      }),
    );
    const conflict = await app.inject(
      sign(h, `/api/v1/executor/jobs/${claim.jobId}/result`, {
        leaseId: claim.leaseId, result: implementedResult({ summary: 'different' }),
      }),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'result_conflict' });
    h.close();
  });

  it('rate limits a chatty executor', async () => {
    const h = makeHarness();
    const app = await boot(h);
    let limited = 0;
    for (let i = 0; i < 130; i += 1) {
      const res = await app.inject(
        sign(h, '/api/v1/executor/heartbeat', {
          executorId: h.executorId, version: '0.1.0', capabilities: [], activeJobIds: [],
        }),
      );
      if (res.statusCode === 429) {
        limited += 1;
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(limited).toBeGreaterThan(0);
    h.close();
  });

  it('never logs a raw URL, header set or body', async () => {
    const lines: string[] = [];
    const h = makeHarness();
    server = await buildServer({
      store: h.store,
      jobs: h.app.jobs,
      credentials: h.app.credentials,
      logger: { level: 'trace', stream: { write: (s: string) => lines.push(s) } },
    });
    await server.ready();
    await server.inject(
      sign(h, '/api/v1/executor/heartbeat', {
        executorId: h.executorId, version: '0.1.0', capabilities: [], activeJobIds: [],
      }),
    );
    const dump = lines.join('\n');
    expect(dump).not.toContain(h.bearer);
    expect(dump).not.toContain(h.hmac);
    expect(dump).not.toContain('x-ducky-signature');
    h.close();
  });
});

/**
 * `/readyz` used to be `SELECT 1`, which reports ready for an instance with a
 * database it cannot migrate, no credential loaded, and no executor that has
 * ever connected -- i.e. one where a submitted job can never run.
 */
describe('readiness', () => {
  it('is ready when the database, migrations, a credential and an executor are all present', async () => {
    const h = makeHarness();
    const app = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    // `info` is operator context, never a readiness condition: retention is off
    // by default, so an instance that has never run it is perfectly ready.
    expect(res.json()).toEqual({ ok: true, info: { retentionRanHoursAgo: null } });
    await app.close();
  });

  it('is NOT ready when no executor has ever been seen', async () => {
    const h = makeHarness({ registerExecutor: false });
    const app = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { notReady: string[] }).notReady).toContain('executor');
    await app.close();
  });

  it('reports reason CODES only, never a path or an error message', async () => {
    const h = makeHarness({ registerExecutor: false });
    const app = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
    const body = (await app.inject({ method: 'GET', url: '/readyz' })).body;
    expect(body).not.toMatch(/\/home\//);
    expect(body).not.toMatch(/Error|sqlite|SELECT/i);
    expect(JSON.parse(body)).toEqual({
      ok: false,
      notReady: expect.any(Array),
      // Counts and nulls only. An unauthenticated endpoint is not a diagnostics
      // channel, so `info` carries no path, no id and no message.
      info: { retentionRanHoursAgo: null },
    });
    await app.close();
  });

  it('reports how long ago retention ran, in whole hours and nothing else', async () => {
    const h = makeHarness({ env: { DUCKY_RETENTION_ENABLED: 'true' } });
    await h.app.retention.run('manual');
    const app = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });

    const body = (await app.inject({ method: 'GET', url: '/readyz' })).json() as {
      info: { retentionRanHoursAgo: number | null };
    };

    expect(body.info.retentionRanHoursAgo).toBe(0);
    await app.close();
    h.close();
  });

  it('healthz stays liveness-only and says nothing about readiness', async () => {
    const h = makeHarness({ registerExecutor: false });
    const app = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe('executor pause route', () => {
  const REG = {
    workspaceId: 'wX', label: 'ducky-mgd:demo', mode: 'direct', agentName: 'ducky-pi-demo',
    workspacePath: '/tmp/ducky-demo', state: 'active',
  };
  const PAUSE = {
    cause: 'agent_idle_no_result', workspaceId: 'wX', agentName: 'ducky-pi-demo',
    agentStatus: 'idle', quiescent: true,
  };

  async function claimed(h: ReturnType<typeof makeHarness>, app: FastifyInstance) {
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const claim = (
      await app.inject(
        sign(h, '/api/v1/executor/claim', {
          executorId: h.executorId, capabilities: [], waitMs: 0, idempotencyKey: 'abcdefgh',
        }),
      )
    ).json() as { jobId: string; leaseId: string };
    const reg = await app.inject(
      sign(h, `/api/v1/executor/jobs/${claim.jobId}/workspace`, { leaseId: claim.leaseId, ...REG }),
    );
    expect(reg.statusCode).toBe(200);
    return claim;
  }

  it('pauses a quiet job, answers a retried report identically, and refuses everything else', async () => {
    const h = makeHarness();
    const app = await boot(h);
    const claim = await claimed(h, app);
    const url = `/api/v1/executor/jobs/${claim.jobId}/pause`;

    const first = await app.inject(sign(h, url, { leaseId: claim.leaseId, ...PAUSE }));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ state: 'needs_owner_input', paused: true });
    expect(h.store.jobs.byId(claim.jobId)).toMatchObject({ state: 'needs_owner_input', attempts: 0 });

    const again = await app.inject(sign(h, url, { leaseId: claim.leaseId, ...PAUSE }));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());

    const stale = await app.inject(sign(h, url, { leaseId: 'not-the-lease', ...PAUSE }));
    expect(stale.statusCode).toBe(409);

    for (const bad of [{ quiescent: false }, { agentStatus: 'working' }, { cause: 'quota' }]) {
      const res = await app.inject(sign(h, url, { leaseId: claim.leaseId, ...PAUSE, ...bad }));
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }

    const anon = await app.inject({
      method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(anon.statusCode).toBe(401);
    h.close();
  });
});

describe('executor durable pause-delivery routes', () => {
  const REG = {
    workspaceId: 'wX', label: 'ducky-mgd:demo', mode: 'direct', agentName: 'ducky-pi-demo',
    workspacePath: '/tmp/ducky-demo', state: 'active',
  };
  const REPORT = {
    protocol: 1, reportId: '11111111-1111-4111-8111-111111111111', cause: 'agent_idle_no_result',
    workspaceId: 'wX', agentName: 'ducky-pi-demo', agentStatus: 'idle', quiescent: true,
  };

  async function claimed(h: ReturnType<typeof makeHarness>, app: FastifyInstance, capabilities: string[]) {
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const claim = (
      await app.inject(
        sign(h, '/api/v1/executor/claim', {
          executorId: h.executorId, capabilities, waitMs: 0, idempotencyKey: 'abcdefgh',
        }),
      )
    ).json() as { jobId: string; leaseId: string; pauseProtocol?: number };
    expect(
      (await app.inject(sign(h, `/api/v1/executor/jobs/${claim.jobId}/workspace`, { leaseId: claim.leaseId, ...REG })))
        .statusCode,
    ).toBe(200);
    return claim;
  }

  it('negotiates on the claim, answers a structured disposition, and refuses with distinguishable errors', async () => {
    const h = makeHarness();
    const app = await boot(h);
    const claim = await claimed(h, app, ['herdr-pi', 'pause-delivery-v1']);
    expect(claim.pauseProtocol).toBe(1);
    const report = `/api/v1/executor/jobs/${claim.jobId}/pause-report`;
    const disposition = `/api/v1/executor/jobs/${claim.jobId}/pause-disposition`;
    const digest = createHash('sha256').update(claim.leaseId).digest('hex').slice(0, 16);
    const query = { ...REPORT, leaseDigest: digest } as Record<string, unknown>;
    delete query['agentStatus'];
    delete query['quiescent'];

    const pending = await app.inject(sign(h, disposition, query));
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ disposition: 'pending', reportId: REPORT.reportId, jobId: claim.jobId });

    const first = await app.inject(sign(h, report, { leaseId: claim.leaseId, ...REPORT }));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ disposition: 'paused', state: 'needs_owner_input', leaseDigest: digest });
    expect(h.store.jobs.byId(claim.jobId)).toMatchObject({ state: 'needs_owner_input', attempts: 0 });

    const again = await app.inject(sign(h, report, { leaseId: claim.leaseId, ...REPORT }));
    expect(again.json()).toEqual(first.json());
    expect((await app.inject(sign(h, disposition, query))).json()).toMatchObject({ disposition: 'paused' });

    // 409 lease_mismatch (nothing matches), 404 not_found (no such job), 400 (schema / reused id).
    const stale = await app.inject(
      sign(h, report, { leaseId: 'not-the-lease', ...REPORT, reportId: '22222222-2222-4222-8222-222222222222' }),
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'lease_mismatch' });
    const unknown = await app.inject(sign(h, '/api/v1/executor/jobs/no-such-job/pause-report', { leaseId: 'l', ...REPORT }));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });
    for (const bad of [{ protocol: 2 }, { quiescent: false }, { agentStatus: 'working' }, { reportId: 'x' }, { extra: 1 }]) {
      const res = await app.inject(sign(h, report, { leaseId: claim.leaseId, ...REPORT, ...bad }));
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const reused = await app.inject(sign(h, report, { leaseId: claim.leaseId, ...REPORT, agentName: 'ducky-pi-x' }));
    expect(reused.statusCode).toBe(400);

    for (const url of [report, disposition]) {
      const anon = await app.inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json' } });
      expect(anon.statusCode).toBe(401);
    }
    h.close();
  });

  it('does not negotiate with an executor that did not advertise the capability', async () => {
    const h = makeHarness();
    const app = await boot(h);
    const claim = await claimed(h, app, ['herdr-pi']);
    expect(claim.pauseProtocol).toBeUndefined();
    h.close();
  });
});
