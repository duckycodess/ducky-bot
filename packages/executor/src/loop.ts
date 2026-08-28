import { redact } from '@ducky/adapters';
import { isDuckyError } from '@ducky/contracts';
import type { PiOrchestrator } from '@ducky/adapters';
import type { CoordinatorClient } from './client.js';
import { runClaimedJob } from './runner.js';

export interface LoopDeps {
  readonly client: CoordinatorClient;
  readonly orchestrator: PiOrchestrator;
  readonly pollWaitMs: number;
  readonly version: string;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often to report structured executor state while a job runs. */
  readonly presenceIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Comfortably inside the offline window, so a running job never looks idle. */
const PRESENCE_INTERVAL_MS = 30_000;

/**
 * Claim, run, report. Backoff with jitter covers laptop sleep, network changes
 * and coordinator restarts; the coordinator's reconciler heals anything
 * orphaned across the gap.
 */
export class ExecutorLoop {
  #stopped = false;
  #presence: NodeJS.Timeout | undefined;
  /** Jobs this executor is running right now, reported on every heartbeat. */
  readonly #active = new Set<string>();
  private readonly workspaces = new Map<
    string,
    { workspaceId: string; agentName: string; workspacePath: string }
  >();

  constructor(private readonly deps: LoopDeps) {}

  stop(): void {
    this.#stopped = true;
    this.stopPresence();
  }

  /**
   * Reports structured executor state on a timer, independently of the claim
   * loop.
   *
   * The loop is blocked inside a running turn, so without this the general
   * heartbeat -- the one carrying capabilities and activeJobIds -- would go
   * silent for the whole job and `activeJobIds` would only ever be empty. The
   * supervisor's per-job heartbeat keeps the lease and liveness fresh; this
   * keeps the structured view useful, and deliberately does nothing with
   * cancellation so the two cannot interfere.
   */
  private startPresence(): void {
    if (this.#presence) return;
    const interval = this.deps.presenceIntervalMs ?? PRESENCE_INTERVAL_MS;
    this.#presence = setInterval(() => {
      void this.deps.client
        .heartbeat({
          version: this.deps.version,
          capabilities: ['herdr-pi'],
          activeJobIds: this.activeJobIds(),
        })
        .catch(() => {
          /* transient; the supervisor's job heartbeat is the liveness path */
        });
    }, interval);
    this.#presence.unref?.();
  }

  private stopPresence(): void {
    if (this.#presence) clearInterval(this.#presence);
    this.#presence = undefined;
  }

  /** Job ids currently being executed here. */
  activeJobIds(): string[] {
    return [...this.#active];
  }

  async runOnce(): Promise<'claimed' | 'idle'> {
    const claim = await this.deps.client.claim(this.deps.pollWaitMs);
    if (!claim) return 'idle';

    this.#active.add(claim.jobId);
    this.startPresence();
    try {
      await runClaimedJob(
        {
          client: this.deps.client,
          orchestrator: this.deps.orchestrator,
          recordedWorkspace: (jobId) => this.workspaces.get(jobId),
          onWorkspace: (jobId, info) =>
            this.workspaces.set(jobId, {
              workspaceId: info.workspaceId,
              agentName: info.agentName,
              workspacePath: info.workspacePath,
            }),
          ...(this.deps.log ? { log: this.deps.log } : {}),
        },
        claim,
      );
    } finally {
      this.#active.delete(claim.jobId);
      this.stopPresence();
    }
    return 'claimed';
  }

  async run(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const log = this.deps.log ?? (() => {});
    let backoff = 1000;

    while (!this.#stopped) {
      try {
        // Reports what is genuinely in flight, so the coordinator's liveness
        // view matches reality rather than always looking idle.
        await this.deps.client.heartbeat({
          version: this.deps.version,
          capabilities: ['herdr-pi'],
          activeJobIds: this.activeJobIds(),
        });
        const outcome = await this.runOnce();
        backoff = 1000;
        if (outcome === 'idle') await sleep(250);
      } catch (err) {
        // `ownerMessage` is already safe by construction; an arbitrary error
        // message is not, and this is the one place a non-Ducky error reaches a
        // log line.
        const message = isDuckyError(err) ? err.ownerMessage : redact((err as Error).message);
        log(`executor loop error: ${message}`);
        const jitter = Math.floor(backoff * 0.25 * Math.random());
        await sleep(backoff + jitter);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}
