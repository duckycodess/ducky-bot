import { DuckyError, type ApprovalActionKind } from '@ducky/contracts';

export interface ActionPerformer {
  readonly enabled: boolean;
  perform(kind: ApprovalActionKind, details: unknown): Promise<void>;
}

/**
 * Phase 1 records approval decisions but performs nothing.
 *
 * Every consequential write -- commit, push, pull request, issue, deployment,
 * cloud mutation -- stops here on purpose. There is no GitHub writer anywhere
 * in the codebase and no "approve everything" switch.
 */
export class DeferredActionPerformer implements ActionPerformer {
  readonly enabled = false;

  async perform(kind: ApprovalActionKind, _details: unknown): Promise<void> {
    throw new DuckyError(
      'not_enabled_in_phase1',
      `Approved, but ${kind.replace(/_/g, ' ')} is not executed in Phase 1. The decision is recorded.`,
    );
  }
}
