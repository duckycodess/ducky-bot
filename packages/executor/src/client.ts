import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  DuckyError, EXECUTOR_HEADERS, PAUSE_DELIVERY_CAPABILITY, PAUSE_DISPOSITION_PATH,
  JOB_STATUS_PATH, JobStatusResponseSchema, PAUSE_REPORT_PATH, PauseDeliveryResponseSchema, canonicalRequest,
  type CancelAckRequest, type ClaimResponse, type ExecutorFailureReason,
  type HeartbeatRequest, type JobHeartbeatRequest, type JobHeartbeatResponse,
  type JobPauseRequest, type JobPauseResponse, type JobResultFile,
  type JobStatusResponse, type PauseDeliveryResponse, type PauseDispositionRequest,
  type PauseReportRequest,
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
    /**
     * Why. Every kind means "hold", never "forget": only a validated terminal
     * disposition retires an intent.
     *
     * - `transport`, `server`: could not reach it / it failed; try again;
     * - `version_skew`: no such route (an older coordinator), a coordinated-upgrade limit;
     * - `unknown_job`: the coordinator does not know the job;
     * - `mismatch`: the coordinator knows no attempt that matches the report;
     * - `refused`: it refused the report (400);
     * - `unauthorized`: our credentials were rejected;
     * - `malformed`: a 2xx whose body is not the disposition schema.
     */
    readonly kind:
      | 'transport' | 'server' | 'version_skew' | 'unknown_job' | 'mismatch' | 'refused'
      | 'unauthorized' | 'malformed' = 'transport',
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

  /**
   * `holdsNoPauseIntent` is an attestation, not a preference: the capability
   * `pause-delivery-v1` goes on the claim ONLY when this executor has no
   * unresolved pause intent, because the coordinator reads it as "I hold none"
   * and will otherwise not let this executor take a job whose lease expired
   * with a deferred charge.
   */
  async claim(waitMs: number, opts: { holdsNoPauseIntent?: boolean } = {}): Promise<ClaimResponse | undefined> {
    const res = await this.post(
      '/api/v1/executor/claim',
      {
        executorId: this.opts.executorId,
        capabilities: opts.holdsNoPauseIntent === true ? ['herdr-pi', PAUSE_DELIVERY_CAPABILITY] : ['herdr-pi'],
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

  get executorId(): string {
    return this.opts.executorId;
  }

  /**
   * Delivers a durable pause report (protocol 1). A transport failure, a 5xx or
   * a 429 is retried a bounded number of times -- safe, because the coordinator
   * answers a repeat of the same report id identically. Anything else is thrown
   * at once as a `PauseDeliveryError` of the matching kind, and a 2xx whose body
   * is not the disposition schema is `malformed`.
   */
  async pauseReport(jobId: string, body: PauseReportRequest): Promise<PauseDeliveryResponse> {
    const retry = this.opts.pauseRetry ?? { attempts: 4, delayMs: 2_000 };
    const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: PauseDeliveryError | undefined;
    for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
      if (attempt > 0) await sleep(retry.delayMs * attempt);
      try {
        return await this.deliveryCall(PAUSE_REPORT_PATH(jobId), body);
      } catch (err) {
        if (err instanceof PauseDeliveryError && (err.kind === 'transport' || err.kind === 'server')) {
          last = err;
          continue;
        }
        throw err;
      }
    }
    throw last ?? new PauseDeliveryError(undefined, 'The pause report was not attempted.');
  }

  /**
   * Where a job stands, for pruning durable local records. `gone` is the
   * coordinator saying it does not know the job at all (so it cannot be live);
   * anything else that is not a valid answer throws, and the caller keeps its
   * records.
   */
  async jobStatus(jobId: string): Promise<{ kind: 'known'; status: JobStatusResponse } | { kind: 'gone' }> {
    let res: Response;
    try {
      res = await this.post(JOB_STATUS_PATH(jobId), {});
    } catch {
      throw new PauseDeliveryError(undefined, 'The coordinator could not be reached.', 'transport');
    }
    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new PauseDeliveryError(res.status, 'Unreadable job status.', 'malformed');
      }
      const parsed = JobStatusResponseSchema.safeParse(json);
      if (!parsed.success) throw new PauseDeliveryError(res.status, 'Unexpected job status.', 'malformed');
      return { kind: 'known', status: parsed.data };
    }
    if (res.status === 404) {
      if ((await errorCode(res)) === 'not_found') return { kind: 'gone' };
      throw new PauseDeliveryError(404, 'The coordinator has no job status route (version skew).', 'version_skew');
    }
    throw new PauseDeliveryError(
      res.status,
      res.status === 409 ? 'The coordinator knows no such job of this executor.' : `Job status refused (${res.status}).`,
      res.status >= 500 || res.status === 429 ? 'server' : res.status === 409 ? 'mismatch' : 'refused',
    );
  }

  /** What became of a report. One attempt: the caller's loop is the retry. */
  async pauseDisposition(jobId: string, body: PauseDispositionRequest): Promise<PauseDeliveryResponse> {
    return this.deliveryCall(PAUSE_DISPOSITION_PATH(jobId), body);
  }

  private async deliveryCall(pathname: string, body: unknown): Promise<PauseDeliveryResponse> {
    let res: Response;
    try {
      res = await this.post(pathname, body);
    } catch {
      throw new PauseDeliveryError(undefined, 'The coordinator could not be reached.', 'transport');
    }
    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new PauseDeliveryError(res.status, 'The coordinator answered with an unreadable body.', 'malformed');
      }
      const parsed = PauseDeliveryResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new PauseDeliveryError(res.status, 'The coordinator answered with an unexpected body.', 'malformed');
      }
      return parsed.data;
    }
    if (res.status >= 500 || res.status === 429) {
      throw new PauseDeliveryError(res.status, `Coordinator responded ${res.status}.`, 'server');
    }
    if (res.status === 401) throw new PauseDeliveryError(401, 'The coordinator rejected our credentials.', 'unauthorized');
    const code = await errorCode(res);
    if (res.status === 404) {
      // `not_found` is the coordinator saying it does not know the JOB. Any other
      // 404 is a coordinator that has no such route.
      throw code === 'not_found'
        ? new PauseDeliveryError(404, 'The coordinator does not know that job.', 'unknown_job')
        : new PauseDeliveryError(404, 'The coordinator does not speak durable pause delivery (version skew).', 'version_skew');
    }
    if (res.status === 409) {
      throw new PauseDeliveryError(409, 'The coordinator knows no attempt that matches the report.', 'mismatch');
    }
    throw new PauseDeliveryError(res.status, `The coordinator refused the report (${res.status}).`, 'refused');
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
