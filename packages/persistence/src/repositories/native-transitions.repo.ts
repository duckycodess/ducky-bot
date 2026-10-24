import {
  NATIVE_LEGACY_SKEW_MS, canonicalStamp, feedEventTransition, isObservedReviewKind, isWellFormedTransition, targetTransition,
  transitionKey, transitionRepoKey,
  type HashDomain, type ReviewObservedState, type TargetEventFacts, type Transition, type TransitionKind,
} from '@ducky/contracts';
import type { Db } from '../db.js';
import { atomically } from '../db.js';

/**
 * The exact reconciliation ledger between the native paths (the GitHub feed, the ordinary
 * repository watch) and the imported notification targets (ADR 0034).
 *
 * One row per owner, repository, exact transition and HOLDER. Several native paths can tell
 * the same transition (a feed card and an ordinary summary), so each keeps its own row, keyed
 * by (path, via, ref): a delivery or a release touches only the row of the outbox row it
 * belongs to, and one holder being abandoned can never erase another holder's receipt. The
 * target keeps at most ONE row per transition (a partial unique index) and is decided against
 * the AGGREGATE of the native holders: any delivered holder settles it, any reserved holder
 * makes it wait. A `native` row is a reservation made with an outbox row (it is released if
 * that row will never be sent, and becomes a receipt when it was delivered); a `target` row
 * exists only around one actual send attempt and becomes a receipt on success. Nothing here
 * reads the allowlist mirror, a timestamp alone, a count or a snapshot as evidence, and
 * nothing is a receipt until a send succeeded.
 *
 * Every decision is made inside the caller's transaction, synchronously, so a check and the
 * reservation that follows it are one step.
 */

export type ClaimVia = 'feed_event' | 'feed_commit' | 'watch_summary' | 'target_alert' | 'target_digest';
export type ClaimPath = 'native' | 'target';
export type DeliveredTo = 'github_channel' | 'owner_dm';

export interface ClaimRow {
  readonly ownerId: string;
  readonly repoKey: string;
  readonly transitionKey: string;
  readonly transition: Transition;
  readonly path: ClaimPath;
  readonly state: 'reserved' | 'delivered';
  readonly via: ClaimVia;
  readonly ref: string;
  readonly observedAt: string;
  readonly deliveredTo: DeliveredTo | null;
  readonly deliveredAt: string | null;
}

export interface LedgerBoundary {
  readonly cutoffAt: string;
  readonly fresh: boolean;
  readonly seededAt: string | null;
}

/**
 * What a native path may do with one item it is about to tell. `ambiguous`: the target delivered a
 * requested-changes review on the SAME pull request whose id differs, and nothing proves the two are
 * different reviews (the provider instants are equal or one is unknown): the card is neither sent nor
 * skipped, it is HELD and counted.
 */
export type NativeProbe = 'free' | 'target_delivered' | 'target_in_flight' | 'ambiguous';

export interface NativeProbeOptions {
  /**
   * `pb` of the previous COMPLETE review set the fact's review is absent from: the host instant fixed before the
   * read that produced it began. Null or absent means no proof. Used only for a NEW review fact.
   */
  readonly boundary?: string | null;
  /** The fact is a known review changing state (to DISMISSED). */
  readonly stateChange?: boolean;
  /**
   * For a state change only: the state the previous COMPLETE set recorded for that review, and ONLY when it was a
   * known, not-dismissed state. Without it a state change has no boundary proof (an unknown or identity-only prior
   * state proves nothing).
   */
  readonly priorState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
}

/**
 * The SQL predicate (over `kind` and `provider_state`) that selects the claims whose observed state is COMPATIBLE
 * with `state`: the same state, or a candidate set that includes it. Different states never compare.
 */
function compatibleStates(state: ReviewObservedState): string {
  switch (state) {
    case 'APPROVED': return `kind = 'review_approved'`;
    case 'COMMENTED': return `kind = 'review_commented'`;
    case 'DISMISSED': return `kind = 'review_dismissed' OR (kind = 'review_commented' AND provider_state = 'COMMENTED|DISMISSED')`;
    case 'COMMENTED|DISMISSED': return `kind IN ('review_commented','review_dismissed')`;
  }
}

/** What an imported event may do. */
export type TargetResolution =
  | { readonly outcome: 'deliver' }
  /** A native path already delivered it: settle silently, tell nothing. */
  | { readonly outcome: 'covered' }
  /** A native path holds it for a send that has not happened: wait, settle nothing. */
  | { readonly outcome: 'wait' }
  /** The evidence cannot place it: never delivered, never settled, counted. */
  | { readonly outcome: 'withhold'; readonly reason: 'legacy_unproven' | 'ambiguous_evidence' };

/** The ledger boundary could not be read: native observation and target delivery fail closed. */
export class NativeLedgerUnreadable extends Error {
  constructor() {
    super('native ledger boundary unreadable');
    this.name = 'NativeLedgerUnreadable';
  }
}

const mapClaim = (r: Record<string, unknown>): ClaimRow => ({
  ownerId: String(r['owner_id']),
  repoKey: String(r['repo_key']),
  transitionKey: String(r['transition_key']),
  transition: {
    kind: String(r['kind']) as TransitionKind,
    item: String(r['item']),
    stamp: r['stamp'] == null ? null : String(r['stamp']),
    hash: r['provider_hash'] == null ? null : String(r['provider_hash']),
    attempt: r['attempt'] == null ? null : String(r['attempt']),
    domain: r['hash_domain'] == null ? 'provider' : (String(r['hash_domain']) as HashDomain),
    state: r['provider_state'] == null ? null : (String(r['provider_state']) as ReviewObservedState),
  },
  path: String(r['path']) as ClaimPath,
  state: String(r['state']) as 'reserved' | 'delivered',
  via: String(r['via']) as ClaimVia,
  ref: String(r['ref']),
  observedAt: String(r['observed_at']),
  deliveredTo: r['delivered_to'] == null ? null : (String(r['delivered_to']) as DeliveredTo),
  deliveredAt: r['delivered_at'] == null ? null : String(r['delivered_at']),
});

export class NativeTransitionsRepo {
  constructor(private readonly db: Db) {}

  // ---- the boundary ---------------------------------------------------------------

  boundary(): LedgerBoundary | undefined {
    const r = this.db.prepare('SELECT * FROM native_ledger_boundary WHERE id = 1').get() as
      Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      cutoffAt: String(r['cutoff_at']),
      fresh: Number(r['fresh']) === 1,
      seededAt: r['seeded_at'] == null ? null : String(r['seeded_at']),
    };
  }

  /** The boundary, or a refusal: nothing native is observed or delivered against an unreadable one. */
  requireBoundary(): LedgerBoundary {
    const b = this.boundary();
    if (!b || !Number.isFinite(Date.parse(b.cutoffAt))) throw new NativeLedgerUnreadable();
    return b;
  }

  /**
   * Turns the rows the migration staged into claims for this owner, once, and empties the stage.
   * A staged delivered row is an exact receipt; a staged pending row or unconsumed commit is a
   * reservation (the sweep releases one whose outbox row will never be sent).
   */
  ensureSeeded(ownerId: string, atIso: string): void {
    const b = this.requireBoundary();
    if (b.seededAt !== null) return;
    atomically(this.db, () => {
      let receipts = 0;
      let reservations = 0;
      const rows = this.db.prepare('SELECT * FROM native_legacy_seed').all() as Record<string, unknown>[];
      for (const r of rows) {
        const t: Transition = {
          kind: String(r['kind']) as TransitionKind, item: String(r['item']),
          stamp: r['stamp'] == null ? null : String(r['stamp']),
          hash: r['provider_hash'] == null ? null : String(r['provider_hash']),
          attempt: r['attempt'] == null ? null : String(r['attempt']),
          domain: r['hash_domain'] == null ? 'provider' : (String(r['hash_domain']) as HashDomain),
        };
        const delivered = r['delivered_at'] != null && r['delivered_to'] != null;
        const ok = this.insertClaim({
          ownerId, repoKey: String(r['repo_key']), transition: t, path: 'native',
          via: String(r['via']) as ClaimVia, ref: String(r['ref']), observedAt: String(r['observed_at']), atIso,
          ...(delivered ? { delivered: { at: String(r['delivered_at']), to: String(r['delivered_to']) as DeliveredTo } } : {}),
        });
        if (ok) {
          if (delivered) receipts += 1;
          else reservations += 1;
        }
      }
      this.db.prepare('DELETE FROM native_legacy_seed').run();
      this.db
        .prepare(
          `UPDATE native_ledger_boundary SET seeded_at = ?, seeded_receipts = ?, seeded_reservations = ?
            WHERE id = 1 AND seeded_at IS NULL`,
        )
        .run(atIso, receipts, reservations);
    });
  }

  // ---- writing a claim --------------------------------------------------------------

  /**
   * INSERT OR IGNORE: true when this holder's row exists now. A native holder is never refused because
   * another holder has the transition; the one target row per transition is the only exclusive claim.
   */
  private insertClaim(c: {
    ownerId: string;
    repoKey: string;
    transition: Transition;
    path: ClaimPath;
    via: ClaimVia;
    ref: string;
    observedAt: string;
    atIso: string;
    delivered?: { at: string; to: DeliveredTo };
    providerAt?: string | null;
  }): boolean {
    if (!isWellFormedTransition(c.transition)) return false;
    const repo = transitionRepoKey(c.repoKey);
    if (repo === null) return false;
    const t = c.transition;
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO native_transition_claims
           (owner_id, repo_key, transition_key, kind, item, stamp, provider_hash, hash_domain, provider_state, attempt,
            provider_at, path, state, via, ref, observed_at, delivered_to, delivered_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.ownerId, repo, transitionKey(t), t.kind, t.item, t.stamp, t.hash, t.domain ?? 'provider', t.state ?? null,
        t.attempt, canonicalStamp(c.providerAt ?? null),
        c.path, c.delivered ? 'delivered' : 'reserved', c.via, c.ref, c.observedAt,
        c.delivered?.to ?? null, c.delivered?.at ?? null, c.atIso, c.atIso,
      );
    return Number(res.changes) === 1;
  }

  /**
   * The strongest state among one item's rows on one path that satisfy `extra`: `delivered` beats
   * `reserved`, null is none. One indexed aggregate, so the work does not grow with the lifetime of
   * the ledger the way reading and looping over every row would.
   */
  private strongest(
    ownerId: string, repoKey: string, kind: TransitionKind, item: string, path: ClaimPath,
    extra = '', ...params: (string | number)[]
  ): 'delivered' | 'reserved' | null {
    const r = this.db
      .prepare(
        `SELECT MAX(CASE WHEN state = 'delivered' THEN 2 ELSE 1 END) AS m
           FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND kind = ? AND item = ? AND path = ? ${extra}`,
      )
      .get(ownerId, repoKey, kind, item, path, ...params) as { m: number | null };
    return r.m === 2 ? 'delivered' : r.m === 1 ? 'reserved' : null;
  }

  /**
   * The strongest state among the rows of ONE exact transition on one path, across every holder:
   * `delivered` beats `reserved`, null is none.
   */
  private byKeyState(ownerId: string, repoKey: string, key: string, path: ClaimPath): 'delivered' | 'reserved' | null {
    const r = this.db
      .prepare(
        `SELECT MAX(CASE WHEN state = 'delivered' THEN 2 ELSE 1 END) AS m
           FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND transition_key = ? AND path = ?`,
      )
      .get(ownerId, repoKey, key, path) as { m: number | null };
    return r.m === 2 ? 'delivered' : r.m === 1 ? 'reserved' : null;
  }

  /** The one target row of an exact transition, if any. */
  private targetRow(ownerId: string, repoKey: string, key: string): { state: 'reserved' | 'delivered'; ref: string } | undefined {
    return this.db
      .prepare(
        `SELECT state, ref FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND transition_key = ? AND path = 'target'`,
      )
      .get(ownerId, repoKey, key) as { state: 'reserved' | 'delivered'; ref: string } | undefined;
  }

  // ---- the native side --------------------------------------------------------------

  /**
   * Whether a native path may tell this item. Only an ACTUALLY DELIVERED target transition
   * lets it skip; a target send in flight makes it wait (the caller defers); anything else,
   * including an imported event that merely exists, is free. A requested-changes review is
   * compared with the target's claims on the same pull request (`probeReview`).
   */
  probeNative(
    ownerId: string, repoKey: string, t: Transition, providerAt: string | null = null, opts: NativeProbeOptions = {},
  ): NativeProbe {
    const repo = transitionRepoKey(repoKey);
    if (repo === null || !isWellFormedTransition(t)) return 'free';
    if (t.kind === 'changes_requested') return this.probeReview(ownerId, repo, t, canonicalStamp(providerAt));
    if (isObservedReviewKind(t.kind)) return this.probeObserved(ownerId, repo, t, canonicalStamp(providerAt), opts);
    // An update is covered by a target update at or after it; every other kind by its exact key.
    const state = t.kind === 'pr_updated'
      ? this.strongest(ownerId, repo, t.kind, t.item, 'target', 'AND stamp >= ?', t.stamp ?? '')
      : this.byKeyState(ownerId, repo, transitionKey(t), 'target');
    return state === 'delivered' ? 'target_delivered' : state === 'reserved' ? 'target_in_flight' : 'free';
  }

  /**
   * A requested-changes card against the target's claims on the same pull request. The exact key (the
   * hash of the review id) decides when the ids match. A DIFFERENT hash is not proof of a different
   * review (the native and REST ids may simply not be comparable on a live provider), so: a target send
   * in flight makes the card wait; a delivered one proves a DIFFERENT review only when both provider
   * instants are known and differ (then the card is sent); an equal or unknown instant cannot be told
   * apart, so the card is HELD, never sent, skipped or receipted.
   */
  private probeReview(ownerId: string, repo: string, t: Transition, providerAt: string | null): NativeProbe {
    const exact = this.byKeyState(ownerId, repo, transitionKey(t), 'target');
    if (exact === 'delivered') return 'target_delivered';
    if (exact === 'reserved') return 'target_in_flight';
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN state = 'reserved' THEN 1 ELSE 0 END), 0) AS reserved,
                COALESCE(SUM(CASE WHEN state = 'delivered'
                                   AND (provider_at IS NULL OR ? IS NULL OR provider_at = ?) THEN 1 ELSE 0 END), 0) AS unprovable
           FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND kind = 'changes_requested' AND item = ? AND path = 'target'`,
      )
      .get(providerAt, providerAt, ownerId, repo, t.item) as { reserved: number; unprovable: number };
    if (Number(r.reserved) > 0) return 'target_in_flight';
    return Number(r.unprovable) > 0 ? 'ambiguous' : 'free';
  }

  /**
   * A native review fact in an OBSERVED state against the target's claims on the same pull request. Only claims of a
   * COMPATIBLE state are compared (an approved and a dismissed observation are different tellings, both told, and
   * never held against each other). The exact key (same domain, same hash, same state) decides first. Otherwise a
   * target send in flight makes the fact wait; a delivered claim with a DIFFERENT known submission instant is a
   * different review; an equal or unknown instant cannot be told apart, so the fact is HELD, unless the boundary
   * proof shows the target's review existed before the read that produced the previous complete set began
   * (`observed_at` + the skew margin is before `opts.boundary`): then it is in that set and the new fact is not it.
   * A known review changing state to DISMISSED has a proof of its own, resting on the enforced lifecycle (DISMISSED
   * is terminal, and an approved or requested-changes review is never merely commented): when the previous set
   * recorded that review in a KNOWN not-dismissed state (`opts.priorState`), a compatible target claim committed
   * before that set's read began cannot be the same review, because it was already dismissed (or, for a candidate set,
   * dismissed or commented) while the review was still recorded undismissed. A prior COMMENTED state cannot refute a
   * candidate set that includes COMMENTED. With no known prior state (unknown, identity-only, no boundary) there is
   * no proof and the fact stays held.
   */
  private probeObserved(
    ownerId: string, repo: string, t: Transition, providerAt: string | null, opts: NativeProbeOptions,
  ): NativeProbe {
    const key = transitionKey(t);
    const exact = this.byKeyState(ownerId, repo, key, 'target');
    if (exact === 'delivered') return 'target_delivered';
    if (exact === 'reserved') return 'target_in_flight';
    const rows = this.db
      .prepare(
        `SELECT kind, state, provider_at, observed_at FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND item = ? AND path = 'target' AND transition_key != ?
            AND (${compatibleStates(t.state ?? 'COMMENTED|DISMISSED')})`,
      )
      .all(ownerId, repo, t.item, key) as { kind: string; state: string; provider_at: string | null; observed_at: string }[];
    if (rows.some((r) => r.state === 'reserved')) return 'target_in_flight';
    const boundaryMs = opts.boundary == null ? Number.NaN : Date.parse(opts.boundary);
    // A state change is proven only against a known not-dismissed prior state.
    const usable = Number.isFinite(boundaryMs) && (opts.stateChange !== true || opts.priorState !== undefined);
    for (const r of rows) {
      if (providerAt !== null && r.provider_at !== null && r.provider_at !== providerAt) continue;
      if (usable && Date.parse(r.observed_at) + NATIVE_LEGACY_SKEW_MS < boundaryMs) {
        if (opts.stateChange !== true) continue;
        // Terminal DISMISSED refutes any known not-dismissed prior; a candidate set also needs the prior not to be COMMENTED.
        if (r.kind === 'review_dismissed' || opts.priorState !== 'COMMENTED') continue;
      }
      return 'ambiguous';
    }
    return 'free';
  }

  /**
   * Whether ANY path delivered ANY state of this exact review (same provider-domain hash on the same pull
   * request). It only chooses the wording of a dismissal ("a review was dismissed" against "a review was
   * submitted and is dismissed"); it is never a receipt for a dismissal.
   */
  reviewTold(ownerId: string, repoKey: string, item: string, hash: string): boolean {
    const repo = transitionRepoKey(repoKey);
    if (repo === null) return false;
    return this.db
      .prepare(
        `SELECT 1 FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND item = ? AND provider_hash = ? AND hash_domain = 'provider'
            AND state = 'delivered'
            AND kind IN ('changes_requested','review_approved','review_commented','review_dismissed') LIMIT 1`,
      )
      .get(ownerId, repo, item, hash) !== undefined;
  }

  /** Reserves a transition for a native outbox row. False when something already owns it. */
  reserveNative(
    ownerId: string, repoKey: string, t: Transition, via: ClaimVia, ref: string, observedAt: string, atIso: string,
    providerAt: string | null = null,
  ): boolean {
    return this.insertClaim({ ownerId, repoKey, transition: t, path: 'native', via, ref, observedAt, atIso, providerAt });
  }

  /** The outbox row was delivered: its reservations become receipts. Same transaction as the settlement. */
  markNativeDelivered(via: ClaimVia, ref: string, to: DeliveredTo, atIso: string, repoKey?: string): number {
    const repo = repoKey === undefined ? null : transitionRepoKey(repoKey);
    return Number(
      this.db
        .prepare(
          `UPDATE native_transition_claims
              SET state = 'delivered', delivered_to = ?, delivered_at = ?, updated_at = ?
            WHERE path = 'native' AND state = 'reserved' AND via = ? AND ref = ?
              AND (? IS NULL OR repo_key = ?)`,
        )
        .run(to, atIso, atIso, via, ref, repo, repo).changes,
    );
  }

  /** Releases one native reservation: its outbox row will not be sent. */
  releaseNative(via: ClaimVia, ref: string, repoKey?: string): number {
    const repo = repoKey === undefined ? null : transitionRepoKey(repoKey);
    return Number(
      this.db
        .prepare(
          `DELETE FROM native_transition_claims
            WHERE path = 'native' AND state = 'reserved' AND via = ? AND ref = ? AND (? IS NULL OR repo_key = ?)`,
        )
        .run(via, ref, repo, repo).changes,
    );
  }

  /** Releases every reservation of one repository on one path (a deselected feed repository). */
  releaseNativeForRepo(via: ClaimVia, repoKey: string): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM native_transition_claims
            WHERE path = 'native' AND state = 'reserved' AND via = ? AND repo_key = ?`,
        )
        .run(via, repoKey).changes,
    );
  }

  /** Releases every reservation made through one path (a disabled feed). Rows elsewhere are untouched. */
  releaseNativeVia(via: ClaimVia): number {
    return Number(
      this.db
        .prepare(`DELETE FROM native_transition_claims WHERE path = 'native' AND state = 'reserved' AND via = ?`)
        .run(via).changes,
    );
  }

  /**
   * Releases native reservations whose outbox row can no longer be sent: a feed event that is not
   * pending, a buffered commit that was consumed or whose repository is no longer selected, and an
   * ordinary event that was delivered or abandoned. Delivered and still-pending rows keep theirs.
   * Idempotent, bounded by the table, and safe to repeat.
   */
  sweepOrphans(): { feedEvents: number; commits: number; summaries: number } {
    const del = (sql: string): number => Number(this.db.prepare(sql).run().changes);
    return atomically(this.db, () => ({
      feedEvents: del(
        `DELETE FROM native_transition_claims
          WHERE path = 'native' AND state = 'reserved' AND via = 'feed_event'
            AND NOT EXISTS (SELECT 1 FROM github_feed_events e WHERE e.id = ref AND e.status = 'pending')`,
      ),
      commits: del(
        `DELETE FROM native_transition_claims
          WHERE path = 'native' AND state = 'reserved' AND via = 'feed_commit'
            AND NOT EXISTS (
              SELECT 1 FROM github_feed_commits c
                JOIN github_feed_repos r ON r.repo_key = c.repo_key
               WHERE lower(c.repo_key) = native_transition_claims.repo_key
                 AND c.sha = native_transition_claims.ref
                 AND c.consumed_at IS NULL AND r.state = 'active')`,
      ),
      summaries: del(
        `DELETE FROM native_transition_claims
          WHERE path = 'native' AND state = 'reserved' AND via = 'watch_summary'
            AND NOT EXISTS (
              SELECT 1 FROM github_watch_events e
               WHERE e.id = ref AND e.delivered_at IS NULL AND e.abandoned_at IS NULL)`,
      ),
    }));
  }

  // ---- the target side --------------------------------------------------------------

  /**
   * Whether an imported event with a native counterpart is older than the ledger. On a database
   * that is not new this holds for EVERY such event at or before the cutoff plus the skew margin,
   * whatever rows survive: pruned history proves nothing, and the repository a legacy ordinary
   * watch queried was never recorded. Only an exact receipt (checked before this) clears it.
   */
  private legacyHeld(occurredAtMs: number): boolean {
    const b = this.requireBoundary();
    if (b.fresh) return false;
    return occurredAtMs <= Date.parse(b.cutoffAt) + NATIVE_LEGACY_SKEW_MS;
  }

  /**
   * What an imported event may do right now. Pure reads, each an indexed aggregate. Order of
   * evidence: an exact (or, for an update, a dominating) native claim; for a review or a run lacking
   * its exact id, any native claim for the same item and the existence of any native path that could
   * ever tell it; the legacy cutoff. A timestamp is used only to prove an event LATER than a native
   * observation (so it could not have been told), never to suppress one.
   */
  resolveTarget(ownerId: string, repoKey: string, e: TargetEventFacts): TargetResolution {
    const t = targetTransition(e);
    if (t.status === 'none') return { outcome: 'deliver' };
    const repo = transitionRepoKey(repoKey);
    if (repo === null) return { outcome: 'withhold', reason: 'ambiguous_evidence' };
    const occurredMs = Date.parse(e.occurredAt);
    if (!Number.isFinite(occurredMs)) return { outcome: 'withhold', reason: 'ambiguous_evidence' };

    if (t.status === 'ambiguous') return this.ambiguous(ownerId, repo, t.family, t.item, occurredMs);
    const x = t.transition;
    // An update is covered by a native update at or after it; every other kind by its exact key.
    const exact = x.kind === 'pr_updated'
      ? this.strongest(ownerId, repo, x.kind, x.item, 'native', 'AND stamp >= ?', x.stamp ?? '')
      : this.byKeyState(ownerId, repo, transitionKey(x), 'native');
    if (exact === 'delivered') return { outcome: 'covered' };
    if (exact === 'reserved') return { outcome: 'wait' };
    if (x.kind === 'changes_requested') {
      const near = this.nativeSameItem(ownerId, repo, x.kind, x.item, occurredMs);
      if (near) return near;
    }
    if (isObservedReviewKind(x.kind)) {
      const near = this.nativeObservedHolders(ownerId, repo, x, canonicalStamp(e.providerAt ?? null));
      if (near) return near;
    }
    // The observed-state review families are exempt from the migration-36 cutoff: they were deliverable before
    // they had a counterpart, and migration 38 only records provenance. Withholding them by time would make
    // history that was never a receipt look like one.
    if (!isObservedReviewKind(x.kind) && this.legacyHeld(occurredMs)) {
      return { outcome: 'withhold', reason: 'legacy_unproven' };
    }
    return { outcome: 'deliver' };
  }

  /**
   * An event that has a native counterpart but lacks the exact id to name it (a review without its
   * node id, a run without its attempt). No exact receipt can ever be written for it, so a send could
   * not be seen by a native path that tells the same fact LATER, and "no native claim yet" proves
   * nothing. It is therefore delivered only when no native path could ever tell it: the repository
   * has no feed row at all (a durable tombstone), no native claim exists for the item and, for a
   * requested-changes review, NO ordinary watch row is bound to the repository in any state (the
   * ordinary summary tells exact new reviews, and a cancelled or identity-stopped row is a tombstone
   * just as a feed row is). Otherwise it is withheld, counted, never sent and never settled. Nothing
   * native is suppressed by this: it only keeps the target from telling what a native path will tell.
   */
  private ambiguous(
    ownerId: string, repo: string, family: TransitionKind, item: string, occurredMs: number,
  ): TargetResolution {
    const near = this.nativeSameItem(ownerId, repo, family, item, family === 'ci_failed' ? null : occurredMs);
    if (near) return near;
    if (this.legacyHeld(occurredMs)) return { outcome: 'withhold', reason: 'legacy_unproven' };
    // The feed's repository list is one global table with no owner column (the feed serves the single configured
    // owner), so this lookup cannot be owner-scoped; it is a durable tombstone of "a feed ever watched it".
    const feed = this.db.prepare('SELECT 1 FROM github_feed_repos WHERE repo_key = ?').get(repo);
    if (feed !== undefined) return { outcome: 'withhold', reason: 'ambiguous_evidence' };
    if (family === 'changes_requested') {
      // An ordinary watch is the OWNER's: another owner's watch is no native path that could tell this owner's review.
      const ordinary = this.db
        .prepare('SELECT 1 FROM github_watches WHERE repo_key = ? AND discord_user_id = ? LIMIT 1')
        .get(repo, ownerId);
      if (ordinary !== undefined) return { outcome: 'withhold', reason: 'ambiguous_evidence' };
    }
    return { outcome: 'deliver' };
  }

  /**
   * Native claims for the same item, whatever exact identity they carry, across EVERY holder. ANY reserved
   * holder makes the event wait (a send that has not happened may be the one that tells it). A delivered
   * holder holds it back unless the event was provably submitted AFTER that holder's observation (plus the
   * skew margin): with `occurredMs`, that proof has to hold against every delivered holder, so only the
   * holders observed late enough to contain the event count and one of them is enough to withhold it.
   */
  private nativeSameItem(
    ownerId: string, repo: string, kind: TransitionKind, item: string, occurredMs: number | null,
  ): TargetResolution | null {
    const contained = occurredMs === null
      ? this.hasNative(ownerId, repo, kind, item, 'delivered')
      : this.hasNative(
        ownerId, repo, kind, item, 'delivered', 'AND observed_at >= ?', new Date(occurredMs - NATIVE_LEGACY_SKEW_MS).toISOString(),
      );
    if (contained) return { outcome: 'withhold', reason: 'ambiguous_evidence' };
    return this.hasNative(ownerId, repo, kind, item, 'reserved') ? { outcome: 'wait' } : null;
  }

  /**
   * The native holders of the same pull request whose observed state is compatible with an imported review row's,
   * beside the exact key that was already decided. ANY reserved holder makes the row wait (a send that has not
   * happened may be the one that tells it). A delivered holder holds the row back unless its own submission instant
   * is KNOWN and later than that holder's observation plus the skew margin (a different, later review); a row with
   * no known instant (an imported-document row, one observed before migration 38, a provider that gave none) can
   * never prove it, so it is withheld, counted, never delivered and never settled. Two KNOWN submission instants
   * that differ prove two different reviews (one review has one submission instant), so a holder whose known
   * instant differs from the row's known instant is not compared at all, in either direction and whether it
   * delivered or only reserved; equal or unknown instants fall through to the containment rule.
   */
  private nativeObservedHolders(
    ownerId: string, repo: string, x: Transition, providerAt: string | null,
  ): TargetResolution | null {
    const key = transitionKey(x);
    const all = this.db
      .prepare(
        `SELECT state, observed_at, provider_at FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND item = ? AND path = 'native' AND transition_key != ?
            AND (${compatibleStates(x.state ?? 'COMMENTED|DISMISSED')})`,
      )
      .all(ownerId, repo, x.item, key) as { state: string; observed_at: string; provider_at: string | null }[];
    const rows = all.filter((r) => providerAt === null || r.provider_at === null || r.provider_at === providerAt);
    if (rows.length === 0) return null;
    const providerMs = providerAt === null ? Number.NaN : Date.parse(providerAt);
    const contained = rows.some(
      (r) => r.state === 'delivered' && (!Number.isFinite(providerMs) || Date.parse(r.observed_at) >= providerMs - NATIVE_LEGACY_SKEW_MS),
    );
    if (contained) return { outcome: 'withhold', reason: 'ambiguous_evidence' };
    return rows.some((r) => r.state === 'reserved') ? { outcome: 'wait' } : null;
  }

  /** Whether ANY native holder of the item is in the given state (and satisfies `extra`). */
  private hasNative(
    ownerId: string, repoKey: string, kind: TransitionKind, item: string, state: 'reserved' | 'delivered',
    extra = '', ...params: (string | number)[]
  ): boolean {
    return this.db
      .prepare(
        `SELECT 1 FROM native_transition_claims
          WHERE owner_id = ? AND repo_key = ? AND kind = ? AND item = ? AND path = 'native' AND state = ? ${extra} LIMIT 1`,
      )
      .get(ownerId, repoKey, kind, item, state, ...params) !== undefined;
  }

  /**
   * Reserves the transition for ONE imported send attempt, only when the decision is `deliver`. The
   * decision and the insert are one synchronous step. An event with no exact transition (no native
   * counterpart, or an ambiguous one that was let through) needs no reservation.
   *
   * A reservation already on the key by this same target:
   * - `reserved` (an alert or a digest send of it is in flight, by anyone): the caller WAITS, so two
   *   sends of one transition never run at once;
   * - `delivered` for this same event: its other mode may still be told (an alert, then the briefing
   *   that carries it), as before; for another event, the target already told this transition, so the
   *   event is `covered`.
   */
  reserveTarget(
    ownerId: string, repoKey: string, e: TargetEventFacts, via: 'target_alert' | 'target_digest', ref: string, atIso: string,
  ): { readonly reserved: boolean; readonly resolution: TargetResolution; readonly selfCovered?: true } {
    const resolution = this.resolveTarget(ownerId, repoKey, e);
    if (resolution.outcome !== 'deliver') return { reserved: false, resolution };
    const t = targetTransition(e);
    if (t.status !== 'exact') return { reserved: false, resolution };
    const repo = transitionRepoKey(repoKey);
    if (repo === null) return { reserved: false, resolution: { outcome: 'wait' } };
    // Native holders were decided by `resolveTarget` above (any delivered covers, any reserved waits); what
    // can already be on the key now is this target's own single row.
    const own = this.targetRow(ownerId, repo, transitionKey(t.transition));
    if (own) {
      if (own.state === 'reserved') return { reserved: false, resolution: { outcome: 'wait' } };
      return own.ref === ref
        ? { reserved: false, resolution }
        : { reserved: false, resolution: { outcome: 'covered' }, selfCovered: true };
    }
    // An observed-state review claim records the instant the event row was COMMITTED (an upper bound on when the
    // review existed, never `occurredAt`) and the provider's own submission instant only when it supplied one: an
    // unknown instant stays unknown, never "now". Every other target claim (a requested change included) keeps the
    // meaning it always had, the moment of the send.
    const observed = isObservedReviewKind(t.transition.kind);
    const ok = this.insertClaim({
      ownerId, repoKey: repo, transition: t.transition, path: 'target', via, ref,
      observedAt: observed ? (e.createdAt ?? atIso) : atIso, atIso,
      providerAt: observed ? (e.providerAt ?? null) : e.occurredAt,
    });
    return ok ? { reserved: true, resolution } : { reserved: false, resolution: { outcome: 'wait' } };
  }

  /** The send succeeded: this reference's reservations become receipts. */
  markTargetDelivered(via: 'target_alert' | 'target_digest', ref: string, atIso: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE native_transition_claims
              SET state = 'delivered', delivered_to = 'owner_dm', delivered_at = ?, updated_at = ?
            WHERE path = 'target' AND state = 'reserved' AND via = ? AND ref = ?`,
        )
        .run(atIso, atIso, via, ref).changes,
    );
  }

  /** The send failed or was not made: the reservation goes, the event stays pending. */
  releaseTarget(via: 'target_alert' | 'target_digest', ref: string): number {
    return Number(
      this.db
        .prepare(`DELETE FROM native_transition_claims WHERE path = 'target' AND state = 'reserved' AND via = ? AND ref = ?`)
        .run(via, ref).changes,
    );
  }

  /**
   * At startup, after the runtime lock was taken: no earlier holder is alive, so a target
   * reservation is a send of unknown outcome. It is released, never turned into a receipt: the
   * event stays pending and may be sent again (the existing at-least-once transport caveat).
   */
  recoverTargetSends(): number {
    return Number(
      this.db.prepare(`DELETE FROM native_transition_claims WHERE path = 'target' AND state = 'reserved'`).run().changes,
    );
  }

  // ---- counts only -------------------------------------------------------------------

  counts(): { reservedNative: number; reservedTarget: number; receiptsNative: number; receiptsTarget: number } {
    const n = (path: ClaimPath, state: string): number =>
      Number(
        (this.db
          .prepare('SELECT COUNT(*) AS n FROM native_transition_claims WHERE path = ? AND state = ?')
          .get(path, state) as { n: number }).n,
      );
    return {
      reservedNative: n('native', 'reserved'), reservedTarget: n('target', 'reserved'),
      receiptsNative: n('native', 'delivered'), receiptsTarget: n('target', 'delivered'),
    };
  }

  /** For tests and the export: every claim, stable order. */
  all(): ClaimRow[] {
    return this.db
      .prepare('SELECT * FROM native_transition_claims ORDER BY owner_id, repo_key, transition_key')
      .all()
      .map((r) => mapClaim(r as Record<string, unknown>));
  }
}
