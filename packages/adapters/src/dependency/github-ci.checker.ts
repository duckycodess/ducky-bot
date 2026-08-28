import {
  DEPENDENCY_DETAIL_MAX,
  type DependencyCheckInput, type DependencyCheckOutcome, type DependencyType,
} from '@ducky/contracts';
import type { GitHubReader, RepoRef } from '../github/github.port.js';

/**
 * Resolves an allowlisted repository slug to its GitHub reference.
 *
 * Injected as a function so this adapter never imports the coordinator's
 * allowlist: a checker is told about a dependency and nothing else, and the set
 * of repositories it may look at is somebody else's decision.
 */
export type RepoRefResolver = (slug: string) => RepoRef | undefined;

/** `<allowlisted-slug>#<pr number>`, and nothing else is accepted. */
const EXTERNAL_KEY = /^([a-z0-9][a-z0-9-]{0,63})#(\d{1,7})$/;

const clamp = (s: string): string =>
  s.length <= DEPENDENCY_DETAIL_MAX ? s : `${s.slice(0, DEPENDENCY_DETAIL_MAX - 1)}…`;

/** Check buckets that mean the run will not become green on its own. */
const FAILED = /^(fail|cancel|timed_out|action_required|startup_failure)/i;
/** Buckets that are finished and fine. `skipping` counts: a skipped check passed. */
const PASSED = /^(pass|success|skipping|neutral)/i;

/**
 * Answers "has CI finished?" from the READ-ONLY `gh` surface Ducky already has.
 *
 * The shipped default (`UnavailableDependencyChecker`) answers `pending` for
 * everything, which is honest and useless: a job that waits on CI always ends at
 * the owner's desk even when CI definitively failed hours earlier. This one can
 * say `failed`, which is the answer that saves the owner a decision.
 *
 * Deliberate limits, each of which is a refusal rather than an oversight:
 *
 * - **`ci_run` only.** A package publish, an upstream change and a human action
 *   are not things `gh pr checks` can answer for, and claiming to support them
 *   would produce a confident `pending` that means nothing.
 * - **`verified` is false on this host, and that is load-bearing.** No GitHub
 *   repository is configured in the allowlist here, so no live check has ever
 *   run — and the resolver DOWNGRADES a `ready` from an unverified checker to
 *   `pending`. So on this host it can fail a job, and it cannot resume one. That
 *   asymmetry is the correct one: failing on a definite failure is safe;
 *   resuming on an unexercised integration is the plausible-looking fake this
 *   codebase refuses everywhere else.
 * - **An unreadable answer is `pending`, never `failed`.** A malformed key, an
 *   unknown repository, a `gh` error: none of those is evidence that the
 *   dependency will not be satisfied, and failing a job on a lookup problem
 *   would throw away work for an unrelated reason.
 * - **Read-only by construction.** It holds a `GitHubReader`, whose port has no
 *   write method, and every argv it can reach is classified `read_only`.
 */
export class GitHubCiDependencyChecker {
  readonly name = 'github-ci';
  readonly supports: readonly DependencyType[] = ['ci_run'];

  constructor(
    private readonly reader: GitHubReader,
    private readonly resolveRepo: RepoRefResolver,
    /**
     * True only once a live check has been recorded on this host. Nothing in
     * the code sets it: `verified` has to mean "it was exercised" or it means
     * nothing, exactly as it does for Herdr and OpenClaw.
     */
    readonly verified = false,
  ) {}

  async check(input: DependencyCheckInput): Promise<DependencyCheckOutcome> {
    if (input.type !== 'ci_run') {
      return {
        status: 'pending',
        detail: clamp(`This checker only answers for CI runs, not for ${input.type}.`),
      };
    }

    const key = (input.externalKey ?? '').trim().toLowerCase();
    const parsed = EXTERNAL_KEY.exec(key);
    if (!parsed) {
      return {
        status: 'pending',
        detail: clamp(
          'No usable CI reference. Report `externalKey` as `<repo slug>#<pull request number>`.',
        ),
      };
    }

    const ref = this.resolveRepo(parsed[1]!);
    if (!ref) {
      // An unallowlisted or unmapped repository is not a failure of the work.
      return {
        status: 'pending',
        detail: clamp(`\`${parsed[1]}\` is not an allowlisted repository with a GitHub mapping.`),
      };
    }

    let checks;
    try {
      checks = await this.reader.prChecks(ref, Number(parsed[2]));
    } catch {
      // Never the raw error: it can carry a token or a path, and the resolver
      // records this detail. A lookup problem is not a verdict.
      return { status: 'pending', detail: 'The CI status could not be read this time.' };
    }

    if (checks.length === 0) {
      return { status: 'pending', detail: 'No checks are reported for that pull request yet.' };
    }

    const bucketOf = (c: { state?: string; bucket?: string }): string => c.bucket ?? c.state ?? '';
    const failed = checks.filter((c) => FAILED.test(bucketOf(c)));
    if (failed.length > 0) {
      return {
        status: 'failed',
        detail: clamp(
          `${failed.length} of ${checks.length} check(s) failed: ` +
            failed.slice(0, 3).map((c) => c.name).join(', '),
        ),
      };
    }

    const passed = checks.filter((c) => PASSED.test(bucketOf(c)));
    if (passed.length === checks.length) {
      return { status: 'ready', detail: clamp(`All ${checks.length} check(s) passed.`) };
    }

    return {
      status: 'pending',
      detail: clamp(`${checks.length - passed.length} of ${checks.length} check(s) still running.`),
    };
  }
}
