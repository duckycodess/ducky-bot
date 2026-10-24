import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  DuckyError, EXECUTOR_HEADERS, canonicalRequest,
  type CancelAckRequest, type ClaimResponse, type ExecutorFailureReason,
  type HeartbeatRequest, type JobHeartbeatRequest, type JobHeartbeatResponse,
  type JobPauseRequest, type JobPauseResponse, type JobResultFile,
} from '@ducky/contracts';
import { ClaimResponseSchema } from '@ducky/contracts';

export interface CoordinatorClientOptions {
  readonly baseUrl: string;
  readonly executorId: string;
  readonly keyId: string;
  readonly bearerToken: string;
  readonly hmacSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Bounded retry of a pause report; injected so a test does not wait. */
  readonly pauseRetry?: { readonly attempts: number; readonly delayMs: number; readonly sleep?: (ms: number) => Promise<void> };
}

/** The pause report could not be delivered. The job is NOT failed because of it. */
export class PauseDeliveryError extends DuckyError {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super('not_found', message);
  }
}

/**
 * Outbound-only client.
 *
 * The executor never listens on a port: the WSL host has no inbound surface at
 * all. Every request is bearer-authenticated, body-signed, timestamped, and
 * nonced, so a captured request cannot be replayed.
 */
export class CoordinatorClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CoordinatorClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 40_000;
  }

  private async post(pathname: string, body: unknown, extraTimeoutMs = 0): Promise<Response> {
    const payload = JSON.stringify(body ?? {});
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(16).toString('base64url');
    const signature = createHmac('sha256', this.opts.hmacSecret)
      .update(
        canonicalRequest({
          method: 'POST',
          path: pathname,
          timestamp,
          nonce,
          bodySha256Hex: createHash('sha256').update(payload).digest('hex'),
        }),
      )
      .digest('base64url');

    return this.fetchImpl(new URL(pathname, this.opts.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.bearerToken}`,
        [EXECUTOR_HEADERS.executorId]: this.opts.executorId,
        [EXECUTOR_HEADERS.keyId]: this.opts.keyId,
        [EXECUTOR_HEADERS.timestamp]: timestamp,
        [EXECUTOR_HEADERS.nonce]: nonce,
        [EXECUTOR_HEADERS.signature]: signature,
      },
      body: payload,
      signal: AbortSignal.timeout(this.timeoutMs + extraTimeoutMs),
    });
  }

  private async expectJson(res: Response): Promise<unknown> {
    if (res.status === 401) throw new DuckyError('unauthorized', 'The coordinator rejected our credentials.');
    if (!res.ok) {
      throw new DuckyError('not_found', `Coordinator responded ${res.status}.`);
    }
    return res.json();
  }

  async heartbeat(body: Omit<HeartbeatRequest, 'executorId'>): Promise<void> {
    await this.expectJson(
      await this.post('/api/v1/executor/heartbeat', { ...body, executorId: this.opts.executorId }),
    );
  }

  async claim(waitMs: number): Promise<ClaimResponse | undefined> {
    const res = await this.post(
      '/api/v1/executor/claim',
      {
        executorId: this.opts.executorId,
        capabilities: ['herdr-pi'],
        waitMs,
        idempotencyKey: randomBytes(16).toString('base64url'),
      },
      waitMs,
    );
    // 204 = the long poll expired with nothing to do; 429 = another claim is
    // already in flight for this executor.
    if (res.status === 204 || res.status === 429) return undefined;
    const body = await this.expectJson(res);
    if (body === null) return undefined;
    return ClaimResponseSchema.parse(body);
  }

  /**
   * Renews the lease and optionally reports progress.
   *
   * The response carries the phase the coordinator ACCEPTED, which the caller
   * needs because the phase machine may refuse a reported edge. A refusal
   * arrives as HTTP 400 `invalid_transition`; it is surfaced with that exact
   * code so the supervisor can stop resending a doomed report instead of
   * failing every future lease renewal with it.
   */
  async jobHeartbeat(jobId: string, body: JobHeartbeatRequest): Promise<JobHeartbeatResponse> {
    const res = await this.post(`/api/v1/executor/jobs/${jobId}/heartbeat`, body);
    if (res.status === 400) {
      const code = await errorCode(res);
      if (code === 'invalid_transition') {
        throw new DuckyError('invalid_transition', 'The coordinator refused that work phase.');
      }
    }
    return (await this.expectJson(res)) as JobHeartbeatResponse;
  }

  async submitResult(jobId: string, leaseId: string, result: JobResultFile): Promise<unknown> {
    return this.expectJson(
      await this.post(`/api/v1/executor/jobs/${jobId}/result`, { leaseId, result }),
    );
  }

  async cancelAck(jobId: string, body: CancelAckRequest): Promise<unknown> {
    return this.expectJson(await this.post(`/api/v1/executor/jobs/${jobId}/cancel-ack`, body));
  }

  async registerWorkspace(
    jobId: string,
    body: {
      leaseId: string;
      workspaceId: string;
      agentName: string;
      label: string;
      mode: 'worktree' | 'direct';
      workspacePath: string;
      worktreePath?: string | null;
      state?: 'creating' | 'active' | 'closed';
    },
  ): Promise<unknown> {
    return this.expectJson(
      await this.post(`/api/v1/executor/jobs/${jobId}/workspace`, body),
    );
  }

  /** Idempotent bookkeeping; needs no lease because the job is already done. */
  async closeWorkspace(jobId: string, workspaceId: string): Promise<unknown> {
    return this.expectJson(
      await this.post(`/api/v1/executor/jobs/${jobId}/workspace/close`, { workspaceId }),
    );
  }

  /**
   * Reports a confirmed-quiet pause, retrying a transport failure or a 5xx a
   * bounded number of times -- safe, because the coordinator answers a repeat of
   * the same pause identically.
   *
   * A refusal is never retried and never downgraded: 404 is a coordinator that
   * does not know the route (version skew, a coordinated upgrade), not a
   * provider problem, and 409 or 400 is the coordinator saying the lease or the
   * proof is wrong. Each throws `PauseDeliveryError` and nothing else happens.
   */
  async pauseJob(jobId: string, body: JobPauseRequest): Promise<JobPauseResponse> {
    const retry = this.opts.pauseRetry ?? { attempts: 4, delayMs: 2_000 };
    const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: PauseDeliveryError | undefined;
    for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
      if (attempt > 0) await sleep(retry.delayMs * attempt);
      let res: Response;
      try {
        res = await this.post(`/api/v1/executor/jobs/${jobId}/pause`, body);
      } catch {
        last = new PauseDeliveryError(undefined, 'The coordinator could not be reached to report the pause.');
        continue;
      }
      if (res.ok) return (await res.json()) as JobPauseResponse;
      if (res.status >= 500 || res.status === 429) {
        last = new PauseDeliveryError(res.status, `Coordinator responded ${res.status} to the pause report.`);
        continue;
      }
      if (res.status === 401) throw new DuckyError('unauthorized', 'The coordinator rejected our credentials.');
      throw new PauseDeliveryError(
        res.status,
        res.status === 404
          ? 'The coordinator did not accept the pause route (version skew or unknown job).'
          : `The coordinator refused the pause (${res.status}).`,
      );
    }
    throw last ?? new PauseDeliveryError(undefined, 'The pause report was not attempted.');
  }

  async reportFailure(
    jobId: string,
    leaseId: string,
    reason: ExecutorFailureReason,
    extra: { detail?: string; workspaceId?: string; agentName?: string; quiescent?: boolean } = {},
  ): Promise<unknown> {
    return this.expectJson(
      await this.post(`/api/v1/executor/jobs/${jobId}/failure`, { leaseId, reason, ...extra }),
    );
  }
}

/**
 * The coordinator's machine-readable error code, when it sent one.
 *
 * Read defensively: the body is consumed only on an error path, and a
 * malformed one must not mask the status that was already observed.
 */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}
