import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import { toBool, fromBool, type RepoRow } from './types.js';

const map = (r: Record<string, unknown>): RepoRow => ({
  slug: String(r['slug']),
  absolutePath: String(r['absolute_path']),
  defaultBranch: r['default_branch'] == null ? null : String(r['default_branch']),
  githubOwner: r['github_owner'] == null ? null : String(r['github_owner']),
  githubRepo: r['github_repo'] == null ? null : String(r['github_repo']),
  allowWorktree: toBool(r['allow_worktree']),
  allowBootstrap: toBool(r['allow_bootstrap']),
  bootstrapAllowedEntries: JSON.parse(String(r['bootstrap_allowed_entries_json'])) as string[],
  enabled: toBool(r['enabled']),
});

export class ReposRepo {
  constructor(private readonly db: Db) {}

  /** Config is authoritative; this mirrors it into the DB for FK integrity. */
  upsert(row: RepoRow): void {
    this.db
      .prepare(
        `INSERT INTO repos (slug, absolute_path, default_branch, github_owner, github_repo,
           allow_worktree, allow_bootstrap, bootstrap_allowed_entries_json, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(slug) DO UPDATE SET
           absolute_path = excluded.absolute_path,
           default_branch = excluded.default_branch,
           github_owner = excluded.github_owner,
           github_repo = excluded.github_repo,
           allow_worktree = excluded.allow_worktree,
           allow_bootstrap = excluded.allow_bootstrap,
           bootstrap_allowed_entries_json = excluded.bootstrap_allowed_entries_json,
           enabled = excluded.enabled`,
      )
      .run(
        row.slug,
        row.absolutePath,
        row.defaultBranch,
        row.githubOwner,
        row.githubRepo,
        fromBool(row.allowWorktree),
        fromBool(row.allowBootstrap),
        JSON.stringify(row.bootstrapAllowedEntries),
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
}
