import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, DuckyError, GITHUB_WATCH_BATCH, GITHUB_WATCH_EVENT_BATCH,
  isDuckyError,
  MAX_GITHUB_WATCHES_PER_OWNER,
  GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS, GITHUB_WATCH_MAX_FOLLOWUPS,
  GITHUB_WATCH_MAX_ISSUES, GITHUB_WATCH_MAX_PR_CHECKS, GITHUB_WATCH_MAX_RUNS,
  GITHUB_WATCH_SUMMARY_MAX, GitHubWatchAddInputSchema, newPublicWatchId,
  PublicWatchIdSchema, NATIVE_SUMMARY_NAMED_MAX, NATIVE_LEGACY_SKEW_MS, GITHUB_WATCH_REVIEW_FACTS_MAX,
  canonicalStamp, hashProviderRef, mergedTransition, openedTransition, reviewTransitionFromHash, transitionKey,
  transitionRepoKey, updatedTransition, type PrChecks, type PrList, type RepoView, type Transition,
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
  reviewDecision?: string;
  approvals?: number;
  changesRequested?: number;
  reviewComments?: number;
  commits?: number;
  /** Identifies the review that asked for changes, for follow-up dedup. */
  latestChangeRequestAt?: string;
  /**
   * Exact requested-changes facts (version 2 snapshots). Absent on a legacy snapshot, which is read through
   * its legacy projection only.
   */
  rf?: ReviewFacts;
}

/** What the last read of a pull request's reviews could prove. */
type ReviewFactStatus = 'complete' | 'unavailable' | 'truncated';

/**
 * The exact submitted-review facts of one pull request, from the bounded `reviews` list (never the
 * per-author `latestReviews`). Hashes only: no raw id, login or body.
 *
 * `cr` (the requested-changes reviews: hash and the provider's canonical instant) is a rendered fact and is
 * part of the fingerprint. `s` (how the last read went), `known` and `seen` are comparison metadata and are
 * not: an unavailable read or its recovery must not by itself create a generic snapshot message, and `seen`
 * (every submitted review, whatever its state, as a 32-hex prefix) exists so that a review whose STATE
 * later changed is never mistaken for a new one.
 *
 * An unavailable or truncated read carries the last COMPLETE facts forward unchanged (so the reviews that
 * arrived during the gap are told on recovery) and never absorbs anything it did not see.
 */
interface ReviewFacts {
  s: ReviewFactStatus;
  /** A complete set has existed: `seen` and `cr` are proven. False until the first complete read. */
  known: boolean;
  seen: string[];
  cr: { h: string; at: string }[];
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
  /** 2 once exact review facts are recorded. Absent on a legacy snapshot. */
  v?: 2;
  repoName: string;
  defaultBranch: string;
  openPrCount: number;
  prs: NormalizedPr[];
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
        `${held} requested-changes fact(s) HELD and NOT sent: each cannot be told from a review the notification ` +
          'target already delivered (kept through a cancel; no clearing control; a required blocker)',
      );
    }
    // Pull requests whose review list is too long to prove: no new review of theirs can be told exactly.
    let truncated = 0;
    for (const w of this.store.githubWatches.listForOwner(this.ownerId, false, MAX_GITHUB_WATCHES_PER_OWNER)) {
      truncated += parseSnapshot(w.snapshotJson)?.prs.filter((pr) => pr.rf?.s === 'truncated').length ?? 0;
    }
    if (truncated > 0) {
      notes.push(
        `${truncated} pull request(s) have ${GITHUB_WATCH_REVIEW_FACTS_MAX} or more reviews: no new requested-changes ` +
          'review of theirs is told exactly (a capability limit and a required blocker)',
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
    // `prListAll` rather than `prList`: a merge is the disappearance of an open
    // pull request, and the open-only list could only ever report it as "gone".
    // Runs and issues are separate bounded reads; each is allowed to fail on its
    // own, because a repository with Actions disabled must not break the watch.
    const [view, prs] = await Promise.all([
      this.reader.repoView(ref),
      this.reader.prListAll(ref),
    ]);
    const { snapshot: normalized, createdAt } = await this.normalize(view, prs, ref, previous);
    const snapshotJson = canonicalJson(normalized);
    // A legacy snapshot is compared through its legacy projection ONLY, so the first observation after the
    // upgrade neither announces "changed" for an unchanged repository nor lets new metadata decide anything.
    // From then on the fingerprint covers every fact a line can render.
    const fingerprint = fingerprintOf(normalized, 'v2');
    const comparable = previous !== undefined && previous.v === undefined ? fingerprintOf(normalized, 'legacy') : fingerprint;
    const changed = watch.snapshotHash !== comparable;
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
      let rendered: Summary = { text: null, named: [], universe: [] };
      if (changed) {
        // The passes are bounded by EVERY transition the observation could name (before any cap or clamp),
        // not by what the first render happened to show: removing an item can reveal one a cap or the clamp
        // had hidden. Exclusion only removes from that finite set and every pass that goes round again
        // excluded at least one new key of it, so the loop always ends well inside the bound; a loop that
        // somehow did not would defer, never send a render nobody checked.
        let passes = 0;
        let limit = 0;
        for (;;) {
          rendered = summarizeChange(repo.slug, previous, normalized, { excluded, ...summaryContext });
          if (passes === 0) limit = rendered.universe.length + 1;
          let progressed = false;
          for (const c of rendered.named) {
            const key = transitionKey(c.t);
            const probe = ledger.probeNative(this.ownerId, repoKey, c.t, c.providerAt);
            if (probe === 'target_in_flight') return 'deferred' as const;
            if (excluded.has(key)) continue;
            if (probe === 'target_delivered') {
              excluded.add(key);
              progressed = true;
            } else if (probe === 'ambiguous') {
              excluded.add(key);
              // The text is stored with the row for the record and is NEVER sent: a held row is not pending work.
              held.set(key, {
                id: randomUUID(), heldKey: key, providerAt: c.providerAt,
                summary: `Held, not sent: a requested-changes review on #${c.t.item} cannot be told apart from one ` +
                  'the notification target already delivered.',
              });
              progressed = true;
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
        ...(changed && rendered.text !== null ? [{ id: summaryId, fingerprint, summary: rendered.text }] : []),
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
      return {
        number: pr.number,
        title: redact(pr.title).slice(0, 180),
        state: redact(pr.state).slice(0, 40),
        isDraft: pr.isDraft === true,
        headRefName: redact(pr.headRefName ?? '').slice(0, 180),
        updatedAt: pr.updatedAt ?? '',
        checks,
        headRefOid: redact(pr.headRefOid ?? reviews?.headRefOid ?? '').slice(0, 64),
        mergedAt: pr.mergedAt ?? reviews?.mergedAt ?? '',
        reviewDecision: redact(pr.reviewDecision ?? reviews?.reviewDecision ?? '').slice(0, 40),
        ...reviewFields,
        rf: deriveReviewFacts(reviews, old?.rf),
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

    return {
      snapshot: {
        v: 2,
        repoName: redact(view.name).slice(0, 180),
        defaultBranch: redact(view.defaultBranchRef?.name ?? 'unknown').slice(0, 180),
        // Only the ones still open: `prListAll` includes closed ones now.
        openPrCount: prs.filter((pr) => /open/i.test(pr.state)).length,
        prs: normalizedPrs,
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

function parseSnapshot(raw: string | null): NormalizedSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<NormalizedSnapshot>;
    if (!Array.isArray(candidate.prs)) return undefined;
    // Review facts are read back defensively: a value that is not exactly what this build writes is
    // dropped (the pull request is then "never proven"), never trusted and never repaired.
    const prs = candidate.prs.map((pr) => {
      const { rf, ...rest } = pr as NormalizedPr & { rf?: unknown };
      const clean = cleanReviewFacts(rf);
      return clean ? { ...rest, rf: clean } : rest;
    });
    return { ...(candidate as NormalizedSnapshot), prs };
  } catch {
    return undefined;
  }
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function cleanReviewFacts(raw: unknown): ReviewFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Partial<ReviewFacts>;
  if (r.s !== 'complete' && r.s !== 'unavailable' && r.s !== 'truncated') return undefined;
  if (typeof r.known !== 'boolean' || !Array.isArray(r.seen) || !Array.isArray(r.cr)) return undefined;
  if (r.seen.length > GITHUB_WATCH_REVIEW_FACTS_MAX || r.cr.length > GITHUB_WATCH_REVIEW_FACTS_MAX) return undefined;
  if (!r.seen.every((h) => typeof h === 'string' && HEX32.test(h))) return undefined;
  if (!r.cr.every((c) => c && typeof c.h === 'string' && HEX64.test(c.h) && canonicalStamp(c.at) === c.at)) return undefined;
  return { s: r.s, known: r.known, seen: [...r.seen], cr: r.cr.map((c) => ({ h: c.h, at: c.at })) };
}

/**
 * What a read of one pull request's `reviews` proves about its submitted requested-changes reviews.
 *
 * Only a COMPLETE read yields facts: it must have the list, it must be shorter than the bound (a full
 * list cannot be told from a cut-off one), and every requested-changes review in it must be identifiable.
 * A review still PENDING (a viewer's draft) or without a submission instant is not a submitted review and
 * is neither listed nor counted. Anything less carries the previous complete facts forward unchanged with
 * only the status moved: nothing unseen is absorbed, so a review that arrives during the gap is told when
 * a complete read returns.
 */
function deriveReviewFacts(
  reviews: Awaited<ReturnType<GitHubReader['prReviews']>> | undefined,
  previous: ReviewFacts | undefined,
): ReviewFacts {
  const carry = (s: ReviewFactStatus): ReviewFacts =>
    previous ? { ...previous, s } : { s, known: false, seen: [], cr: [] };
  const list = reviews?.reviews;
  if (!Array.isArray(list)) return carry('unavailable');
  if (list.length >= GITHUB_WATCH_REVIEW_FACTS_MAX) return carry('truncated');
  const seen = new Set<string>();
  const cr = new Map<string, string>();
  for (const r of list) {
    const state = (r.state ?? '').toUpperCase();
    const at = canonicalStamp(r.submittedAt);
    if (state === 'PENDING' || at === null) continue;
    const h = hashProviderRef(r.id);
    if (h === null) {
      // A requested change that cannot be identified makes the whole read unusable for exact facts;
      // any other review without an id cannot be a comparison baseline and is simply not one.
      if (state === 'CHANGES_REQUESTED') return carry('unavailable');
      continue;
    }
    seen.add(h.slice(0, 32));
    if (state === 'CHANGES_REQUESTED') cr.set(h, at);
  }
  return {
    s: 'complete',
    known: true,
    seen: [...seen].sort(),
    cr: [...cr].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([h, at]) => ({ h, at })),
  };
}

/**
 * The fingerprint of a snapshot. `legacy` is exactly what versions before exact review facts hashed (so an
 * unchanged repository hashes the same through an upgrade); `v2` adds what a line can now render (the
 * requested-changes reviews) and still leaves out the comparison metadata (how the last read went, the seen
 * set), which is not a fact the owner is told.
 */
function fingerprintOf(snapshot: NormalizedSnapshot, mode: 'legacy' | 'v2'): string {
  const { v: _version, prs, ...rest } = snapshot;
  const projected = mode === 'legacy'
    ? { ...rest, prs: prs.map(({ rf: _rf, ...pr }) => pr) }
    : { v: 2, ...rest, prs: prs.map(({ rf, ...pr }) => ({ ...pr, cr: rf?.cr ?? [] })) };
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
}

interface SummaryContext {
  /** Transition keys of items that must not be named: the target delivered them, or they are held. */
  readonly excluded?: ReadonlySet<string>;
  /**
   * The host instant before the read the previous snapshot came from STARTED; null when unknown (a legacy or
   * first observation, an unbound watch, after a failed read).
   */
  readonly boundaryMs: number | null;
  /** Canonical creation instants of the current list, by number. */
  readonly createdAt: ReadonlyMap<number, string>;
}

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
 * item the owner was actually shown. Three kinds of fact carry an exact identity:
 * - an update, only when the provider's `updatedAt` itself moved, and a merge by its merge instant (at most
 *   three of each are named);
 * - a requested-changes REVIEW, from the exact submitted-review list: only a review absent from the last
 *   complete set is new, its segment names the pull request, and the claim is the hash of the review's id;
 * - an OPENING, only when the pull request is absent from the previous snapshot AND was created after the
 *   instant the previous read started (plus the skew margin). That is a proof against a boundary, never an
 *   inference from the capped list, its order, a maximum or an equal second. Any other pull request that
 *   enters the list is "newly listed" and carries no opening claim.
 * The PR-level decisions (approved, changes requested by the aggregate decision) and every count stay
 * distinct facts with NO per-review claim: nothing here calls an old review new, or one decision a review.
 */
function summarizeChange(
  slug: string,
  previous: NormalizedSnapshot | undefined,
  current: NormalizedSnapshot,
  ctx: SummaryContext,
): Summary {
  const excluded = ctx.excluded ?? new Set<string>();
  if (!previous) {
    return {
      text: clampSummary(`Started watching \`${slug}\`: ${current.openPrCount} open pull request(s).`),
      named: [],
      universe: [],
    };
  }
  /** One line of the summary and the items it names, with where each item's text ENDS inside the line. */
  interface Part { text: string; items: { claims: NamedClaim[]; end: number }[] }
  const parts: Part[] = [];
  /** Joins named segments after a prefix and remembers where each one ends. */
  const named = (prefix: string, entries: { claims: NamedClaim[]; segment: string }[]): Part => {
    let text = prefix;
    const items: Part['items'] = [];
    entries.forEach((e, i) => {
      if (i > 0) text += '; ';
      text += e.segment;
      if (e.claims.length > 0) items.push({ claims: e.claims, end: text.length });
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

  // ---- proven openings: handled FIRST, because a proven opening is told once and not also as an update ----
  const openings = current.prs.filter((pr) => {
    if (before.has(pr.number) || ctx.boundaryMs === null) return false;
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
    const changedPr = !old || old.state !== pr.state || old.title !== pr.title || old.updatedAt !== pr.updatedAt ||
      canonicalJson(old.checks) !== canonicalJson(pr.checks) ||
      old.headRefOid !== pr.headRefOid;
    if (!changedPr) return false;
    const t = updateOf(pr);
    if (t !== null) universe.add(transitionKey(t));
    if (t !== null && excluded.has(transitionKey(t)) && onlyUpdatedAtMoved(pr)) {
      removed = true;
      return false;
    }
    return true;
  });
  const currentNumbers = new Set(current.prs.map((pr) => pr.number));
  // Absent from a capped, all-state snapshot: pushed out by newer pull requests or closed, which this
  // list cannot tell. It is "no longer listed", never "closed" and never an exact close.
  const gone = previous.prs.filter((pr) => !currentNumbers.has(pr.number));
  const failedChecks = current.prs.filter((pr) => pr.checks.some((check) => /fail|error|cancel/i.test(check)));
  if (newOrUpdated.length > 0) {
    const shown = newOrUpdated.slice(0, NATIVE_SUMMARY_NAMED_MAX);
    parts.push(named(
      `${newOrUpdated.length} pull request update(s): `,
      shown.map((pr) => ({
        claims: one(updateOf(pr)),
        // A pull request new to the snapshot that is not a PROVEN opening is only newly listed.
        segment: `#${pr.number} ${pr.title}${before.has(pr.number) ? '' : ' (newly listed)'}`,
      })),
    ));
  }
  if (gone.length > 0) {
    parts.push(plain(`${gone.length} previously listed pull request(s) are no longer listed (not necessarily closed)`));
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
  if (merged.length > 0) {
    const shown = merged.slice(0, NATIVE_SUMMARY_NAMED_MAX);
    parts.push(named(
      'merged: ',
      shown.map((pr) => ({ claims: one(mergedTransition(pr.number, pr.mergedAt)), segment: `#${pr.number} ${pr.title}` })),
    ));
  }

  // The PR-level approval decision. It names no review and claims none.
  const newlyApproved = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return /APPROVED/i.test(pr.reviewDecision ?? '') && !/APPROVED/i.test(old?.reviewDecision ?? '');
  });
  if (newlyApproved.length > 0) parts.push(plain(`approved: ${newlyApproved.map((pr) => `#${pr.number}`).join(', ')}`));

  // Exact requested-changes reviews: a review absent from the previous COMPLETE set, on a pull request
  // whose previous snapshot held one. Without that baseline nothing is inferred (silent establishment).
  const exact = new Map<number, { h: string; at: string }[]>();
  for (const pr of current.prs) {
    const old = before.get(pr.number);
    if (pr.rf?.s !== 'complete' || !old?.rf?.known) continue;
    const seen = new Set(old.rf.seen);
    const fresh = pr.rf.cr.filter((c) => !seen.has(c.h.slice(0, 32)));
    if (fresh.length > 0) exact.set(pr.number, fresh);
  }
  const exactEntries: { claims: NamedClaim[]; segment: string }[] = [];
  for (const [n, fresh] of [...exact].sort(([a], [b]) => a - b)) {
    const claims: NamedClaim[] = [];
    for (const c of fresh) {
      const t = reviewTransitionFromHash(n, c.h);
      if (t !== null) universe.add(transitionKey(t));
      if (t !== null && !excluded.has(transitionKey(t))) claims.push({ t, providerAt: c.at });
    }
    if (claims.length === 0) {
      removed = true;
      continue;
    }
    // One segment per pull request; every new review of it is claimed by that segment and only if the
    // whole segment is shown.
    exactEntries.push({ claims, segment: `#${n}` });
  }
  if (exactEntries.length > 0) parts.push(named('requested changes submitted on ', exactEntries));

  // The aggregate decision, a DISTINCT fact with no per-review claim. A pull request whose requested-changes
  // review is handled exactly above is not repeated here, whether that review was told, delivered by the
  // target or held.
  const newlyBlocked = current.prs.filter((pr) => {
    if (exact.has(pr.number)) return false;
    const old = before.get(pr.number);
    if (!isChangesRequested(pr)) return false;
    // A previous value that was never read is unknown, not "none": nothing is called new from it.
    return old === undefined || (old.latestChangeRequestAt !== undefined &&
      old.latestChangeRequestAt !== pr.latestChangeRequestAt);
  });
  if (newlyBlocked.length > 0) parts.push(plain(`changes requested on ${newlyBlocked.map((pr) => `#${pr.number}`).join(', ')}`));

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
  if (parts.length === 0 && removed) return { text: null, named: [], universe: [...universe] };
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
  let start = head.length;
  for (const p of parts) {
    for (const it of p.items) if (start + it.end <= shownLimit) claims.push(...it.claims);
    start += p.text.length + 2;
  }
  return { text: clampSummary(full), named: claims, universe: [...universe] };
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
