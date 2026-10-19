import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type {
  GitHubFeedCommitRow, GitHubFeedCursorKind, GitHubFeedCursorRow, GitHubFeedDigestRow,
  GitHubFeedDigestStatus, GitHubFeedEventOrigin, GitHubFeedEventRow, GitHubFeedEventStatus,
  GitHubFeedRepoRow, GitHubFeedRepoSource, GitHubFeedRepoState,
} from './types.js';
import type { GitHubFeedKind, GitHubFeedTarget } from '@ducky/contracts';

const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapRepo = (r: Record<string, unknown>): GitHubFeedRepoRow => ({
  repoKey: String(r['repo_key']),
  display: String(r['display']),
  source: String(r['source']) as GitHubFeedRepoSource,
  state: String(r['state']) as GitHubFeedRepoState,
  defaultBranch: str(r['default_branch']),
  commitGapAt: str(r['commit_gap_at']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  cancelledAt: str(r['cancelled_at']),
});

const mapCursor = (r: Record<string, unknown>): GitHubFeedCursorRow => ({
  scope: String(r['scope']),
  kind: String(r['kind']) as GitHubFeedCursorKind,
  baselinedAt: str(r['baselined_at']),
  cursor: str(r['cursor']),
  meta: str(r['meta']),
  nextCheckAt: String(r['next_check_at']),
  failures: Number(r['failures']),
  lastError: str(r['last_error']),
  lastSuccessAt: str(r['last_success_at']),
  updatedAt: String(r['updated_at']),
});

const mapEvent = (r: Record<string, unknown>): GitHubFeedEventRow => ({
  id: String(r['id']),
  eventKey: String(r['event_key']),
  kind: String(r['kind']) as GitHubFeedKind,
  repoKey: String(r['repo_key']),
  origin: String(r['origin']) as GitHubFeedEventOrigin,
  cardJson: str(r['card_json']),
  status: String(r['status']) as GitHubFeedEventStatus,
  attempts: Number(r['attempts']),
  lastAttemptAt: str(r['last_attempt_at']),
  deliveredAt: str(r['delivered_at']),
  deliveredTo: str(r['delivered_to']) as GitHubFeedTarget | null,
  createdAt: String(r['created_at']),
});

const mapCommit = (r: Record<string, unknown>): GitHubFeedCommitRow => ({
  repoKey: String(r['repo_key']),
  sha: String(r['sha']),
  branch: String(r['branch']),
  headline: String(r['headline']),
  author: String(r['author']),
  committedAt: String(r['committed_at']),
  observedAt: String(r['observed_at']),
  consumedAt: str(r['consumed_at']),
  consumedTarget: str(r['consumed_target']) as GitHubFeedTarget | null,
});

const mapDigest = (r: Record<string, unknown>): GitHubFeedDigestRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  dayKey: String(r['day_key']),
  target: String(r['target']) as GitHubFeedTarget,
  dueAt: String(r['due_at']),
  status: String(r['status']) as GitHubFeedDigestStatus,
  attempts: Number(r['attempts']),
  lastAttemptAt: str(r['last_attempt_at']),
  deliveredAt: str(r['delivered_at']),
  note: str(r['note']),
  createdAt: String(r['created_at']),
});

/** An event to record, already projected to a card. `card` is null for history. */
export interface NewFeedEvent {
  readonly id: string;
  readonly eventKey: string;
  readonly kind: GitHubFeedKind;
  readonly repoKey: string;
  readonly origin: GitHubFeedEventOrigin;
  readonly cardJson: string | null;
  readonly status: 'baseline' | 'pending';
}

export interface NewFeedCommit {
  readonly sha: string;
  readonly headline: string;
  readonly author: string;
  readonly committedAt: string;
  /**
   * History seen at a first watch (or when the walk lost its place), recorded as
   * ALREADY consumed so it is remembered as seen and never reported.
   */
  readonly baseline?: boolean;
}

/**
 * Durable state for the GitHub feed: the selected list, per-kind cursors, the
 * event ledger, the commit buffer and the daily digest slots.
 *
 * Every write that moves a cursor ALSO records what that read produced, in the
 * caller's transaction, so a crash can keep neither or both. And none of it
 * ever deletes anything on its own: retention names the settled rows it may
 * remove and never touches `github_feed_repos` or `github_feed_cursors`.
 */
export class GitHubFeedRepo {
  constructor(private readonly db: Db) {}

  // ---- the selected list ----------------------------------------------------

  listRepos(state?: GitHubFeedRepoState): GitHubFeedRepoRow[] {
    const rows = state
      ? this.db.prepare('SELECT * FROM github_feed_repos WHERE state = ? ORDER BY repo_key').all(state)
      : this.db.prepare('SELECT * FROM github_feed_repos ORDER BY repo_key').all();
    return rows.map((r) => mapRepo(r as Record<string, unknown>));
  }

  /** Every repository the feed's list still has a row for, active or cancelled (a tombstone is kept). */
  repoKeysEver(): string[] {
    return (
      this.db.prepare('SELECT repo_key AS k FROM github_feed_repos').all() as { k: string }[]
    ).map((r) => String(r.k));
  }

  repoByKey(repoKey: string): GitHubFeedRepoRow | undefined {
    const r = this.db.prepare('SELECT * FROM github_feed_repos WHERE repo_key = ?').get(repoKey);
    return r ? mapRepo(r as Record<string, unknown>) : undefined;
  }

  countActiveRepos(): number {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM github_feed_repos WHERE state = 'active'").get() as
        { n: number }).n,
    );
  }

  insertRepo(row: {
    repoKey: string; display: string; source: GitHubFeedRepoSource; atIso: string;
  }): boolean {
    return Number(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO github_feed_repos
             (repo_key, display, source, state, created_at, updated_at)
           VALUES (?,?,?, 'active', ?, ?)`,
        )
        .run(row.repoKey, row.display, row.source, row.atIso, row.atIso).changes,
    ) > 0;
  }

  /**
   * Takes a repository off the list. The row stays, as a tombstone, so a later
   * reconcile of the same seed does not quietly select it again; its undelivered
   * alerts are retired, because they describe something the owner stopped asking
   * about.
   */
  cancelRepo(repoKey: string, atIso: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE github_feed_repos SET state = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE repo_key = ? AND state = 'active'`,
      )
      .run(atIso, atIso, repoKey);
    if (Number(res.changes) !== 1) return false;
    this.db
      .prepare(
        `UPDATE github_feed_events SET status = 'skipped', last_attempt_at = ?
          WHERE repo_key = ? AND origin = 'selected' AND status = 'pending'`,
      )
      .run(atIso, repoKey);
    return true;
  }

  /**
   * Puts a cancelled repository back, and forgets its baseline.
   *
   * The baseline reset is the point: whatever happened while it was off the list
   * is history, not news, and the event ledger's keys already stop anything seen
   * before from being re-announced.
   */
  reactivateRepo(repoKey: string, source: GitHubFeedRepoSource, atIso: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE github_feed_repos
            SET state = 'active', source = ?, cancelled_at = NULL, updated_at = ?
          WHERE repo_key = ? AND state = 'cancelled'`,
      )
      .run(source, atIso, repoKey);
    if (Number(res.changes) !== 1) return false;
    this.db
      .prepare(
        `UPDATE github_feed_cursors
            SET baselined_at = NULL, cursor = NULL, meta = NULL, failures = 0,
                last_error = NULL, next_check_at = ?, updated_at = ?
          WHERE scope = ?`,
      )
      .run(atIso, atIso, repoKey);
    return true;
  }

  /** Changes how an ACTIVE repository got on the list (a seed the owner then named). */
  setRepoSource(repoKey: string, source: GitHubFeedRepoSource, atIso: string): void {
    this.db
      .prepare('UPDATE github_feed_repos SET source = ?, updated_at = ? WHERE repo_key = ?')
      .run(source, atIso, repoKey);
  }

  setDefaultBranch(repoKey: string, branch: string, atIso: string): void {
    this.db
      .prepare('UPDATE github_feed_repos SET default_branch = ?, updated_at = ? WHERE repo_key = ?')
      .run(branch, atIso, repoKey);
  }

  setCommitGap(repoKey: string, atIso: string | null): void {
    this.db
      .prepare('UPDATE github_feed_repos SET commit_gap_at = ? WHERE repo_key = ?')
      .run(atIso, repoKey);
  }

  // ---- cursors ----------------------------------------------------------------

  /** Creates the unit's row, due now, if it does not exist. Never touches an existing one. */
  ensureCursor(scope: string, kind: GitHubFeedCursorKind, atIso: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO github_feed_cursors (scope, kind, next_check_at, updated_at)
         VALUES (?,?,?,?)`,
      )
      .run(scope, kind, atIso, atIso);
  }

  cursor(scope: string, kind: GitHubFeedCursorKind): GitHubFeedCursorRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM github_feed_cursors WHERE scope = ? AND kind = ?')
      .get(scope, kind);
    return r ? mapCursor(r as Record<string, unknown>) : undefined;
  }

  /**
   * Units that are due: every cursor of an ACTIVE repository, plus the
   * discovery scope when asked. A cancelled repository's cursors are not listed,
   * so cancelling a repository stops its polling without deleting its history.
   */
  dueUnits(nowIsoValue: string, limit: number, includeDiscovery: boolean): GitHubFeedCursorRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM github_feed_cursors c
           LEFT JOIN github_feed_repos r ON r.repo_key = c.scope
          WHERE c.next_check_at <= ?
            AND ((r.state = 'active') OR (c.scope = '@me' AND ? = 1))
          ORDER BY c.next_check_at ASC, c.scope ASC LIMIT ?`,
      )
      .all(nowIsoValue, includeDiscovery ? 1 : 0, limit)
      .map((r) => mapCursor(r as Record<string, unknown>));
  }

  /**
   * Records a SUCCESSFUL read: its events, its commits, and the cursor move.
   *
   * The expected `next_check_at` is a compare-and-swap, so two overlapping
   * passes cannot both record the same observation. Returns false when the CAS
   * lost, in which case NOTHING was written.
   */
  recordSuccess(input: {
    scope: string;
    kind: GitHubFeedCursorKind;
    expectedNextCheckAt: string;
    nextCheckAt: string;
    atIso: string;
    /** When set, this success is the unit's baseline. */
    baseline: boolean;
    cursor: string | null;
    meta?: string | null;
    events?: readonly NewFeedEvent[];
    commits?: { repoKey: string; branch: string; rows: readonly NewFeedCommit[] };
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE github_feed_cursors
            SET baselined_at = CASE WHEN ? = 1 AND baselined_at IS NULL THEN ? ELSE baselined_at END,
                cursor = ?, meta = COALESCE(?, meta), next_check_at = ?, failures = 0,
                last_error = NULL, last_success_at = ?, updated_at = ?
          WHERE scope = ? AND kind = ? AND next_check_at = ?`,
      )
      .run(
        input.baseline ? 1 : 0, input.atIso, input.cursor, input.meta ?? null, input.nextCheckAt,
        input.atIso, input.atIso, input.scope, input.kind, input.expectedNextCheckAt,
      );
    if (Number(res.changes) !== 1) return false;

    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO github_feed_events
         (id, event_key, kind, repo_key, origin, card_json, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const e of input.events ?? []) {
      insertEvent.run(e.id, e.eventKey, e.kind, e.repoKey, e.origin, e.cardJson, e.status, input.atIso);
    }
    if (input.commits) {
      const insertCommit = this.db.prepare(
        `INSERT OR IGNORE INTO github_feed_commits
           (repo_key, sha, branch, headline, author, committed_at, observed_at, consumed_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const c of input.commits.rows) {
        insertCommit.run(
          input.commits.repoKey, c.sha, input.commits.branch, c.headline, c.author, c.committedAt,
          input.atIso, c.baseline ? input.atIso : null,
        );
      }
    }
    return true;
  }

  /** A FAILED read: the cursor, baseline and dedup state are untouched. */
  recordFailure(input: {
    scope: string;
    kind: GitHubFeedCursorKind;
    expectedNextCheckAt: string;
    nextCheckAt: string;
    error: string;
    atIso: string;
  }): boolean {
    return Number(
      this.db
        .prepare(
          `UPDATE github_feed_cursors
              SET failures = failures + 1, last_error = ?, next_check_at = ?, updated_at = ?
            WHERE scope = ? AND kind = ? AND next_check_at = ?`,
        )
        .run(input.error, input.nextCheckAt, input.atIso, input.scope, input.kind, input.expectedNextCheckAt)
        .changes,
    ) === 1;
  }

  /** Sets a cursor to "due now", so a unit is re-read soon (a digest sweep). */
  makeDue(scope: string, kind: GitHubFeedCursorKind, atIso: string): void {
    this.db
      .prepare(
        `UPDATE github_feed_cursors SET next_check_at = ?
          WHERE scope = ? AND kind = ? AND next_check_at > ?`,
      )
      .run(atIso, scope, kind, atIso);
  }

  // ---- events -------------------------------------------------------------------

  eventByKey(eventKey: string): GitHubFeedEventRow | undefined {
    const r = this.db.prepare('SELECT * FROM github_feed_events WHERE event_key = ?').get(eventKey);
    return r ? mapEvent(r as Record<string, unknown>) : undefined;
  }

  /** Which of these keys are already known, so a read can tell new from seen. */
  knownEventKeys(keys: readonly string[]): Set<string> {
    const known = new Set<string>();
    const stmt = this.db.prepare('SELECT 1 FROM github_feed_events WHERE event_key = ?');
    for (const k of keys) if (stmt.get(k) !== undefined) known.add(k);
    return known;
  }

  pendingEvents(limit: number): GitHubFeedEventRow[] {
    return this.db
      .prepare("SELECT * FROM github_feed_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
      .all(limit)
      .map((r) => mapEvent(r as Record<string, unknown>));
  }

  listEvents(status?: GitHubFeedEventStatus): GitHubFeedEventRow[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM github_feed_events WHERE status = ? ORDER BY created_at').all(status)
      : this.db.prepare('SELECT * FROM github_feed_events ORDER BY created_at').all();
    return rows.map((r) => mapEvent(r as Record<string, unknown>));
  }

  markEventDelivered(id: string, atIso: string, to: GitHubFeedTarget): void {
    this.db
      .prepare(
        `UPDATE github_feed_events
            SET status = 'delivered', delivered_at = ?, delivered_to = ?,
                attempts = attempts + 1, last_attempt_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, to, atIso, id);
  }

  recordEventFailure(id: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE github_feed_events
            SET attempts = attempts + 1, last_attempt_at = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'abandoned' ELSE 'pending' END
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, maxAttempts, id);
  }

  markEventSkipped(id: string, atIso: string): void {
    this.db
      .prepare(
        `UPDATE github_feed_events SET status = 'skipped', last_attempt_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, id);
  }

  // ---- commits ----------------------------------------------------------------------

  /** Which of these shas this repository has ever recorded, consumed or not. */
  knownShas(repoKey: string, shas: readonly string[]): Set<string> {
    const known = new Set<string>();
    const stmt = this.db.prepare('SELECT 1 FROM github_feed_commits WHERE repo_key = ? AND sha = ?');
    for (const sha of shas) if (stmt.get(repoKey, sha) !== undefined) known.add(sha);
    return known;
  }

  /**
   * Retires commits that no digest ever picked up, so the buffer is bounded even
   * across a long run of skipped slots. They are marked consumed (with no
   * target), never deleted: the row is still the memory that the commit was seen.
   */
  expireOpenCommits(observedBeforeIso: string, atIso: string): number {
    // By OBSERVATION time, never commit date: a merge can bring in a commit dated
    // months ago, and that commit has only just arrived on the branch.
    return Number(
      this.db
        .prepare(
          `UPDATE github_feed_commits SET consumed_at = ?
            WHERE consumed_at IS NULL AND observed_at < ?`,
        )
        .run(atIso, observedBeforeIso).changes,
    );
  }

  /** Cursors currently failing, for honest degraded-coverage reporting. */
  degradedCursors(): GitHubFeedCursorRow[] {
    return this.db
      .prepare('SELECT * FROM github_feed_cursors WHERE failures > 0 ORDER BY scope, kind')
      .all()
      .map((r) => mapCursor(r as Record<string, unknown>));
  }

  /** Unconsumed commits for one repository, oldest first. */
  openCommits(repoKey: string): GitHubFeedCommitRow[] {
    return this.db
      .prepare(
        `SELECT * FROM github_feed_commits
          WHERE repo_key = ? AND consumed_at IS NULL ORDER BY committed_at ASC, sha ASC`,
      )
      .all(repoKey)
      .map((r) => mapCommit(r as Record<string, unknown>));
  }

  reposWithOpenCommits(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT repo_key FROM github_feed_commits WHERE consumed_at IS NULL ORDER BY repo_key')
        .all() as { repo_key: string }[]
    ).map((r) => r.repo_key);
  }

  /** Marks exactly these commits consumed. Already-consumed ones are left alone. */
  consumeCommits(repoKey: string, shas: readonly string[], atIso: string, target: GitHubFeedTarget): number {
    const stmt = this.db.prepare(
      `UPDATE github_feed_commits SET consumed_at = ?, consumed_target = ?
        WHERE repo_key = ? AND sha = ? AND consumed_at IS NULL`,
    );
    let n = 0;
    for (const sha of shas) n += Number(stmt.run(atIso, target, repoKey, sha).changes);
    return n;
  }

  // ---- digest slots ---------------------------------------------------------------------

  claimDigest(input: {
    id: string; discordUserId: string; dayKey: string; target: GitHubFeedTarget; dueAt: string;
  }): boolean {
    return Number(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO github_feed_digests
             (id, discord_user_id, day_key, target, due_at, status, created_at)
           VALUES (?,?,?,?,?, 'pending', ?)`,
        )
        .run(input.id, input.discordUserId, input.dayKey, input.target, input.dueAt, nowIso()).changes,
    ) > 0;
  }

  pendingDigests(limit: number): GitHubFeedDigestRow[] {
    return this.db
      .prepare("SELECT * FROM github_feed_digests WHERE status = 'pending' ORDER BY due_at, target LIMIT ?")
      .all(limit)
      .map((r) => mapDigest(r as Record<string, unknown>));
  }

  digestBySlot(discordUserId: string, dayKey: string, target: GitHubFeedTarget): GitHubFeedDigestRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM github_feed_digests WHERE discord_user_id = ? AND day_key = ? AND target = ?')
      .get(discordUserId, dayKey, target);
    return r ? mapDigest(r as Record<string, unknown>) : undefined;
  }

  listDigests(): GitHubFeedDigestRow[] {
    return this.db
      .prepare('SELECT * FROM github_feed_digests ORDER BY day_key, target')
      .all()
      .map((r) => mapDigest(r as Record<string, unknown>));
  }

  markDigestDelivered(id: string, atIso: string, note: string | null): void {
    this.db
      .prepare(
        `UPDATE github_feed_digests
            SET status = 'delivered', delivered_at = ?, attempts = attempts + 1,
                last_attempt_at = ?, note = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, atIso, note, id);
  }

  markDigestSkipped(id: string, atIso: string, note: string): void {
    this.db
      .prepare(
        `UPDATE github_feed_digests SET status = 'skipped', last_attempt_at = ?, note = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, note, id);
  }

  recordDigestFailure(id: string, atIso: string, maxAttempts: number): void {
    this.db
      .prepare(
        `UPDATE github_feed_digests
            SET attempts = attempts + 1, last_attempt_at = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'abandoned' ELSE 'pending' END
          WHERE id = ? AND status = 'pending'`,
      )
      .run(atIso, maxAttempts, id);
  }
}
