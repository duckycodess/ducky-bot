import { DuckyError, type ApprovalActionKind } from '@ducky/contracts';
import type { ApprovalRow, HerdrWorkspaceRow, JobRow } from '@ducky/persistence';

export interface ActionExecutionContext {
  readonly job: JobRow;
  readonly approval: ApprovalRow;
  readonly workspace: HerdrWorkspaceRow | undefined;
}

export interface ActionPerformer {
  readonly enabled: boolean;
  perform(
    kind: ApprovalActionKind,
    details: unknown,
    context?: ActionExecutionContext,
  ): Promise<void>;
}

/**
 * The safe default records approval decisions but performs nothing. Actual
 * execution is opt-in and still requires an explicit owner command after the
 * approval, with a durable execution ledger preventing retries from repeating
 * an external write.
 *
 * Every consequential write -- commit, push, pull request, issue, deployment,
 * cloud mutation -- remains disabled unless a concrete performer is composed
 * into the app. There is no "approve everything" switch.
 */
export class DeferredActionPerformer implements ActionPerformer {
  readonly enabled = false;

  async perform(
    kind: ApprovalActionKind,
    _details: unknown,
    _context?: ActionExecutionContext,
  ): Promise<void> {
    throw new DuckyError(
      'not_enabled_in_phase1',
      `Approved, but ${kind.replace(/_/g, ' ')} is not executed in Phase 1. Execution is disabled; the decision is recorded.`,
    );
  }
}
