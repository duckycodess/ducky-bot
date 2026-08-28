import {
  AUDIT_OWNER_REF, canonicalJson, DuckyError, ProposedActionSchema,
  type ApprovalActionKind,
} from '@ducky/contracts';
import { redact } from '@ducky/adapters';
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

export interface ApprovalDetail {
  readonly approval: ApprovalRow;
  readonly job: NonNullable<ReturnType<Store['jobs']['byId']>>;
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

  /**
   * Returns the exact proposal behind one signed control, for the owner's
   * explicit View Details action. The lookup is owner-scoped before any fields
   * are rendered, so an approval id cannot become a cross-job oracle.
   */
  detail(actor: ActorContext, approvalId: string): ApprovalDetail {
    this.authz.requireOwner(actor);
    const approval = this.store.approvals.byId(approvalId);
    if (!approval) throw new DuckyError('not_found', 'That approval no longer exists.');
    this.assertOwnsJob(actor, approval.jobId);
    const job = this.store.jobs.byId(approval.jobId);
    if (!job) throw new DuckyError('not_found', 'That approval no longer exists.');
    return { approval, job };
  }

  /**
   * Executes one previously approved action after an explicit owner request.
   *
   * Approval is not execution: the decision is recorded first, and this method
   * is the only route that may hand an action to the configured performer. The
   * immutable result snapshot is compared with the approval row before the
   * execution slot is claimed, and the slot is durable so a retry cannot run a
   * command twice after a successful external write followed by a crash.
   */
  async execute(actor: ActorContext, approvalId: string): Promise<{ state: 'succeeded'; note: string }> {
    this.authz.requireOwner(actor);
    if (!this.performer.enabled) {
      throw new DuckyError(
        'not_enabled_in_phase1',
        'Approved action execution is disabled. The decision is recorded.',
      );
    }

    const detail = this.detail(actor, approvalId);
    const approval = detail.approval;
    if (approval.state !== 'approved') {
      throw new DuckyError(
        'invalid_input',
        `That action is ${approval.state}; only an approved action can be executed.`,
      );
    }
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      throw new DuckyError('invalid_input', 'That approval expired before execution.');
    }

    const snapshot = this.store.results.byJobId(detail.job.id)?.snapshot;
    const proposed = snapshot?.proposedActions[approval.actionIndex];
    const storedDetails = parseObject(approval.detailsJson);
    const validated = ProposedActionSchema.safeParse({
      kind: approval.actionKind,
      description: approval.description,
      details: storedDetails,
    });
    if (
      !validated.success ||
      !proposed ||
      proposed.kind !== approval.actionKind ||
      proposed.description !== approval.description ||
      canonicalJson(proposed.details) !== canonicalJson(storedDetails)
    ) {
      throw new DuckyError(
        'invalid_input',
        'The approved proposal no longer matches the recorded job result.',
      );
    }

    const existing = this.store.approvals.executionByApproval(approvalId);
    if (existing) {
      if (existing.state === 'succeeded') {
        return { state: 'succeeded', note: 'That action was already executed.' };
      }
      if (existing.state === 'running') {
        throw new DuckyError('invalid_input', 'That action is already being executed.');
      }
      throw new DuckyError(
        'invalid_input',
        'That action previously failed. Inspect the workspace and request a new proposal.',
      );
    }

    const claimed = withTransaction(this.store.db, () =>
      this.store.approvals.beginExecution(approvalId, detail.job.id, this.now().toISOString()),
    );
    if (!claimed) {
      const raced = this.store.approvals.executionByApproval(approvalId);
      if (raced?.state === 'succeeded') {
        return { state: 'succeeded', note: 'That action was already executed.' };
      }
      throw new DuckyError('invalid_input', 'That action is already being executed or was attempted before.');
    }

    this.store.auditLog.record({
      event: 'approval.execution_started', actorKind: 'owner', actorRef: AUDIT_OWNER_REF,
      subjectKind: 'approval', subjectRef: approvalId, detail: approval.actionKind,
    });

    try {
      await this.performer.perform(
        approval.actionKind as ApprovalActionKind,
        storedDetails,
        {
          job: detail.job,
          approval,
          workspace: this.store.herdrWorkspaces.openForJob(detail.job.id),
        },
      );
      withTransaction(this.store.db, () => {
        this.store.approvals.finishExecution(approvalId, 'succeeded', this.now().toISOString());
      });
      this.store.auditLog.record({
        event: 'approval.execution_succeeded', actorKind: 'owner', actorRef: AUDIT_OWNER_REF,
        subjectKind: 'approval', subjectRef: approvalId, detail: approval.actionKind,
      });
      return {
        state: 'succeeded',
        note: `Executed approved ${approval.actionKind.replace(/_/g, ' ')}.`,
      };
    } catch (err) {
      const safe = redact(err instanceof Error ? err.message : 'approved action failed').slice(0, 200);
      withTransaction(this.store.db, () => {
        this.store.approvals.finishExecution(approvalId, 'failed', this.now().toISOString(), safe);
      });
      this.store.auditLog.record({
        event: 'approval.execution_failed', actorKind: 'owner', actorRef: AUDIT_OWNER_REF,
        subjectKind: 'approval', subjectRef: approvalId, outcome: 'failed',
        detail: approval.actionKind,
      });
      if (err instanceof DuckyError) throw err;
      throw new DuckyError('invalid_input', 'The approved action failed. Inspect the job and workspace.');
    }
  }

  /**
   * Records one decision and settles the job in a SINGLE transaction.
   *
   * Doing the two separately left a window where a crash could leave no
   * pending approvals but a job stuck in needs_approval forever. State and
   * expiry are re-checked inside the transaction, so a concurrent decision or
   * an expiry that lands mid-call cannot slip through.
   */
  decide(actor: ActorContext, approvalId: string, decision: 'approved' | 'rejected'): DecisionOutcome {
    this.authz.requireOwner(actor);

    const preflight = this.store.approvals.byId(approvalId);
    if (!preflight) throw new DuckyError('not_found', 'That approval no longer exists.');
    this.assertOwnsJob(actor, preflight.jobId);

    const jobState = withTransaction(this.store.db, () => {
      const approval = this.store.approvals.byId(approvalId);
      if (!approval) throw new DuckyError('not_found', 'That approval no longer exists.');

      // Re-checked INSIDE the transaction: the job may have been cancelled, or
      // the approval decided or expired, between the preflight and here.
      // Settling a job that already moved on would overwrite a terminal state.
      const job = this.store.jobs.byId(approval.jobId);
      if (!job || job.discordUserId !== actor.discordUserId) {
        throw new DuckyError('not_found', 'That approval no longer exists.');
      }
      if (job.state !== 'needs_approval') {
        throw new DuckyError(
          'invalid_input',
          `\`${job.publicId}\` is ${job.state.replace(/_/g, ' ')} and is no longer awaiting approval.`,
        );
      }
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

      // The action KIND and the decision, and nothing else. The action's
      // details -- a commit message, a PR body, a deploy target -- are the
      // owner's content and belong in the approvals table, not duplicated into
      // a long-lived audit record.
      this.store.auditLog.record({
        event: 'approval.decided',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        subjectKind: 'approval',
        subjectRef: approval.id,
        outcome: 'ok',
        detail: `${decision} ${approval.actionKind} for job ${job.publicId} (not executed in this phase)`,
      });

      return this.settleJobWithin(approval.jobId);
    });

    const note =
      decision === 'approved'
        ? 'Approved and recorded. Phase 1 does not execute the action.'
        : 'Rejected.';

    return { approval: this.store.approvals.byId(approvalId)!, jobState, note };
  }

  /** Once nothing is pending the job leaves needs_approval. Opens its own transaction. */
  settleJob(jobId: string): string {
    return withTransaction(this.store.db, () => this.settleJobWithin(jobId));
  }

  /**
   * Settlement body. The CALLER must already hold a transaction, so expiry and
   * settlement can be committed together.
   */
  settleJobWithin(jobId: string): string {
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

    this.store.jobs.transition(jobId, 'completed', reason, 'system:approvals', {
      finishedAt: this.now().toISOString(),
    });
    this.store.jobs.appendEvent(
      jobId,
      reason,
      anyApproved ? 'Approved actions recorded; Phase 1 defers execution.' : 'No action was approved.',
    );
    const r = this.store.jobs.reservation(job.repoSlug);
    if (!r || r.reason !== 'orphan_agent') this.store.jobs.releaseReservation(job.repoSlug);
    return 'completed';
  }

  private assertOwnsJob(actor: ActorContext, jobId: string): void {
    const job = this.store.jobs.byId(jobId);
    if (!job || job.discordUserId !== actor.discordUserId) {
      throw new DuckyError('not_found', 'That approval no longer exists.');
    }
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The immutable proposal is invalid; the caller reports a safe mismatch.
  }
  return {};
}
