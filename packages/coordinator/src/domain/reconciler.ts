import {
  EXECUTOR_OFFLINE_AFTER_MS, HERDR_WORKSPACE_TTL_MS, isTerminal,
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

      withTransaction(this.store.db, () => {
        if (job.state === 'needs_owner_input') {
          this.store.jobs.transition(job.id, 'failed', 'owner_input_expired', 'system:reconciler', {
            finishedAt: this.now().toISOString(),
          });
          this.store.jobs.appendEvent(
            job.id,
            'owner_input_expired',
            'No answer arrived in time. The job stopped safely and its workspace was retained.',
          );
        } else if (job.state === 'needs_approval') {
          this.store.approvals.expireAllPending(job.id, 'reservation_expired');
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
      n += 1;
    }
    return n;
  }

  expireApprovals(): number {
    const rows = this.store.approvals.expiredPending(this.now().toISOString());
    const jobIds = new Set(rows.map((r) => r.jobId));
    let n = 0;
    for (const jobId of jobIds) {
      n += this.store.approvals.expireAllPending(jobId, 'approval_ttl_expired');
      this.approvals.settleJob(jobId);
    }
    return n;
  }

  markOfflineExecutors(): number {
    const cutoff = isoPlus(-EXECUTOR_OFFLINE_AFTER_MS, this.now());
    return this.store.executors.offlineExecutors(cutoff).length;
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
