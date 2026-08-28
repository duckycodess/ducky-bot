import {
  LEASE_HEARTBEAT_MS, PHASE_REPORT_DEBOUNCE_MS, isDuckyError,
  type JobWorkPhase,
} from '@ducky/contracts';
import { FilePhaseReader, redact, shouldReportPhase, type PhaseReader } from '@ducky/adapters';
import type { CoordinatorClient } from './client.js';

export interface SupervisorDeps {
  readonly client: CoordinatorClient;
  readonly jobId: string;
  readonly leaseId: string;
  readonly intervalMs?: number;
  readonly onCancelRequested?: () => void;
  readonly log?: (line: string) => void;
  /** Debounce window for a coalesced phase beat. */
  readonly phaseDebounceMs?: number;
  /** Reads the phase Pi reports about itself. */
  readonly phaseReader?: PhaseReader;
}

/**
 * Keeps the lease alive while a turn runs, watches for a cancellation the owner
 * requested after the job was already claimed, and carries work-phase reports.
 *
 * Without this a running job holds its lease only until it expires, so a
 * cancellation could sit unnoticed for the whole turn and the coordinator
 * might reasonably conclude the executor had died and requeue the work.
 *
 * ## Phases
 *
 * A phase that only rode the regular interval would take up to
 * `LEASE_HEARTBEAT_MS` to appear, which is useless on a short turn. So
 * `reportPhase` schedules a COALESCED extra beat: several reports in quick
 * succession cost one request, and the regular interval is never reset or
 * cancelled by one -- lease renewal must not depend on phase traffic.
 */
export class JobSupervisor {
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #phaseTimer: NodeJS.Timeout | undefined;
  #cancelSeen = false;
  #stopped = false;
  #beatInFlight = false;

  /** Reported by the coordinator, so it is the phase that actually took effect. */
  #acceptedPhase: JobWorkPhase | null = null;
  #pendingPhase: JobWorkPhase | undefined;
  /** Set once the workspace exists, which is when a phase file can appear. */
  #workspacePath: string | undefined;

  private readonly phaseReader: PhaseReader;

  constructor(private readonly deps: SupervisorDeps) {
    this.phaseReader = deps.phaseReader ?? new FilePhaseReader();
  }

  /** Aborted as soon as the coordinator reports a cancellation request. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get cancelRequested(): boolean {
    return this.#cancelSeen;
  }

  /** The phase the coordinator last accepted. Evidence, not a local guess. */
  get acceptedPhase(): JobWorkPhase | null {
    return this.#acceptedPhase;
  }

  /**
   * Where to look for Pi's own phase report. Only known once the workspace (or
   * worktree checkout) exists, which is why it is set rather than constructed.
   */
  watchWorkspace(workspacePath: string): void {
    this.#workspacePath = workspacePath;
  }

  /**
   * Records a phase and nudges a beat so it becomes visible in seconds.
   *
   * Silently ignores a phase the shared machine would refuse: a refused report
   * fails the entire heartbeat, and losing a lease renewal to report a phase
   * that could never be accepted is a bad trade. The coordinator remains the
   * authority -- this only declines to send a report already known to be
   * doomed.
   */
  reportPhase(phase: JobWorkPhase): void {
    if (this.#stopped) return;
    if (!shouldReportPhase(this.#acceptedPhase, phase)) return;
    this.#pendingPhase = phase;
    this.#schedulePhaseBeat();
  }

  #schedulePhaseBeat(): void {
    if (this.#phaseTimer !== undefined || this.#stopped) return;
    const wait = this.deps.phaseDebounceMs ?? PHASE_REPORT_DEBOUNCE_MS;
    this.#phaseTimer = setTimeout(() => {
      this.#phaseTimer = undefined;
      void this.#beat();
    }, wait);
    this.#phaseTimer.unref?.();
  }

  async #beat(): Promise<void> {
    if (this.#stopped) return;
    // One in flight at a time: a coalesced phase beat must never overlap the
    // regular one and burn two nonces for the same information.
    if (this.#beatInFlight) return;
    this.#beatInFlight = true;

    const phase = this.#pendingPhase;
    try {
      const res = await this.deps.client.jobHeartbeat(this.deps.jobId, {
        leaseId: this.deps.leaseId,
        ...(phase === undefined ? {} : { progress: { kind: 'phase', message: phase, phase } }),
      });

      if (phase !== undefined) this.#pendingPhase = undefined;
      if (res.workPhase !== undefined && res.workPhase !== null) {
        if (res.workPhase !== this.#acceptedPhase) {
          this.deps.log?.(`job ${this.deps.jobId}: phase accepted as ${res.workPhase}`);
        }
        this.#acceptedPhase = res.workPhase;
      }

      if (res.cancelRequested && !this.#cancelSeen) {
        this.#cancelSeen = true;
        this.deps.log?.(`job ${this.deps.jobId}: cancellation requested by the owner`);
        this.deps.onCancelRequested?.();
        this.#controller.abort();
      }
    } catch (err) {
      // A REFUSED phase is not a transport problem and must not be retried:
      // the coordinator has already decided that edge is illegal, and resending
      // it would fail every future renewal too.
      if (isDuckyError(err) && err.code === 'invalid_transition') {
        this.#pendingPhase = undefined;
        this.deps.log?.(`job ${this.deps.jobId}: phase report refused (${phase ?? 'none'})`);
      } else {
        // A transient failure must not kill the turn; the lease has slack, and
        // a genuinely dead coordinator is handled by lease expiry on its side.
        this.deps.log?.(
          `job ${this.deps.jobId}: heartbeat failed (${redact((err as Error).message).slice(0, 200)})`,
        );
      }
    } finally {
      this.#beatInFlight = false;
    }
  }

  /** Picks up a phase Pi wrote for itself, if any, and reports it. */
  async #pollPhaseFile(): Promise<void> {
    const workspacePath = this.#workspacePath;
    if (workspacePath === undefined) return;
    try {
      const phase = await this.phaseReader.read(workspacePath);
      if (phase !== undefined) this.reportPhase(phase);
    } catch {
      /* the phase is a nicety; never let reading it disturb the turn */
    }
  }

  start(): void {
    const interval = this.deps.intervalMs ?? LEASE_HEARTBEAT_MS;
    const tick = async (): Promise<void> => {
      await this.#pollPhaseFile();
      await this.#beat();
    };

    this.#timer = setInterval(() => void tick(), interval);
    this.#timer.unref?.();
    void tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#phaseTimer) clearTimeout(this.#phaseTimer);
    this.#phaseTimer = undefined;
  }
}
