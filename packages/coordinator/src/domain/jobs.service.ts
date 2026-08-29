import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_MAX_ATTEMPTS, DuckyError, EXECUTOR_OFFLINE_AFTER_MS, INITIAL_WORK_PHASE, LEASE_TTL_MS,
  MAX_OWNER_INPUT_ROUNDS, ORPHAN_FAILURE_REASONS, RESERVATION_TTL_MS,
  canTransitionWorkPhase,
  isTerminal, newPublicJobId, type ClaimResponse, type ExecutorFailureReason,
  type JobProgress, type JobState, type JobSubmitInput, type JobWorkPhase,
} from '@ducky/contracts';
import { DUCKY_AGENT_PREFIX, DUCKY_WORKSPACE_LABEL_PREFIX } from '@ducky/contracts';
import { redact, toSlugKey as herdrSlugKey } from '@ducky/adapters';

/** Herdr checks linked worktrees out under its own directory. */
const HERDR_WORKTREE_DIR = /(^|\/)\.herdr\/worktrees\//;

const isWithin = (parent: string, child: string): boolean => {
  const rel = path.relative(path.normalize(parent), path.normalize(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
import { AUDIT_OWNER_REF } from '@ducky/contracts';
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
  /**
   * What this job has waited on, newest last. PRIVATE: the shared projection
   * has no field that could carry it, and no shared route reaches this method.
   */
  readonly dependencies: ReturnType<Store['dependencies']['forJob']>;
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

  /**
   * `origin.sharedChannelId` is set by the router ONLY when the submission
   * arrived from a channel that was in the configured shared set at that
   * moment. It is the address later lifecycle updates are posted to, so a job
   * started in a shared channel keeps reporting there instead of going quiet
   * in a DM nobody else can read.
   *
   * It is not authorization and grants nothing: it is re-checked against live
   * configuration before every send, so removing a channel from
   * configuration silences it immediately.
   */
  submit(
    actor: ActorContext,
    input: JobSubmitInput,
    origin: { sharedChannelId?: string | undefined } = {},
  ): JobRow {
    this.authz.requireOwner(actor);
    const repo = this.allowlist.resolve(input.repoSlug);
    /**
     * A watch-only mapping is not a job target.
     *
     * Refused HERE, at submit, rather than at claim: the owner finds out
     * immediately instead of watching a job sit queued forever, and no job row
     * is created for work that could never run. A repository is in the
     * allowlist so it can be watched through `gh`; running a job in it hands a
     * real agent edit capability in a working tree, which is a different
     * permission and now needs a different flag.
     */
    if (!repo.allowJobs) {
      throw new DuckyError(
        'repo_not_allowed',
        `\`${repo.slug}\` is configured for read-only observation only; it does not accept jobs.`,
      );
    }
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
        originSharedChannelId: origin.sharedChannelId ?? null,
      });
      if (state !== 'queued') {
        this.store.jobs.transition(job.id, state, 'no_executor_online', 'system:submit');
      }
      this.store.jobs.appendEvent(job.id, 'submitted', `Queued for ${repo.slug}.`);
      this.store.auditLog.record({
        event: 'job.created',
        actorKind: 'owner',
        actorRef: AUDIT_OWNER_REF,
        subjectKind: 'job',
        subjectRef: job.publicId,
        detail: `repo ${repo.slug}; state ${state}`,
      });
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
      dependencies: this.store.dependencies.forJob(job.id),
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
        this.store.auditLog.record({
          event: 'job.cancel_requested', actorKind: 'owner', actorRef: AUDIT_OWNER_REF,
          subjectKind: 'job', subjectRef: job.publicId,
          detail: 'running; waiting for the executor to stop',
        });
      });
      return { state: 'running', note: 'Cancellation requested; waiting for the executor to stop.' };
    }

    const reason =
      job.state === 'needs_approval'
        ? 'cancelled_with_pending_approvals'
        : job.state === 'needs_owner_input'
          ? 'cancelled_awaiting_owner_input'
          : job.state === 'waiting_on_dependency'
            ? 'cancelled_awaiting_dependency'
            : 'cancelled_by_owner';

    withTransaction(this.store.db, () => {
      if (job.state === 'needs_approval') {
        this.store.approvals.rejectAllPending(job.id, `owner:${actor.discordUserId}`, 'job_cancelled');
      }
      // A cancelled job must stop being polled for. Closing the dependency in
      // the SAME transaction is what stops the resolver spending its bounded
      // budget on work nobody wants -- and what stops it later requeueing a
      // job the owner already stopped.
      this.store.dependencies.cancelOpenForJob(job.id, this.now().toISOString());
      this.store.jobs.transition(job.id, 'cancelled', reason, `owner:${actor.discordUserId}`, {
        finishedAt: this.now().toISOString(),
        cancelRequested: true,
      });
      this.store.jobs.appendEvent(job.id, reason, 'Cancelled by the owner. Workspace retained.');
      this.store.auditLog.record({
        event: 'job.cancelled', actorKind: 'owner', actorRef: AUDIT_OWNER_REF,
        subjectKind: 'job', subjectRef: job.publicId, detail: reason,
      });
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
   * Clears an `orphan_agent` reservation, and ONLY that.
   *
   * `force` is the second step of the documented two-step confirmation for an
   * orphan whose agent cannot be confirmed gone. It is deliberately not an
   * override for a live reservation: releasing one while its job is still
   * nonterminal would let a second writer start on the same repository, which
   * is exactly what the reservation exists to prevent. A normal reservation is
   * released by cancelling the job, which goes through the safe path.
   */
  cleanup(
    actor: ActorContext,
    publicId: string,
    force: boolean,
    agentState?: 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | 'absent',
  ): { released: boolean; note: string } {
    this.authz.requireOwner(actor);
    const job = this.ownedJob(actor, publicId);
    const reservation = this.store.jobs.reservation(job.repoSlug);

    if (!reservation || reservation.jobId !== job.id) {
      return { released: false, note: 'That job is not holding its repository.' };
    }
    if (reservation.reason !== 'orphan_agent') {
      return {
        released: false,
        note: `\`${job.publicId}\` is ${job.state.replace(/_/g, ' ')} and still holds \`${job.repoSlug}\`. Cancel it instead; forced cleanup is only for an orphaned agent.`,
      };
    }

    // Step one: the caller must have inspected the agent. `agentState` is what
    // the caller observed, not a claim the owner typed. Without an observation
    // showing the agent gone or idle, an unforced cleanup refuses -- releasing
    // while a writer is live is what the reservation exists to prevent.
    const live = agentState === 'working' || agentState === 'blocked';
    const unknown = agentState === undefined || agentState === 'unknown';

    if (live && !force) {
      return {
        released: false,
        note: `The agent for \`${job.repoSlug}\` is still ${agentState}. Stop it first, or re-run with force to release anyway.`,
      };
    }
    if (unknown && !force) {
      return {
        released: false,
        note: `Could not confirm the agent for \`${job.repoSlug}\` has stopped. Inspect it, then re-run with force to release anyway.`,
      };
    }

    withTransaction(this.store.db, () => {
      this.store.jobs.releaseReservation(job.repoSlug);
      this.store.jobs.appendEvent(
        job.id,
        force ? 'forced_cleanup' : 'cleanup',
        force
          ? `Owner forced release of an orphaned reservation (agent observed: ${agentState ?? 'unknown'}).`
          : `Owner released an orphaned reservation after the agent was observed ${agentState}.`,
      );
    });
    return { released: true, note: `Released \`${job.repoSlug}\`.` };
  }

  // ========================================================= executor side ==

  hasLiveExecutor(): boolean {
    return this.liveExecutorIds().length > 0;
  }

  /** Active executors that have checked in recently enough to be trusted live. */
  private liveExecutorIds(): string[] {
    const cutoff = isoPlus(-EXECUTOR_OFFLINE_AFTER_MS, this.now());
    return this.store.executors
      .listExecutors()
      .filter((e) => e.state === 'active' && e.lastSeenAt !== null && e.lastSeenAt >= cutoff)
      .map((e) => e.id);
  }

  /**
   * The slugs this executor may be handed work for, right now.
   *
   * Two filters, in this order:
   *
   * 1. **Placement.** The executor must have a checkout of the repository. A
   *    repository with placements answers only for the executors it lists;
   *    one with the single-path form answers for everybody, which is what it
   *    has always meant.
   * 2. **Preference.** A repository may name a preferred host. While that host
   *    is LIVE it is the only eligible one; once it is not, every other placed
   *    executor becomes eligible again. A preference that survived its own
   *    host going offline would be a pin, and a pin means one host being off
   *    is one repository being dead.
   *
   * A repository that passes neither is simply absent from the claim
   * predicate, so its jobs stay queued rather than being handed to a host that
   * cannot run them. That is the fail-closed direction: waiting is recoverable,
   * running against the wrong directory is not.
   */
  private claimableSlugsFor(executorId: string): string[] {
    const live = new Set(this.liveExecutorIds());
    return this.allowlist
      .list()
      .filter((repo) => {
        if (this.allowlist.placementFor(repo, executorId) === undefined) return false;
        const preferred = repo.preferredExecutorId;
        if (preferred === null || preferred === executorId) return true;
        return !live.has(preferred);
      })
      .map((repo) => repo.slug);
  }

  /**
   * Why a queued job is not moving, in the owner's terms.
   *
   * Answers only for a job that is genuinely waiting on placement, and only
   * for the owner's private view. Undefined means "nothing unusual", and the
   * caller falls back to the ordinary queued copy.
   */
  placementHold(repoSlug: string): string | undefined {
    const repo = this.allowlist.list().find((r) => r.slug === repoSlug);
    if (!repo) return undefined;
    const eligible = this.allowlist.eligibleExecutors(repo);
    // The single-path form is eligible for anybody, so it is never held here.
    if (eligible === undefined) return undefined;
    if (eligible.length === 0) {
      return `No executor is configured to check out \`${repoSlug}\`.`;
    }
    const live = new Set(this.liveExecutorIds());
    if (!eligible.some((id) => live.has(id))) {
      return (
        `Waiting for an executor that has \`${repoSlug}\` checked out. ` +
        `Configured: ${eligible.map((id) => `\`${id}\``).join(', ')}; none is online.`
      );
    }
    return undefined;
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
      // Executor-aware from here on. Before placements existed, any executor
      // could be handed any queued job because there was only ever one path
      // per repository; now the claim predicate has to know who is asking.
      const job = this.store.jobs.nextClaimable(this.claimableSlugsFor(executorId));
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
        // A freshly claimed job is preparing. Setting it here rather than
        // waiting for the first progress report means the owner never sees a
        // running job with no phase at all.
        workPhase: INITIAL_WORK_PHASE,
      });
      this.store.jobs.appendEvent(job.id, 'claimed', 'Picked up by the executor.');
      this.store.auditLog.record({
        event: 'job.claimed', actorKind: 'executor', actorRef: executorId,
        subjectKind: 'job', subjectRef: job.publicId, detail: `repo ${job.repoSlug}`,
      });

      const repo = this.allowlist.resolve(job.repoSlug);
      /**
       * The path THIS executor uses, and nobody else's.
       *
       * `claimableSlugsFor` already established that a placement exists, so an
       * absent one here would mean the configuration changed underneath the
       * transaction. That is a refusal rather than a fallback: handing over
       * some other host's path is the one outcome this whole model exists to
       * prevent.
       */
      const placement = this.allowlist.placementFor(repo, executorId);
      if (!placement) {
        throw new DuckyError(
          'repo_not_allowed',
          `\`${repo.slug}\` has no checkout configured for this executor.`,
        );
      }
      const recorded = this.store.herdrWorkspaces.openForJob(job.id);
      const response: ClaimResponse = {
        jobId: job.id,
        publicId: job.publicId,
        leaseId,
        leaseExpiresAt,
        payload: {
          repoSlug: repo.slug,
          absolutePath: placement.absolutePath,
          defaultBranch: repo.defaultBranch,
          // Sent so the executor can PROVE the checkout in front of it is the
          // right repository before an agent touches it. It is a claim from
          // configuration and is only ever used to refuse.
          github: repo.github,
          fetchBeforeJob: repo.fetchBeforeJob,
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
        // A restarted executor has no in-memory map, so ownership travels with
        // the claim. Without it, recovery would meet its own agent as a
        // stranger and report a foreign conflict.
        recordedWorkspace: recorded
          ? {
              workspaceId: recorded.workspaceId,
              agentName: recorded.agentName,
              workspacePath: recorded.workspacePath ?? placement.absolutePath,
              mode: recorded.mode,
              state: recorded.state,
            }
          : null,
      };

      this.store.db
        .prepare('INSERT INTO idempotency_keys (key, scope, response_json, created_at) VALUES (?,?,?,?)')
        .run(`claim:${executorId}:${idempotencyKey}`, 'claim', JSON.stringify(response), nowIso());

      return response;
    });
  }

  /**
   * Lease renewal, proof of life, and -- optionally -- a move through the
   * engineering loop.
   *
   * The phase is applied INSIDE the same transaction as the lease renewal, so
   * a job can never end up with a refreshed lease and a stale phase or the
   * reverse. It is validated three ways before it lands:
   *
   * - the value is an allowlisted enum, rejected at the HTTP schema before it
   *   ever reaches here;
   * - the edge must be permitted by the work-phase machine, so a report cannot
   *   walk backwards from `implementing` to `planning`; and
   * - the job must still be lease-bearing, which the lease check above has
   *   already established.
   *
   * Reporting the SAME phase again is a no-op rather than an error: a retried
   * heartbeat is ordinary traffic. An invalid EDGE is refused with a clear
   * error, because that is a bug in the executor rather than a retry.
   */
  jobHeartbeat(
    executorId: string,
    jobId: string,
    leaseId: string,
    progress?: JobProgress,
  ): { cancelRequested: boolean; leaseExpiresAt: string; workPhase: JobWorkPhase | null } {
    const job = this.leasedJob(executorId, jobId, leaseId);
    const leaseExpiresAt = isoPlus(LEASE_TTL_MS, this.now());
    let phase = job.workPhase;

    // Validated BEFORE the transaction opens, and the refusal is recorded
    // outside it. Doing this inside would roll the audit row back along with
    // the rejected write, which would lose exactly the record worth keeping:
    // a refusal is a fact about an executor's behaviour, not a failed write to
    // be forgotten.
    if (progress?.phase !== undefined && !canTransitionWorkPhase(job.workPhase, progress.phase)) {
      this.store.auditLog.record({
        event: 'job.phase_changed', actorKind: 'executor', actorRef: executorId,
        subjectKind: 'job', subjectRef: job.publicId, outcome: 'refused',
        detail: `refused ${job.workPhase ?? 'none'} -> ${progress.phase}`,
      });
      throw new DuckyError(
        'invalid_transition',
        `A job cannot move from ${job.workPhase ?? 'no phase'} to ${progress.phase}.`,
      );
    }

    withTransaction(this.store.db, () => {
      // A job heartbeat IS proof of life. Renewing only the lease left a
      // long-running job's executor looking offline after the liveness window,
      // so a second submission would report "waiting for executor" while one
      // was demonstrably running.
      this.store.executors.touchExecutor(executorId, null);
      this.store.jobs.touchLease(job.id, leaseExpiresAt);
      this.store.jobs.refreshReservationForState(job.repoSlug, job.id, job.state);

      if (progress?.phase !== undefined) {
        const from = job.workPhase;
        // Re-asserted inside the transaction by `setWorkPhase` itself, so the
        // pre-check above is a convenience for the audit record rather than
        // the only guard.
        if (this.store.jobs.setWorkPhase(job.id, progress.phase)) phase = progress.phase;
        if (from !== phase) {
          this.store.jobs.appendEvent(
            job.id, 'phase_changed', `${from ?? 'none'} -> ${phase}`,
          );
          this.store.auditLog.record({
            event: 'job.phase_changed', actorKind: 'executor', actorRef: executorId,
            subjectKind: 'job', subjectRef: job.publicId,
            detail: `${from ?? 'none'} -> ${phase}`,
          });
        }
      }

      if (progress) {
        this.store.jobs.appendEvent(job.id, progress.kind, redact(progress.message).slice(0, 400));
      }
    });
    return { cancelRequested: job.cancelRequested, leaseExpiresAt, workPhase: phase };
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
      this.store.auditLog.record({
        event: 'job.cancelled', actorKind: 'executor', actorRef: executorId,
        subjectKind: 'job', subjectRef: job.publicId, detail: 'termination confirmed',
      });
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

    // Once a workspace is registered, a Ducky-owned agent may be live in it.
    // ANY failure from that point on therefore keeps the repository reserved
    // until the owner has looked -- releasing it would let a second writer
    // start beside a running agent. Only a failure that happened before any
    // workspace existed can safely release.
    const hasRecordedWorkspace = this.store.herdrWorkspaces.openForJob(job.id) !== undefined;
    const orphan = ORPHAN_FAILURE_REASONS.includes(reason) || hasRecordedWorkspace;

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
      this.store.auditLog.record({
        event: 'job.failed', actorKind: 'executor', actorRef: executorId,
        subjectKind: 'job', subjectRef: job.publicId, outcome: 'failed',
        detail: `${reason}${orphan ? '; repository stays reserved' : ''}`,
      });
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

  /**
   * Records a Ducky-owned Herdr workspace. The executor calls this as soon as
   * the workspace exists and BEFORE any agent is started in it, so a crash in
   * between still leaves the coordinator able to prove ownership rather than
   * mistaking a live agent for a stranger's.
   *
   * Idempotent, and lease-checked: a stale executor cannot re-point a
   * workspace at a different job.
   */
  registerWorkspace(
    executorId: string,
    jobId: string,
    leaseId: string,
    input: {
      workspaceId: string;
      label: string;
      mode: 'worktree' | 'direct';
      agentName: string;
      workspacePath: string;
      worktreePath?: string | null | undefined;
      state?: 'creating' | 'active' | 'closed';
    },
  ): { registered: boolean; workspaceId: string } {
    const job = this.leasedJob(executorId, jobId, leaseId);
    this.assertRegistrable(executorId, job, input);

    // The ownership decision is made INSIDE the transaction. Checking first and
    // writing afterwards left a race where a concurrent registration could win
    // and this call would still report success while recording nothing.
    withTransaction(this.store.db, () => {
      const existing = this.store.herdrWorkspaces.byWorkspaceId(input.workspaceId);
      const wrote = this.store.herdrWorkspaces.record({
        workspaceId: input.workspaceId,
        repoSlug: job.repoSlug,
        jobId: job.id,
        label: input.label,
        mode: input.mode,
        agentName: input.agentName,
        workspacePath: input.workspacePath,
        worktreePath: input.worktreePath ?? null,
        state: input.state ?? 'creating',
      });
      if (!wrote) {
        throw new DuckyError(
          'lease_mismatch',
          'That workspace is already registered to a different job.',
        );
      }
      if (!existing) {
        this.store.jobs.appendEvent(
          job.id,
          'workspace_registered',
          `Registered Ducky workspace ${input.workspaceId} (${input.mode}).`,
        );
      }
    });
    return { registered: true, workspaceId: input.workspaceId };
  }

  /**
   * The registration decides what Ducky will later consider its own, and what
   * it is therefore willing to close. Executor-supplied values are checked
   * here rather than trusted: a malformed name or a path escaping the
   * repository must be refused BEFORE it is persisted, or a later cleanup
   * could act on something that is not ours.
   *
   * A worktree checkout legitimately lives outside the source repository --
   * Herdr places it under its own directory -- so that case is allowed, but
   * only under a Ducky-owned worktrees path, never at an arbitrary location.
   */
  private assertRegistrable(
    executorId: string,
    job: JobRow,
    input: {
      workspaceId: string;
      label: string;
      mode: 'worktree' | 'direct';
      agentName: string;
      workspacePath: string;
    },
  ): void {
    const bad = (message: string): never => {
      throw new DuckyError('invalid_input', message);
    };

    const slugKey = herdrSlugKey(job.repoSlug);
    if (input.agentName !== `${DUCKY_AGENT_PREFIX}${slugKey}`) {
      bad('That agent name is not the one Ducky uses for this repository.');
    }
    if (input.label !== `${DUCKY_WORKSPACE_LABEL_PREFIX}${slugKey}`) {
      bad('That workspace label is not Ducky-managed.');
    }
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.workspaceId)) {
      bad('That workspace id is malformed.');
    }
    if (input.workspacePath.includes('\0') || /[\u0000-\u001f\u007f]/.test(input.workspacePath)) {
      bad('That workspace path contains control characters.');
    }
    if (!path.isAbsolute(input.workspacePath) || path.normalize(input.workspacePath) !== input.workspacePath) {
      bad('That workspace path is not a normalized absolute path.');
    }

    /**
     * Validated against the CLAIMING executor's own checkout.
     *
     * With placements there is no single "the repository path" any more, and
     * checking against another host's would either reject a correct workspace
     * or -- worse -- accept a path that is only meaningful somewhere else.
     */
    const repo = this.allowlist.resolve(job.repoSlug);
    const placement = this.allowlist.placementFor(repo, executorId);
    if (!placement) {
      bad('That executor has no configured checkout of this repository.');
    }
    const repoPath = placement!.absolutePath;
    const inRepo = isWithin(repoPath, input.workspacePath);
    if (input.mode === 'direct') {
      // Direct mode edits the checkout itself, so it must be the checkout.
      if (input.workspacePath !== path.normalize(repoPath)) {
        bad('A direct-mode workspace must be the configured repository path.');
      }
      return;
    }
    // Worktree mode: either inside the repo, or under a Ducky-owned worktrees
    // directory that Herdr manages. Nothing else.
    if (!inRepo && !HERDR_WORKTREE_DIR.test(input.workspacePath)) {
      bad('A worktree workspace must live in the repository or a Herdr worktrees directory.');
    }
  }

  /**
   * Marks a recorded workspace closed after the executor actually closed it.
   *
   * Deliberately separate from registerWorkspace: accepting the result clears
   * the lease, so the bookkeeping that follows a successful cleanup cannot use
   * one. It is therefore allowed on a TERMINAL job and authenticated by the
   * executor that owns the row rather than by a live lease.
   *
   * It can only ever close a workspace already recorded against this job, so
   * it can never authorize closing an unrecorded or user-owned workspace.
   */
  markWorkspaceClosed(
    executorId: string,
    jobId: string,
    workspaceId: string,
  ): { closed: boolean; workspaceId: string } {
    const job = this.store.jobs.byId(jobId);
    if (!job) throw new DuckyError('not_found', 'Unknown job.');
    if (job.executorId !== executorId) {
      throw new DuckyError('lease_mismatch', 'That job belongs to another executor.');
    }

    const row = this.store.herdrWorkspaces.byWorkspaceId(workspaceId);
    if (!row || row.jobId !== job.id) {
      throw new DuckyError('not_found', 'That workspace is not recorded for this job.');
    }
    // Idempotent: a retried close is a success, not an error. Checked before
    // the state gate so a late retry cannot fail after the job moved on.
    if (row.closedAt !== null) return { closed: true, workspaceId };

    // Only a job that COMPLETED may have its workspace closed. Failure,
    // approval, owner-input and orphan states all retain theirs so the work
    // stays inspectable -- and a still-running job must never have its
    // workspace marked gone underneath it.
    if (job.state !== 'completed') {
      throw new DuckyError(
        'invalid_transition',
        `\`${job.publicId}\` is ${job.state.replace(/_/g, ' ')}; only a completed job's workspace is closed.`,
      );
    }

    withTransaction(this.store.db, () => {
      this.store.herdrWorkspaces.markClosed(workspaceId);
      this.store.jobs.appendEvent(job.id, 'workspace_closed', `Closed workspace ${workspaceId}.`);
    });
    return { closed: true, workspaceId };
  }

  /** Recorded workspace for a job, so a reclaim can prove ownership. */
  workspaceForJob(jobId: string): ReturnType<Store['herdrWorkspaces']['openForJob']> {
    return this.store.herdrWorkspaces.openForJob(jobId);
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
