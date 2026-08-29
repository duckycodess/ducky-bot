import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import { toBool, fromBool, type RepoPlacementRow, type RepoRow } from './types.js';

/**
 * `absolute_path` is deliberately absent here.
 *
 * It is the dead column migration 20 could not drop (three tables carry a
 * foreign key to `repos(slug)`, so the table cannot be rebuilt). `local_path`
 * replaced it, is nullable, and is the only path this mapper reads. A test
 * asserts the dead column is never read anywhere.
 */
const map = (r: Record<string, unknown>): RepoRow => ({
  slug: String(r['slug']),
  localPath: r['local_path'] == null ? null : String(r['local_path']),
  defaultBranch: r['default_branch'] == null ? null : String(r['default_branch']),
  githubOwner: r['github_owner'] == null ? null : String(r['github_owner']),
  githubRepo: r['github_repo'] == null ? null : String(r['github_repo']),
  allowWorktree: toBool(r['allow_worktree']),
  allowBootstrap: toBool(r['allow_bootstrap']),
  bootstrapAllowedEntries: JSON.parse(String(r['bootstrap_allowed_entries_json'])) as string[],
  allowJobs: toBool(r['allow_jobs']),
  enabled: toBool(r['enabled']),
});

const mapPlacement = (r: Record<string, unknown>): RepoPlacementRow => ({
  repoSlug: String(r['repo_slug']),
  executorId: String(r['executor_id']),
  absolutePath: String(r['absolute_path']),
  enabled: toBool(r['enabled']),
});

export class ReposRepo {
  constructor(private readonly db: Db) {}

  /** Config is authoritative; this mirrors it into the DB for FK integrity. */
  upsert(row: RepoRow): void {
    this.db
      .prepare(
        `INSERT INTO repos (slug, absolute_path, local_path, default_branch, github_owner, github_repo,
           allow_worktree, allow_bootstrap, bootstrap_allowed_entries_json, allow_jobs, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(slug) DO UPDATE SET
           absolute_path = excluded.absolute_path,
           local_path = excluded.local_path,
           default_branch = excluded.default_branch,
           github_owner = excluded.github_owner,
           github_repo = excluded.github_repo,
           allow_worktree = excluded.allow_worktree,
           allow_bootstrap = excluded.allow_bootstrap,
           bootstrap_allowed_entries_json = excluded.bootstrap_allowed_entries_json,
           allow_jobs = excluded.allow_jobs,
           enabled = excluded.enabled`,
      )
      .run(
        row.slug,
        // The dead column. NOT NULL still demands a value, and a pathless
        // repository has none to give; nothing reads this, so the placeholder
        // means nothing to anyone. See migration 20.
        row.localPath ?? '',
        row.localPath,
        row.defaultBranch,
        row.githubOwner,
        row.githubRepo,
        fromBool(row.allowWorktree),
        fromBool(row.allowBootstrap),
        JSON.stringify(row.bootstrapAllowedEntries),
        fromBool(row.allowJobs),
        fromBool(row.enabled),
        nowIso(),
      );
  }

  get(slug: string): RepoRow | undefined {
    const r = this.db.prepare('SELECT * FROM repos WHERE slug = ?').get(slug);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  list(): RepoRow[] {
    return this.db
      .prepare('SELECT * FROM repos ORDER BY slug')
      .all()
      .map((r) => map(r as Record<string, unknown>));
  }

  // ------------------------------------------------------------ placements --

  /**
   * Replaces the placements for one repository, in one transaction-free pass.
   *
   * Called only from the composition root, mirroring operator configuration.
   * Deleting first is what makes a REMOVED placement actually disappear: an
   * upsert alone would leave a host that was taken out of the config still
   * listed, and a stale placement is a path nobody reviewed any more.
   */
  replacePlacements(slug: string, placements: readonly RepoPlacementRow[]): void {
    this.db.prepare('DELETE FROM repo_placements WHERE repo_slug = ?').run(slug);
    const insert = this.db.prepare(
      `INSERT INTO repo_placements (repo_slug, executor_id, absolute_path, enabled, created_at)
       VALUES (?,?,?,?,?)`,
    );
    for (const p of placements) {
      insert.run(p.repoSlug, p.executorId, p.absolutePath, fromBool(p.enabled), nowIso());
    }
  }

  placements(slug?: string): RepoPlacementRow[] {
    const rows = slug
      ? this.db
          .prepare('SELECT * FROM repo_placements WHERE repo_slug = ? ORDER BY executor_id')
          .all(slug)
      : this.db
          .prepare('SELECT * FROM repo_placements ORDER BY repo_slug, executor_id')
          .all();
    return rows.map((r) => mapPlacement(r as Record<string, unknown>));
  }
}
