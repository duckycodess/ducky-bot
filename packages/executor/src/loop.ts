import { redact } from '@ducky/adapters';
import { isDuckyError } from '@ducky/contracts';
import type { PiOrchestrator } from '@ducky/adapters';
import type { CoordinatorClient } from './client.js';
import { runClaimedJob } from './runner.js';
import type { HeadroomVerdict } from './memory-headroom.js';
import { reconcileIntent } from './pause-delivery.js';
import { sweepJournal } from './journal-sweep.js';
import type { FileDispatchJournal } from './dispatch-journal-file.js';
import type { PauseIntentStore } from './pause-intents.js';

export interface LoopDeps {
  readonly client: CoordinatorClient;
  readonly orchestrator: PiOrchestrator;
  /**
   * The durable outbox of pauses this executor owes. REQUIRED. While any record
   * is pending or unreadable no claim is made and no prompt is sent, and every
   * claim that IS made attests that none is pending.
   */
  readonly intents: PauseIntentStore;
  /** Drops the dispatch journal of a job the coordinator reports nothing will ever run again. */
  readonly forgetJournal?: (jobId: string) => void;
  /**
   * The durable dispatch journal. When present, the loop prunes entries of jobs
   * the coordinator confirms are finished (at startup, periodically, and whenever
   * it is full) and makes NO claim while it has no room, so a started agent is
   * never left around a job that cannot be journaled.
   */
  readonly journal?: FileDispatchJournal;
  readonly journalHasRoomFor?: (jobId: string) => boolean;
  /** How often to prune the journal when it is not full. */
  readonly journalSweepMs?: number;
  /**
   * Whether the agent runtime is reachable. When it is not, no claim is made: a
   * job claimed into an unreachable Herdr can only fail, and a pause owed to the
   * coordinator cannot be proved without it. Omitting it means no check.
   */
  readonly herdrAvailable?: () => Promise<boolean>;
  /** How long to wait before reconciling an unresolved pause again. */
  readonly pauseRetryMs?: number;
  readonly pollWaitMs: number;
  readonly version: string;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often to report structured executor state while a job runs. */
  readonly presenceIntervalMs?: number;
  /**
   * Answers whether the account has room for another engineering job. Omitting
   * it means no check. When present and `ok: false`, no claim is attempted, so
   * the job stays queued instead of being started into a nearly full slice.
   */
  readonly headroom?: () => Promise<HeadroomVerdict>;
  /** How long to wait before re-checking after a refusal. */
  readonly headroomRetryMs?: number;
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
  /** The reason the last claim was withheld, so a long hold logs once. */
  #heldFor: string | undefined;
  /** Why claims are withheld for a pause, so a long hold logs once. */
  #pauseHeldFor: string | undefined;
  #lastJournalSweep = 0;
  #journalFull = false;
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

  /**
   * Settles every pause this executor owes BEFORE it can claim or prompt:
   * startup, and every tick after. `'clear'` means nothing is owed and nothing is
   * unreadable -- the only state in which a claim may be attempted, and what the
   * claim's attestation rests on. Everything else holds, and says why once.
   */
  async reconcilePauses(): Promise<'clear' | 'held'> {
    const log = this.deps.log ?? (() => {});
    const owed = this.deps.intents.list();
    if (owed.blocked.length > 0) {
      const key = `blocked:${owed.blocked.join('|')}`;
      if (this.#pauseHeldFor !== key) {
        this.#pauseHeldFor = key;
        log(
          `claims withheld: ${owed.blocked.length} pause record(s) cannot be trusted ` +
            `(${owed.blocked.slice(0, 3).join('; ')}); nothing was deleted or repaired`,
        );
      }
      return 'held';
    }
    let held = false;
    for (const intent of owed.intents) {
      const res = await reconcileIntent(
        {
          client: this.deps.client,
          orchestrator: this.deps.orchestrator,
          intents: this.deps.intents,
          ...(this.deps.forgetJournal ? { forgetJournal: this.deps.forgetJournal } : {}),
          log,
        },
        intent,
      );
      if (res === 'held') held = true;
    }
    if (held) {
      if (this.#pauseHeldFor !== 'owed') {
        this.#pauseHeldFor = 'owed';
        log('claims withheld: a pause report is still owed to the coordinator');
      }
      return 'held';
    }
    if (this.#pauseHeldFor !== undefined) log('all owed pause reports settled; claiming again');
    this.#pauseHeldFor = undefined;
    return 'clear';
  }

  /**
   * Prunes finished jobs' journal entries on a schedule and whenever the journal is
   * full, then reports whether there is room for a new job. A full journal means no
   * claim (and one log line): the alternative is claiming a job, starting its agent,
   * and only then failing to record the dispatch.
   */
  private async maintainJournal(): Promise<boolean> {
    const journal = this.deps.journal!;
    const now = Date.now();
    const due = now - this.#lastJournalSweep >= (this.deps.journalSweepMs ?? 600_000);
    if (due || !journal.hasRoom()) {
      this.#lastJournalSweep = now;
      await sweepJournal(
        {
          client: this.deps.client, journal, intents: this.deps.intents,
          log: this.deps.log ?? (() => {}),
        },
      ).catch(() => undefined);
    }
    if (journal.hasRoom()) {
      if (this.#journalFull) this.deps.log?.('the dispatch journal has room again; claiming resumes');
      this.#journalFull = false;
      return true;
    }
    if (!this.#journalFull) {
      this.#journalFull = true;
      this.deps.log?.(
        'claims withheld: the dispatch journal is full and no finished job could be pruned; ' +
          'nothing was deleted that could back a proof',
      );
    }
    return false;
  }

  async runOnce(): Promise<'claimed' | 'idle' | 'held' | 'pause_held'> {
    if ((await this.reconcilePauses()) === 'held') return 'pause_held';
    if (this.deps.herdrAvailable && !(await this.deps.herdrAvailable().catch(() => false))) {
      if (this.#heldFor !== 'herdr') {
        this.#heldFor = 'herdr';
        this.deps.log?.('claim withheld: Herdr is not reachable; nothing is claimed until it answers');
      }
      return 'held';
    }
    if (this.#heldFor === 'herdr') {
      this.#heldFor = undefined;
      this.deps.log?.('Herdr is reachable again; claiming resumes');
    }
    if (this.deps.journal && !(await this.maintainJournal())) return 'held';

    // Checked BEFORE the claim, because a claim is what starts a job. A refused
    // check leaves the job queued and the executor heartbeating, which is the
    // honest state: work is waiting, and nothing has been started that the
    // account cannot hold.
    if (this.deps.headroom) {
      const verdict = await this.deps.headroom();
      if (!verdict.ok) {
        if (this.#heldFor !== verdict.reason) {
          this.#heldFor = verdict.reason;
          this.deps.log?.(`claim withheld, no memory headroom: ${verdict.reason}`);
        }
        return 'held';
      }
      if (this.#heldFor !== undefined) this.deps.log?.('memory headroom restored; claiming again');
      this.#heldFor = undefined;
    }
    // Reached only when nothing is owed, so the claim may attest as much.
    const claim = await this.deps.client.claim(this.deps.pollWaitMs, { holdsNoPauseIntent: true });
    if (!claim) return 'idle';

    this.#active.add(claim.jobId);
    this.startPresence();
    try {
      await runClaimedJob(
        {
          client: this.deps.client,
          orchestrator: this.deps.orchestrator,
          intents: this.deps.intents,
          ...(this.deps.journalHasRoomFor ? { journalHasRoomFor: this.deps.journalHasRoomFor } : {}),
          ...(this.deps.forgetJournal ? { forgetJournal: this.deps.forgetJournal } : {}),
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
        else if (outcome === 'held') await sleep(this.deps.headroomRetryMs ?? 15_000);
        else if (outcome === 'pause_held') await sleep(this.deps.pauseRetryMs ?? 30_000);
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
