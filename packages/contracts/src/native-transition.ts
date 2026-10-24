import { createHash } from 'node:crypto';
import { canonicalRepoKey } from './github-feed.js';
import type { WatchEventKind } from './assistant-watch.js';

/**
 * Exact transitions: the one place that says which native notification and which
 * imported watch event are the SAME fact (ADR 0034).
 *
 * A native path (the GitHub feed, the ordinary repository watch) and an imported
 * notification target can both observe a repository. They tell the owner about the same
 * transition only when an exact identity says so, and nothing weaker is ever evidence:
 * a count ("3 new issues"), an unnamed aggregate, a timestamp alone, a snapshot, a
 * skipped or baseline row and a merely observed item are NOT receipts. Everything here
 * is pure; the persistence layer, the services and the tests all call it, so they cannot
 * drift apart.
 *
 * A transition is `(kind, item, stamp, hash, attempt)`:
 * - an opened pull request or issue is its number;
 * - a named commit is its SHA;
 * - an update is its number and the provider's `updatedAt` instant;
 * - a merge is its number and the provider's `mergedAt` instant;
 * - a requested-changes review is its pull request number and a HASH of the provider's
 *   review id (exact string equality, no decoding; the raw id is never stored here);
 * - a failed workflow run is its id and its rerun attempt.
 */

export const TRANSITION_KINDS = [
  'commit', 'pr_opened', 'pr_updated', 'pr_merged', 'changes_requested', 'issue_opened', 'ci_failed',
  'review_approved', 'review_commented', 'review_dismissed',
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * The OBSERVED-STATE review families (migration 38). A fact is a review in an observed state: the same review
 * can legitimately be told once as approved and later as dismissed, and both tellings are accepted source
 * behaviour, so no key is shared across states. `review_dismissed` means ONLY "this review was observed in
 * state DISMISSED": it carries no dismissal time, actor or cause (no approved DTO provides one).
 */
export const OBSERVED_REVIEW_KINDS = ['review_approved', 'review_commented', 'review_dismissed'] as const;
export type ObservedReviewKind = (typeof OBSERVED_REVIEW_KINDS)[number];
export const isObservedReviewKind = (k: string): k is ObservedReviewKind =>
  (OBSERVED_REVIEW_KINDS as readonly string[]).includes(k);

/**
 * Which identity a stored hash is. `provider` is `hashProviderRef` of the provider's review id; the gh GraphQL
 * `reviews[].id` and the REST `node_id` are both hashed in it (whether they are EQUAL is the unproven live
 * gate). `source_identity` hashes the imported event's own identity string plus its observed-state scope, and
 * exists only for a review row that carries no provider hash. Hashes of different domains are never equal and
 * never proof of a different review.
 */
export const HASH_DOMAINS = ['provider', 'source_identity'] as const;
export type HashDomain = (typeof HASH_DOMAINS)[number];

/** The observed state a review fact names. The last spelling is a stateless commented row: BOTH candidates. */
export const REVIEW_OBSERVED_STATES = ['APPROVED', 'COMMENTED', 'DISMISSED', 'COMMENTED|DISMISSED'] as const;
export type ReviewObservedState = (typeof REVIEW_OBSERVED_STATES)[number];

/** Every state word a stored review row can carry (a requested change included, for lifecycle checks). */
export const REVIEW_PROVIDER_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'] as const;
export type ReviewProviderState = (typeof REVIEW_PROVIDER_STATES)[number];
export const isReviewProviderState = (v: unknown): v is ReviewProviderState =>
  typeof v === 'string' && (REVIEW_PROVIDER_STATES as readonly string[]).includes(v);

export interface Transition {
  readonly kind: TransitionKind;
  /** Number, SHA or run id: plain, validated text. */
  readonly item: string;
  /** A canonical `toISOString` instant, for updates and merges. */
  readonly stamp: string | null;
  /** A 64-hex hash of a review identity (see `domain`), for the review families. */
  readonly hash: string | null;
  /** A rerun attempt, for a failed run. */
  readonly attempt: string | null;
  /** Which identity `hash` is. Absent means `provider`, which is every pre-38 transition. */
  readonly domain?: HashDomain;
  /** The observed state, for the observed-state review families only. */
  readonly state?: ReviewObservedState | null;
}

/** Where an imported event kind stands against the native paths. Exhaustive, by `satisfies`. */
export const IMPORTED_COUNTERPART = {
  commit: 'commit',
  pr_opened: 'pr_opened',
  pr_updated: 'pr_updated',
  pr_merged: 'pr_merged',
  // Native count lines ("no longer open") never name an item.
  pr_closed: null,
  review_requested_changes: 'changes_requested',
  // A submitted review in an OBSERVED STATE (migration 38). The ordinary summary names new approved and
  // commented reviews and observed dismissals exactly; a PR-level decision and the conversation-comment count
  // stay distinct facts that claim nothing. `review_commented` carries COMMENTED or DISMISSED (the source's
  // collapsed vocabulary), told apart by the stored provider state.
  review_approved: 'review_approved',
  review_commented: 'review_commented',
  review_pending: null,
  issue_opened: 'issue_opened',
  // Native issue lines are counts only.
  issue_updated: null,
  issue_closed: null,
  // Nothing native tells a release or a default-branch change.
  release: null,
  ci_started: null,
  ci_failed: 'ci_failed',
  ci_recovered: null,
  default_branch_change: null,
} as const satisfies Record<WatchEventKind, TransitionKind | null>;

/** How long a legacy cutoff is widened by, for clock skew between the provider and this host. */
export const NATIVE_LEGACY_SKEW_MS = 1_000;

/** A named update or merge is at most this many per rendered summary, as the text names at most three. */
export const NATIVE_SUMMARY_NAMED_MAX = 3;

const SHA = /^[0-9a-f]{7,64}$/;
const NUMBER = /^[1-9]\d{0,8}$/;
const RUN = /^(0|[1-9]\d{0,14})$/;
const ATTEMPT = /^[1-9]\d{0,3}$/;
const HASH = /^[0-9a-f]{64}$/;

/** A canonical instant, as `toISOString` writes it, from any ISO string the provider sends; else null. */
export function canonicalStamp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The canonical `owner/repo` key both sides use; null when it is not one. */
export function transitionRepoKey(raw: string): string | null {
  const parts = raw.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return canonicalRepoKey(raw);
}

/**
 * A comparison identity for a provider review id: a domain-separated SHA-256, never the id.
 * Equality is exact string equality of the id; nothing is decoded or normalised.
 */
export function hashProviderRef(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255) return null;
  return createHash('sha256').update(`ducky-provider-ref:v1:${raw}`).digest('hex');
}

const build = (
  kind: TransitionKind, item: string, extra: Partial<Pick<Transition, 'stamp' | 'hash' | 'attempt'>> = {},
): Transition => ({ kind, item, stamp: extra.stamp ?? null, hash: extra.hash ?? null, attempt: extra.attempt ?? null });

/** The transition a native commit digest line names, or null. */
export const commitTransition = (sha: string): Transition | null =>
  SHA.test(sha) ? build('commit', sha) : null;

export const openedTransition = (kind: 'pr_opened' | 'issue_opened', n: number): Transition | null =>
  NUMBER.test(String(n)) ? build(kind, String(n)) : null;

export function updatedTransition(n: number, updatedAt: string | null | undefined): Transition | null {
  const stamp = canonicalStamp(updatedAt);
  return stamp !== null && NUMBER.test(String(n)) ? build('pr_updated', String(n), { stamp }) : null;
}

export function mergedTransition(n: number, mergedAt: string | null | undefined): Transition | null {
  const stamp = canonicalStamp(mergedAt);
  return stamp !== null && NUMBER.test(String(n)) ? build('pr_merged', String(n), { stamp }) : null;
}

export function reviewTransition(n: number, providerRef: string | null | undefined): Transition | null {
  const hash = hashProviderRef(providerRef);
  return hash !== null && NUMBER.test(String(n)) ? build('changes_requested', String(n), { hash }) : null;
}

/** The same transition from a hash this codec already produced (a stored one), or null when it is not one. */
export function reviewTransitionFromHash(n: number, hash: string | null | undefined): Transition | null {
  return typeof hash === 'string' && HASH.test(hash) && NUMBER.test(String(n))
    ? build('changes_requested', String(n), { hash })
    : null;
}

/** The kind that names a review observed in this state. A candidate set is a stateless commented row. */
export const observedStateKind = (state: ReviewObservedState): ObservedReviewKind =>
  state === 'APPROVED' ? 'review_approved' : state === 'DISMISSED' ? 'review_dismissed' : 'review_commented';

/**
 * A domain-separated identity hash of an imported event that carries no provider hash. It covers the event's own
 * identity string and the state scope, so the two source rows of one review (told approved, then dismissed)
 * never share a hash, and it can never equal a provider hash (the prefix differs).
 */
export function hashSourceIdentity(identity: string, scope: ReviewObservedState): string | null {
  if (identity.length === 0 || identity.length > 300) return null;
  return createHash('sha256').update(`ducky-source-review:v1:${identity}:${scope}`).digest('hex');
}

/** One review fact: a pull request, a review identity in a domain, and the state it was observed in. */
export function observedReviewTransition(
  n: number, hash: string | null | undefined, domain: HashDomain, state: ReviewObservedState,
): Transition | null {
  if (typeof hash !== 'string' || !HASH.test(hash) || !NUMBER.test(String(n))) return null;
  const t: Transition = { ...build(observedStateKind(state), String(n), { hash }), domain, state };
  return isWellFormedTransition(t) ? t : null;
}

export function runTransition(runId: number | string, attempt: number | string | null | undefined): Transition | null {
  const run = String(runId);
  const att = attempt === null || attempt === undefined ? null : String(attempt);
  return RUN.test(run) && att !== null && ATTEMPT.test(att) ? build('ci_failed', run, { attempt: att }) : null;
}

/** The stable text of a transition: a ledger key, unique per owner and repository. */
export function transitionKey(t: Transition): string {
  switch (t.kind) {
    case 'commit': case 'pr_opened': case 'issue_opened': return `${t.kind}:${t.item}`;
    case 'pr_updated': case 'pr_merged': return `${t.kind}:${t.item}:${t.stamp}`;
    case 'changes_requested': return `${t.kind}:${t.item}:${t.hash}`;
    case 'ci_failed': return `${t.kind}:${t.item}:${t.attempt}`;
    // The domain is part of the key, so a provider hash and a source-identity hash can never collide, and a
    // stateless commented row has a target-only key no native fact can equal.
    case 'review_approved': case 'review_commented': case 'review_dismissed':
      return `${t.kind}:${t.item}${t.domain === 'source_identity' ? ':src' : ''}:${t.hash}` +
        (t.state === 'COMMENTED|DISMISSED' ? ':unknown_state' : '');
  }
}

/** Whether a stored row's parts are exactly what the codec would have written. */
export function isWellFormedTransition(t: Transition): boolean {
  switch (t.kind) {
    case 'commit': return SHA.test(t.item) && !t.stamp && !t.hash && !t.attempt;
    case 'pr_opened': case 'issue_opened': return NUMBER.test(t.item) && !t.stamp && !t.hash && !t.attempt;
    case 'pr_updated': case 'pr_merged':
      return NUMBER.test(t.item) && t.stamp !== null && canonicalStamp(t.stamp) === t.stamp && !t.hash && !t.attempt;
    case 'changes_requested': return NUMBER.test(t.item) && t.hash !== null && HASH.test(t.hash) && !t.stamp && !t.attempt;
    case 'ci_failed': return RUN.test(t.item) && t.attempt !== null && ATTEMPT.test(t.attempt) && !t.stamp && !t.hash;
    case 'review_approved': case 'review_commented': case 'review_dismissed': {
      if (!NUMBER.test(t.item) || t.hash === null || !HASH.test(t.hash) || t.stamp || t.attempt) return false;
      const domain = t.domain ?? 'provider';
      if (domain !== 'provider' && domain !== 'source_identity') return false;
      const state = t.state ?? null;
      if (state === null || !(REVIEW_OBSERVED_STATES as readonly string[]).includes(state)) return false;
      if (observedStateKind(state) !== t.kind) return false;
      // A candidate set is only ever a source-identity, target-only fact: a provider hash names ONE state.
      return state !== 'COMMENTED|DISMISSED' || domain === 'source_identity';
    }
  }
}

/**
 * What a native FEED event key names, or null.
 *
 * The key is `pr_opened:<repo>#<n>`, `issue_opened:<repo>#<n>`, `changes_requested:<repo>#<n>:<review id>`
 * or `check_failed:<repo>:<run id>:<attempt>`. The repository part must equal the event's own
 * repository exactly, so a key that merely resembles one never matches. Every other key (a
 * review request, a check on a pull request head) names nothing an imported event can be.
 */
export function feedEventTransition(
  eventKey: string, kind: string, repoKey: string,
): { readonly repoKey: string; readonly transition: Transition } | null {
  const repo = transitionRepoKey(repoKey);
  if (repo === null) return null;
  const rest = (head: string): string | null =>
    eventKey.startsWith(head) ? eventKey.slice(head.length) : null;
  if (kind === 'pr_opened' || kind === 'issue_opened') {
    const r = rest(`${kind}:${repoKey}#`);
    const t = r !== null && NUMBER.test(r) ? openedTransition(kind, Number(r)) : null;
    return t ? { repoKey: repo, transition: t } : null;
  }
  if (kind === 'changes_requested') {
    const r = rest(`changes_requested:${repoKey}#`);
    const m = r === null ? null : /^([1-9]\d{0,8}):(.{1,255})$/.exec(r);
    const t = m ? reviewTransition(Number(m[1]), m[2]!) : null;
    return t ? { repoKey: repo, transition: t } : null;
  }
  if (kind === 'check_failed') {
    const r = rest(`check_failed:${repoKey}:`);
    const m = r === null ? null : /^(0|[1-9]\d{0,14}):([1-9]\d{0,3})$/.exec(r);
    const t = m ? runTransition(m[1]!, m[2]!) : null;
    return t ? { repoKey: repo, transition: t } : null;
  }
  return null;
}

/** What an imported event says about itself, in the columns the store keeps. */
export interface TargetEventFacts {
  readonly kind: WatchEventKind;
  readonly identity: string;
  readonly occurredAt: string;
  /** Hash of the provider review id, for a requested-changes review. */
  readonly providerHash: string | null;
  /** The rerun attempt, for a failed run. */
  readonly attempt: string | null;
  /**
   * The review state the row was OBSERVED in (APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED), stored from
   * migration 38 on. Absent on a row observed before it and on every imported-document row: never guessed.
   */
  readonly providerState?: string | null;
  /**
   * The provider's canonical submission instant, only when the provider supplied one. Absent or null is
   * UNKNOWN: the source's own fallback is "now", which is never a submission instant.
   */
  readonly providerAt?: string | null;
  /** The host instant the event row was committed: an upper bound on when the review existed. */
  readonly createdAt?: string | null;
}

export type TargetTransition =
  | { readonly status: 'none' }
  /** A native counterpart exists but this event lacks the evidence to name it exactly. */
  | { readonly status: 'ambiguous'; readonly family: TransitionKind; readonly item: string }
  | { readonly status: 'exact'; readonly transition: Transition };

/**
 * The transition an imported event is, per kind. Total over every kind: the table above
 * decides, and anything with no native counterpart is `none`, never matched, never withheld.
 */
export function targetTransition(e: TargetEventFacts): TargetTransition {
  const family = IMPORTED_COUNTERPART[e.kind];
  if (family === null) return { status: 'none' };
  const head = (re: RegExp): string | null => re.exec(e.identity)?.[1] ?? null;
  // An identity the codec cannot read can never equal one a native path wrote (those are built
  // only through the same validators), so it has no native counterpart to be confused with.
  const invalid = (): TargetTransition => ({ status: 'none' });
  switch (e.kind) {
    case 'commit': {
      const t = commitTransition(e.identity);
      return t ? { status: 'exact', transition: t } : invalid();
    }
    case 'pr_opened': {
      const n = head(/^(\d+):opened$/);
      const t = n === null ? null : openedTransition('pr_opened', Number(n));
      return t ? { status: 'exact', transition: t } : invalid();
    }
    case 'issue_opened': {
      const n = head(/^(\d+):issue_opened:/);
      const t = n === null ? null : openedTransition('issue_opened', Number(n));
      return t ? { status: 'exact', transition: t } : invalid();
    }
    case 'pr_merged': {
      const n = head(/^(\d+):merged$/);
      const t = n === null ? null : mergedTransition(Number(n), e.occurredAt);
      return t ? { status: 'exact', transition: t } : invalid();
    }
    case 'pr_updated': {
      const m = /^(\d+):updated:(.+)$/.exec(e.identity);
      const t = m ? updatedTransition(Number(m[1]), m[2]!) : null;
      return t ? { status: 'exact', transition: t } : invalid();
    }
    case 'review_approved':
    case 'review_commented': {
      const n = head(/^(\d+):review:/);
      if (n === null || !NUMBER.test(n)) return invalid();
      // The state the row names: an approval is APPROVED; a commented row is COMMENTED or DISMISSED when its
      // stored state says so and a CANDIDATE SET otherwise (never guessed).
      const state: ReviewObservedState = e.kind === 'review_approved'
        ? 'APPROVED'
        : e.providerState === 'COMMENTED' || e.providerState === 'DISMISSED'
          ? e.providerState
          : 'COMMENTED|DISMISSED';
      // A provider hash names exactly one state; without one (or without a state) the identity string is the
      // identity, in its own domain.
      const provider = state !== 'COMMENTED|DISMISSED' && e.providerHash !== null && e.providerHash !== undefined &&
        HASH.test(e.providerHash);
      const t = provider
        ? observedReviewTransition(Number(n), e.providerHash, 'provider', state)
        : observedReviewTransition(Number(n), hashSourceIdentity(e.identity, state), 'source_identity', state);
      return t ? { status: 'exact', transition: t } : invalid();
    }
    case 'review_requested_changes': {
      const n = head(/^(\d+):review:/);
      if (n === null || !NUMBER.test(n)) return invalid();
      const t = e.providerHash !== null && HASH.test(e.providerHash)
        ? build('changes_requested', n, { hash: e.providerHash })
        : null;
      return t ? { status: 'exact', transition: t } : { status: 'ambiguous', family, item: n };
    }
    case 'ci_failed': {
      const run = head(/^(\d+):ci_failed$/);
      if (run === null || !RUN.test(run)) return invalid();
      const t = runTransition(run, e.attempt);
      return t ? { status: 'exact', transition: t } : { status: 'ambiguous', family, item: run };
    }
    default:
      return { status: 'none' };
  }
}

// ---- unidentified per-author review lines that were actually delivered (gap markers) ----------------------

/**
 * A per-author review line ("approvals ...", "changes requested on ...") names no review id. When one is told
 * while the exact review list could not identify what it summarises, the line may overlap a review an imported
 * target tells, and no receipt can settle it. A delivered one is durable, counted, blocking evidence (never a
 * receipt, never cleared).
 */
export const GAP_CLASSES = ['approval', 'changes_requested'] as const;
export type GapClass = (typeof GAP_CLASSES)[number];
/**
 * Why a per-author line could not stand on exact facts: no comparable baseline, the list unavailable, the list at
 * the bound, or `not_conveyed` (a comparable observation held same-class exact facts, but at least one of them was
 * not shown in full, so the line came back and its exact segment has no receipt).
 */
export const GAP_REASONS = ['no_comparison', 'unavailable', 'truncated', 'not_conveyed'] as const;
export type GapReason = (typeof GAP_REASONS)[number];
/** `shown`: the whole segment lies inside the clamp and redaction left the summary unchanged. */
export const GAP_SHOWN = ['shown', 'delivered_not_provably_shown'] as const;
export type GapShown = (typeof GAP_SHOWN)[number];

// ---- review lifecycle ----------------------------------------------------------------------------------------

/**
 * Whether a change of one review's KNOWN state is impossible under the provider lifecycle this build assumes: a
 * submitted review changes state only by being dismissed, so a change to anything but DISMISSED, and any change
 * out of DISMISSED, is refused. The assumption is explicit and enforced, and it is NOT proven live. An unknown
 * (absent) state never conflicts, so callers compare only two known states.
 */
export const isImpossibleReviewChange = (from: ReviewProviderState, to: ReviewProviderState): boolean =>
  from !== to && to !== 'DISMISSED';
