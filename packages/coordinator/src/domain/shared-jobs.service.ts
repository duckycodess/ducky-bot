import {
  DuckyError, PUBLIC_JOB_ID_RE, SHARED_SUMMARY_MAX, UNLISTED_REPO_SLUG,
  JOB_PHASE_LABEL, SHARED_NEXT_STEP, phaseOf,
  type JobState, type SharedJobProjection,
} from '@ducky/contracts';
import type { JobRow, Store } from '@ducky/persistence';
import type { RepoAllowlist } from './allowlist.js';

export interface SharedJobsServiceDeps {
  readonly store: Store;
  readonly allowlist: RepoAllowlist;
}

const clamp = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * The only source of job information for a non-owner.
 *
 * Deliberately a separate service rather than a filter over
 * `JobsService.list` / `JobsService.detail`. Those return `JobRow` and its
 * whole private neighbourhood -- task, context, owner id, transitions, events,
 * approvals, the result snapshot -- and a filter over them is a denylist:
 * correct only for as long as somebody remembers to extend it every time a
 * field is added. This builds `SharedJobProjection` field by field from named
 * sources instead, so a new column on `jobs`, a new event kind, or a new
 * result field is invisible here until somebody deliberately adds it and a
 * reviewer sees the diff.
 *
 * It reads the store directly and takes no `ActorContext`, because it has no
 * *identity* decision to make. Giving it an actor would invite somebody to
 * widen it later with an `if (isOwner)` branch, which is exactly the reuse
 * this separation exists to prevent.
 *
 * It does take a CHANNEL, and every read is scoped to it. Being safe to show
 * is not the same as being meant for this audience: a job submitted in a DM,
 * or in a different shared channel, was never offered to the people reading
 * this one, and its status, timing and result summary are still the owner's
 * to disclose. Scoping is therefore part of the query rather than a filter a
 * caller could forget, and the channel id is a required argument rather than
 * an option, so there is no call shape that reads across channels.
 */
export class SharedJobsService {
  private readonly store: Store;
  private readonly allowlist: RepoAllowlist;

  constructor(deps: SharedJobsServiceDeps) {
    this.store = deps.store;
    this.allowlist = deps.allowlist;
  }

  /**
   * Recent jobs submitted from `channelId`, newest first.
   *
   * Not scoped to a Discord *user*: this is a single-owner product, so every
   * job is the owner's, and scoping by the requesting user would return an
   * empty list to every collaborator. It is scoped to the CHANNEL, which is
   * the thing that actually says who a job was shared with.
   */
  list(channelId: string, limit = 10): SharedJobProjection[] {
    return this.store.jobs
      .listByOriginSharedChannel(channelId, limit)
      .map((job) => this.project(job));
  }

  /**
   * One job by its public id, if it originated in `channelId`.
   *
   * A malformed id, an unknown id, a job submitted in a DM and a job from a
   * different shared channel all produce the SAME `not_found`. That matters
   * beyond tidiness: a distinguishable refusal would turn this into an oracle
   * for which job ids exist and which channel each belongs to, which is most
   * of what the projection is careful not to say.
   */
  detail(channelId: string, publicId: string, atState?: JobState): SharedJobProjection {
    const id = publicId.trim();
    const job = PUBLIC_JOB_ID_RE.test(id)
      ? this.store.jobs.byPublicIdForSharedChannel(id, channelId)
      : undefined;
    if (!job) throw new DuckyError('not_found', 'No job with that id.');
    return this.project(job, atState);
  }

  /**
   * The single place a `JobRow` becomes shareable.
   *
   * Every field is named explicitly. `job.task`, `job.context`,
   * `job.discordUserId`, `job.retainedWorkspaceId`, `job.executorId`,
   * `job.leaseId` and the whole result snapshot are never read here.
   *
   * `atState` reports the job AS OF a particular transition rather than as it
   * stands now. A proactive notification needs that: by the time a sweep runs,
   * the job may already have moved on, and posting "working" and "paused" as
   * two identical "paused" messages would misreport the history the channel
   * is watching. An interactive read passes nothing and gets the live state.
   */
  project(job: JobRow, atState?: JobState): SharedJobProjection {
    const phase = phaseOf(atState ?? job.state);
    const result = this.store.results.byJobId(job.id);
    return {
      publicId: job.publicId,
      repoSlug: this.shareableSlug(job.repoSlug),
      phase,
      label: JOB_PHASE_LABEL[phase],
      nextStep: SHARED_NEXT_STEP[phase],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      // Redacted once already, at result intake. Clamped again here so a long
      // summary cannot crowd out the rest of the projection.
      resultSummary: result ? clamp(result.summaryRedacted, SHARED_SUMMARY_MAX) : null,
      resultVerdict: result ? result.verdict : null,
    };
  }

  /**
   * A slug is operator-curated configuration, so only a slug that is STILL
   * curated is shared. A job for a repository since removed from (or disabled
   * in) the allowlist reports a stand-in rather than a name the operator has
   * deliberately stopped listing.
   */
  private shareableSlug(slug: string): string {
    try {
      return this.allowlist.resolve(slug).slug;
    } catch {
      return UNLISTED_REPO_SLUG;
    }
  }
}
