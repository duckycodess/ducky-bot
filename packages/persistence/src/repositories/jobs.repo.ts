import {
  RESERVATION_TTL_MS,
  assertTransition, assertWorkPhaseTransition, isLeaseBearing,
  type JobState, type JobWorkPhase,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import { isoPlus, nowIso } from '../db.js';
import { fromBool, toBool, type JobRow, type OwnerInputRow, type ReservationRow } from './types.js';

const mapJob = (r: Record<string, unknown>): JobRow => ({
  id: String(r['id']),
  publicId: String(r['public_id']),
  discordUserId: String(r['discord_user_id']),
  repoSlug: String(r['repo_slug']),
  task: String(r['task']),
  context: r['context'] == null ? null : String(r['context']),
  bootstrap: toBool(r['bootstrap']),
  state: String(r['state']) as JobState,
  workPhase: r['work_phase'] == null ? null : (String(r['work_phase']) as JobWorkPhase),
  cancelRequested: toBool(r['cancel_requested']),
  attempts: Number(r['attempts']),
  maxAttempts: Number(r['max_attempts']),
  ownerInputRounds: Number(r['owner_input_rounds']),
  maxOwnerInputRounds: Number(r['max_owner_input_rounds']),
  recoveryRequired: toBool(r['recovery_required']),
  leaseId: r['lease_id'] == null ? null : String(r['lease_id']),
  leaseExpiresAt: r['lease_expires_at'] == null ? null : String(r['lease_expires_at']),
  executorId: r['executor_id'] == null ? null : String(r['executor_id']),
  retainedWorkspaceId: r['retained_workspace_id'] == null ? null : String(r['retained_workspace_id']),
  originSharedChannelId:
    r['origin_shared_channel_id'] == null ? null : String(r['origin_shared_channel_id']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  startedAt: r['started_at'] == null ? null : String(r['started_at']),
  finishedAt: r['finished_at'] == null ? null : String(r['finished_at']),
});

/**
 * Turns a transition actor into an audit actor kind plus a SAFE reference.
 *
 * `owner:<discord id>` becomes `('owner', 'owner')`: there is exactly one
 * owner, so the id adds nothing an auditor could use and would be unnecessary
 * personal data in a long-lived table. An executor id is not a secret and is
 * genuinely identifying, so it is kept.
 */
const splitActor = (actor: string): [string, string] => {
  const [prefix, ...rest] = actor.split(':');
  const tail = rest.join(':');
  if (prefix === 'owner') return ['owner', 'owner'];
  if (prefix === 'executor') return ['executor', tail || 'unknown'];
  if (prefix === 'system' && tail === 'reconciler') return ['reconciler', 'reconciler'];
  return ['system', tail || prefix || 'system'];
};

const mapReservation = (r: Record<string, unknown>): ReservationRow => ({
  repoSlug: String(r['repo_slug']),
  jobId: String(r['job_id']),
  acquiredAt: String(r['acquired_at']),
  expiresAt: r['expires_at'] == null ? null : String(r['expires_at']),
  reason: String(r['reason']) as 'active_job' | 'orphan_agent',
});

export interface CreateJobInput {
  id: string;
  publicId: string;
  discordUserId: string;
  repoSlug: string;
  task: string;
  context: string | null;
  bootstrap: boolean;
  maxAttempts: number;
  maxOwnerInputRounds: number;
  state: JobState;
  /**
   * The configured shared channel the job was submitted from, if any. Set by
   * the caller only when the channel was shared AT SUBMIT TIME, so this column
   * never holds an id that was not configured when it was written.
   */
  originSharedChannelId?: string | null;
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- jobs ----

  create(input: CreateJobInput): JobRow {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, context, bootstrap,
           state, max_attempts, max_owner_input_rounds, origin_shared_channel_id,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id, input.publicId, input.discordUserId, input.repoSlug, input.task,
        input.context, fromBool(input.bootstrap), input.state, input.maxAttempts,
        input.maxOwnerInputRounds, input.originSharedChannelId ?? null, ts, ts,
      );
    return this.byId(input.id)!;
  }

  byId(id: string): JobRow | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return r ? mapJob(r as Record<string, unknown>) : undefined;
  }

  byPublicId(publicId: string): JobRow | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE public_id = ?').get(publicId);
    return r ? mapJob(r as Record<string, unknown>) : undefined;
  }

  listRecent(ownerId: string, limit: number): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(ownerId, limit)
      .map((r) => mapJob(r as Record<string, unknown>));
  }

  /**
   * Recent jobs that were submitted from one specific shared channel.
   *
   * Exists for the shared projection. The channel scope is part of the query
   * rather than a filter applied afterwards: a job submitted in a DM or in a
   * different channel must never be a row this returns, so there is nothing
   * for a caller to forget to filter.
   *
   * `origin_shared_channel_id` is NULL for every privately submitted job, and
   * `= ?` never matches NULL in SQL, so those are excluded by the comparison
   * itself.
   *
   * It returns whole `JobRow`s like any repository method -- narrowing to
   * what is safe to *show* is the projection service's job, not the
   * repository's. Scoping which jobs exist at all is this method's.
   */
  listByOriginSharedChannel(channelId: string, limit: number): JobRow[] {
    return this.db
      .prepare(
        'SELECT * FROM jobs WHERE origin_shared_channel_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(channelId, limit)
      .map((r) => mapJob(r as Record<string, unknown>));
  }

  /**
   * One job by public id, but only if it originated in the given shared
   * channel. Returns undefined otherwise, so an unknown id and a private or
   * foreign-channel job are indistinguishable to the caller.
   */
  byPublicIdForSharedChannel(publicId: string, channelId: string): JobRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM jobs WHERE public_id = ? AND origin_shared_channel_id = ?')
      .get(publicId, channelId);
    return r ? mapJob(r as Record<string, unknown>) : undefined;
  }

  listByState(state: JobState): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at')
      .all(state)
      .map((r) => mapJob(r as Record<string, unknown>));
  }

  /**
   * Single point of state change. Validates the edge, records the transition,
   * and keeps the reservation TTL consistent with the new state.
   * Must be called inside a transaction by the caller.
   */
  transition(
    jobId: string,
    to: JobState,
    reason: string,
    actor: string,
    patch: Partial<{
      leaseId: string | null;
      leaseExpiresAt: string | null;
      executorId: string | null;
      cancelRequested: boolean;
      recoveryRequired: boolean;
      attempts: number;
      ownerInputRounds: number;
      retainedWorkspaceId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      workPhase: JobWorkPhase | null;
    }> = {},
  ): JobRow {
    const job = this.byId(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    assertTransition(job.state, to);

    const ts = nowIso();
    const sets: string[] = ['state = ?', 'updated_at = ?'];
    const args: unknown[] = [to, ts];
    const put = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if ('leaseId' in patch) put('lease_id', patch.leaseId ?? null);
    if ('leaseExpiresAt' in patch) put('lease_expires_at', patch.leaseExpiresAt ?? null);
    if ('executorId' in patch) put('executor_id', patch.executorId ?? null);
    if ('cancelRequested' in patch) put('cancel_requested', fromBool(patch.cancelRequested!));
    if ('recoveryRequired' in patch) put('recovery_required', fromBool(patch.recoveryRequired!));
    if ('attempts' in patch) put('attempts', patch.attempts);
    if ('ownerInputRounds' in patch) put('owner_input_rounds', patch.ownerInputRounds);
    if ('retainedWorkspaceId' in patch) put('retained_workspace_id', patch.retainedWorkspaceId ?? null);
    if ('startedAt' in patch) put('started_at', patch.startedAt ?? null);
    if ('finishedAt' in patch) put('finished_at', patch.finishedAt ?? null);

    // The work phase belongs to a live lease and to nothing else. Leaving a
    // stale `reviewing` on a job that has since been cancelled, paused on a
    // dependency or completed would render a lie, so any move OUT of a
    // lease-bearing state clears it unless the caller set one explicitly.
    if ('workPhase' in patch) put('work_phase', patch.workPhase ?? null);
    else if (!isLeaseBearing(to)) put('work_phase', null);

    args.push(jobId);

    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]));
    this.db
      .prepare(
        `INSERT INTO job_transitions (job_id, from_state, to_state, reason, actor, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(jobId, job.state, to, reason, actor, ts);

    // Audited HERE because this is the single point of state change, so
    // coverage is structural rather than a thing every caller has to remember.
    // It shares this transaction: a rolled-back transition must not leave an
    // audit row claiming it happened.
    //
    // The actor string is already a role-prefixed reference the callers
    // construct (`owner:<id>`, `executor:<id>`, `system:<component>`); only its
    // KIND and the non-identifying half are kept, so a Discord user id never
    // lands in the audit table.
    const [actorKind, actorTail] = splitActor(actor);
    this.db
      .prepare(
        `INSERT INTO audit_log (at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail)
         VALUES (?, 'job.transitioned', ?, ?, 'job', ?, 'ok', ?)`,
      )
      .run(ts, actorKind, actorTail, job.publicId, `${job.state} -> ${to} (${reason})`);

    this.refreshReservationForState(job.repoSlug, jobId, to);
    return this.byId(jobId)!;
  }

  transitions(jobId: string): { from: string; to: string; reason: string; actor: string; at: string }[] {
    return this.db
      .prepare('SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id')
      .all(jobId)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          from: String(r['from_state']),
          to: String(r['to_state']),
          reason: String(r['reason']),
          actor: String(r['actor']),
          at: String(r['created_at']),
        };
      });
  }

  /**
   * Moves a running job's engineering phase.
   *
   * Refuses on three independent grounds, and each is a real one:
   *
   * - the job must be lease-bearing, because a phase describes work in
   *   progress and there is none otherwise;
   * - the edge must be allowed by `ALLOWED_WORK_PHASE_TRANSITIONS`, so a
   *   report cannot walk backwards from implementing to planning; and
   * - reporting the SAME phase is a no-op that returns true, because a
   *   retried heartbeat is normal traffic and must not be an error.
   *
   * Throws `InvalidWorkPhaseTransitionError` on a bad edge; returns false when
   * the job simply is not in a state that has phases.
   */
  setWorkPhase(jobId: string, phase: JobWorkPhase): boolean {
    const job = this.byId(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (!isLeaseBearing(job.state)) return false;
    assertWorkPhaseTransition(job.workPhase, phase);
    if (job.workPhase === phase) return true;
    this.db
      .prepare('UPDATE jobs SET work_phase = ?, updated_at = ? WHERE id = ?')
      .run(phase, nowIso(), jobId);
    return true;
  }

  setCancelRequested(jobId: string): void {
    this.db
      .prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), jobId);
  }

  // -------------------------------------------------------------- events ----

  appendEvent(jobId: string, kind: string, messageRedacted: string): void {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM job_events WHERE job_id = ?')
      .get(jobId) as { n: number };
    this.db
      .prepare(
        `INSERT INTO job_events (job_id, seq, kind, message_redacted, created_at) VALUES (?,?,?,?,?)`,
      )
      .run(jobId, Number(next.n), kind, messageRedacted, nowIso());
  }

  events(jobId: string, limit = 20): { seq: number; kind: string; message: string; at: string }[] {
    return this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY seq DESC LIMIT ?')
      .all(jobId, limit)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          seq: Number(r['seq']),
          kind: String(r['kind']),
          message: String(r['message_redacted']),
          at: String(r['created_at']),
        };
      });
  }

  // -------------------------------------------------------- owner inputs ----

  addOwnerInput(id: string, jobId: string, round: number, question: string, answer: string): void {
    this.db
      .prepare(
        `INSERT INTO job_owner_inputs (id, job_id, round, question_redacted, answer, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, jobId, round, question, answer, nowIso());
  }

  ownerInputs(jobId: string): OwnerInputRow[] {
    return this.db
      .prepare('SELECT * FROM job_owner_inputs WHERE job_id = ? ORDER BY round')
      .all(jobId)
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          round: Number(r['round']),
          question: String(r['question_redacted']),
          answer: String(r['answer']),
        };
      });
  }

  // -------------------------------------------------------- reservations ----

  reservation(repoSlug: string): ReservationRow | undefined {
    const r = this.db.prepare('SELECT * FROM repo_reservations WHERE repo_slug = ?').get(repoSlug);
    return r ? mapReservation(r as Record<string, unknown>) : undefined;
  }

  reservationForJob(jobId: string): ReservationRow | undefined {
    const r = this.db.prepare('SELECT * FROM repo_reservations WHERE job_id = ?').get(jobId);
    return r ? mapReservation(r as Record<string, unknown>) : undefined;
  }

  /**
   * Acquire or extend a reservation. The guarded upsert can only ever extend a
   * row that already belongs to this job, so a concurrent claim by another job
   * makes no change and the caller aborts.
   */
  acquireReservation(repoSlug: string, jobId: string, expiresAt: string | null): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO repo_reservations (repo_slug, job_id, acquired_at, expires_at, reason)
         VALUES (?,?,?,?, 'active_job')
         ON CONFLICT(repo_slug) DO UPDATE SET
           expires_at = excluded.expires_at,
           acquired_at = excluded.acquired_at
         WHERE repo_reservations.job_id = excluded.job_id`,
      )
      .run(repoSlug, jobId, nowIso(), expiresAt);
    return Number(res.changes) > 0;
  }

  releaseReservation(repoSlug: string): void {
    this.db.prepare('DELETE FROM repo_reservations WHERE repo_slug = ?').run(repoSlug);
  }

  /** Orphan reservations never expire; only an explicit owner cleanup clears them. */
  markReservationOrphan(repoSlug: string): void {
    this.db
      .prepare(
        `UPDATE repo_reservations SET reason = 'orphan_agent', expires_at = NULL WHERE repo_slug = ?`,
      )
      .run(repoSlug);
  }

  refreshReservationForState(repoSlug: string, jobId: string, state: JobState): void {
    const existing = this.reservation(repoSlug);
    if (!existing || existing.jobId !== jobId) return;
    if (existing.reason === 'orphan_agent') return; // never auto-expires
    const ttl = RESERVATION_TTL_MS[state];
    if (ttl === undefined) {
      // terminal state: the caller releases the reservation explicitly
      return;
    }
    this.db
      .prepare('UPDATE repo_reservations SET expires_at = ? WHERE repo_slug = ?')
      .run(ttl === null ? null : isoPlus(ttl), repoSlug);
  }

  expiredReservations(now = nowIso()): ReservationRow[] {
    return this.db
      .prepare('SELECT * FROM repo_reservations WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(now)
      .map((r) => mapReservation(r as Record<string, unknown>));
  }

  // --------------------------------------------------------------- claim ----

  /**
   * A job is claimable when its repo has no reservation, or the reservation is
   * its own -- which is what lets an answered needs_owner_input job be
   * re-claimed while still holding the repo against every other job.
   */
  nextClaimable(): JobRow | undefined {
    const r = this.db
      .prepare(
        `SELECT j.* FROM jobs j
         LEFT JOIN repo_reservations r ON r.repo_slug = j.repo_slug
         WHERE j.state IN ('queued','waiting_for_executor')
           AND j.cancel_requested = 0
           AND (r.repo_slug IS NULL OR r.job_id = j.id)
         ORDER BY j.created_at ASC
         LIMIT 1`,
      )
      .get();
    return r ? mapJob(r as Record<string, unknown>) : undefined;
  }

  // -------------------------------------------------------------- leases ----

  touchLease(jobId: string, leaseExpiresAt: string): void {
    this.db
      .prepare('UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(leaseExpiresAt, nowIso(), jobId);
  }

  /**
   * Jobs whose lease has gone stale.
   *
   * Scoped to `running` exactly as in Phase 1, and correctly so: it is the
   * only lease-bearing state. A job waiting on a dependency holds a
   * reservation but NO lease, so it must not appear here -- it is not stalled,
   * it is on schedule.
   */
  expiredLeases(now = nowIso()): JobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(now)
      .map((r) => mapJob(r as Record<string, unknown>));
  }
}
