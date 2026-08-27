import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  DuckyError, EXECUTOR_HEADERS, canonicalRequest,
  type CancelAckRequest, type ClaimResponse, type ExecutorFailureReason,
  type HeartbeatRequest, type JobHeartbeatRequest, type JobResultFile,
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

  async jobHeartbeat(
    jobId: string,
    body: JobHeartbeatRequest,
  ): Promise<{ cancelRequested: boolean; leaseExpiresAt: string }> {
    return (await this.expectJson(
      await this.post(`/api/v1/executor/jobs/${jobId}/heartbeat`, body),
    )) as { cancelRequested: boolean; leaseExpiresAt: string };
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

  async reportFailure(
    jobId: string,
    leaseId: string,
    reason: ExecutorFailureReason,
    extra: { detail?: string; workspaceId?: string; agentName?: string } = {},
  ): Promise<unknown> {
    return this.expectJson(
      await this.post(`/api/v1/executor/jobs/${jobId}/failure`, { leaseId, reason, ...extra }),
    );
  }
}
