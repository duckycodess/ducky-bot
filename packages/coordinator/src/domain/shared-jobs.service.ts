import {
  DuckyError, PUBLIC_JOB_ID_RE, SHARED_SUMMARY_MAX, UNLISTED_REPO_SLUG,
  JOB_PHASE_LABEL, SHARED_NEXT_STEP, phaseOf,
  type SharedJobProjection,
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
 * authorization decision to make: the router has already established that the
 * request came from a configured shared channel, and everything this returns
 * is safe for anyone who can read that channel. Giving it an actor would
 * invite somebody to widen it later with an `if (isOwner)` branch, which is
 * exactly the reuse this separation exists to prevent.
 */
export class SharedJobsService {
  private readonly store: Store;
  private readonly allowlist: RepoAllowlist;

  constructor(deps: SharedJobsServiceDeps) {
    this.store = deps.store;
    this.allowlist = deps.allowlist;
  }

  /**
   * Recent jobs, newest first.
   *
   * Deliberately not scoped to a Discord user. This is a single-owner
   * product, so every job is the owner's; scoping by the *requesting* user
   * would return an empty list to every collaborator, and scoping by the
   * owner's id would mean passing an identity into a service that must not
   * have one. What keeps this safe is the projection, not a row filter.
   */
  list(limit = 10): SharedJobProjection[] {
    return this.store.jobs.listAllRecent(limit).map((job) => this.project(job));
  }

  /**
   * One job by its public id.
   *
   * A malformed id, an unknown id and a stale id all produce the SAME
   * `not_found`, so the shared surface cannot be used to probe which job ids
   * have ever existed.
   */
  detail(publicId: string): SharedJobProjection {
    const id = publicId.trim();
    const job = PUBLIC_JOB_ID_RE.test(id) ? this.store.jobs.byPublicId(id) : undefined;
    if (!job) throw new DuckyError('not_found', 'No job with that id.');
    return this.project(job);
  }

  /**
   * The single place a `JobRow` becomes shareable.
   *
   * Every field is named explicitly. `job.task`, `job.context`,
   * `job.discordUserId`, `job.retainedWorkspaceId`, `job.executorId`,
   * `job.leaseId` and the whole result snapshot are never read here.
   */
  project(job: JobRow): SharedJobProjection {
    const phase = phaseOf(job.state);
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
