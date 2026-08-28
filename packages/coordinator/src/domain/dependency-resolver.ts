import {
  DEPENDENCY_BACKOFF_FACTOR, DEPENDENCY_BACKOFF_MAX_MS, DEPENDENCY_CHECK_BATCH,
  DEPENDENCY_CHECK_TIMEOUT_MS, DEPENDENCY_DEFAULT_CHECK_INTERVAL_MS, DEPENDENCY_DETAIL_MAX,
  DEPENDENCY_RESOLUTIONS, DEPENDENCY_TYPE_LABEL, RESERVATION_TTL_MS,
  type DependencyCheckOutcome, type DependencyCheckStatus, type JobState,
} from '@ducky/contracts';
import type { DependencyChecker } from '@ducky/adapters';
import { redact } from '@ducky/adapters';
import { withTransaction, type DependencyRow, type Store } from '@ducky/persistence';

export interface DependencyResolverDeps {
  readonly store: Store;
  readonly checker: DependencyChecker;
  readonly now?: () => Date;
  /** Bounds one pass. Never unbounded, however many dependencies are open. */
  readonly batchSize?: number;
  readonly checkTimeoutMs?: number;
}

export interface DependencyTickResult {
  /** Dependencies whose cursor came due and were checked this pass. */
  readonly checked: number;
  /** Jobs requeued because their dependency became ready. */
  readonly resumed: number;
  /** Jobs failed because a checker said the dependency will not be satisfied. */
  readonly failed: number;
  /** Jobs handed to the owner because the bounded check budget ran out. */
  readonly handedToOwner: number;
  /** Dependencies rescheduled for a later check. */
  readonly rescheduled: number;
  /** Rows found with no live job to resume; closed rather than left polling. */
  readonly abandoned: number;
}

const clamp = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/**
 * Moves jobs out of `waiting_on_dependency`, on a bounded schedule.
 *
 * The design rule is that **nothing here can poll forever**. Every open
 * dependency carries two independent ceilings written at intake -- a check
 * count and a wall-clock deadline -- and both are enforced here. A dependency
 * that no checker can answer therefore stops on its own and lands at the
 * owner's desk rather than holding a repository reservation indefinitely.
 *
 * The four outcomes, and what each does to the job:
 *
 * - **ready** → the job is requeued (`waiting_on_dependency` → `queued`) and
 *   KEEPS its reservation with a fresh TTL, so it re-claims its own repository
 *   ahead of everything queued behind it. Exactly what an answered question
 *   does.
 * - **failed** → the job fails and the reservation is released (unless it was
 *   already orphaned, which outranks everything).
 * - **pending, budget remaining** → rescheduled with bounded exponential
 *   backoff. The job does not move.
 * - **pending, budget exhausted** → the job goes to `needs_owner_input`. This
 *   is the honest end state when nothing could confirm the dependency, and it
 *   is what the default `UnavailableDependencyChecker` always reaches.
 *
 * A checker that throws is treated as `pending` and still spends a check, so a
 * broken checker cannot buy unlimited retries by failing.
 *
 * Every pass is re-entrancy guarded and every write is one transaction per
 * dependency, so a crash mid-pass leaves the rest untouched and the next pass
 * resumes from the durable cursor.
 */
export class DependencyResolver {
  private readonly store: Store;
  private readonly checker: DependencyChecker;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly checkTimeoutMs: number;
  private ticking: Promise<DependencyTickResult> | null = null;

  constructor(deps: DependencyResolverDeps) {
    this.store = deps.store;
    this.checker = deps.checker;
    this.now = deps.now ?? (() => new Date());
    this.batchSize = deps.batchSize ?? DEPENDENCY_CHECK_BATCH;
    this.checkTimeoutMs = deps.checkTimeoutMs ?? DEPENDENCY_CHECK_TIMEOUT_MS;
  }

  get checkerName(): string {
    return this.checker.name;
  }

  get checkerVerified(): boolean {
    return this.checker.verified;
  }

  tick(): Promise<DependencyTickResult> {
    if (this.ticking) return this.ticking;
    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  async waitForIdle(): Promise<void> {
    if (this.ticking) await this.ticking.catch(() => undefined);
  }

  private async runTick(): Promise<DependencyTickResult> {
    const nowMs = this.now().getTime();
    const due = this.store.dependencies.due(new Date(nowMs).toISOString(), this.batchSize);

    const out = {
      checked: 0, resumed: 0, failed: 0, handedToOwner: 0, rescheduled: 0, abandoned: 0,
    };

    for (const dep of due) {
      const job = this.store.jobs.byId(dep.jobId);
      // A dependency whose job is gone or has moved on is closed rather than
      // checked. Otherwise a cancelled job's dependency would keep spending
      // budget on work nobody wants any more.
      if (!job || job.state !== 'waiting_on_dependency') {
        withTransaction(this.store.db, () => {
          this.store.dependencies.resolve({
            id: dep.id,
            state: 'cancelled',
            detail: 'The job is no longer waiting on this.',
            atIso: this.now().toISOString(),
          });
        });
        out.abandoned += 1;
        continue;
      }

      const outcome = await this.checkOnce(dep);
      out.checked += 1;
      this.apply(dep, outcome, out);
    }
    return out;
  }

  /**
   * One check, isolated and time-boxed.
   *
   * A checker that throws, or that hangs past the timeout, is reported as
   * `pending` with the reason recorded -- and the check still counts against
   * the budget. Treating a broken checker as "no answer yet" is what keeps the
   * failure mode a bounded wait rather than either a false resume or an
   * unbounded retry loop.
   */
  private async checkOnce(dep: DependencyRow): Promise<DependencyCheckOutcome> {
    if (!this.checker.supports.includes(dep.type)) {
      return {
        status: 'pending',
        detail: `No configured checker supports ${DEPENDENCY_TYPE_LABEL[dep.type]}.`,
      };
    }
    const input = {
      dependencyId: dep.id,
      type: dep.type,
      description: dep.description,
      externalKey: dep.externalKey,
      checksMade: dep.checksMade,
      maxChecks: dep.maxChecks,
      deadlineAt: dep.deadlineAt,
    };
    try {
      return await withTimeout(this.checker.check(input), this.checkTimeoutMs);
    } catch (err) {
      return {
        status: 'pending',
        detail: `The dependency check did not complete: ${(err as Error).message}`,
      };
    }
  }

  private apply(
    dep: DependencyRow,
    outcome: DependencyCheckOutcome,
    out: { resumed: number; failed: number; handedToOwner: number; rescheduled: number },
  ): void {
    const at = this.now();
    const atIso = at.toISOString();
    const detail = outcome.detail === undefined ? null : clamp(redact(outcome.detail), DEPENDENCY_DETAIL_MAX);
    const checksAfter = dep.checksMade + 1;
    const budgetSpent = checksAfter >= dep.maxChecks || at.getTime() >= Date.parse(dep.deadlineAt);

    // `ready` is the only status that may come from an UNVERIFIED checker
    // without being believed. The default checker never reports it, but a
    // future one could be misconfigured, and resuming work on the strength of
    // an unexercised integration is exactly the kind of plausible-looking
    // fake this codebase refuses everywhere else.
    const trustworthy = this.checker.verified;
    const status: DependencyCheckStatus =
      outcome.status === 'ready' && !trustworthy ? 'pending' : outcome.status;
    const downgraded = status !== outcome.status;

    withTransaction(this.store.db, () => {
      const job = this.store.jobs.byId(dep.jobId);
      // Re-read inside the transaction: the owner may have cancelled between
      // the check starting and it returning.
      if (!job || job.state !== 'waiting_on_dependency') {
        this.store.dependencies.resolve({
          id: dep.id, state: 'cancelled', detail: 'The job stopped waiting.', atIso,
        });
        return;
      }

      if (status === 'ready') {
        const resolved = this.store.dependencies.resolve({
          id: dep.id, state: 'ready', detail, atIso, countCheck: true, status: 'ready',
          expectedChecksMade: dep.checksMade,
        });
        if (!resolved) return;
        this.store.jobs.transition(
          job.id, 'queued', DEPENDENCY_RESOLUTIONS.ready, 'system:dependency',
        );
        // Keep holding the repository, with a fresh TTL, exactly as an
        // answered question does.
        this.store.jobs.acquireReservation(
          job.repoSlug, job.id, this.reservationExpiry('queued'),
        );
        this.store.jobs.appendEvent(
          job.id, 'dependency_ready',
          clamp(`${labelFor(dep)} is ready; the job is queued to continue.`, 400),
        );
        this.store.auditLog.record({
          event: 'dependency.resolved', actorKind: 'system', actorRef: this.checker.name,
          subjectKind: 'dependency', subjectRef: dep.id, outcome: 'ok',
          detail: `ready after ${checksAfter} check(s); job ${job.publicId} requeued`,
        });
        out.resumed += 1;
        return;
      }

      if (status === 'failed') {
        const resolved = this.store.dependencies.resolve({
          id: dep.id, state: 'failed', detail, atIso, countCheck: true, status: 'failed',
          expectedChecksMade: dep.checksMade,
        });
        if (!resolved) return;
        this.store.jobs.transition(
          job.id, 'failed', DEPENDENCY_RESOLUTIONS.failed, 'system:dependency',
          { finishedAt: atIso },
        );
        this.store.jobs.appendEvent(
          job.id, 'dependency_failed',
          clamp(`${labelFor(dep)} will not be satisfied.${detail ? ` ${detail}` : ''}`, 400),
        );
        this.releaseUnlessOrphan(job.repoSlug);
        this.store.auditLog.record({
          event: 'dependency.resolved', actorKind: 'system', actorRef: this.checker.name,
          subjectKind: 'dependency', subjectRef: dep.id, outcome: 'failed',
          detail: `reported unsatisfiable; job ${job.publicId} failed`,
        });
        out.failed += 1;
        return;
      }

      // Still pending.
      if (budgetSpent) {
        const resolved = this.store.dependencies.resolve({
          id: dep.id, state: 'expired', detail, atIso, countCheck: true, status: 'pending',
          expectedChecksMade: dep.checksMade,
        });
        if (!resolved) return;
        this.store.jobs.transition(
          job.id, 'needs_owner_input', DEPENDENCY_RESOLUTIONS.expired, 'system:dependency',
        );
        this.store.jobs.appendEvent(
          job.id, 'dependency_check_budget_exhausted',
          clamp(
            `Stopped checking ${labelFor(dep)} after ${checksAfter} attempt(s). ` +
              'Answer to continue, or cancel the job.',
            400,
          ),
        );
        this.store.auditLog.record({
          event: 'dependency.resolved', actorKind: 'system', actorRef: this.checker.name,
          subjectKind: 'dependency', subjectRef: dep.id, outcome: 'refused',
          detail: `check budget exhausted after ${checksAfter}; job ${job.publicId} needs the owner`,
        });
        out.handedToOwner += 1;
        return;
      }

      const nextCheckAt = new Date(at.getTime() + this.backoffMs(checksAfter)).toISOString();
      const recorded = this.store.dependencies.recordCheck({
        id: dep.id,
        expectedChecksMade: dep.checksMade,
        status: 'pending',
        detail,
        nextCheckAt,
        atIso,
      });
      if (!recorded) return;
      this.store.auditLog.record({
        event: 'dependency.checked', actorKind: 'system', actorRef: this.checker.name,
        subjectKind: 'dependency', subjectRef: dep.id, outcome: 'ok',
        detail:
          `pending (${checksAfter}/${dep.maxChecks})` +
          (downgraded ? '; an unverified checker reported ready and was not believed' : ''),
      });
      out.rescheduled += 1;
    });
  }

  /**
   * Bounded exponential backoff, deterministic and with no jitter.
   *
   * Jitter would spread load across many coordinators; there is one, and a
   * deterministic schedule is what makes the timeout path testable without
   * waiting for real time.
   */
  private backoffMs(checksMade: number): number {
    const base = DEPENDENCY_DEFAULT_CHECK_INTERVAL_MS;
    const grown = base * DEPENDENCY_BACKOFF_FACTOR ** Math.max(0, checksMade - 1);
    return Math.min(grown, DEPENDENCY_BACKOFF_MAX_MS);
  }

  /** Same table `JobsService` uses, so a resumed job gets the same TTL. */
  private reservationExpiry(state: JobState): string | null {
    const ttl = RESERVATION_TTL_MS[state];
    return ttl == null ? null : new Date(this.now().getTime() + ttl).toISOString();
  }

  private releaseUnlessOrphan(repoSlug: string): void {
    const r = this.store.jobs.reservation(repoSlug);
    if (r && r.reason === 'orphan_agent') return;
    this.store.jobs.releaseReservation(repoSlug);
  }
}

const labelFor = (dep: DependencyRow): string =>
  `${DEPENDENCY_TYPE_LABEL[dep.type]} (${dep.description})`;

/**
 * Fails the promise rather than the process if a checker never settles. The
 * underlying work is not cancellable through the port, so the timeout bounds
 * OUR wait, not the checker's -- which is the honest thing a port boundary can
 * promise.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}
