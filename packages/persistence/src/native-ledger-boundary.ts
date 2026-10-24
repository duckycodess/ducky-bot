import { feedEventTransition, transitionKey, transitionRepoKey, isWellFormedTransition, type Transition } from '@ducky/contracts';
import type { Db } from './db.js';

/**
 * Captures where the native ledger starts, in the migration's own transaction and BEFORE any
 * retention can run against the history it summarises (ADR 0034).
 *
 * The boundary says only whether the database is verifiably new and when the ledger began. It
 * deliberately does NOT record whether any ordinary watch or feed row survives: retention may
 * already have pruned them, so their absence proves nothing, and the repository a legacy
 * ordinary watch queried was never recorded at all.
 *
 * On a database that is not new, the feed rows that still carry their own repository, key and
 * time are read through the shared codec and staged, ownerless, for the first reader that knows
 * the owner. A delivered row stages a receipt, a pending row or an unconsumed buffered commit
 * stages a reservation. A skipped, baseline, abandoned or pruned row, and a commit a digest
 * already consumed (named or counted is unknown), stage nothing.
 */
export function captureNativeLedgerBoundary(db: Db, ctx: { readonly fresh: boolean; readonly at: string }): void {
  db.prepare(
    `INSERT INTO native_ledger_boundary (id, cutoff_at, fresh, created_at) VALUES (1, ?, ?, ?)`,
  ).run(ctx.at, ctx.fresh ? 1 : 0, ctx.at);
  if (ctx.fresh) return;

  const stage = db.prepare(
    `INSERT OR IGNORE INTO native_legacy_seed
       (repo_key, transition_key, kind, item, stamp, provider_hash, attempt, via, ref, observed_at,
        delivered_to, delivered_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const put = (
    repoKey: string, t: Transition, via: 'feed_event' | 'feed_commit', ref: string, observedAt: string,
    delivered: { to: string; at: string } | null,
  ): void => {
    if (!isWellFormedTransition(t)) return;
    stage.run(
      repoKey, transitionKey(t), t.kind, t.item, t.stamp, t.hash, t.attempt, via, ref, observedAt,
      delivered?.to ?? null, delivered?.at ?? null,
    );
  };

  const events = db
    .prepare(
      `SELECT id, event_key, kind, repo_key, status, created_at, delivered_at, delivered_to
         FROM github_feed_events WHERE status IN ('delivered','pending')`,
    )
    .all() as Record<string, unknown>[];
  for (const e of events) {
    const parsed = feedEventTransition(String(e['event_key']), String(e['kind']), String(e['repo_key']));
    if (!parsed) continue;
    if (String(e['status']) === 'delivered') {
      if (e['delivered_to'] == null || e['delivered_at'] == null) continue;
      put(parsed.repoKey, parsed.transition, 'feed_event', String(e['id']), String(e['created_at']), {
        to: String(e['delivered_to']), at: String(e['delivered_at']),
      });
    } else {
      put(parsed.repoKey, parsed.transition, 'feed_event', String(e['id']), String(e['created_at']), null);
    }
  }
  const commits = db
    .prepare('SELECT repo_key, sha, observed_at FROM github_feed_commits WHERE consumed_at IS NULL')
    .all() as Record<string, unknown>[];
  for (const c of commits) {
    const repo = transitionRepoKey(String(c['repo_key']));
    const sha = String(c['sha']);
    if (repo === null || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    put(repo, { kind: 'commit', item: sha, stamp: null, hash: null, attempt: null }, 'feed_commit', sha,
      String(c['observed_at']), null);
  }
}
