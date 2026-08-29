import { DuckyError, type RepoStatusSummary } from '@ducky/contracts';
import type { GitHubReader } from '@ducky/adapters';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { RepoAllowlist } from './allowlist.js';

/**
 * Read-only repository inspection. `owner/repo` comes from operator
 * configuration, never from Discord text, and the reader exposes no write
 * operation at all.
 */
export class GitHubService {
  constructor(
    private readonly authz: Authorizer,
    private readonly allowlist: RepoAllowlist,
    private readonly reader: GitHubReader,
  ) {}

  async repoStatus(actor: ActorContext, slug: string): Promise<RepoStatusSummary> {
    this.authz.requireOwner(actor);
    const repo = this.allowlist.resolve(slug);
    if (!repo.github) {
      throw new DuckyError('invalid_input', `\`${repo.slug}\` has no GitHub repository configured.`);
    }
    const ref = { owner: repo.github.owner, repo: repo.github.repo };

    const [view, prs] = await Promise.all([this.reader.repoView(ref), this.reader.prList(ref)]);
    const latest = prs[0];

    let checks = 'n/a';
    if (latest) {
      try {
        const rollup = await this.reader.prChecks(ref, latest.number);
        checks = summarizeChecks(rollup.map((c) => c.bucket ?? c.state ?? 'unknown'));
      } catch {
        checks = 'unavailable';
      }
    }

    return {
      slug: repo.slug,
      repoName: view.name,
      defaultBranch: view.defaultBranchRef?.name ?? repo.defaultBranch,
      openPrCount: prs.length,
      latestPr: latest
        ? { number: latest.number, title: latest.title, state: latest.state, checks }
        : null,
      placement: {
        jobsAllowed: repo.allowJobs,
        // Ids, never paths. `undefined` from the allowlist means "any
        // executor"; the summary says that with null rather than an empty list,
        // which would read as "nowhere".
        hosts: this.allowlist.eligibleExecutors(repo) ?? null,
        preferred: repo.preferredExecutorId,
      },
    };
  }
}

function summarizeChecks(buckets: readonly string[]): string {
  if (buckets.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const b of buckets) counts.set(b, (counts.get(b) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
}
