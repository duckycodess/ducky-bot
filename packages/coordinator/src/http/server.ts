import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  CLAIM_MAX_WAIT_MS, HTTP_BODY_LIMIT, HTTP_CONNECTION_TIMEOUT_MS, HTTP_KEEPALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS, RATE_LIMITS, RESULT_MAX_BYTES,
  CancelAckRequestSchema, ClaimRequestSchema, HeartbeatRequestSchema,
  JobFailureRequestSchema, JobHeartbeatRequestSchema, JobResultRequestSchema,
  WorkspaceCloseRequestSchema, WorkspaceRegistrationRequestSchema,
  EXECUTOR_HEADERS, isDuckyError,
} from '@ducky/contracts';
import type { ExecutorCredentialStore } from '@ducky/adapters';
import type { Store } from '@ducky/persistence';
import { verifyExecutorRequest } from '../security/executor-auth.js';
import type { JobsService } from '../domain/jobs.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBodyBuffer?: Buffer;
    executorId?: string;
  }
}

export interface ServerDeps {
  readonly store: Store;
  readonly jobs: JobsService;
  readonly credentials: ExecutorCredentialStore;
  readonly logger?: boolean | object;
}

/** One in-flight long poll per executor; a second gets 429 instead of a socket. */
class ClaimRegistry {
  readonly #active = new Set<string>();
  tryEnter(executorId: string): boolean {
    if (this.#active.has(executorId)) return false;
    this.#active.add(executorId);
    return true;
  }
  leave(executorId: string): void {
    this.#active.delete(executorId);
  }
}

const generic401 = { error: 'unauthorized' } as const;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: HTTP_BODY_LIMIT,
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: HTTP_KEEPALIVE_TIMEOUT_MS,
    connectionTimeout: HTTP_CONNECTION_TIMEOUT_MS,
    // Never log a raw URL, query string, header set, or body.
    // (Fastify 5 marks this deprecated in favour of `logController`, which
    // requires a full controller object; revisit when moving to Fastify 6.)
    disableRequestLogging: true,
    logger: deps.logger ?? false,
  });

  // Keep the exact bytes: the HMAC covers sha256(rawBody), so re-serializing
  // would silently break every signature.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBodyBuffer = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(new Error('invalid json'), undefined);
      }
    },
  );

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req: FastifyRequest) =>
      req.executorId ?? String(req.headers[EXECUTOR_HEADERS.executorId] ?? req.ip),
  });

  const claims = new ClaimRegistry();

  const authed = (
    handler: (req: FastifyRequest, executorId: string) => Promise<unknown>,
  ) =>
    async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
      let executorId: string;
      try {
        const verified = verifyExecutorRequest(
          {
            method: req.method,
            path: req.url.split('?')[0]!,
            headers: req.headers as Record<string, string | string[] | undefined>,
            rawBody: req.rawBodyBuffer ?? Buffer.alloc(0),
          },
          { store: deps.credentials, executors: deps.store.executors },
        );
        executorId = verified.executorId;
        req.executorId = executorId;
      } catch (err) {
        if (isDuckyError(err) && err.code === 'replay_detected') {
          return reply.code(409).send({ error: 'replay_detected' });
        }
        return reply.code(401).send(generic401);
      }
      try {
        const out = await handler(req, executorId);
        // A long poll that found nothing answers 204 rather than an empty body.
        if (out === null || out === undefined) return reply.code(204).send();
        return reply.send(out);
      } catch (err) {
        return sendDomainError(reply, err);
      }
    };

  app.post(
    '/api/v1/executor/heartbeat',
    { config: { rateLimit: { max: RATE_LIMITS.heartbeat.max, timeWindow: RATE_LIMITS.heartbeat.windowMs } } },
    authed(async (req, executorId) => {
      const body = HeartbeatRequestSchema.parse(req.body);
      deps.store.executors.touchExecutor(executorId, body.version);
      return {
        serverTime: new Date().toISOString(),
        leaseTtlMs: 5 * 60_000,
        pollWaitMs: CLAIM_MAX_WAIT_MS,
      };
    }),
  );

  app.post(
    '/api/v1/executor/claim',
    { config: { rateLimit: { max: RATE_LIMITS.claim.max, timeWindow: RATE_LIMITS.claim.windowMs } } },
    authed(async (req, executorId) => {
      const body = ClaimRequestSchema.parse(req.body);
      if (!claims.tryEnter(executorId)) {
        throw Object.assign(new Error('claim in flight'), { statusCode: 429 });
      }
      try {
        deps.store.executors.touchExecutor(executorId, null);
        const waitMs = Math.min(body.waitMs, CLAIM_MAX_WAIT_MS);
        const deadline = Date.now() + waitMs;
        for (;;) {
          const claimed = deps.jobs.claim(executorId, body.idempotencyKey);
          if (claimed) return claimed;
          if (Date.now() >= deadline) return null;
          await sleep(Math.min(500, Math.max(50, deadline - Date.now())));
        }
      } finally {
        claims.leave(executorId);
      }
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/executor/jobs/:id/heartbeat',
    { config: { rateLimit: { max: RATE_LIMITS.jobHeartbeat.max, timeWindow: RATE_LIMITS.jobHeartbeat.windowMs } } },
    authed(async (req, executorId) => {
      const body = JobHeartbeatRequestSchema.parse(req.body);
      const { id } = req.params as { id: string };
      return deps.jobs.jobHeartbeat(executorId, id, body.leaseId, body.progress);
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/executor/jobs/:id/result',
    { config: { rateLimit: { max: RATE_LIMITS.result.max, timeWindow: RATE_LIMITS.result.windowMs } } },
    authed(async (req, executorId) => {
      const size = req.rawBodyBuffer?.length ?? 0;
      if (size > RESULT_MAX_BYTES) {
        throw Object.assign(new Error('result too large'), { statusCode: 413 });
      }
      const body = JobResultRequestSchema.parse(req.body);
      const { id } = req.params as { id: string };
      const verdict = deps.jobs.submitResult(executorId, id, body.leaseId, body.result, size);
      return {
        state: verdict.kind === 'duplicate' ? verdict.state : verdict.state,
        accepted: true,
        duplicate: verdict.duplicate,
      };
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/executor/jobs/:id/cancel-ack',
    { config: { rateLimit: { max: RATE_LIMITS.cancelAck.max, timeWindow: RATE_LIMITS.cancelAck.windowMs } } },
    authed(async (req, executorId) => {
      const body = CancelAckRequestSchema.parse(req.body);
      const { id } = req.params as { id: string };
      return deps.jobs.cancelAck(executorId, id, body.leaseId, body.terminated, body.note);
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/executor/jobs/:id/failure',
    { config: { rateLimit: { max: RATE_LIMITS.result.max, timeWindow: RATE_LIMITS.result.windowMs } } },
    authed(async (req, executorId) => {
      const body = JobFailureRequestSchema.parse(req.body);
      const { id } = req.params as { id: string };
      return deps.jobs.reportFailure(executorId, id, body.leaseId, body.reason, {
        ...(body.detail === undefined ? {} : { detail: body.detail }),
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        ...(body.agentName === undefined ? {} : { agentName: body.agentName }),
      });
    }),
  );

  // Registered before an agent starts, so ownership is durable even if the
  // executor dies between creating a workspace and prompting it.
  app.post<{ Params: { id: string } }>(
    '/api/v1/executor/jobs/:id/workspace',
    { config: { rateLimit: { max: RATE_LIMITS.jobHeartbeat.max, timeWindow: RATE_LIMITS.jobHeartbeat.windowMs } } },
    authed(async (req, executorId) => {
      const body = WorkspaceRegistrationRequestSchema.parse(req.body);
      const { id } = req.params as { id: string };
      return deps.jobs.registerWorkspace(executorId, id, body.leaseId, {
        workspaceId: body.workspaceId,
        label: body.label,
        mode: body.mode,
        agentName: body.agentName,
        workspacePath: body.workspacePath,
        worktreePath: body.worktreePath ?? null,
        state: body.state,
      });
    }),
  );

  // Bookkeeping after the executor closed a workspace. Allowed on a terminal
  // job precisely because the result already cleared the lease.
  app.post<{ Params: { id: string } }>(
    '/api/v1/executor/jobs/:id/workspace/close',
    { config: { rateLimit: { max: RATE_LIMITS.jobHeartbeat.max, timeWindow: RATE_LIMITS.jobHeartbeat.windowMs } } },
    authed(async (req, executorId) => {
      const body = WorkspaceCloseRequestSchema.parse(req.body);
      const { id } = req.params as { id: string };
      return deps.jobs.markWorkspaceClosed(executorId, id, body.workspaceId);
    }),
  );

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      deps.store.db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  return app;
}

function sendDomainError(reply: import('fastify').FastifyReply, err: unknown) {
  const status = (err as { statusCode?: number }).statusCode;
  if (status === 429) return reply.code(429).send({ error: 'rate_limited' });
  if (status === 413) return reply.code(413).send({ error: 'result_rejected' });
  if (isDuckyError(err)) {
    switch (err.code) {
      case 'lease_mismatch':
      case 'result_conflict':
      case 'replay_detected':
        return reply.code(409).send({ error: err.code });
      case 'unauthorized':
        return reply.code(401).send(generic401);
      case 'not_found':
        return reply.code(404).send({ error: 'not_found' });
      case 'rate_limited':
        return reply.code(429).send({ error: 'rate_limited' });
      default:
        return reply.code(400).send({ error: err.code });
    }
  }
  if (err instanceof Error && err.name === 'ZodError') {
    return reply.code(400).send({ error: 'invalid_input' });
  }
  return reply.code(500).send({ error: 'internal' });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
