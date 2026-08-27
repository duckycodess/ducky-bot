import { createHash, randomUUID } from 'node:crypto';
import {
  APPROVAL_TTL_MS, DuckyError, JobResultFileSchema, MAX_REVIEW_NOTES, MAX_SUMMARY,
  RESULT_MAX_BYTES, canonicalJson, isRepoRelativePath, type JobResultFile,
} from '@ducky/contracts';
import { redact } from '@ducky/adapters';
import { withTransaction, type Store, type JobRow } from '@ducky/persistence';

export type IntakeVerdict =
  | {
      kind: 'accepted';
      state: 'needs_approval' | 'needs_owner_input' | 'completed' | 'failed';
      duplicate: false;
    }
  | { kind: 'duplicate'; state: string; duplicate: true }
  | { kind: 'downgraded'; state: 'failed'; reason: string; duplicate: false };

const clamp = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/** Deep-sanitizes every free-text field. Runs before anything is persisted. */
export function sanitizeResult(result: JobResultFile): JobResultFile {
  const base = {
    schemaVersion: 1 as const,
    summary: clamp(redact(result.summary), MAX_SUMMARY),
    changedFiles: result.changedFiles,
    review: { ...result.review, notes: clamp(redact(result.review.notes), MAX_REVIEW_NOTES) },
    verification: {
      passed: result.verification.passed,
      commands: result.verification.commands.map((c) => ({
        cmd: clamp(redact(c.cmd), 512),
        exitCode: c.exitCode,
        summary: clamp(redact(c.summary), 1000),
      })),
    },
  };

  switch (result.verdict) {
    case 'implemented':
      return {
        ...base,
        verdict: 'implemented',
        proposedActions: result.proposedActions.map((a) => sanitizeAction(a)),
      };
    case 'needs_owner_input':
      return {
        ...base,
        verdict: 'needs_owner_input',
        question: clamp(redact(result.question), 2000),
        proposedActions: [],
      };
    case 'failed':
      return { ...base, verdict: 'failed', proposedActions: [] };
  }
}

function sanitizeAction(a: JobResultFile['proposedActions'][number]): typeof a {
  const description = clamp(redact(a.description), 500);
  switch (a.kind) {
    case 'git_commit':
      return {
        kind: 'git_commit',
        description,
        details: { message: clamp(redact(a.details.message), 2000), files: a.details.files },
      };
    case 'github_pr':
      return {
        kind: 'github_pr',
        description,
        details: {
          title: clamp(redact(a.details.title), 256),
          body: clamp(redact(a.details.body), 5000),
          base: a.details.base,
          head: a.details.head,
        },
      };
    case 'github_issue':
      return {
        kind: 'github_issue',
        description,
        details: {
          title: clamp(redact(a.details.title), 256),
          body: clamp(redact(a.details.body), 5000),
        },
      };
    default:
      return { ...a, description };
  }
}

/**
 * `implemented` is a claim about evidence, not a self-certification. Without an
 * independent passing review and passing verification the coordinator refuses
 * it; the executor cannot mark its own homework.
 */
export function hasSufficientEvidence(r: JobResultFile): boolean {
  if (r.verdict !== 'implemented') return true;
  return (
    r.review.performed &&
    r.review.independent &&
    r.review.verdict === 'pass' &&
    r.verification.passed &&
    r.verification.commands.length > 0
  );
}

/** Rejects absolute/traversal paths anywhere in the payload, before persistence. */
export function assertResultPaths(r: JobResultFile): void {
  const paths = [...r.changedFiles];
  for (const a of r.proposedActions) {
    if (a.kind === 'git_commit') paths.push(...a.details.files);
  }
  for (const p of paths) {
    if (!isRepoRelativePath(p)) {
      throw new DuckyError('result_rejected', 'A reported file path was not repository-relative.');
    }
  }
}

export interface IntakeDeps {
  readonly store: Store;
  readonly now?: () => Date;
}

export interface IntakeInput {
  readonly job: JobRow;
  readonly leaseId: string;
  readonly rawBodyBytes: number;
  readonly result: unknown;
}

export function resultHash(r: JobResultFile): string {
  return createHash('sha256').update(canonicalJson(r)).digest('hex');
}

/**
 * Validates, sanitizes, and persists a job result.
 *
 * The result snapshot, the derived approval rows, the state transition and the
 * events are written in ONE transaction, so a partial fan-out cannot exist.
 * Idempotency is keyed on the payload hash rather than on row existence: an
 * identical retry is accepted, a *different* payload on the same lease is a
 * conflict and changes nothing.
 */
export function intakeResult(deps: IntakeDeps, input: IntakeInput): IntakeVerdict {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  if (input.rawBodyBytes > RESULT_MAX_BYTES) {
    throw new DuckyError('result_rejected', 'The result payload was too large.');
  }

  const parsed = JobResultFileSchema.safeParse(input.result);
  if (!parsed.success) {
    throw new DuckyError('result_rejected', 'The result payload did not match the result contract.');
  }
  assertResultPaths(parsed.data);

  const sanitized = sanitizeResult(parsed.data);
  const hash = resultHash(sanitized);

  // Scoped to this turn: a previous round's result is a separate record.
  const existing = store.results.byLease(input.job.id, input.leaseId);
  if (existing) {
    if (existing.resultSha256 !== hash) {
      store.jobs.appendEvent(
        input.job.id,
        'conflicting_result_payload',
        'A second, different result was submitted for the same lease and was rejected.',
      );
      throw new DuckyError('result_conflict', 'A different result was already recorded for this job.');
    }
    return { kind: 'duplicate', state: input.job.state, duplicate: true };
  }

  if (!hasSufficientEvidence(sanitized)) {
    withTransaction(store.db, () => {
      store.jobs.transition(input.job.id, 'failed', 'unverified_implementation', 'system:intake', {
        finishedAt: now().toISOString(),
        leaseId: null,
        leaseExpiresAt: null,
      });
      store.jobs.appendEvent(
        input.job.id,
        'unverified_implementation',
        'Reported as implemented without an independent passing review and passing verification.',
      );
      store.jobs.releaseReservation(input.job.repoSlug);
    });
    return { kind: 'downgraded', state: 'failed', reason: 'unverified_implementation', duplicate: false };
  }

  const target =
    sanitized.verdict === 'failed'
      ? 'failed'
      : sanitized.verdict === 'needs_owner_input'
        ? 'needs_owner_input'
        : sanitized.proposedActions.length > 0
          ? 'needs_approval'
          : 'completed';

  withTransaction(store.db, () => {
    store.results.insert({
      id: randomUUID(),
      jobId: input.job.id,
      leaseId: input.leaseId,
      resultSha256: hash,
      result: sanitized,
    });

    if (sanitized.verdict === 'implemented' && sanitized.proposedActions.length > 0) {
      store.approvals.insertMany(
        input.job.id,
        sanitized.proposedActions,
        new Date(now().getTime() + APPROVAL_TTL_MS).toISOString(),
        sanitized.proposedActions.map(() => randomUUID()),
      );
    }

    const terminal = target === 'completed' || target === 'failed';
    store.jobs.transition(input.job.id, target, `result_${sanitized.verdict}`, 'system:intake', {
      leaseId: null,
      leaseExpiresAt: null,
      ...(terminal ? { finishedAt: now().toISOString() } : {}),
    });
    store.jobs.appendEvent(input.job.id, 'result_recorded', sanitized.summary.slice(0, 400));

    if (terminal) store.jobs.releaseReservation(input.job.repoSlug);
  });

  return { kind: 'accepted', state: target, duplicate: false };
}
