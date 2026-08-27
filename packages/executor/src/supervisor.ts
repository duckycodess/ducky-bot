import { LEASE_HEARTBEAT_MS } from '@ducky/contracts';
import type { CoordinatorClient } from './client.js';

export interface SupervisorDeps {
  readonly client: CoordinatorClient;
  readonly jobId: string;
  readonly leaseId: string;
  readonly intervalMs?: number;
  readonly onCancelRequested?: () => void;
  readonly log?: (line: string) => void;
}

/**
 * Keeps the lease alive while a turn runs, and watches for a cancellation the
 * owner requested after the job was already claimed.
 *
 * Without this a running job holds its lease only until it expires, so a
 * cancellation could sit unnoticed for the whole turn and the coordinator
 * might reasonably conclude the executor had died and requeue the work.
 */
export class JobSupervisor {
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #cancelSeen = false;
  #stopped = false;

  constructor(private readonly deps: SupervisorDeps) {}

  /** Aborted as soon as the coordinator reports a cancellation request. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get cancelRequested(): boolean {
    return this.#cancelSeen;
  }

  start(): void {
    const interval = this.deps.intervalMs ?? LEASE_HEARTBEAT_MS;
    const beat = async (): Promise<void> => {
      if (this.#stopped) return;
      try {
        const res = await this.deps.client.jobHeartbeat(this.deps.jobId, {
          leaseId: this.deps.leaseId,
        });
        if (res.cancelRequested && !this.#cancelSeen) {
          this.#cancelSeen = true;
          this.deps.log?.(`job ${this.deps.jobId}: cancellation requested by the owner`);
          this.deps.onCancelRequested?.();
          this.#controller.abort();
        }
      } catch (err) {
        // A transient failure must not kill the turn; the lease has slack, and
        // a genuinely dead coordinator is handled by lease expiry on its side.
        this.deps.log?.(`job ${this.deps.jobId}: heartbeat failed (${(err as Error).message})`);
      }
    };

    this.#timer = setInterval(() => void beat(), interval);
    this.#timer.unref?.();
    void beat();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
