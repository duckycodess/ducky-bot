import { z } from 'zod';
import {
  DuckyError, EXECUTOR_ID_RE, GH_OWNER_RE, GH_REPO_RE, REPO_SLUG_RE,
} from '@ducky/contracts';
import type { RepoPlacementRow, RepoRow } from '@ducky/persistence';

/**
 * One host's checkout of one logical repository.
 *
 * The slug stays the only name anyone uses: Discord supplies a slug and never a
 * path, and the per-executor path is resolved by the coordinator at CLAIM time
 * from this operator-controlled file. An executor is told where its own
 * checkout is and is never told about anybody else's.
 */
export const RepoPlacementSchema = z.strictObject({
  executorId: z.string().regex(EXECUTOR_ID_RE),
  absolutePath: z.string().min(1).max(4096),
  /**
   * Lets an operator take one host out of rotation without deleting the path
   * they will want back. A disabled placement makes that executor ineligible;
   * it does not make the repository unavailable to the others.
   */
  enabled: z.boolean().default(true),
});

export const RepoConfigSchema = z
  .strictObject({
    /**
     * Operator notes. Ignored entirely, and permitted only so that a strict
     * schema does not force the reasoning for an entry to live somewhere the
     * person editing this file will not see it.
     */
    _comment: z.union([z.string(), z.array(z.string())]).optional(),
    slug: z.string().regex(REPO_SLUG_RE),
    /**
     * The single-path form, which is what every existing configuration uses and
     * which keeps meaning exactly what it always meant: this repository lives
     * here, and any executor may run jobs in it.
     *
     * Null for a repository with no checkout on this host at all -- a
     * watch-only GitHub mapping -- or for one whose paths are all expressed as
     * placements instead.
     */
    absolutePath: z.string().min(1).max(4096).nullable().default(null),
    /**
     * Per-executor checkouts. Empty keeps today's behaviour precisely.
     *
     * When this is non-empty it is EXHAUSTIVE: an executor not listed here is
     * not eligible for this repository. That is the fail-closed direction and
     * it is the whole point -- an Azure executor silently inheriting a WSL path
     * would be a job running against a directory that does not exist there, or
     * worse, one that does and is something else.
     */
    placements: z.array(RepoPlacementSchema).max(16).default([]),
    /**
     * The host that should get this repository's work when it is available.
     *
     * A preference, never a pin: if the preferred executor is not live, another
     * eligible one may claim. A hard pin would mean one host being off is one
     * repository being dead, which is a worse failure than running somewhere
     * else the operator already allowlisted.
     */
    preferredExecutorId: z.string().regex(EXECUTOR_ID_RE).nullable().default(null),
    defaultBranch: z.string().max(255).nullable().default(null),
    github: z
      .strictObject({ owner: z.string().regex(GH_OWNER_RE), repo: z.string().regex(GH_REPO_RE) })
      .nullable()
      .default(null),
    allowWorktree: z.boolean().default(true),
    allowBootstrap: z.boolean().default(false),
    bootstrapAllowedEntries: z.array(z.string().max(255)).max(32).default(['.git']),
    /**
     * Whether a coding job may run here at all. Default true, so every existing
     * entry is unchanged.
     *
     * Set false for a repository that exists in this file only so it can be
     * WATCHED. Watching is a read through `gh`; running a job hands a real
     * agent edit capability in a working tree. Before this flag, adding a
     * GitHub mapping so a repository could be watched also made it a job
     * target, which is one permission granting another.
     */
    allowJobs: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const p of cfg.placements) {
      if (seen.has(p.executorId)) {
        ctx.addIssue({
          code: 'custom',
          message: `\`${cfg.slug}\` lists executor \`${p.executorId}\` twice; one executor has one checkout of one repository.`,
        });
      }
      seen.add(p.executorId);
    }

    // Two ways of saying where the code is would mean deciding which wins, and
    // whichever answer we picked, half the readers would assume the other.
    if (cfg.placements.length > 0 && cfg.absolutePath !== null) {
      ctx.addIssue({
        code: 'custom',
        message:
          `\`${cfg.slug}\` sets both \`absolutePath\` and \`placements\`. Pick one: the single ` +
          'path applies to every executor, placements name a path per executor. Move the ' +
          'top-level path into a placement.',
      });
    }

    if (cfg.preferredExecutorId !== null && !seen.has(cfg.preferredExecutorId)) {
      ctx.addIssue({
        code: 'custom',
        message:
          `\`${cfg.slug}\` prefers executor \`${cfg.preferredExecutorId}\`, which has no ` +
          'placement here. An executor cannot be preferred for a repository it has no checkout of.',
      });
    }

    // A repository that accepts jobs has to say where they run. Caught at
    // startup rather than at claim time, so a typo fails at boot.
    if (cfg.allowJobs && cfg.absolutePath === null && cfg.placements.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `\`${cfg.slug}\` accepts jobs but names no path. Give it an \`absolutePath\`, give it ` +
          '`placements`, or set `allowJobs: false` if it exists here only to be watched.',
      });
    }
  });

export const RepoAllowlistSchema = z.strictObject({
  version: z.literal(1),
  repos: z.array(RepoConfigSchema).max(64),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type RepoPlacement = z.infer<typeof RepoPlacementSchema>;

/** Where one executor would run a job for one repository, and why. */
export interface ResolvedPlacement {
  readonly absolutePath: string;
  /** `placement` when named per executor, `default` for the single-path form. */
  readonly source: 'placement' | 'default';
}

/**
 * Discord supplies a *slug*, never a path. The mapping from slug to absolute
 * path lives in operator-controlled configuration, so no Discord message can
 * point a job at an arbitrary directory.
 *
 * With several executors that mapping is one-to-many: the same logical slug is
 * checked out in a different place on each host. The slug is still the only
 * thing anybody names, the repository reservation is still keyed on the slug
 * and is therefore still GLOBAL across every executor, and the path is chosen
 * here, at claim time, for the executor that is claiming.
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

  /**
   * Where this executor would check this repository out, or undefined when it
   * has nowhere to.
   *
   * Fail-closed in both directions: a repository with placements answers only
   * for the executors it lists, and a repository that accepts no jobs answers
   * for nobody at all.
   */
  placementFor(repo: RepoConfig, executorId: string): ResolvedPlacement | undefined {
    if (!repo.enabled || !repo.allowJobs) return undefined;
    if (repo.placements.length > 0) {
      const p = repo.placements.find((x) => x.executorId === executorId && x.enabled);
      return p ? { absolutePath: p.absolutePath, source: 'placement' } : undefined;
    }
    return repo.absolutePath === null
      ? undefined
      : { absolutePath: repo.absolutePath, source: 'default' };
  }

  /**
   * Every executor that could run a job for this repository today.
   *
   * The single-path form answers `undefined` rather than a list, because it
   * means "any executor" -- there is no set to enumerate, and inventing one
   * from the executors that happen to have checked in would make the answer
   * depend on who was online.
   */
  eligibleExecutors(repo: RepoConfig): readonly string[] | undefined {
    if (!repo.enabled || !repo.allowJobs) return [];
    if (repo.placements.length === 0) return undefined;
    return repo.placements.filter((p) => p.enabled).map((p) => p.executorId);
  }

  /** Slugs this executor could be handed work for, for the claim predicate. */
  slugsFor(executorId: string): string[] {
    return this.list()
      .filter((r) => this.placementFor(r, executorId) !== undefined)
      .map((r) => r.slug);
  }

  toRepoRows(): RepoRow[] {
    return this.list().map((r) => ({
      slug: r.slug,
      // The single-path form is this host's path; the placement form has no
      // one path, so the mirrored row carries none and the placements table
      // carries them all.
      localPath: r.absolutePath,
      defaultBranch: r.defaultBranch,
      githubOwner: r.github?.owner ?? null,
      githubRepo: r.github?.repo ?? null,
      allowWorktree: r.allowWorktree,
      allowBootstrap: r.allowBootstrap,
      bootstrapAllowedEntries: r.bootstrapAllowedEntries,
      allowJobs: r.allowJobs,
      enabled: r.enabled,
    }));
  }

  toPlacementRows(slug: string): RepoPlacementRow[] {
    const repo = this.bySlug.get(slug);
    if (!repo) return [];
    return repo.placements.map((p) => ({
      repoSlug: slug,
      executorId: p.executorId,
      absolutePath: p.absolutePath,
      enabled: p.enabled,
    }));
  }
}
