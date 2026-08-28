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
