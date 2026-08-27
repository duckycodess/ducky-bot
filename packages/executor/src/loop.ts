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
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Claim, run, report. Backoff with jitter covers laptop sleep, network changes
 * and coordinator restarts; the coordinator's reconciler heals anything
 * orphaned across the gap.
 */
export class ExecutorLoop {
  #stopped = false;
  /** Jobs this executor is running right now, reported on every heartbeat. */
  readonly #active = new Set<string>();
  private readonly workspaces = new Map<
    string,
    { workspaceId: string; agentName: string; workspacePath: string }
  >();

  constructor(private readonly deps: LoopDeps) {}

  stop(): void {
    this.#stopped = true;
  }

  /** Job ids currently being executed here. */
  activeJobIds(): string[] {
    return [...this.#active];
  }

  async runOnce(): Promise<'claimed' | 'idle'> {
    const claim = await this.deps.client.claim(this.deps.pollWaitMs);
    if (!claim) return 'idle';

    this.#active.add(claim.jobId);
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
        const message = isDuckyError(err) ? err.ownerMessage : (err as Error).message;
        log(`executor loop error: ${message}`);
        const jitter = Math.floor(backoff * 0.25 * Math.random());
        await sleep(backoff + jitter);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}
