import {
  AUDIT_PRUNE_BATCH, AUDIT_RETENTION_MS, EXECUTOR_OFFLINE_AFTER_MS, HERDR_WORKSPACE_TTL_MS,
  isTerminal,
} from '@ducky/contracts';
import { isoPlus, withTransaction, type Store } from '@ducky/persistence';
import type { ApprovalsService } from './approvals.service.js';
import type { PendingScheduleStore } from './pending-schedules.js';

export interface ReconcileReport {
  leasesExpired: number;
  reservationsExpired: number;
  approvalsExpired: number;
  noncesPruned: number;
  draftsSwept: number;
  executorsOffline: number;
  /** Audit rows past the retention window, removed so the table stays bounded. */
  auditPruned: number;
}

export interface ReconcilerDeps {
  readonly store: Store;
  readonly approvals: ApprovalsService;
  readonly pending: PendingScheduleStore;
  readonly now?: () => Date;
}

/**
 * Heals everything a crash or a walk-away can leave behind, atomically and with
 * an explicit outcome for every nonterminal state -- no job is ever stranded,
 * and nothing is silently re-run.
 */
export class Reconciler {
  private readonly store: Store;
  private readonly approvals: ApprovalsService;
  private readonly pending: PendingScheduleStore;
  private readonly now: () => Date;

  constructor(deps: ReconcilerDeps) {
    this.store = deps.store;
    this.approvals = deps.approvals;
    this.pending = deps.pending;
    this.now = deps.now ?? (() => new Date());
  }

  run(): ReconcileReport {
    return {
      leasesExpired: this.expireLeases(),
      reservationsExpired: this.expireReservations(),
      approvalsExpired: this.expireApprovals(),
      noncesPruned: this.store.executors.pruneNonces(this.now().toISOString()),
      draftsSwept: this.pending.sweep(),
      executorsOffline: this.markOfflineExecutors(),
      auditPruned: this.pruneAudit(),
    };
  }

  /**
   * An expired lease does NOT hand the repository to another job. The
   * reservation is kept and the job is flagged for recovery, so the executor
   * reattaches to the workspace it already owns rather than starting a second
   * writer beside it.
   */
  expireLeases(): number {
    const stale = this.store.jobs.expiredLeases(this.now().toISOString());
    let n = 0;
    for (const job of stale) {
      withTransaction(this.store.db, () => {
        const attempts = job.attempts + 1;

        // The owner asked for this job to stop. Requeueing it would run the
        // work again after a cancellation, so expiry is the terminal outcome.
        if (job.cancelRequested) {
          this.store.jobs.transition(
            job.id,
            'cancelled',
            'lease_expired_after_cancel',
            'system:reconciler',
            {
              attempts,
              finishedAt: this.now().toISOString(),
              leaseId: null,
              leaseExpiresAt: null,
            },
          );
          this.store.jobs.appendEvent(
            job.id,
            'lease_expired_after_cancel',
            'The executor stopped reporting after cancellation was requested. Workspace retained.',
          );
          // A workspace we recorded may still hold a live agent, so the
          // repository stays blocked for the owner rather than being handed on.
          if (this.store.herdrWorkspaces.openForJob(job.id)) {
            this.store.jobs.markReservationOrphan(job.repoSlug);
            this.store.jobs.appendEvent(
              job.id,
              'reservation_orphaned',
              `\`${job.repoSlug}\` stays reserved until /job cleanup ${job.publicId}.`,
            );
          } else {
            this.releaseUnlessOrphan(job.repoSlug);
          }
          return;
        }

        if (attempts > job.maxAttempts) {
          this.store.jobs.transition(job.id, 'failed', 'lease_expired_exhausted', 'system:reconciler', {
            attempts,
            finishedAt: this.now().toISOString(),
            leaseId: null,
            leaseExpiresAt: null,
          });
          this.store.jobs.appendEvent(
            job.id,
            'lease_expired_exhausted',
            'The executor stopped reporting and no attempts remain. Workspace retained.',
          );
          this.releaseUnlessOrphan(job.repoSlug);
          return;
        }
        this.store.jobs.transition(job.id, 'waiting_for_executor', 'lease_expired', 'system:reconciler', {
          attempts,
          recoveryRequired: true,
          leaseId: null,
          leaseExpiresAt: null,
        });
        this.store.jobs.appendEvent(
          job.id,
          'lease_expired',
          'The executor stopped reporting; the job will be recovered on the next claim.',
        );
      });
      n += 1;
    }
    return n;
  }

  /**
   * Explicit, atomic outcome per state. `orphan_agent` reservations have a NULL
   * expiry and are therefore never seen here: only /job cleanup clears them.
   */
  expireReservations(): number {
    const expired = this.store.jobs.expiredReservations(this.now().toISOString());
    let n = 0;
    for (const reservation of expired) {
      const job = this.store.jobs.byId(reservation.jobId);
      if (!job) {
        this.store.jobs.releaseReservation(reservation.repoSlug);
        n += 1;
        continue;
      }
      if (isTerminal(job.state)) {
        this.store.jobs.releaseReservation(reservation.repoSlug);
        n += 1;
        continue;
      }

      // Recorded after the transaction commits, so bookkeeping can never roll
      // back the expiry -- and counted here because the branch below runs
      // inside the transaction.
      let approvalsExpiredHere = 0;

      withTransaction(this.store.db, () => {
        if (job.state === 'waiting_on_dependency') {
          // The reservation outlives the longest permitted dependency wait, so
          // reaching this means the wait itself somehow outlived its own
          // ceilings. Fail rather than extend: a job that has held a
          // repository longer than any bound allows is a bug, and quietly
          // renewing the reservation would hide it.
          this.store.dependencies.cancelOpenForJob(job.id, this.now().toISOString());
          this.store.jobs.transition(job.id, 'failed', 'dependency_wait_expired', 'system:reconciler', {
            finishedAt: this.now().toISOString(),
          });
          this.store.jobs.appendEvent(
            job.id,
            'dependency_wait_expired',
            'The repository reservation outlived the dependency wait. The job stopped safely.',
          );
        } else if (job.state === 'needs_owner_input') {
          this.store.jobs.transition(job.id, 'failed', 'owner_input_expired', 'system:reconciler', {
            finishedAt: this.now().toISOString(),
          });
          this.store.jobs.appendEvent(
            job.id,
            'owner_input_expired',
            'No answer arrived in time. The job stopped safely and its workspace was retained.',
          );
        } else if (job.state === 'needs_approval') {
          approvalsExpiredHere = this.store.approvals.expireAllPending(
            job.id,
            'reservation_expired',
          );
          this.store.jobs.transition(
            job.id,
            'completed',
            'approvals_expired_reservation',
            'system:reconciler',
            { finishedAt: this.now().toISOString() },
          );
          this.store.jobs.appendEvent(
            job.id,
            'approvals_expired_reservation',
            'Pending actions expired. The recorded result is unchanged.',
          );
        } else {
          this.store.jobs.transition(job.id, 'failed', 'reservation_expired', 'system:reconciler', {
            finishedAt: this.now().toISOString(),
          });
          this.store.jobs.appendEvent(
            job.id,
            'reservation_expired',
            'The repository reservation expired while the job was still open.',
          );
        }
        this.store.jobs.releaseReservation(reservation.repoSlug);
      });

      // The SAME event `expireApprovals()` records. An approval that lapsed on
      // this path was invisible in the trail purely because the reservation
      // timer got there first, which is not a distinction an auditor cares
      // about -- and the detail names the cause so the two are still
      // distinguishable.
      if (approvalsExpiredHere > 0) {
        this.store.auditLog.record({
          event: 'approval.expired',
          actorKind: 'reconciler',
          actorRef: 'reconciler',
          subjectKind: 'job',
          subjectRef: job.publicId,
          outcome: 'ok',
          detail:
            `${approvalsExpiredHere} pending approval(s) lapsed unanswered ` +
            '(repository reservation expired first)',
        });
      }
      n += 1;
    }
    return n;
  }

  /**
   * Expiry and settlement are one transaction per job. Doing them separately
   * left a window where every approval was expired but the job stayed in
   * needs_approval until some later pass noticed.
   *
   * A job the owner cancelled in the meantime is skipped rather than settled:
   * cancellation already resolved its pending approvals, and settling would
   * try to move a terminal job.
   */
  expireApprovals(): number {
    const rows = this.store.approvals.expiredPending(this.now().toISOString());
    const jobIds = new Set(rows.map((r) => r.jobId));
    let n = 0;
    for (const jobId of jobIds) {
      const job = this.store.jobs.byId(jobId);
      if (!job || job.state !== 'needs_approval') continue;
      const expired = withTransaction(this.store.db, () => {
        const count = this.store.approvals.expireAllPending(jobId, 'approval_ttl_expired');
        this.approvals.settleJobWithin(jobId);
        return count;
      });
      n += expired;
      if (expired > 0) {
        // An approval that lapsed unanswered is a decision by default, and the
        // trail had no record of it at all. Written OUTSIDE the transaction so
        // a bookkeeping failure cannot roll back the expiry itself.
        this.store.auditLog.record({
          event: 'approval.expired',
          actorKind: 'reconciler',
          actorRef: 'reconciler',
          subjectKind: 'job',
          subjectRef: job.publicId,
          outcome: 'ok',
          detail: `${expired} pending approval(s) lapsed unanswered`,
        });
      }
    }
    return n;
  }

  markOfflineExecutors(): number {
    const cutoff = isoPlus(-EXECUTOR_OFFLINE_AFTER_MS, this.now());
    const offline = this.store.executors.offlineExecutors(cutoff);
    for (const e of offline) {
      this.store.auditLog.record({
        event: 'executor.offline', actorKind: 'reconciler', actorRef: 'reconciler',
        subjectKind: 'executor', subjectRef: e.id, outcome: 'ok',
        detail: `no heartbeat since ${e.lastSeenAt ?? 'never'}`,
      });
    }
    return offline.length;
  }

  /**
   * Keeps the audit table bounded.
   *
   * It is the one structure here that otherwise grows for as long as the
   * system runs. A window rather than an archive is the honest trade for a
   * personal assistant on a workstation, and the batch cap means a long-idle
   * instance drains over several passes instead of one enormous delete.
   */
  pruneAudit(): number {
    return this.store.auditLog.pruneOlderThan(
      isoPlus(-AUDIT_RETENTION_MS, this.now()),
      AUDIT_PRUNE_BATCH,
    );
  }

  /** Ducky-owned workspaces whose repo is no longer reserved may be reaped. */
  reapableWorkspaces(): { workspaceId: string; repoSlug: string }[] {
    const cutoff = isoPlus(-HERDR_WORKSPACE_TTL_MS, this.now());
    return this.store.herdrWorkspaces
      .staleOpen(cutoff)
      .filter((w) => this.store.jobs.reservation(w.repoSlug) === undefined)
      .map((w) => ({ workspaceId: w.workspaceId, repoSlug: w.repoSlug }));
  }

  private releaseUnlessOrphan(repoSlug: string): void {
    const r = this.store.jobs.reservation(repoSlug);
    if (r && r.reason === 'orphan_agent') return;
    this.store.jobs.releaseReservation(repoSlug);
  }
}
