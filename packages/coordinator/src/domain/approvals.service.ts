import { DuckyError } from '@ducky/contracts';
import { withTransaction, type ApprovalRow, type Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { ActionPerformer } from './action-performer.js';

export interface ApprovalsServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly performer: ActionPerformer;
  readonly now?: () => Date;
}

export interface DecisionOutcome {
  readonly approval: ApprovalRow;
  readonly jobState: string;
  readonly note: string;
}

/**
 * One approval row per proposed action, each decided individually and exactly
 * once. There is deliberately no bulk-approve entry point.
 */
export class ApprovalsService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly performer: ActionPerformer;
  private readonly now: () => Date;

  constructor(deps: ApprovalsServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.performer = deps.performer;
    this.now = deps.now ?? (() => new Date());
  }

  forJob(actor: ActorContext, jobId: string): ApprovalRow[] {
    this.authz.requireOwner(actor);
    this.assertOwnsJob(actor, jobId);
    return this.store.approvals.forJob(jobId);
  }

  decide(actor: ActorContext, approvalId: string, decision: 'approved' | 'rejected'): DecisionOutcome {
    this.authz.requireOwner(actor);

    const approval = this.store.approvals.byId(approvalId);
    if (!approval) throw new DuckyError('not_found', 'That approval no longer exists.');
    this.assertOwnsJob(actor, approval.jobId);

    if (approval.state !== 'pending') {
      throw new DuckyError('invalid_input', `That action was already ${approval.state}.`);
    }
    if (Date.parse(approval.expiresAt) < this.now().getTime()) {
      throw new DuckyError('invalid_input', 'That approval expired.');
    }

    const changed = this.store.approvals.decide(
      approvalId,
      decision,
      `owner:${actor.discordUserId}`,
      decision === 'approved' ? 'owner_approved' : 'owner_rejected',
    );
    if (!changed) throw new DuckyError('invalid_input', 'That action was already decided.');

    let note =
      decision === 'approved'
        ? 'Approved and recorded. Phase 1 does not execute the action.'
        : 'Rejected.';

    if (decision === 'approved' && this.performer.enabled) {
      // Reserved for a later phase; the deferred performer never reaches here.
      note = 'Approved.';
    }

    const jobState = this.settleJob(approval.jobId);
    return { approval: this.store.approvals.byId(approvalId)!, jobState, note };
  }

  /** Once nothing is pending the job leaves needs_approval. */
  settleJob(jobId: string): string {
    const job = this.store.jobs.byId(jobId);
    if (!job) throw new DuckyError('not_found', 'Unknown job.');
    if (job.state !== 'needs_approval') return job.state;
    if (this.store.approvals.pendingCount(jobId) > 0) return job.state;

    const rows = this.store.approvals.forJob(jobId);
    const anyApproved = rows.some((r) => r.state === 'approved');
    const anyExpired = rows.some((r) => r.state === 'expired');
    const reason = anyApproved
      ? 'actions_decided'
      : anyExpired
        ? 'approvals_expired'
        : 'all_actions_rejected';

    withTransaction(this.store.db, () => {
      this.store.jobs.transition(jobId, 'completed', reason, 'system:approvals', {
        finishedAt: this.now().toISOString(),
      });
      this.store.jobs.appendEvent(
        jobId,
        reason,
        anyApproved
          ? 'Approved actions recorded; Phase 1 defers execution.'
          : 'No action was approved.',
      );
      const r = this.store.jobs.reservation(job.repoSlug);
      if (!r || r.reason !== 'orphan_agent') this.store.jobs.releaseReservation(job.repoSlug);
    });
    return 'completed';
  }

  private assertOwnsJob(actor: ActorContext, jobId: string): void {
    const job = this.store.jobs.byId(jobId);
    if (!job || job.discordUserId !== actor.discordUserId) {
      throw new DuckyError('not_found', 'That approval no longer exists.');
    }
  }
}
