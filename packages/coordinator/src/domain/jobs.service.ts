import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_ATTEMPTS, DuckyError, EXECUTOR_OFFLINE_AFTER_MS, LEASE_TTL_MS,
  MAX_OWNER_INPUT_ROUNDS, ORPHAN_FAILURE_REASONS, RESERVATION_TTL_MS,
  isTerminal, newPublicJobId, type ClaimResponse, type ExecutorFailureReason,
  type JobState, type JobSubmitInput,
} from '@ducky/contracts';
import { redact } from '@ducky/adapters';
import { isoPlus, nowIso, withTransaction, type JobRow, type Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { RepoAllowlist } from './allowlist.js';
import { intakeResult, type IntakeVerdict } from './result-intake.js';

export interface JobsServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly allowlist: RepoAllowlist;
  readonly now?: () => Date;
}

export interface JobDetail {
  readonly job: JobRow;
  readonly transitions: ReturnType<Store['jobs']['transitions']>;
  readonly events: ReturnType<Store['jobs']['events']>;
  readonly approvals: ReturnType<Store['approvals']['forJob']>;
  readonly result: ReturnType<Store['results']['byJobId']>;
}

export class JobsService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly allowlist: RepoAllowlist;
  private readonly now: () => Date;

  constructor(deps: JobsServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.allowlist = deps.allowlist;
    this.now = deps.now ?? (() => new Date());
  }

  // ============================================================ owner side ==

  submit(actor: ActorContext, input: JobSubmitInput): JobRow {
    this.authz.requireOwner(actor);
    const repo = this.allowlist.resolve(input.repoSlug);
    if (input.bootstrap && !repo.allowBootstrap) {
      throw new DuckyError(
        'repo_not_allowed',
        `\`${repo.slug}\` is not configured to allow bootstrap jobs.`,
      );
    }

    const state: JobState = this.hasLiveExecutor() ? 'queued' : 'waiting_for_executor';
    return withTransaction(this.store.db, () => {
      const job = this.store.jobs.create({
        id: randomUUID(),
        publicId: newPublicJobId(),
        discordUserId: actor.discordUserId,
        repoSlug: repo.slug,
        task: input.task,
        context: input.context ?? null,
        bootstrap: input.bootstrap,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        maxOwnerInputRounds: MAX_OWNER_INPUT_ROUNDS,
        state: 'queued',
      });
      if (state !== 'queued') {
        this.store.jobs.transition(job.id, state, 'no_executor_online', 'system:submit');
      }
      this.store.jobs.appendEvent(job.id, 'submitted', `Queued for ${repo.slug}.`);
      return this.store.jobs.byId(job.id)!;
    });
  }

  list(actor: ActorContext, limit = 10): JobRow[] {
    this.authz.requireOwner(actor);
    return this.store.jobs.listRecent(actor.discordUserId, limit);
  }

  detail(actor: ActorContext, publicId: string): JobDetail {
    this.authz.requireOwner(actor);
    const job = this.ownedJob(actor, publicId);
    return {
      job,
      transitions: this.store.jobs.transitions(job.id),
      events: this.store.jobs.events(job.id),
      approvals: this.store.approvals.forJob(job.id),
      result: this.store.results.byJobId(job.id),
    };
  }

  /**
   * Valid from every nonterminal state and always idempotent.
   *
   * A running job is never optimistically marked cancelled: the flag is set and
   * the executor's acknowledgement (or lease expiry) decides. A paused job is
   * quiescent -- no lease, no writer lock -- so it can be cancelled at once.
   */
  requestCancel(actor: ActorContext, publicId: string): { state: JobState; note: string } {
    this.authz.requireOwner(actor);
    const job = this.ownedJob(actor, publicId);

    if (isTerminal(job.state)) return { state: job.state, note: 'Already finished.' };

    if (job.state === 'running') {
      if (job.cancelRequested) {
        return { state: job.state, note: 'Cancellation already requested; waiting for the executor.' };
      }
      withTransaction(this.store.db, () => {
        this.store.jobs.setCancelRequested(job.id);
        this.store.jobs.appendEvent(job.id, 'cancel_requested', 'Owner requested cancellation.');
      });
      return { state: 'running', note: 'Cancellation requested; waiting for the executor to stop.' };
    }

    const reason =
      job.state === 'needs_approval'
        ? 'cancelled_with_pending_approvals'
        : job.state === 'needs_owner_input'
          ? 'cancelled_awaiting_owner_input'
          : 'cancelled_by_owner';

    withTransaction(this.store.db, () => {
      if (job.state === 'needs_approval') {
        this.store.approvals.rejectAllPending(job.id, `owner:${actor.discordUserId}`, 'job_cancelled');
      }
      this.store.jobs.transition(job.id, 'cancelled', reason, `owner:${actor.discordUserId}`, {
        finishedAt: this.now().toISOString(),
        cancelRequested: true,
      });
      this.store.jobs.appendEvent(job.id, reason, 'Cancelled by the owner. Workspace retained.');
      this.releaseUnlessOrphan(job.repoSlug);
    });
    return { state: 'cancelled', note: 'Cancelled. Any workspace was retained for inspection.' };
  }

  /**
   * Owner answer to a needs_owner_input job. The reservation is retained and
   * refreshed, so the job re-claims its own repo while every other job stays
   * queued behind it.
   */
  submitOwnerInput(actor: ActorContext, publicId: string, answer: string): { state: JobState; note: string } {
    this.authz.requireOwner(actor);
    const job = this.ownedJob(actor, publicId);

    if (
      (job.state === 'queued' || job.state === 'waiting_for_executor') &&
      job.ownerInputRounds > 0
    ) {
      // Idempotent: the answer already landed and the job was requeued.
      return { state: job.state, note: 'That question was already answered.' };
    }
    if (job.state !== 'needs_owner_input') {
      throw new DuckyError(
        'invalid_transition',
        `Job ${publicId} is ${job.state.replace(/_/g, ' ')} and is not waiting for an answer.`,
      );
    }

    const question = this.store.results.byJobId(job.id)?.snapshot;
    const questionText =
      question && question.verdict === 'needs_owner_input' ? question.question : '(question unavailable)';

    if (job.ownerInputRounds + 1 > job.maxOwnerInputRounds) {
      withTransaction(this.store.db, () => {
        this.store.jobs.transition(job.id, 'failed', 'owner_input_rounds_exhausted', 'system:jobs', {
          finishedAt: this.now().toISOString(),
        });
        this.store.jobs.appendEvent(
          job.id,
          'owner_input_rounds_exhausted',
          'The maximum number of owner-input rounds was reached.',
        );
        this.releaseUnlessOrphan(job.repoSlug);
      });
      return { state: 'failed', note: 'That job already used all of its question rounds.' };
    }

    withTransaction(this.store.db, () => {
      this.store.jobs.addOwnerInput(
        randomUUID(),
        job.id,
        job.ownerInputRounds,
        redact(questionText),
        answer,
      );
      this.store.jobs.transition(job.id, 'queued', 'owner_answered', `owner:${actor.discordUserId}`, {
        ownerInputRounds: job.ownerInputRounds + 1,
      });
      this.store.jobs.appendEvent(job.id, 'owner_answered', 'Owner answered; requeued for the executor.');
      // keep holding the repo, with a fresh TTL
      this.store.jobs.acquireReservation(job.repoSlug, job.id, this.reservationExpiry('queued'));
    });
    return { state: 'queued', note: 'Answer recorded. The job is queued to continue.' };
  }

  /**
   * Clears an `orphan_agent` reservation. Without `force` the caller must have
   * confirmed the agent is gone; with `force` the decision is recorded.
   */
  cleanup(actor: ActorContext, publicId: string, force: boolean): { released: boolean; note: string } {
    this.authz.requireOwner(actor);
    const job = this.ownedJob(actor, publicId);
    const reservation = this.store.jobs.reservation(job.repoSlug);

    if (!reservation || reservation.jobId !== job.id) {
      return { released: false, note: 'That job is not holding its repository.' };
    }
    if (reservation.reason !== 'orphan_agent' && !force) {
      return { released: false, note: 'That reservation is a normal active job; cancel it instead.' };
    }

    withTransaction(this.store.db, () => {
      this.store.jobs.releaseReservation(job.repoSlug);
      this.store.jobs.appendEvent(
        job.id,
        force ? 'forced_cleanup' : 'cleanup',
        force
          ? 'Owner forced release of the repository reservation.'
          : 'Owner released the repository reservation.',
      );
    });
    return { released: true, note: `Released \`${job.repoSlug}\`.` };
  }

  // ========================================================= executor side ==

  hasLiveExecutor(): boolean {
    const cutoff = isoPlus(-EXECUTOR_OFFLINE_AFTER_MS, this.now());
    return this.store.executors
      .listExecutors()
      .some((e) => e.state === 'active' && e.lastSeenAt !== null && e.lastSeenAt >= cutoff);
  }

  /**
   * Atomic claim. The reservation -- not `state = running` -- is the gate, and
   * the guarded upsert can only extend a reservation this job already owns, so
   * a concurrent claim by a different job for the same repo makes no change and
   * this transaction aborts.
   */
  claim(executorId: string, idempotencyKey: string): ClaimResponse | undefined {
    const cached = this.store.db
      .prepare('SELECT response_json FROM idempotency_keys WHERE key = ?')
      .get(`claim:${executorId}:${idempotencyKey}`) as { response_json: string } | undefined;
    if (cached) return JSON.parse(cached.response_json) as ClaimResponse;

    return withTransaction(this.store.db, () => {
      const job = this.store.jobs.nextClaimable();
      if (!job) return undefined;

      const acquired = this.store.jobs.acquireReservation(
        job.repoSlug,
        job.id,
        this.reservationExpiry('running'),
      );
      if (!acquired) throw new DuckyError('rate_limited', 'Repository reserved by another job.');

      const leaseId = randomUUID();
      const leaseExpiresAt = isoPlus(LEASE_TTL_MS, this.now());
      this.store.jobs.transition(job.id, 'running', 'claimed', `executor:${executorId}`, {
        leaseId,
        leaseExpiresAt,
        executorId,
        startedAt: job.startedAt ?? this.now().toISOString(),
      });
      this.store.jobs.appendEvent(job.id, 'claimed', 'Picked up by the executor.');

      const repo = this.allowlist.resolve(job.repoSlug);
      const response: ClaimResponse = {
        jobId: job.id,
        publicId: job.publicId,
        leaseId,
        leaseExpiresAt,
        payload: {
          repoSlug: repo.slug,
          absolutePath: repo.absolutePath,
          defaultBranch: repo.defaultBranch,
          task: job.task,
          context: job.context,
          bootstrap: job.bootstrap,
          allowWorktree: repo.allowWorktree,
          allowBootstrap: repo.allowBootstrap,
          bootstrapAllowedEntries: repo.bootstrapAllowedEntries,
          maxOwnerInputRounds: job.maxOwnerInputRounds,
          recoveryRequired: job.recoveryRequired,
          ownerInputRounds: job.ownerInputRounds,
        },
        ownerInputs: this.store.jobs.ownerInputs(job.id),
      };

      this.store.db
        .prepare('INSERT INTO idempotency_keys (key, scope, response_json, created_at) VALUES (?,?,?,?)')
        .run(`claim:${executorId}:${idempotencyKey}`, 'claim', JSON.stringify(response), nowIso());

      return response;
    });
  }

  jobHeartbeat(
    executorId: string,
    jobId: string,
    leaseId: string,
    progress?: { kind: string; message: string },
  ): { cancelRequested: boolean; leaseExpiresAt: string } {
    const job = this.leasedJob(executorId, jobId, leaseId);
    const leaseExpiresAt = isoPlus(LEASE_TTL_MS, this.now());
    withTransaction(this.store.db, () => {
      this.store.jobs.touchLease(job.id, leaseExpiresAt);
      this.store.jobs.refreshReservationForState(job.repoSlug, job.id, job.state);
      if (progress) {
        this.store.jobs.appendEvent(job.id, progress.kind, redact(progress.message).slice(0, 400));
      }
    });
    return { cancelRequested: job.cancelRequested, leaseExpiresAt };
  }

  /**
   * Accepting a result clears the lease, so a network-retry of that same
   * submission must still be recognised. The lease is therefore valid here if
   * it is the job's current lease OR the lease of a result already recorded for
   * this job -- which is what makes an identical retry idempotent and a
   * *different* payload on the same lease a conflict rather than a lease error.
   */
  submitResult(
    executorId: string,
    jobId: string,
    leaseId: string,
    result: unknown,
    rawBodyBytes: number,
  ): IntakeVerdict {
    const job = this.store.jobs.byId(jobId);
    if (!job) throw new DuckyError('not_found', 'Unknown job.');
    if (job.executorId !== executorId) {
      throw new DuckyError('lease_mismatch', 'That lease is no longer current for this job.');
    }
    const recorded = this.store.results.byLease(jobId, leaseId);
    if (job.leaseId !== leaseId && !recorded) {
      throw new DuckyError('lease_mismatch', 'That lease is no longer current for this job.');
    }
    return intakeResult({ store: this.store, now: this.now }, {
      job,
      leaseId,
      result,
      rawBodyBytes,
    });
  }

  /**
   * `terminated: false` must NOT cancel the job: the executor is telling us it
   * could not stop the work. The job stays running, keeps its cancel flag, and
   * is resolved either by lease expiry or by a later genuine result.
   */
  cancelAck(
    executorId: string,
    jobId: string,
    leaseId: string,
    terminated: boolean,
    note?: string,
  ): { state: JobState } {
    const known = this.store.jobs.byId(jobId);
    // A repeated acknowledgement after the job already stopped is a no-op.
    if (known && known.executorId === executorId && isTerminal(known.state)) {
      return { state: known.state };
    }
    const job = this.leasedJob(executorId, jobId, leaseId);

    if (!terminated) {
      withTransaction(this.store.db, () => {
        this.store.jobs.appendEvent(
          job.id,
          'cancel_ack_not_terminated',
          redact(note ?? 'Executor could not terminate the work yet.').slice(0, 400),
        );
      });
      return { state: job.state };
    }

    withTransaction(this.store.db, () => {
      this.store.jobs.transition(job.id, 'cancelled', 'cancel_acknowledged', `executor:${executorId}`, {
        finishedAt: this.now().toISOString(),
        leaseId: null,
        leaseExpiresAt: null,
      });
      this.store.jobs.appendEvent(job.id, 'cancelled', 'Executor confirmed termination.');
      this.releaseUnlessOrphan(job.repoSlug);
    });
    return { state: 'cancelled' };
  }

  /**
   * Structured failure. Orphan reasons convert the reservation instead of
   * releasing it: a possibly-live writer must keep blocking the repository
   * until the owner clears it with /job cleanup.
   */
  reportFailure(
    executorId: string,
    jobId: string,
    leaseId: string,
    reason: ExecutorFailureReason,
    extra: { detail?: string; workspaceId?: string; agentName?: string } = {},
  ): { state: JobState; orphan: boolean } {
    const job = this.leasedJob(executorId, jobId, leaseId);
    const orphan = ORPHAN_FAILURE_REASONS.includes(reason);

    withTransaction(this.store.db, () => {
      this.store.jobs.transition(job.id, 'failed', reason, `executor:${executorId}`, {
        finishedAt: this.now().toISOString(),
        leaseId: null,
        leaseExpiresAt: null,
        ...(extra.workspaceId ? { retainedWorkspaceId: extra.workspaceId } : {}),
      });
      this.store.jobs.appendEvent(
        job.id,
        reason,
        redact(extra.detail ?? reason.replace(/_/g, ' ')).slice(0, 400),
      );
      if (orphan) {
        this.store.jobs.markReservationOrphan(job.repoSlug);
        this.store.jobs.appendEvent(
          job.id,
          'reservation_orphaned',
          `Repository \`${job.repoSlug}\` stays reserved until /job cleanup ${job.publicId}.`,
        );
      } else {
        this.releaseUnlessOrphan(job.repoSlug);
      }
    });
    return { state: 'failed', orphan };
  }

  recordWorkspace(input: {
    jobId: string;
    repoSlug: string;
    workspaceId: string;
    label: string;
    mode: 'worktree' | 'direct';
    agentName: string;
    worktreePath: string | null;
  }): void {
    this.store.herdrWorkspaces.record(input);
  }

  // ================================================================ helpers ==

  reservationExpiry(state: JobState): string | null {
    const ttl = RESERVATION_TTL_MS[state];
    return ttl == null ? null : isoPlus(ttl, this.now());
  }

  private releaseUnlessOrphan(repoSlug: string): void {
    const r = this.store.jobs.reservation(repoSlug);
    if (r && r.reason === 'orphan_agent') return;
    this.store.jobs.releaseReservation(repoSlug);
  }

  private ownedJob(actor: ActorContext, publicId: string): JobRow {
    const job = this.store.jobs.byPublicId(publicId);
    // Row ownership is re-checked in addition to the role check, so a routing
    // mistake cannot expose another account's job.
    if (!job || job.discordUserId !== actor.discordUserId) {
      throw new DuckyError('not_found', `No job \`${publicId}\`.`);
    }
    return job;
  }

  private leasedJob(executorId: string, jobId: string, leaseId: string): JobRow {
    const job = this.store.jobs.byId(jobId);
    if (!job) throw new DuckyError('not_found', 'Unknown job.');
    if (job.executorId !== executorId || job.leaseId !== leaseId) {
      throw new DuckyError('lease_mismatch', 'That lease is no longer current for this job.');
    }
    return job;
  }
}
