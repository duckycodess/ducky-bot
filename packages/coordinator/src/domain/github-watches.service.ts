import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, DuckyError, GITHUB_WATCH_BATCH, GITHUB_WATCH_EVENT_BATCH,
  isDuckyError,
  MAX_GITHUB_WATCHES_PER_OWNER,
  GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS, GITHUB_WATCH_MAX_FOLLOWUPS,
  GITHUB_WATCH_MAX_ISSUES, GITHUB_WATCH_MAX_PR_CHECKS, GITHUB_WATCH_MAX_RUNS,
  GITHUB_WATCH_SUMMARY_MAX, GitHubWatchAddInputSchema, newPublicWatchId,
  PublicWatchIdSchema, NATIVE_SUMMARY_NAMED_MAX, NATIVE_LEGACY_SKEW_MS, GITHUB_WATCH_REVIEW_FACTS_MAX,
  canonicalStamp, closedTransition, hashProviderRef, mergedTransition, observedReviewTransition, openedTransition,
  reviewTransitionFromHash, transitionKey, transitionRepoKey, updatedTransition, type GapClass, type GapReason,
  type GapShown, type PrChecks, type PrList, type PrReviews, type RepoView, type Transition,
} from '@ducky/contracts';
import { redact, type GitHubReader } from '@ducky/adapters';
import { withTransaction, type GitHubWatchRow, type Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { RepoAllowlist } from './allowlist.js';
import type { OwnerClock } from './owner-clock.js';
import { dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { githubWatchDm } from '../discord/assistant-presenters.js';

interface NormalizedPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  updatedAt: string;
  checks: string[];
  /**
   * The review surface, added by the final milestone.
   *
   * Every field is optional in the wire schema and defaulted here, because the
   * field NAMES are recorded (`pnpm probe:gh`) while the response VALUES are
   * not: no GitHub repository is configured on this host. A missing field
   * degrades the summary; it never fails the observation.
   */
  headRefOid?: string;
  mergedAt?: string;
  /**
   * The canonical close instant, written ONLY when the list's own explicit evidence proves a close (raw state exactly
   * CLOSED, `mergedAt` present and explicitly null, a readable close instant, and no contradiction from the per-pull-
   * request read). Never inferred from the normalized fallback strings. Version 4 snapshots; absent on an older one,
   * which is read through its own projection and so cannot make this metadata a change.
   */
  cp?: string;
  reviewDecision?: string;
  approvals?: number;
  changesRequested?: number;
  reviewComments?: number;
  commits?: number;
  /** Identifies the review that asked for changes, for follow-up dedup. */
  latestChangeRequestAt?: string;
  /**
   * Exact submitted-review facts (version 3 snapshots). Absent on a legacy snapshot, which is read through its
   * legacy projection only. A version 2 snapshot is read through its own projection and converted on parse.
   */
  rf?: ReviewFacts;
}

/** What the last read of a pull request's reviews could prove. */
type ReviewFactStatus = 'complete' | 'unavailable' | 'truncated';

/**
 * A review's state as the snapshot records it: approved, requested changes, commented, dismissed, or a state word
 * this build does not know (never told, never claimed, never a lifecycle conflict).
 */
type ReviewCode = 'A' | 'R' | 'C' | 'D' | 'U';

/** One SUBMITTED review: its identity hash, the provider's canonical submission instant and its states. */
interface ReviewFact {
  /** `hashProviderRef` of the provider's review id (64 hex): never the id. */
  h: string;
  /** The provider's canonical submission instant. It identifies the REVIEW; it is never a dismissal time. */
  at: string;
  /** The state this review was FIRST observed in, never rewritten; null when it was known only by identity. */
  f: ReviewCode | null;
  /** The state it is in now. */
  c: ReviewCode;
}

/**
 * The exact submitted-review facts of one pull request, from the bounded `reviews` list (never the per-author
 * `latestReviews`). Hashes only: no raw id, login or body.
 *
 * `rv` (every submitted review: hash, instant, first and current state) is a rendered fact and is part of the
 * fingerprint, except for state words this build does not know. `s` (how the last read went), `known`, `pb` and
 * `x` are comparison metadata and are not: an unavailable read or its recovery must not by itself create a
 * generic snapshot message.
 *
 * An unavailable or truncated read carries the last COMPLETE facts forward unchanged (so the reviews that arrived
 * during the gap are told on recovery) and never absorbs anything it did not see. A submitted review never
 * leaves the list and changes state only by being dismissed: a complete read that contradicts either is refused
 * like an unavailable one, carries the last proven facts, and is counted (`x`), never read as a new review.
 */
interface ReviewFacts {
  s: ReviewFactStatus;
  /** A complete set has existed: `rv` is proven. False until the first complete read. */
  known: boolean;
  /**
   * The host instant fixed BEFORE the observation's reads began, written only beside a complete set under the
   * observation's compare-and-set and carried unchanged on a gap. Null: no proof (legacy, first sight, an unbound
   * or remapped watch). A review that existed before this instant is in this set.
   */
  pb: string | null;
  rv: ReviewFact[];
  /**
   * A version 2 snapshot knew reviews by a 32-hex prefix alone, with no state: they are identities that are not
   * new, whose prior state is unknown. The first complete read of this build absorbs them into `rv`.
   */
  seen?: string[];
  /** Why exact facts are refused for this pull request: a review left the list, or its state changed impossibly. */
  x?: 'left' | 'lifecycle';
}

/**
 * A pull request in positions beyond the rich slice of the fetched list (version 4): just enough to apply a close or a
 * merge to a pull request that is still listed, without an extra read and without inventing rich check or review data.
 * It is comparison evidence for a pull request already known, never a lifecycle claim for one first seen here.
 */
interface TailPr {
  n: number;
  /** The raw state class: open, closed, merged, or a word this build does not know. */
  s: 'O' | 'C' | 'M' | 'U';
  /** The canonical close proof, by the same rule as `NormalizedPr.cp`. */
  cp?: string;
  /** The canonical merge instant, when the list carried a readable one. */
  ma?: string;
}

interface NormalizedRun {
  workflow: string;
  branch: string;
  headSha: string;
  status: string;
  conclusion: string;
}

interface NormalizedIssue {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
}

interface NormalizedSnapshot {
  /**
   * 2 once exact requested-changes facts were recorded, 3 once every review state is, 4 once the close proof and the
   * rest of the fetched list are. Absent on a legacy snapshot.
   */
  v?: 2 | 3 | 4;
  repoName: string;
  defaultBranch: string;
  openPrCount: number;
  prs: NormalizedPr[];
  /** Version 4: the fetched list beyond the rich slice, ordered by number (never by list position). */
  tail?: TailPr[];
  /** Bounded workflow-run history: a failure, and the recovery after one. */
  runs?: NormalizedRun[];
  openIssues?: NormalizedIssue[];
}

export interface GitHubWatchTickResult {
  observed: number;
  changed: number;
  failed: number;
  delivered: number;
  deliveryFailed: number;
  abandoned: number;
  /** Observations put off because an imported send of an item they would tell was in flight. */
  deferred: number;
  /** Watches the system stopped because their slug now names another repository. */
  identityStopped: number;
}

export interface GitHubWatchServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly allowlist: RepoAllowlist;
  readonly reader: GitHubReader;
  readonly transport: DiscordTransport;
  readonly ownerId: string;
  readonly clock: OwnerClock;
}

/**
 * Owner-configured, read-only GitHub observations plus their durable DM outbox.
 *
 * The reader is deliberately the existing read-only GitHub port. Each tick
 * takes a bounded number of watches, stores a normalized snapshot rather than
 * an API payload, and creates an event only when the snapshot fingerprint
 * changes. Delivery is retried independently through the same sanitized
 * transport boundary as every other proactive message.
 */
export class GitHubWatchService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly allowlist: RepoAllowlist;
  private readonly reader: GitHubReader;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;
  private readonly clock: OwnerClock;
  private ticking: Promise<GitHubWatchTickResult> | null = null;

  constructor(deps: GitHubWatchServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.allowlist = deps.allowlist;
    this.reader = deps.reader;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.clock = deps.clock;
  }

  add(actor: ActorContext, raw: unknown): GitHubWatchRow {
    this.authz.requireOwner(actor);
    const input = GitHubWatchAddInputSchema.parse(raw);
    const repo = this.allowlist.resolve(input.repoSlug);
    if (!repo.github) {
      throw new DuckyError('invalid_input', `\`${repo.slug}\` has no GitHub repository configured.`);
    }
    if (this.store.githubWatches.countActive(actor.discordUserId) >= MAX_GITHUB_WATCHES_PER_OWNER) {
      throw new DuckyError('invalid_input', 'You already have the maximum number of repository watches.');
    }

    const nowMs = this.clock.nowMs();
    try {
      return this.store.githubWatches.insert({
        id: randomUUID(),
        publicId: this.freshPublicId(),
        discordUserId: actor.discordUserId,
        repoSlug: repo.slug,
        intervalMinutes: input.everyMinutes,
        nextCheckAt: new Date(nowMs + input.everyMinutes * 60_000).toISOString(),
        createdAt: new Date(nowMs).toISOString(),
        // The identity every observation of this watch will be recorded under, fixed now.
        repoKey: transitionRepoKey(`${repo.github.owner}/${repo.github.repo}`),
      });
    } catch {
      // The active (owner, repository) unique index intentionally makes this
      // race-safe. Do not surface SQLite text or a second account's row.
      throw new DuckyError('invalid_input', `A watch for \`${repo.slug}\` already exists.`);
    }
  }

  /**
   * For `/status`: counts only, never a repository, review or pull request. Empty when there is nothing to
   * say, otherwise ending in `; ` so it can lead the rest of the line.
   */
  statusNotes(): string {
    const notes: string[] = [];
    const held = this.store.githubWatches.heldCount(this.ownerId);
    if (held > 0) {
      notes.push(
        `${held} review fact(s) HELD and NOT sent: each cannot be told from a review the notification ` +
          'target already delivered (kept through a cancel; no clearing control; a required blocker)',
      );
    }
    // A native exact close that matches a close the target settled before exact close receipts existed: held, never sent.
    const heldCloses = this.store.githubWatches.heldCloseCount(this.ownerId);
    if (heldCloses > 0) {
      notes.push(
        `${heldCloses} pull request close(s) HELD and NOT sent: the notification target settled a close of that pull ` +
          'request before exact close receipts existed and nothing proves what it showed (kept through a cancel and ' +
          'retention; no clearing control; a required blocker)',
      );
    }
    const evidence = reviewEvidenceCounts(this.store, this.ownerId);
    // Pull requests whose review list is too long to prove: no new review of theirs can be told exactly.
    if (evidence.truncated > 0) {
      notes.push(
        `${evidence.truncated} pull request(s) have ${GITHUB_WATCH_REVIEW_FACTS_MAX} or more reviews: no new review ` +
          'of theirs is told exactly (a capability limit and a required blocker)',
      );
    }
    // A review that left the list, or changed state in a way the provider lifecycle does not allow: exact facts are
    // refused for that pull request, the last proven facts are kept, and it stays counted (a required blocker).
    if (evidence.refused > 0) {
      notes.push(
        `${evidence.refused} pull request(s) refused for exact review facts (a review left the list or changed state ` +
          'impossibly; the last proven facts are kept; a required blocker)',
      );
    }
    // Per-author lines told without exact review identity: delivered, durable, never cleared.
    const gaps = this.store.githubWatches.gapMarkerCounts(this.ownerId);
    if (gaps.shown + gaps.notProvablyShown > 0) {
      notes.push(
        `${gaps.shown + gaps.notProvablyShown} per-author review line(s) were delivered without exact review identity ` +
          `(${gaps.shown} shown, ${gaps.notProvablyShown} not provably shown; kept through a cancel and retention; ` +
          'no clearing control; a required blocker)',
      );
    }
    return notes.length > 0 ? `${notes.join('; ')}; ` : '';
  }

  list(actor: ActorContext, includeCancelled = false, limit = 20): GitHubWatchRow[] {
    this.authz.requireOwner(actor);
    return this.store.githubWatches.listForOwner(actor.discordUserId, includeCancelled, limit);
  }

  cancel(actor: ActorContext, publicId: string): GitHubWatchRow {
    this.authz.requireOwner(actor);
    const id = this.owned(actor, publicId).id;
    const changed = withTransaction(this.store.db, () =>
      this.store.githubWatches.cancel(actor.discordUserId, id, this.clock.nowIso()),
    );
    if (!changed) throw new DuckyError('invalid_input', 'That watch is already cancelled.');
    return this.store.githubWatches.byId(id)!;
  }

  async tick(): Promise<GitHubWatchTickResult> {
    if (this.ticking) return this.ticking;
    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  async waitForIdle(): Promise<void> {
    if (this.ticking) await this.ticking.catch(() => undefined);
  }

  private async runTick(): Promise<GitHubWatchTickResult> {
    const due = this.store.githubWatches.due(this.clock.nowIso(), GITHUB_WATCH_BATCH);
    const result: GitHubWatchTickResult = {
      observed: 0, changed: 0, failed: 0, delivered: 0, deliveryFailed: 0, abandoned: 0,
      deferred: 0, identityStopped: 0,
    };

    for (const watch of due) {
      try {
        const outcome = await this.observe(watch);
        if (outcome === 'deferred') {
          result.deferred += 1;
          continue;
        }
        if (outcome === 'identity_stopped') {
          result.identityStopped += 1;
          continue;
        }
        result.observed += 1;
        if (outcome === 'changed') result.changed += 1;
      } catch (err) {
        // A repository removed from the allowlist is not a transient GitHub
        // outage. Retire that watch instead of polling forever against a
        // configuration the owner deliberately stopped exposing.
        if (isDuckyError(err) && (err.code === 'repo_not_allowed' || err.code === 'invalid_input')) {
          withTransaction(this.store.db, () =>
            this.store.githubWatches.cancel(watch.discordUserId, watch.id, this.clock.nowIso()),
          );
          result.abandoned += 1;
          continue;
        }
        const now = this.clock.nowMs();
        const next = new Date(now + watch.intervalMinutes * 60_000).toISOString();
        this.store.githubWatches.recordFailure(
          watch.id,
          watch.nextCheckAt!,
          next,
          'The GitHub observation failed.',
          new Date(now).toISOString(),
        );
        result.failed += 1;
      }
    }

    const pending = this.store.githubWatches.pendingEvents(GITHUB_WATCH_EVENT_BATCH);
    for (const event of pending) {
      const now = this.clock.nowIso();
      if (event.discordUserId !== this.ownerId) {
        this.store.githubWatches.recordEventFailure(event.id, now, 0);
        result.abandoned += 1;
        continue;
      }
      try {
        await this.transport.send(dmTarget(this.ownerId), githubWatchDm(event));
        // The receipt and the settlement are one step: the owner was told only once the send succeeded.
        withTransaction(this.store.db, () => {
          this.store.githubWatches.markEventDelivered(event.id, now);
          this.store.nativeTransitions.markNativeDelivered('watch_summary', event.id, 'owner_dm', now);
          // A per-author line told without exact review identity becomes durable evidence only now that the
          // send succeeded, in the step that settles the row (never for a queued, failed or abandoned one).
          this.store.githubWatches.promoteGapMarkers(event.id);
        });
        result.delivered += 1;
      } catch {
        this.store.githubWatches.recordEventFailure(
          event.id,
          now,
          GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS,
        );
        if (event.attempts + 1 >= GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS) result.abandoned += 1;
        else result.deliveryFailed += 1;
      }
    }
    // An outbox row that will never be sent (abandoned, or its watch cancelled) must not keep an
    // imported event waiting: its reservation is released, rows still pending keep theirs.
    this.store.nativeTransitions.sweepOrphans();
    return result;
  }

  private async observe(watch: GitHubWatchRow): Promise<'changed' | 'unchanged' | 'deferred' | 'identity_stopped'> {
    const repo = this.allowlist.resolve(watch.repoSlug);
    if (!repo.github) throw new DuckyError('invalid_input', 'The watched repository has no GitHub mapping.');
    const ref = { owner: repo.github.owner, repo: repo.github.repo };
    // The repository this observation queries, fixed NOW and recorded with everything it
    // produces: a mapping that changes while the reads are awaited cannot change what was queried.
    const repoKey = transitionRepoKey(`${ref.owner}/${ref.repo}`);
    if (repoKey === null) throw new DuckyError('invalid_input', 'The watched repository is not a valid reference.');
    // A watch bound to one repository whose slug now names another is stopped, never silently
    // retargeted: its snapshot and outbox describe the old repository and are kept as they are.
    if (watch.repoKey !== null && watch.repoKey !== repoKey) {
      withTransaction(this.store.db, () => this.store.githubWatches.cancelForIdentity(watch.id, this.clock.nowIso()));
      return 'identity_stopped';
    }
    // The host instant BEFORE any read starts, fixed now: what this snapshot is a view of cannot be
    // older than this, so a pull request created after it cannot have been in the previous snapshot.
    const readStartIso = new Date(this.clock.nowMs()).toISOString();
    const previous = parseSnapshot(watch.snapshotJson);
    // `prListAll` rather than `prList`: a merge or a close is told from the list's own explicit evidence
    // (`mergedAt`, `closedAt`, the state), and the open-only list could only ever report it as "gone".
    // Runs and issues are separate bounded reads; each is allowed to fail on its
    // own, because a repository with Actions disabled must not break the watch.
    const [view, prs] = await Promise.all([
      this.reader.repoView(ref),
      this.reader.prListAll(ref),
    ]);
    // The pre-read instant is a proof of what a review set contained only for the repository the watch is bound to.
    const reviewBoundary = watch.repoKey !== null && watch.repoKey === repoKey ? readStartIso : null;
    const { snapshot: normalized, createdAt } = await this.normalize(view, prs, ref, previous, reviewBoundary);
    const snapshotJson = canonicalJson(normalized);
    // A legacy snapshot is compared through its legacy projection ONLY, so the first observation after the
    // upgrade neither announces "changed" for an unchanged repository nor lets new metadata decide anything. A
    // version 2 snapshot is compared through its own projection AND by the review facts it already proves
    // comparable (its identities and requested-changes states), so a genuinely new review is never swallowed by
    // the upgrade. A version 3 snapshot is compared through ITS projection, which has no close proof and none of the
    // fetched list beyond the rich slice: gaining that metadata is no change, while a real change to any older
    // field still is. From then on the fingerprint covers every fact a line can render.
    const fingerprint = fingerprintOf(normalized, 'v4');
    const newFacts = previous !== undefined && previous.v === 2 ? reviewFactChanges(previous, normalized).length > 0 : false;
    const comparable = previous === undefined
      ? fingerprint
      : previous.v === undefined
        ? fingerprintOf(normalized, 'legacy')
        : previous.v === 2
          ? fingerprintOf(normalized, 'v2')
          : previous.v === 3 ? fingerprintOf(normalized, 'v3') : fingerprint;
    const changed = watch.snapshotHash !== comparable || newFacts;
    // The read boundary is trusted only for the repository it was recorded for, and only beside a snapshot.
    const boundaryMs = previous !== undefined && watch.repoKey !== null && watch.repoKey === repoKey &&
      watch.readBoundaryAt !== null ? Date.parse(watch.readBoundaryAt) : Number.NaN;
    const summaryContext = {
      boundaryMs: Number.isFinite(boundaryMs) ? boundaryMs : null,
      createdAt,
    };
    const nowMs = this.clock.nowMs();
    const atIso = new Date(nowMs).toISOString();
    const nextCheckAt = new Date(nowMs + watch.intervalMinutes * 60_000).toISOString();

    // Follow-up proposals are enqueued whether or not the whole snapshot moved:
    // a review that asked for changes is worth proposing once even if nothing
    // else about the repository differs. The unique `(watch, fingerprint)` index
    // is what makes "once" true. A follow-up is actionable content of its own, not a receipt
    // for any review.
    const followUps = followUpProposals(repo.slug, normalized).map((f) => ({
      id: randomUUID(),
      fingerprint: f.fingerprint,
      summary: f.summary,
    }));

    // One synchronous step: what may be told is decided against the ledger, the outbox rows and
    // the cursor commit together, so a check and the reservation after it cannot be separated.
    const outcome = withTransaction(this.store.db, () => {
      const ledger = this.store.nativeTransitions;
      ledger.requireBoundary();
      ledger.ensureSeeded(this.ownerId, atIso);

      // An item an imported target has already DELIVERED is not told again, so it is taken out of
      // the summary and the summary is rebuilt around exactly what remains. An item an imported
      // send is in flight for is told by neither: the whole observation waits, unchanged, and nothing
      // is persisted for it. A requested-changes review that cannot be told apart from one the target
      // delivered is neither told nor dropped: it becomes its own durable HELD row (below), so one
      // unplaceable review neither repeats a notification nor stalls the rest of the repository.
      const excluded = new Set<string>();
      const held = new Map<string, { id: string; heldKey: string; summary: string; providerAt: string | null }>();
      let rendered: Summary = { text: null, named: [], universe: [], suppressed: [], markers: [] };
      // Per-author lines that are shown after all, because the exact facts that stood for them were not conveyed.
      const demoted = new Set<string>();
      const priorState = (n: number, hash: string): boolean => ledger.reviewTold(this.ownerId, repoKey, String(n), hash);
      if (changed) {
        // The passes are bounded by EVERY transition the observation could name (before any cap or clamp),
        // not by what the first render happened to show: removing an item can reveal one a cap or the clamp
        // had hidden. Exclusion only removes from that finite set and every pass that goes round again
        // excluded at least one new key of it, so the loop always ends well inside the bound; a loop that
        // somehow did not would defer, never send a render nobody checked. A per-author line that was left out
        // because exact facts stand for it comes back when one of those facts was not conveyed (cut off by the
        // clamp, or inside a redacted summary): the set of demoted lines only grows and is bounded by the pull
        // requests and the two classes, so that adds a fixed number of passes and no more.
        let passes = 0;
        let limit = 0;
        for (;;) {
          rendered = summarizeChange(repo.slug, previous, normalized, { excluded, demoted, priorState, ...summaryContext });
          if (passes === 0) limit = rendered.universe.length + 1 + 2 * GITHUB_WATCH_MAX_PR_CHECKS;
          let progressed = false;
          for (const c of rendered.named) {
            const key = transitionKey(c.t);
            const probe = ledger.probeNative(this.ownerId, repoKey, c.t, c.providerAt, {
              boundary: c.boundary ?? null, stateChange: c.stateChange === true,
              ...(c.priorState === undefined ? {} : { priorState: c.priorState }),
            });
            if (probe === 'target_in_flight') return 'deferred' as const;
            if (excluded.has(key)) continue;
            if (probe === 'target_delivered') {
              excluded.add(key);
              progressed = true;
            } else if (probe === 'ambiguous' || probe === 'uncertain') {
              excluded.add(key);
              // The text is stored with the row for the record and is NEVER sent: a held row is not pending work. A held
              // close is counted on its own (its key is a `pr_closed:` transition key).
              held.set(key, {
                id: randomUUID(), heldKey: key, providerAt: c.providerAt,
                summary: probe === 'uncertain'
                  ? `Held, not sent: a pull request close on #${c.t.item} may already have been told by the notification ` +
                    'target before exact close receipts existed, and nothing proves what it showed.'
                  : `Held, not sent: a review fact on #${c.t.item} cannot be told apart from one ` +
                    'the notification target already delivered.',
              });
              progressed = true;
            }
          }
          if (!progressed) {
            // The probing is stable. A per-author line that exact facts stand for must not be left out on the
            // strength of a fact the text did not actually show: that fact has no receipt and the owner has not
            // read it. Show the line, and look again.
            const shownKeys = new Set(rendered.named.map((c) => transitionKey(c.t)));
            for (const sup of rendered.suppressed) {
              if (!demoted.has(sup.key) && sup.renderedKeys.some((k) => !shownKeys.has(k))) {
                demoted.add(sup.key);
                progressed = true;
              }
            }
          }
          if (!progressed) break;
          passes += 1;
          if (passes > limit) return 'deferred' as const;
        }
      }
      const summaryId = randomUUID();
      const events = [
        // `text === null`: everything that changed was an item an imported target delivered or a held one.
        ...(changed && rendered.text !== null
          ? [{ id: summaryId, fingerprint, summary: rendered.text, gapMarkers: rendered.markers }]
          : []),
        ...followUps,
      ];
      const committed = this.store.githubWatches.observe({
        id: watch.id,
        expectedNextCheckAt: watch.nextCheckAt!,
        expectedRepoKey: watch.repoKey,
        repoKey,
        snapshotHash: fingerprint,
        snapshotJson,
        nextCheckAt,
        atIso,
        changed,
        events,
        readBoundaryAt: readStartIso,
        held: [...held.values()],
      });
      if (!committed) return 'lost' as const;
      // Each named item is reserved by THIS summary's own holder row, beside any other native holder of the
      // same transition (a feed card): one holder abandoning can never erase another's receipt. A
      // fingerprint that already had an outbox row reserves nothing new.
      if (events.some((e) => e.id === summaryId)) {
        const stored = this.store.db
          .prepare('SELECT id FROM github_watch_events WHERE id = ?')
          .get(summaryId) as { id: string } | undefined;
        if (stored) {
          for (const c of rendered.named) {
            ledger.reserveNative(this.ownerId, repoKey, c.t, 'watch_summary', summaryId, atIso, atIso, c.providerAt);
          }
        }
      }
      return 'committed' as const;
    });
    if (outcome === 'deferred') return 'deferred';
    // `committed` reports whether the cursor CAS held; the public tick metric
    // reports whether the snapshot itself changed.
    return outcome === 'committed' && changed ? 'changed' : 'unchanged';
  }

  private async normalize(
    view: RepoView,
    prs: PrList,
    ref: { owner: string; repo: string },
    previous: NormalizedSnapshot | undefined,
    reviewBoundary: string | null,
  ): Promise<{ snapshot: NormalizedSnapshot; createdAt: Map<number, string> }> {
    const selected = prs.slice(0, GITHUB_WATCH_MAX_PR_CHECKS);
    const before = new Map((previous?.prs ?? []).map((p) => [p.number, p]));
    // Canonical creation instants of the CURRENT list, used once to prove an opening and never stored.
    const createdAt = new Map<number, string>();
    for (const pr of selected) {
      const stamp = canonicalStamp(pr.createdAt);
      if (stamp !== null) createdAt.set(pr.number, stamp);
    }
    const normalizedPrs = await Promise.all(selected.map(async (pr): Promise<NormalizedPr> => {
      const old = before.get(pr.number);
      let checks: string[] = [];
      try {
        checks = normalizeChecks(await this.reader.prChecks(ref, pr.number));
      } catch {
        checks = ['unavailable'];
      }
      // The review surface. Failing to read it degrades the summary rather than
      // failing the observation: a repository with reviews disabled, or a `gh`
      // that does not support a selector, must not silence a watch.
      let reviews: Awaited<ReturnType<GitHubReader['prReviews']>> | undefined;
      try {
        reviews = await this.reader.prReviews(ref, pr.number);
      } catch {
        reviews = undefined;
      }
      // What the review read says about the OLDER fields. An unavailable read is not an empty one: those
      // fields keep the last values proven by an earlier read (and stay absent when none exists), so a
      // failed read neither erases a requested change nor makes every old comment look new on recovery.
      // A field comes from a read ONLY when that read actually carried it, each from its OWN list: a
      // successful answer that omits `latestReviews`, `comments` or `commits` (the schema makes each
      // optional) says nothing about that field, and a failed read says nothing about any. Then the last
      // value proven by an earlier read stays (and a field never proven stays absent), so neither a failed
      // nor a partial read erases a requested change or turns old comments new. The three lists are
      // separate connections: a `reviews` list at the bound cuts off only the exact facts (`rf`, below),
      // never the per-author view, the comments or the commits, which keep updating from their own lists.
      const reviewFields: Pick<
        NormalizedPr, 'approvals' | 'changesRequested' | 'reviewComments' | 'commits' | 'latestChangeRequestAt'
      > = {};
      const latestRead = Array.isArray(reviews?.latestReviews) ? reviews!.latestReviews! : undefined;
      if (latestRead) {
        const changeRequests = latestRead.filter((r) => /CHANGES_REQUESTED/i.test(r.state ?? ''));
        reviewFields.approvals = latestRead.filter((r) => /APPROVED/i.test(r.state ?? '')).length;
        reviewFields.changesRequested = changeRequests.length;
        reviewFields.latestChangeRequestAt = changeRequests
          .map((r) => r.submittedAt ?? '')
          .sort()
          .at(-1) ?? '';
      } else {
        if (old?.approvals !== undefined) reviewFields.approvals = old.approvals;
        if (old?.changesRequested !== undefined) reviewFields.changesRequested = old.changesRequested;
        if (old?.latestChangeRequestAt !== undefined) reviewFields.latestChangeRequestAt = old.latestChangeRequestAt;
      }
      if (Array.isArray(reviews?.comments)) reviewFields.reviewComments = reviews!.comments!.length;
      else if (old?.reviewComments !== undefined) reviewFields.reviewComments = old.reviewComments;
      if (Array.isArray(reviews?.commits)) reviewFields.commits = reviews!.commits!.length;
      else if (old?.commits !== undefined) reviewFields.commits = old.commits;
      // A close is proven by the list's OWN explicit evidence, and a successful per-pull-request read may only
      // confirm it. A contradiction (it supplies a merge instant, or a state that is not CLOSED) proves no close and
      // no new merge claim either: neither source is believed over the other.
      const proof = proveClose(pr, reviews);
      const contradicted = pr.state === 'CLOSED' && pr.mergedAt === null && proof === undefined && reviewsContradictClose(reviews);
      return {
        number: pr.number,
        title: redact(pr.title).slice(0, 180),
        state: redact(pr.state).slice(0, 40),
        isDraft: pr.isDraft === true,
        headRefName: redact(pr.headRefName ?? '').slice(0, 180),
        updatedAt: pr.updatedAt ?? '',
        checks,
        headRefOid: redact(pr.headRefOid ?? reviews?.headRefOid ?? '').slice(0, 64),
        mergedAt: pr.mergedAt ?? (contradicted ? '' : reviews?.mergedAt) ?? '',
        ...(proof !== undefined ? { cp: proof } : {}),
        // A decision is a value only from a read that CARRIED it: a missing or empty field is "not read", so the
        // last proven value stays and a failed read and its recovery never produce a decision change.
        reviewDecision: redact(pr.reviewDecision ?? reviews?.reviewDecision ?? '').slice(0, 40) || (old?.reviewDecision ?? ''),
        ...reviewFields,
        rf: deriveReviewFacts(reviews, old?.rf, reviewBoundary),
      };
    }));

    // Bounded, and each independently optional.
    let runs: NormalizedRun[] = [];
    try {
      runs = (await this.reader.runList(ref)).slice(0, GITHUB_WATCH_MAX_RUNS).map((r) => ({
        workflow: redact(r.workflowName ?? '').slice(0, 120),
        branch: redact(r.headBranch ?? '').slice(0, 120),
        headSha: redact(r.headSha ?? '').slice(0, 64),
        status: redact(r.status ?? '').slice(0, 40),
        conclusion: redact(r.conclusion ?? '').slice(0, 40),
      }));
    } catch {
      runs = [];
    }

    let openIssues: NormalizedIssue[] = [];
    try {
      openIssues = (await this.reader.issueList(ref)).slice(0, GITHUB_WATCH_MAX_ISSUES).map((i) => ({
        number: i.number,
        title: redact(i.title).slice(0, 180),
        state: redact(i.state ?? '').slice(0, 40),
        updatedAt: i.updatedAt ?? '',
      }));
    } catch {
      openIssues = [];
    }

    // The rest of the fetched list, for lifecycle evidence only (a close or a merge of a pull request that is still
    // listed). Ordered by number, so list order is never evidence, and never a pull request that is already rich.
    const richNumbers = new Set(selected.map((pr) => pr.number));
    const tail: TailPr[] = prs.slice(GITHUB_WATCH_MAX_PR_CHECKS)
      .filter((pr) => !richNumbers.has(pr.number) && Number.isInteger(pr.number) && pr.number > 0)
      .map((pr): TailPr => {
        const proof = proveClose(pr, undefined);
        const ma = canonicalStamp(pr.mergedAt);
        return { n: pr.number, s: stateClassOf(pr.state), ...(proof !== undefined ? { cp: proof } : {}), ...(ma !== null ? { ma } : {}) };
      })
      .sort((a, b) => a.n - b.n)
      .slice(0, TAIL_MAX);

    return {
      snapshot: {
        v: 4,
        repoName: redact(view.name).slice(0, 180),
        defaultBranch: redact(view.defaultBranchRef?.name ?? 'unknown').slice(0, 180),
        // Only the ones still open: `prListAll` includes closed ones now.
        openPrCount: prs.filter((pr) => /open/i.test(pr.state)).length,
        prs: normalizedPrs,
        tail,
        runs,
        openIssues,
      },
      createdAt,
    };
  }

  private owned(actor: ActorContext, publicId: string): GitHubWatchRow {
    const parsed = PublicWatchIdSchema.safeParse(publicId.trim().toLowerCase());
    const row = parsed.success
      ? this.store.githubWatches.byPublicId(actor.discordUserId, parsed.data)
      : undefined;
    if (!row) throw new DuckyError('not_found', 'No repository watch with that id.');
    return row;
  }

  private freshPublicId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newPublicWatchId();
      // The handle namespace is shared with notification-only targets, so one
      // handle names exactly one watch whichever kind it is.
      if (!this.store.githubWatches.publicIdExists(id) && !this.store.assistantWatch.publicIdExists(id)) {
        return id;
      }
    }
    throw new DuckyError('invalid_input', 'Could not allocate a repository watch id. Try again.');
  }
}

/**
 * Counts only, over the owner's watches (any state): pull requests whose review list is at the bound (no new
 * review can be told exactly), and pull requests for which exact review facts are REFUSED because a submitted
 * review left the list or changed state in a way the provider lifecycle does not allow. Never a repository, a
 * pull request number or a review.
 */
export function reviewEvidenceCounts(store: Store, ownerId: string): { truncated: number; refused: number } {
  let truncated = 0;
  let refused = 0;
  for (const w of store.githubWatches.listForOwner(ownerId, true, MAX_GITHUB_WATCHES_PER_OWNER)) {
    for (const pr of parseSnapshot(w.snapshotJson)?.prs ?? []) {
      // A cancelled watch no longer reads anything, so its last truncated read is not a live limit; a refusal is
      // evidence and stays counted whatever became of the watch.
      if (pr.rf?.s === 'truncated' && w.state === 'active') truncated += 1;
      if (pr.rf?.x !== undefined) refused += 1;
    }
  }
  return { truncated, refused };
}

function parseSnapshot(raw: string | null): NormalizedSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<NormalizedSnapshot>;
    if (!Array.isArray(candidate.prs)) return undefined;
    // Review facts are read back defensively: a value that is not exactly what this build writes (or what version
    // 2 wrote, which is converted) is dropped (the pull request is then "never proven"), never trusted and never
    // repaired.
    const prs = candidate.prs.map((pr) => {
      const { rf, cp, ...rest } = pr as NormalizedPr & { rf?: unknown; cp?: unknown };
      const clean = cleanReviewFacts(rf);
      // A close proof is a canonical instant exactly as this build writes it; anything else is dropped (the pull
      // request is then "not proven closed"), never trusted and never repaired.
      const proof = typeof cp === 'string' && canonicalStamp(cp) === cp ? cp : undefined;
      return { ...rest, ...(proof !== undefined ? { cp: proof } : {}), ...(clean ? { rf: clean } : {}) };
    });
    const { tail: rawTail, ...restOfSnapshot } = candidate as Partial<NormalizedSnapshot> & { tail?: unknown };
    const tail = cleanTail(rawTail);
    return { ...(restOfSnapshot as NormalizedSnapshot), prs, ...(tail !== undefined ? { tail } : {}) };
  } catch {
    return undefined;
  }
}

/** The fetched list beyond the rich slice, as this build writes it; anything else is not trusted at all. */
function cleanTail(raw: unknown): TailPr[] | undefined {
  if (!Array.isArray(raw) || raw.length > TAIL_MAX) return undefined;
  const seen = new Set<number>();
  const out: TailPr[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object' || !Number.isInteger(t['n']) || (t['n'] as number) < 1 || seen.has(t['n'] as number)) return undefined;
    if (t['s'] !== 'O' && t['s'] !== 'C' && t['s'] !== 'M' && t['s'] !== 'U') return undefined;
    if (t['cp'] !== undefined && (typeof t['cp'] !== 'string' || canonicalStamp(t['cp']) !== t['cp'])) return undefined;
    if (t['ma'] !== undefined && (typeof t['ma'] !== 'string' || canonicalStamp(t['ma']) !== t['ma'])) return undefined;
    seen.add(t['n'] as number);
    out.push({
      n: t['n'] as number, s: t['s'], ...(t['cp'] !== undefined ? { cp: t['cp'] as string } : {}),
      ...(t['ma'] !== undefined ? { ma: t['ma'] as string } : {}),
    });
  }
  return out;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REVIEW_CODES: readonly string[] = ['A', 'R', 'C', 'D', 'U'];

/** A version 3 set as written, or a version 2 set (`seen` prefixes and requested-changes `cr`) converted. */
function cleanReviewFacts(raw: unknown): ReviewFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r['s'] !== 'complete' && r['s'] !== 'unavailable' && r['s'] !== 'truncated') return undefined;
  if (typeof r['known'] !== 'boolean') return undefined;
  const status = r['s'] as ReviewFactStatus;
  if (Array.isArray(r['rv'])) {
    const rv = r['rv'] as Record<string, unknown>[];
    if (rv.length > GITHUB_WATCH_REVIEW_FACTS_MAX) return undefined;
    const pb = r['pb'] === null || r['pb'] === undefined ? null : typeof r['pb'] === 'string' ? canonicalStamp(r['pb']) : undefined;
    if (pb === undefined || (r['pb'] != null && pb !== r['pb'])) return undefined;
    const seenHashes = new Set<string>();
    const facts: ReviewFact[] = [];
    for (const f of rv) {
      if (!f || typeof f['h'] !== 'string' || !HEX64.test(f['h']) || seenHashes.has(f['h'])) return undefined;
      if (typeof f['at'] !== 'string' || canonicalStamp(f['at']) !== f['at']) return undefined;
      if (typeof f['c'] !== 'string' || !REVIEW_CODES.includes(f['c'])) return undefined;
      if (f['f'] !== null && (typeof f['f'] !== 'string' || !REVIEW_CODES.includes(f['f']))) return undefined;
      seenHashes.add(f['h']);
      facts.push({ h: f['h'], at: f['at'], f: f['f'] as ReviewCode | null, c: f['c'] as ReviewCode });
    }
    const seen = r['seen'];
    if (seen !== undefined && (!Array.isArray(seen) || seen.length > GITHUB_WATCH_REVIEW_FACTS_MAX ||
        !seen.every((h) => typeof h === 'string' && HEX32.test(h)))) return undefined;
    const x = r['x'];
    if (x !== undefined && x !== 'left' && x !== 'lifecycle') return undefined;
    return {
      s: status, known: r['known'] as boolean, pb, rv: facts,
      ...(seen !== undefined && seen.length > 0 ? { seen: [...(seen as string[])] } : {}),
      ...(x !== undefined ? { x } : {}),
    };
  }
  // Version 2: the requested-changes reviews (hash and instant) and every submitted identity's prefix.
  if (!Array.isArray(r['seen']) || !Array.isArray(r['cr'])) return undefined;
  const seen = r['seen'] as unknown[];
  const cr = r['cr'] as Record<string, unknown>[];
  if (seen.length > GITHUB_WATCH_REVIEW_FACTS_MAX || cr.length > GITHUB_WATCH_REVIEW_FACTS_MAX) return undefined;
  if (!seen.every((h) => typeof h === 'string' && HEX32.test(h))) return undefined;
  if (!cr.every((c) => c && typeof c['h'] === 'string' && HEX64.test(c['h']) && typeof c['at'] === 'string' &&
      canonicalStamp(c['at']) === c['at'])) return undefined;
  const known = new Set(cr.map((c) => String(c['h']).slice(0, 32)));
  return {
    s: status, known: r['known'] as boolean, pb: null,
    // A requested change proves an earlier state; a bare identity proves only that the review is not new.
    rv: cr.map((c) => ({ h: String(c['h']), at: String(c['at']), f: 'R' as const, c: 'R' as const })),
    ...(seen.some((h) => !known.has(String(h))) ? { seen: (seen as string[]).filter((h) => !known.has(h)) } : {}),
  };
}

const codeOfState = (state: string): ReviewCode => {
  switch (state) {
    case 'APPROVED': return 'A';
    case 'CHANGES_REQUESTED': return 'R';
    case 'COMMENTED': return 'C';
    case 'DISMISSED': return 'D';
    default: return 'U';
  }
};

/**
 * What a read of one pull request's `reviews` proves about its submitted reviews and their states.
 *
 * Only a COMPLETE read yields facts: it must have the list, it must be shorter than the bound (a full list
 * cannot be told from a cut-off one), and every purported submitted review in it must be identifiable (an id and
 * a submission instant). A review still PENDING (a viewer's draft) is not a submitted review and is neither
 * listed nor counted. Anything less carries the previous complete facts forward unchanged with only the status
 * moved: nothing unseen is absorbed, so a review that arrives during the gap is told when a complete read
 * returns.
 *
 * A complete read is also checked against the lifecycle this build assumes (and does not claim to have proven
 * live): a submitted review never leaves the list, and it changes state only by being dismissed. A read that
 * contradicts either is treated like an unavailable one, never absorbed, never read as a new review, and counted.
 */
function deriveReviewFacts(
  reviews: Awaited<ReturnType<GitHubReader['prReviews']>> | undefined,
  previous: ReviewFacts | undefined,
  boundary: string | null,
): ReviewFacts {
  const carry = (s: ReviewFactStatus, x?: 'left' | 'lifecycle'): ReviewFacts => {
    const kept = x ?? previous?.x;
    return previous
      ? { ...previous, s, ...(kept !== undefined ? { x: kept } : {}) }
      : { s, known: false, pb: null, rv: [] };
  };
  const list = reviews?.reviews;
  if (!Array.isArray(list)) return carry('unavailable');
  if (list.length >= GITHUB_WATCH_REVIEW_FACTS_MAX) return carry('truncated');
  const current = new Map<string, { at: string; c: ReviewCode }>();
  for (const r of list) {
    const state = (r.state ?? '').toUpperCase();
    if (state === 'PENDING') continue;
    const at = canonicalStamp(r.submittedAt);
    const h = hashProviderRef(r.id);
    // A purported submitted review that cannot be identified makes the whole read unusable for exact facts.
    if (h === null || at === null) return carry('unavailable');
    current.set(h, { at, c: codeOfState(state) });
  }
  const before = previous?.known ? new Map(previous.rv.map((f) => [f.h, f])) : new Map<string, ReviewFact>();
  const seenPrefixes = previous?.known ? new Set(previous.seen ?? []) : new Set<string>();
  if (previous?.known) {
    // A submitted review never leaves the list: an identity that is gone is not a deletion this build can prove.
    for (const f of previous.rv) if (!current.has(f.h)) return carry('unavailable', 'left');
    const currentPrefixes = new Set([...current.keys()].map((h) => h.slice(0, 32)));
    for (const p of seenPrefixes) if (!currentPrefixes.has(p)) return carry('unavailable', 'left');
    for (const [h, v] of current) {
      const p = before.get(h);
      // A known state changes only to DISMISSED. An unknown state never conflicts.
      if (p && p.c !== v.c && p.c !== 'U' && v.c !== 'D') return carry('unavailable', 'lifecycle');
    }
  }
  const rv = [...current].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([h, v]): ReviewFact => {
    const p = before.get(h);
    // The first-observed state is never rewritten; a review known only by identity has none.
    const f = p ? p.f : seenPrefixes.has(h.slice(0, 32)) ? null : v.c;
    return { h, at: v.at, f, c: v.c };
  });
  return { s: 'complete', known: true, pb: boundary, rv };
}

/** The most pull requests beyond the rich slice a snapshot keeps (the list is fetched at 20, the slice is 5). */
const TAIL_MAX = 30;

/** The raw state class of a pull request: open, closed, merged, or a word this build does not know. */
function stateClassOf(raw: string): TailPr['s'] {
  switch (raw.toUpperCase()) {
    case 'OPEN': return 'O';
    case 'CLOSED': return 'C';
    case 'MERGED': return 'M';
    default: return 'U';
  }
}

/**
 * The canonical close instant, or undefined, from the list row's OWN explicit evidence only: the raw state is exactly
 * `CLOSED`, `mergedAt` is PRESENT and explicitly null (a missing, empty or non-null merge field proves nothing: a
 * merged pull request is closed too), the number is valid and `closedAt` is a readable instant. A successful
 * per-pull-request read may only confirm it: if it supplies a merge instant, or a state that is not CLOSED, it
 * contradicts the list and proves no close. Nothing is inferred from a disappearance, an update time or a fallback.
 */
function proveClose(row: PrList[number], reviews: PrReviews | undefined): string | undefined {
  if (row.state !== 'CLOSED' || row.mergedAt !== null) return undefined;
  if (reviewsContradictClose(reviews)) return undefined;
  const stamp = canonicalStamp(row.closedAt);
  return stamp !== null && closedTransition(row.number, stamp) !== null ? stamp : undefined;
}

/** Whether a successful per-pull-request read says something a CLOSED, unmerged list row cannot be. */
function reviewsContradictClose(reviews: PrReviews | undefined): boolean {
  if (reviews === undefined) return false;
  if (reviews.mergedAt !== undefined && reviews.mergedAt !== null) return true;
  return reviews.state !== undefined && reviews.state !== 'CLOSED';
}

/**
 * The fingerprint of a snapshot. `legacy` is exactly what versions before exact review facts hashed (so an
 * unchanged repository hashes the same through an upgrade). `v2` is what version 2 hashed (the requested-changes
 * reviews); a version 2 snapshot is compared through it. `v3` adds every review state a line can now render and
 * still leaves out the comparison metadata (how the last read went, the boundary, the anomaly mark, a state word
 * this build does not know), which is not a fact the owner is told; a version 3 snapshot is compared through it, so
 * gaining the close proof and the fetched tail is no change. `v4` adds the close proof of each pull request and the
 * rest of the fetched list. `core` is what a line can say apart from the review summaries: when only the rest
 * moved, nothing is worth a message.
 */
function fingerprintOf(snapshot: NormalizedSnapshot, mode: 'legacy' | 'v2' | 'v3' | 'v4' | 'core'): string {
  const { v: _version, prs, tail, ...rest } = snapshot;
  let projected: unknown;
  // Every projection but `v4` leaves out the close proof and the fetched list beyond the rich slice: a version 3
  // snapshot never held them, so gaining them is no change, and a line that cannot say them must not be moved by them.
  switch (mode) {
    case 'legacy':
      projected = { ...rest, prs: prs.map(({ rf: _rf, cp: _cp, ...pr }) => pr) };
      break;
    case 'v2':
      projected = {
        v: 2, ...rest,
        prs: prs.map(({ rf, cp: _cp, ...pr }) => ({
          ...pr, cr: (rf?.rv ?? []).filter((f) => f.c === 'R').map(({ h, at }) => ({ h, at })),
        })),
      };
      break;
    case 'v3':
      projected = {
        v: 3, ...rest,
        prs: prs.map(({ rf, cp: _cp, ...pr }) => ({
          ...pr, rv: (rf?.rv ?? []).filter((f) => f.c !== 'U').map((f) => [f.h, f.at, f.c]),
        })),
      };
      break;
    case 'v4':
      projected = {
        v: 4, ...rest, tail: tail ?? [],
        prs: prs.map(({ rf, ...pr }) => ({
          ...pr, rv: (rf?.rv ?? []).filter((f) => f.c !== 'U').map((f) => [f.h, f.at, f.c]),
        })),
      };
      break;
    case 'core':
      projected = {
        ...rest,
        prs: prs.map(({
          rf: _rf, cp: _cp, approvals: _a, changesRequested: _c, commits: _m, latestChangeRequestAt: _l, reviewDecision: _d, ...pr
        }) => pr),
      };
      break;
  }
  return createHash('sha256').update(canonicalJson(projected)).digest('hex');
}

function normalizeChecks(checks: PrChecks): string[] {
  return checks
    .map((check) => `${redact(check.name).slice(0, 80)}:${redact(check.bucket ?? check.state ?? 'unknown').slice(0, 40)}`)
    .sort();
}

/** One item a summary's text names, with the provider instant of the fact where one is known. */
interface NamedClaim {
  readonly t: Transition;
  readonly providerAt: string | null;
  /** For a NEW review fact: the boundary of the previous complete set it is absent from (null: no proof). */
  readonly boundary?: string | null;
  /** The fact is a known review changing state (to DISMISSED). */
  readonly stateChange?: boolean;
  /** For a state change: the KNOWN not-dismissed state the previous complete set recorded (never an unknown one). */
  readonly priorState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
}

/** A per-author line segment rendered without exact review identity, checked against the final text. */
interface GapMarkerOut {
  readonly pr: number;
  readonly cls: GapClass;
  readonly reason: GapReason;
  readonly shown: GapShown;
}

/** A rendered summary and the exact items its text NAMES (never a count, never an unnamed aggregate). */
interface Summary {
  readonly text: string | null;
  readonly named: readonly NamedClaim[];
  /**
   * EVERY transition key the observation could name, before any cap, clamp or exclusion: the finite set the
   * reconciliation loop works through. Exclusion only removes from it, so it bounds the passes.
   */
  readonly universe: readonly string[];
  /**
   * Per-author lines left out because exact facts of the same class stand for them: the key (`class:#`) and the
   * keys of the facts the text still names for it. If one of those is not shown in full, the line comes back.
   */
  readonly suppressed: readonly { key: string; renderedKeys: readonly string[] }[];
  /** The per-author segments rendered without exact review identity, with how provably each is shown. */
  readonly markers: readonly GapMarkerOut[];
}

interface SummaryContext {
  /** Transition keys of items that must not be named: the target delivered them, or they are held. */
  readonly excluded?: ReadonlySet<string>;
  /** Per-author lines (`class:#`) that must be shown even though exact facts stand for them. */
  readonly demoted?: ReadonlySet<string>;
  /** Whether any path already delivered some state of this review (it only chooses a dismissal's wording). */
  readonly priorState?: (n: number, hash: string) => boolean;
  /**
   * The host instant before the read the previous snapshot came from STARTED; null when unknown (a legacy or
   * first observation, an unbound watch, after a failed read).
   */
  readonly boundaryMs: number | null;
  /** Canonical creation instants of the current list, by number. */
  readonly createdAt: ReadonlyMap<number, string>;
}

/** One review fact the snapshots prove: a NEW review in its state, or a known review observed dismissed. */
interface ReviewFactChange {
  readonly n: number;
  readonly h: string;
  readonly at: string;
  readonly code: 'A' | 'R' | 'C' | 'D';
  readonly stateChange: boolean;
  /**
   * `pb` of the previous complete set. For a NEW review: the set it is absent from. For a state change: the set that
   * recorded the review in `priorState`; null when that prior state is not a known not-dismissed one.
   */
  readonly boundary: string | null;
  /** For a state change: the known not-dismissed prior state. Absent for an unknown prior state. */
  readonly priorState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
}

/**
 * The review facts a pair of snapshots PROVES, only against a complete, comparable previous set.
 *
 * - A review whose identity is in neither the previous set nor its identity-only list is NEW, and is a fact in
 *   the state it is in now (approved, commented, requested changes, or dismissed on first sight). A state word
 *   this build does not know is no fact.
 * - A review in the previous set that is DISMISSED now and was not before is an observed dismissal: a state
 *   change, claiming only the DISMISSED state, with no dismissal time (no allowed DTO provides one).
 * - A review known only by identity (a version 2 snapshot) that is dismissed now proves nothing about its prior
 *   state: it is established silently, with no claim. A version 2 requested change that is dismissed now does.
 * Nothing here is inferred from a count, a timestamp or a decision.
 */
function reviewFactChanges(previous: NormalizedSnapshot, current: NormalizedSnapshot): ReviewFactChange[] {
  const before = new Map(previous.prs.map((pr) => [pr.number, pr]));
  const out: ReviewFactChange[] = [];
  for (const pr of current.prs) {
    const old = before.get(pr.number);
    if (pr.rf?.s !== 'complete' || !old?.rf?.known) continue;
    const prior = new Map(old.rf.rv.map((f) => [f.h, f]));
    const identityOnly = new Set(old.rf.seen ?? []);
    for (const f of pr.rf.rv) {
      const p = prior.get(f.h);
      if (!p) {
        if (identityOnly.has(f.h.slice(0, 32)) || f.c === 'U') continue;
        out.push({ n: pr.number, h: f.h, at: f.at, code: f.c, stateChange: false, boundary: old.rf.pb });
      } else if (p.c !== f.c && f.c === 'D') {
        // The previous set recorded this review in a state; only a KNOWN not-dismissed one lets the lifecycle prove
        // a compatible target claim committed before that read began is a different review. An unknown state
        // word (U) is not proven not-dismissed, so it gets no boundary.
        const prior = p.c === 'A' ? 'APPROVED' : p.c === 'R' ? 'CHANGES_REQUESTED' : p.c === 'C' ? 'COMMENTED' : undefined;
        out.push({
          n: pr.number, h: f.h, at: f.at, code: 'D', stateChange: true,
          boundary: prior === undefined ? null : old.rf.pb, ...(prior === undefined ? {} : { priorState: prior }),
        });
      }
    }
  }
  return out;
}

const transitionOfChange = (c: ReviewFactChange): Transition | null =>
  c.code === 'R'
    ? reviewTransitionFromHash(c.n, c.h)
    : observedReviewTransition(c.n, c.h, 'provider', c.code === 'A' ? 'APPROVED' : c.code === 'C' ? 'COMMENTED' : 'DISMISSED');

const stampMs = (raw: string | undefined): number | null => {
  const stamp = canonicalStamp(raw);
  return stamp === null ? null : Date.parse(stamp);
};

/** A decision, in words. It names a decision state, never a submitted review. */
const decisionWords = (value: string): string => value.toLowerCase().replace(/_/g, ' ');

/**
 * What changed, in words, and which items the words actually name.
 *
 * `excluded` holds the transition keys of items an imported target has already DELIVERED (or that are held
 * as unplaceable); those items are left out of the lines that name them and the summary is built around the
 * rest. Nothing else is left out: a count, an aggregate or an unnamed piece is never dropped on the theory
 * that an imported target will eventually tell it, because there is no promise to rely on. `text` is null
 * only when removing those items left nothing to say.
 *
 * The named items come from the SAME slices the text is written from, so a receipt can only exist for an
 * item the owner was actually shown. These kinds of fact carry an exact identity:
 * - an update, only when the provider's `updatedAt` itself moved, and a merge by its merge instant (at most
 *   three of each are named);
 * - a REVIEW in an observed state, from the exact submitted-review list and only against a complete comparable
 *   previous set: a new requested-changes, approved or commented review, a review first seen dismissed, and a
 *   known review observed dismissed. Each is claimed in its OWN state; approved and dismissed are different
 *   tellings of one review, both accepted, so no claim is shared across states;
 * - an OPENING, only when the pull request is absent from the previous snapshot AND was created after the
 *   instant the previous read started (plus the skew margin). That is a proof against a boundary, never an
 *   inference from the capped list, its order, a maximum or an equal second. Any other pull request that
 *   enters the list is "newly listed" and carries no opening claim;
 * - a CLOSE, by its number and the provider's canonical close instant, only from the proof the snapshots carry (the
 *   list row's own explicit evidence) and only as a change: the previous snapshot held the pull request not closed, or
 *   closed with another instant. A pull request that merely gains the proof, or is first seen beyond the rich slice,
 *   is established silently. At most three are named, the rest counted. A pull request whose only change is the
 *   close is told by its close segment alone.
 * A changed review DECISION is its own line and is never claimed, never suppressed because a review was
 * submitted beside it, and never tied to a cause (no DTO proves one). A per-author line (approvals, changes
 * requested) names no review and claims none; it is left out only for a pull request whose complete, comparable
 * observation holds exact facts of the same class that are actually shown, and it is labelled (and counted once
 * delivered) when no exact list could identify what it summarises.
 */
function summarizeChange(
  slug: string,
  previous: NormalizedSnapshot | undefined,
  current: NormalizedSnapshot,
  ctx: SummaryContext,
): Summary {
  const excluded = ctx.excluded ?? new Set<string>();
  const demoted = ctx.demoted ?? new Set<string>();
  if (!previous) {
    return {
      text: clampSummary(`Started watching \`${slug}\`: ${current.openPrCount} open pull request(s).`),
      named: [],
      universe: [],
      suppressed: [],
      markers: [],
    };
  }
  /** One line of the summary and the items it names, with where each item's text ENDS inside the line. */
  interface Part {
    text: string;
    items: { claims: NamedClaim[]; end: number; marker?: { pr: number; cls: GapClass; reason: GapReason } }[];
  }
  interface Entry { claims: NamedClaim[]; segment: string; marker?: { pr: number; cls: GapClass; reason: GapReason } }
  const parts: Part[] = [];
  /** Joins named segments after a prefix and remembers where each one ends. */
  const named = (prefix: string, entries: Entry[], sep = '; '): Part => {
    let text = prefix;
    const items: Part['items'] = [];
    entries.forEach((e, i) => {
      if (i > 0) text += sep;
      text += e.segment;
      if (e.claims.length > 0 || e.marker) items.push({ claims: e.claims, end: text.length, ...(e.marker ? { marker: e.marker } : {}) });
    });
    return { text, items };
  };
  const plain = (text: string): Part => ({ text, items: [] });
  const one = (t: Transition | null): NamedClaim[] => (t === null ? [] : [{ t, providerAt: null }]);
  let removed = false;
  const before = new Map(previous.prs.map((pr) => [pr.number, pr]));
  const updateOf = (pr: NormalizedPr): Transition | null => {
    const old = before.get(pr.number);
    return old !== undefined && old.updatedAt !== pr.updatedAt ? updatedTransition(pr.number, pr.updatedAt) : null;
  };
  // Every key this observation could name, whatever a cap or the clamp later leaves out.
  const universe = new Set<string>();
  const onlyUpdatedAtMoved = (pr: NormalizedPr): boolean => {
    const old = before.get(pr.number);
    return old !== undefined && canonicalJson(old.checks) === canonicalJson(pr.checks) &&
      old.headRefOid === pr.headRefOid;
  };

  // ---- the fetched list as a whole: the rich slice AND the rest of it ------------------------------------------
  //
  // A pull request is "listed" if it is anywhere in the fetched list, rich or not, and a pull request is "no longer
  // listed" only when it is absent from ALL of it (list order is never evidence). A pull request that dropped out of
  // the rich slice but is still in the list keeps its lifecycle evidence here, without an extra read.
  const tailNow = new Map((current.tail ?? []).map((t) => [t.n, t]));
  const tailBefore = new Map((previous.tail ?? []).map((t) => [t.n, t]));
  const wasListed = (n: number): boolean => before.has(n) || tailBefore.has(n);
  /** What the PREVIOUS snapshot held about a pull request's lifecycle, rich or not; undefined when it held nothing. */
  const priorView = (n: number): { cls: TailPr['s']; cp?: string; ma?: string } | undefined => {
    const old = before.get(n);
    if (old !== undefined) {
      const ma = canonicalStamp(old.mergedAt);
      return { cls: stateClassOf(old.state), ...(old.cp !== undefined ? { cp: old.cp } : {}), ...(ma !== null ? { ma } : {}) };
    }
    const held = tailBefore.get(n);
    return held === undefined
      ? undefined
      : { cls: held.s, ...(held.cp !== undefined ? { cp: held.cp } : {}), ...(held.ma !== undefined ? { ma: held.ma } : {}) };
  };

  // ---- exact closes ---------------------------------------------------------------------------------------------
  //
  // A close is told only from the proof the snapshots carry (never from a disappearance, an update time or a missing
  // merge field), and only as a CHANGE: the previous snapshot held the pull request not closed (so this is a proven new
  // close), or closed with a different canonical instant (a reopen and a new close). A pull request the previous
  // snapshot already held CLOSED, which merely gains the proof, is established silently, as is one first seen beyond
  // the rich slice. A pull request that first appears in the rich slice already closed states its known close; that is
  // the close itself, never a claim that it happened since the last read.
  interface CloseFact { n: number; at: string; title: string; t: Transition; rich: boolean }
  const closeTold = (cp: string, prior: ReturnType<typeof priorView>, entrant: boolean): boolean =>
    prior === undefined ? entrant : prior.cls === 'O' || (prior.cls === 'C' && prior.cp !== undefined && prior.cp !== cp);
  const closeFacts: CloseFact[] = [];
  for (const pr of current.prs) {
    if (pr.cp === undefined || !closeTold(pr.cp, priorView(pr.number), true)) continue;
    const t = closedTransition(pr.number, pr.cp);
    if (t !== null) closeFacts.push({ n: pr.number, at: pr.cp, title: pr.title, t, rich: true });
  }
  for (const tl of current.tail ?? []) {
    if (tl.cp === undefined || !closeTold(tl.cp, priorView(tl.n), false)) continue;
    const t = closedTransition(tl.n, tl.cp);
    if (t !== null) closeFacts.push({ n: tl.n, at: tl.cp, title: before.get(tl.n)?.title ?? '', t, rich: false });
  }
  closeFacts.sort((a, b) => a.n - b.n);
  for (const c of closeFacts) universe.add(transitionKey(c.t));
  const closeOf = new Map(closeFacts.map((c) => [c.n, c]));
  /**
   * A change of state to CLOSED and of the update instant (and the close proof itself) and nothing else: such a pull
   * request is told only by its close segment, so it is no generic update, and removing the close (the target told it)
   * leaves no update sentence that retells it. Any other change to an older field keeps its own update line.
   */
  const pureClose = (pr: NormalizedPr): boolean => {
    const old = before.get(pr.number);
    return closeOf.get(pr.number)?.rich === true && old !== undefined && old.title === pr.title &&
      old.isDraft === pr.isDraft && old.headRefName === pr.headRefName && old.headRefOid === pr.headRefOid &&
      canonicalJson(old.checks) === canonicalJson(pr.checks);
  };

  // ---- proven openings: handled FIRST, because a proven opening is told once and not also as an update ----
  const openings = current.prs.filter((pr) => {
    if (wasListed(pr.number) || ctx.boundaryMs === null) return false;
    const stamp = canonicalStamp(ctx.createdAt.get(pr.number));
    return stamp !== null && Date.parse(stamp) > ctx.boundaryMs + NATIVE_LEGACY_SKEW_MS &&
      openedTransition('pr_opened', pr.number) !== null;
  });
  const openingNumbers = new Set(openings.map((pr) => pr.number));
  for (const pr of openings) universe.add(transitionKey(openedTransition('pr_opened', pr.number)!));
  const shownOpenings = openings.filter((pr) => {
    if (excluded.has(transitionKey(openedTransition('pr_opened', pr.number)!))) {
      removed = true;
      return false;
    }
    return true;
  });
  if (shownOpenings.length > 0) {
    parts.push(named(
      'opened: ',
      shownOpenings.map((pr) => ({
        claims: one(openedTransition('pr_opened', pr.number)), segment: `#${pr.number} ${pr.title}`,
      })),
    ));
  }

  const newOrUpdated = current.prs.filter((pr) => {
    if (openingNumbers.has(pr.number)) return false;
    const old = before.get(pr.number);
    // A pull request first seen in the rich slice that the previous read held beyond it has no rich baseline to differ from.
    const changedPr = !old
      ? !tailBefore.has(pr.number)
      : old.state !== pr.state || old.title !== pr.title || old.updatedAt !== pr.updatedAt ||
        canonicalJson(old.checks) !== canonicalJson(pr.checks) || old.headRefOid !== pr.headRefOid;
    if (!changedPr) return false;
    if (pureClose(pr)) {
      // Told only by its exact close segment (or, when the target already told that close, not at all).
      if (excluded.has(transitionKey(closeOf.get(pr.number)!.t))) removed = true;
      return false;
    }
    const t = updateOf(pr);
    if (t !== null) universe.add(transitionKey(t));
    if (t !== null && excluded.has(transitionKey(t)) && onlyUpdatedAtMoved(pr)) {
      removed = true;
      return false;
    }
    return true;
  });
  const listedNumbers = new Set([...current.prs.map((pr) => pr.number), ...tailNow.keys()]);
  // Absent from the WHOLE fetched list (the rich slice and the rest of it), which is capped and covers every state:
  // pushed out by newer pull requests or closed, which this list cannot tell. It is "no longer listed", never "closed"
  // and never an exact close, and it never settles or suppresses a lifecycle fact.
  const gone = previous.prs.filter((pr) => !listedNumbers.has(pr.number));
  const failedChecks = current.prs.filter((pr) => pr.checks.some((check) => /fail|error|cancel/i.test(check)));
  if (newOrUpdated.length > 0) {
    const shown = newOrUpdated.slice(0, NATIVE_SUMMARY_NAMED_MAX);
    parts.push(named(
      `${newOrUpdated.length} pull request update(s): `,
      shown.map((pr) => ({
        claims: one(updateOf(pr)),
        // A pull request new to the snapshot that is not a PROVEN opening is only newly listed.
        segment: `#${pr.number} ${pr.title}${wasListed(pr.number) ? '' : ' (newly listed)'}`,
      })),
    ));
  }
  if (gone.length > 0) {
    parts.push(plain(
      `${gone.length} previously listed pull request(s) are no longer among the ${listedNumbers.size} listed (not necessarily closed)`,
    ));
  }
  if (failedChecks.length > 0) parts.push(plain(`${failedChecks.length} pull request(s) have failing checks`));

  // ---- what the wider surface added -------------------------------------
  //
  // Each of these compares the SAME normalized fields the fingerprint is built
  // from, so a line can only appear when something the snapshot records actually
  // moved. Nothing here fetches anything.
  const merged = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    if (!(isSet(pr.mergedAt) && (!old || !isSet(old.mergedAt)))) return false;
    const t = mergedTransition(pr.number, pr.mergedAt);
    if (t !== null) universe.add(transitionKey(t));
    if (t !== null && excluded.has(transitionKey(t))) {
      removed = true;
      return false;
    }
    return true;
  });
  // A pull request beyond the rich slice that gained a merge instant: told only when the previous snapshot held it (one
  // first seen there establishes silently), from the list's own canonical instant, with no extra read.
  const mergedBeyond = (current.tail ?? []).filter((tl) => {
    if (tl.ma === undefined) return false;
    const prior = priorView(tl.n);
    if (prior === undefined || prior.ma !== undefined) return false;
    const t = mergedTransition(tl.n, tl.ma);
    if (t === null) return false;
    universe.add(transitionKey(t));
    if (excluded.has(transitionKey(t))) {
      removed = true;
      return false;
    }
    return true;
  });
  const mergedEntries = [
    ...merged.map((pr) => ({ t: mergedTransition(pr.number, pr.mergedAt), segment: `#${pr.number} ${pr.title}` })),
    ...mergedBeyond.map((tl) => {
      const title = before.get(tl.n)?.title ?? '';
      return { t: mergedTransition(tl.n, tl.ma), segment: `#${tl.n}${title ? ` ${title}` : ''}` };
    }),
  ];
  if (mergedEntries.length > 0) {
    parts.push(named(
      'merged: ',
      mergedEntries.slice(0, NATIVE_SUMMARY_NAMED_MAX).map((e) => ({ claims: one(e.t), segment: e.segment })),
    ));
  }

  // The exact closes, each named with its canonical instant: the number and the instant ARE the fact, and a claim is
  // made only for a segment shown in full. More than the summary names are counted, never silently dropped.
  const closesLeft = closeFacts.filter((c) => {
    if (excluded.has(transitionKey(c.t))) {
      removed = true;
      return false;
    }
    return true;
  });
  if (closesLeft.length > 0) {
    const shown = closesLeft.slice(0, NATIVE_SUMMARY_NAMED_MAX);
    parts.push(named(
      'closed: ',
      shown.map((c) => ({ claims: one(c.t), segment: `#${c.n}${c.title ? ` ${c.title}` : ''} at ${c.at}` })),
    ));
    if (closesLeft.length > shown.length) {
      parts.push(plain(`${closesLeft.length - shown.length} more closed pull request(s) not named here`));
    }
  }

  // The PR-level DECISION. It names a decision state, not a review, and claims none. A value counts only from a
  // read that carried it (a missing or empty field carries the last proven value), and a pull request that is new
  // to the list has no transition.
  const byDecision = new Map<string, number[]>();
  for (const pr of current.prs) {
    const old = before.get(pr.number);
    const was = old?.reviewDecision ?? '';
    const now = pr.reviewDecision ?? '';
    if (old === undefined || was === '' || now === '' || was === now) continue;
    byDecision.set(now, [...(byDecision.get(now) ?? []), pr.number]);
  }
  for (const [value, numbers] of byDecision) {
    parts.push(plain(`review decision now ${decisionWords(value)}: ${numbers.map((n) => `#${n}`).join(', ')}`));
  }

  // ---- exact reviews, each in its OWN observed state ---------------------
  type Bucket = 'R' | 'A' | 'C' | 'Dchange' | 'Dfirst';
  const buckets = new Map<Bucket, Map<number, NamedClaim[]>>();
  /** Per class and pull request: whether exact facts exist for it, and the keys of those still named. */
  const exactFacts = new Map<string, string[]>();
  const bucketOf = (c: ReviewFactChange): Bucket =>
    c.code === 'D'
      ? (c.stateChange || ctx.priorState?.(c.n, c.h) === true ? 'Dchange' : 'Dfirst')
      : c.code;
  let anyHandled = false;
  for (const c of reviewFactChanges(previous, current)) {
    const t = transitionOfChange(c);
    if (t === null) continue;
    const key = transitionKey(t);
    universe.add(key);
    const cls = c.code === 'R' ? 'changes_requested' : c.code === 'A' ? 'approval' : null;
    if (cls !== null && !exactFacts.has(`${cls}:${c.n}`)) exactFacts.set(`${cls}:${c.n}`, []);
    if (excluded.has(key)) {
      anyHandled = true;
      continue;
    }
    if (cls !== null) exactFacts.get(`${cls}:${c.n}`)!.push(key);
    const b = bucketOf(c);
    const byPr = buckets.get(b) ?? new Map<number, NamedClaim[]>();
    byPr.set(c.n, [...(byPr.get(c.n) ?? []), {
      t, providerAt: c.at, boundary: c.boundary, stateChange: c.stateChange,
      ...(c.priorState === undefined ? {} : { priorState: c.priorState }),
    }]);
    buckets.set(b, byPr);
  }
  const lines: [Bucket, string][] = [
    ['R', 'requested changes submitted on '],
    ['A', 'approval submitted on '],
    ['C', 'commented review submitted on '],
    ['Dchange', 'review dismissed (observed) on '],
    ['Dfirst', 'review submitted and now dismissed on '],
  ];
  // The exact lines are written now but placed AFTER the per-author lines (below): the clamp cuts from the end, so a
  // per-author line that comes back because its exact segment was cut off is read before the cut, not behind it.
  const exactParts: Part[] = [];
  for (const [bucket, prefix] of lines) {
    const byPr = buckets.get(bucket);
    if (!byPr || byPr.size === 0) continue;
    // One segment per pull request; every fact of it is claimed by that segment and only if the whole segment is shown.
    exactParts.push(named(prefix, [...byPr].sort(([a], [b]) => a - b).map(([n, claims]) => ({ claims, segment: `#${n}` }))));
  }
  // A fact the target delivered, or that is held, was left out of the lines: say nothing rather than a generic message.
  if (anyHandled) removed = true;

  // ---- per-author lines -----------------------------------------------------
  //
  // They come from `latestReviews` (one view per reviewer), name no review and claim none. A line is left out
  // only for a pull request whose COMPLETE, COMPARABLE observation holds exact facts of the same class (and the
  // loop above brings it back if one of those facts was not shown in full). Otherwise it is told, labelled when
  // no exact list could identify what it summarises, and remembered once it was delivered.
  const suppressed: { key: string; renderedKeys: string[] }[] = [];
  const comparable = (pr: NormalizedPr, old: NormalizedPr | undefined): boolean =>
    pr.rf?.s === 'complete' && old?.rf?.known === true;
  const gapReason = (pr: NormalizedPr, old: NormalizedPr | undefined): GapReason | null => {
    if (pr.rf?.s === 'truncated') return 'truncated';
    if (pr.rf?.s === 'unavailable') return 'unavailable';
    return comparable(pr, old) ? null : 'no_comparison';
  };
  const perAuthor = (cls: GapClass, wanted: (pr: NormalizedPr, old: NormalizedPr) => boolean): Entry[] => {
    const entries: Entry[] = [];
    for (const pr of current.prs) {
      const old = before.get(pr.number);
      if (old === undefined || !wanted(pr, old)) continue;
      const key = `${cls}:${pr.number}`;
      const facts = exactFacts.get(key);
      if (facts !== undefined && comparable(pr, old) && !demoted.has(key)) {
        suppressed.push({ key, renderedKeys: facts });
        continue;
      }
      // A line that comes back because its exact segment was not conveyed has its own reason: the exact facts exist but
      // have no receipt, so this unidentified line is what the owner reads and it is the same evidence as any other.
      const reason = gapReason(pr, old) ?? (facts !== undefined && demoted.has(key) ? 'not_conveyed' : null);
      entries.push({
        claims: [],
        segment: reason === null ? `#${pr.number}` : `#${pr.number} (reviewer summary only)`,
        ...(reason === null ? {} : { marker: { pr: pr.number, cls, reason } }),
      });
    }
    return entries;
  };
  // Requested changes by reviewer: a STRICTLY later canonical submission instant than the last one read. A moved-
  // backward timestamp (a dismissal) and a pull request with no comparable baseline say nothing.
  const changesEntries = perAuthor('changes_requested', (pr, old) => {
    if ((pr.changesRequested ?? 0) <= 0 || old.latestChangeRequestAt === undefined) return false;
    const now = stampMs(pr.latestChangeRequestAt);
    if (now === null) return false;
    const was = stampMs(old.latestChangeRequestAt);
    return was === null || now > was;
  });
  if (changesEntries.length > 0) parts.push(named('changes requested on ', changesEntries, ', '));
  const approvalEntries = perAuthor('approval', (pr, old) =>
    old.approvals !== undefined && pr.approvals !== undefined && pr.approvals > old.approvals);
  if (approvalEntries.length > 0) parts.push(named('approvals recorded on ', approvalEntries, ', '));
  parts.push(...exactParts);

  // `comments` is the pull request's CONVERSATION comment count, not a submitted review.
  const moreComments = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    if (old !== undefined && old.reviewComments === undefined) return false;
    return (pr.reviewComments ?? 0) > (old?.reviewComments ?? 0);
  });
  if (moreComments.length > 0) {
    parts.push(plain(`new conversation comment(s) on ${moreComments.map((pr) => `#${pr.number}`).join(', ')}`));
  }

  const runSummary = summarizeRuns(previous.runs ?? [], current.runs ?? []);
  if (runSummary) parts.push(plain(runSummary));

  const issueSummary = summarizeIssues(previous.openIssues ?? [], current.openIssues ?? []);
  if (issueSummary) parts.push(plain(issueSummary));

  // Only items an imported target DELIVERED (or that are held) were taken out, and nothing remains to say.
  if (parts.length === 0 && removed) return { text: null, named: [], universe: [...universe], suppressed, markers: [] };
  // Nothing a line can say moved but review counts, a decision that was not a change between two read values, or a
  // review state this build tells nothing about: that is not worth a generic message.
  if (parts.length === 0 && fingerprintOf(previous, 'core') === fingerprintOf(current, 'core')) {
    return { text: null, named: [], universe: [...universe], suppressed, markers: [] };
  }
  if (parts.length === 0) parts.push(plain('The repository snapshot changed.'));

  // The text is clamped to a fixed length, and an item cut off by the clamp was NOT shown in full, so it
  // is no receipt. A claim is kept only for an item whose whole text lies inside what the owner reads.
  const head = `Update for \`${slug}\`: `;
  const full = `${head}${parts.map((p) => p.text).join('. ')}.`;
  const cleaned = redact(full);
  // A claim is a statement that the owner READ the segment. Redaction can span segments (a private-key block
  // runs from a BEGIN marker in one title to an END marker in another and swallows what lies between), so
  // when redacting the whole text changes anything at all, no offset is trustworthy and nothing is claimed:
  // the duplicate that may leave is the honest, still-required blocker, never a false receipt. Only when the
  // text is untouched does the clamp decide which whole segments fit.
  const shownLimit = cleaned !== full
    ? -1
    : cleaned.length <= GITHUB_WATCH_SUMMARY_MAX ? Number.POSITIVE_INFINITY : GITHUB_WATCH_SUMMARY_MAX - 1;
  const claims: NamedClaim[] = [];
  const markers: GapMarkerOut[] = [];
  let start = head.length;
  for (const p of parts) {
    for (const it of p.items) {
      const shown = start + it.end <= shownLimit;
      if (shown) claims.push(...it.claims);
      if (it.marker) markers.push({ ...it.marker, shown: shown ? 'shown' : 'delivered_not_provably_shown' });
    }
    start += p.text.length + 2;
  }
  return { text: clampSummary(full), named: claims, universe: [...universe], suppressed, markers };
}

const isSet = (v: string | undefined): boolean => typeof v === 'string' && v !== '';

const isChangesRequested = (pr: NormalizedPr): boolean =>
  /CHANGES_REQUESTED/i.test(pr.reviewDecision ?? '') || (pr.changesRequested ?? 0) > 0;

/**
 * Workflow failures AND recovery.
 *
 * Recovery is reported for the same reason a failure is: "CI is broken" that is
 * never followed by "CI is fixed" trains the owner to ignore the channel. Keyed
 * by workflow + head sha, so a re-run of the same commit is the same run.
 */
function summarizeRuns(previous: readonly NormalizedRun[], current: readonly NormalizedRun[]): string | undefined {
  const key = (r: NormalizedRun): string => `${r.workflow}@${r.headSha}`;
  const before = new Map(previous.map((r) => [key(r), r]));
  const failed = current.filter(
    (r) => /failure|timed_out|cancelled/i.test(r.conclusion) && !before.has(key(r)),
  );
  const recovered = current.filter((r) => {
    if (!/success/i.test(r.conclusion)) return false;
    // Recovery means: this workflow's previous run on the same branch failed.
    const priorOnBranch = previous.find(
      (p) => p.workflow === r.workflow && p.branch === r.branch && p.headSha !== r.headSha,
    );
    return priorOnBranch !== undefined && /failure|timed_out|cancelled/i.test(priorOnBranch.conclusion);
  });

  const parts: string[] = [];
  if (failed.length > 0) {
    parts.push(`workflow failure(s): ${[...new Set(failed.map((r) => r.workflow))].slice(0, 3).join(', ')}`);
  }
  if (recovered.length > 0) {
    parts.push(`workflow recovered: ${[...new Set(recovered.map((r) => r.workflow))].slice(0, 3).join(', ')}`);
  }
  return parts.length > 0 ? parts.join('. ') : undefined;
}

/** Opened, closed and updated issues, counted rather than listed in full. */
function summarizeIssues(
  previous: readonly NormalizedIssue[],
  current: readonly NormalizedIssue[],
): string | undefined {
  const before = new Map(previous.map((i) => [i.number, i]));
  const currentNumbers = new Set(current.map((i) => i.number));
  const opened = current.filter((i) => !before.has(i.number));
  const closed = previous.filter((i) => !currentNumbers.has(i.number));
  const updated = current.filter((i) => {
    const old = before.get(i.number);
    return old !== undefined && old.updatedAt !== i.updatedAt;
  });

  const parts: string[] = [];
  if (opened.length > 0) parts.push(`${opened.length} new issue(s)`);
  if (closed.length > 0) parts.push(`${closed.length} issue(s) no longer open`);
  if (updated.length > 0) parts.push(`${updated.length} issue update(s)`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * A follow-up job the OWNER may choose to submit, for a pull request whose
 * review asked for changes.
 *
 * Three properties, and each is a refusal of an easier design:
 *
 * - **Nothing is submitted.** This produces a MESSAGE naming the exact command,
 *   and the owner types it. No job is created, no approval is bypassed, and
 *   every existing gate stays exactly where it is. A one-press signed control
 *   would be friendlier and would need a new entry on the owner-only interaction
 *   manifest, which `AGENTS.md` forbids widening -- so the surface the owner
 *   already has is the surface this uses.
 * - **Tied to the repository, the pull request AND the review revision.** The
 *   fingerprint carries the slug, the PR number, the head commit and the review
 *   timestamp, so a proposal is repeated only when there is genuinely new review
 *   or new code -- never on every pass.
 * - **Deduplicated by the database, not by memory.** The fingerprint is unique
 *   per watch, and the insert is `OR IGNORE`, so two overlapping observations
 *   produce one proposal.
 */
export function followUpProposals(
  slug: string,
  snapshot: NormalizedSnapshot,
): { fingerprint: string; summary: string }[] {
  return snapshot.prs
    .filter((pr) => isChangesRequested(pr) && !isSet(pr.mergedAt) && /open/i.test(pr.state))
    .slice(0, GITHUB_WATCH_MAX_FOLLOWUPS)
    .map((pr) => ({
      // Deliberately NOT the snapshot hash: this must survive an unrelated
      // snapshot change without re-proposing, and must re-propose when the
      // review or the code moves.
      fingerprint: `followup:${pr.number}:${pr.headRefOid ?? ''}:${pr.latestChangeRequestAt ?? ''}`,
      summary: clampSummary(
        `Changes requested on \`${slug}\` #${pr.number} (${pr.title}). ` +
          `Nothing has been submitted. If you want Ducky to work on it, run: ` +
          `/job submit repo:${slug} task:"address the requested changes on pull request #${pr.number}"`,
      ),
    }));
}

function clampSummary(value: string): string {
  const cleaned = redact(value);
  return cleaned.length <= GITHUB_WATCH_SUMMARY_MAX
    ? cleaned
    : `${cleaned.slice(0, GITHUB_WATCH_SUMMARY_MAX - 1)}…`;
}
