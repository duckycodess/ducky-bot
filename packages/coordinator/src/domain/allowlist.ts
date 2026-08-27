import { z } from 'zod';
import { DuckyError, GH_OWNER_RE, GH_REPO_RE, REPO_SLUG_RE } from '@ducky/contracts';
import type { RepoRow } from '@ducky/persistence';

export const RepoConfigSchema = z.strictObject({
  slug: z.string().regex(REPO_SLUG_RE),
  absolutePath: z.string().min(1).max(4096),
  defaultBranch: z.string().max(255).nullable().default(null),
  github: z
    .strictObject({ owner: z.string().regex(GH_OWNER_RE), repo: z.string().regex(GH_REPO_RE) })
    .nullable()
    .default(null),
  allowWorktree: z.boolean().default(true),
  allowBootstrap: z.boolean().default(false),
  bootstrapAllowedEntries: z.array(z.string().max(255)).max(32).default(['.git']),
  enabled: z.boolean().default(true),
});

export const RepoAllowlistSchema = z.strictObject({
  version: z.literal(1),
  repos: z.array(RepoConfigSchema).max(64),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * Discord supplies a *slug*, never a path. The mapping from slug to absolute
 * path lives in operator-controlled configuration, so no Discord message can
 * point a job at an arbitrary directory.
 */
export class RepoAllowlist {
  private readonly bySlug: Map<string, RepoConfig>;

  constructor(repos: readonly RepoConfig[]) {
    this.bySlug = new Map(repos.map((r) => [r.slug, r]));
  }

  static fromJson(json: string): RepoAllowlist {
    const parsed = RepoAllowlistSchema.parse(JSON.parse(json));
    return new RepoAllowlist(parsed.repos);
  }

  list(): RepoConfig[] {
    return [...this.bySlug.values()];
  }

  /** Rejects anything that is not a known, enabled slug. */
  resolve(slug: unknown): RepoConfig {
    if (typeof slug !== 'string' || !REPO_SLUG_RE.test(slug)) {
      throw new DuckyError('repo_not_allowed', 'That is not a configured repository.');
    }
    const found = this.bySlug.get(slug);
    if (!found || !found.enabled) {
      throw new DuckyError('repo_not_allowed', `\`${slug}\` is not an allowed repository.`);
    }
    return found;
  }

  toRepoRows(): RepoRow[] {
    return this.list().map((r) => ({
      slug: r.slug,
      absolutePath: r.absolutePath,
      defaultBranch: r.defaultBranch,
      githubOwner: r.github?.owner ?? null,
      githubRepo: r.github?.repo ?? null,
      allowWorktree: r.allowWorktree,
      allowBootstrap: r.allowBootstrap,
      bootstrapAllowedEntries: r.bootstrapAllowedEntries,
      enabled: r.enabled,
    }));
  }
}
