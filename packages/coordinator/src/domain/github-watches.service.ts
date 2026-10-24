import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, DuckyError, GITHUB_WATCH_BATCH, GITHUB_WATCH_EVENT_BATCH,
  isDuckyError,
  MAX_GITHUB_WATCHES_PER_OWNER,
  GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS, GITHUB_WATCH_MAX_FOLLOWUPS,
  GITHUB_WATCH_MAX_ISSUES, GITHUB_WATCH_MAX_PR_CHECKS, GITHUB_WATCH_MAX_RUNS,
  GITHUB_WATCH_SUMMARY_MAX, GitHubWatchAddInputSchema, newPublicWatchId,
  PublicWatchIdSchema, NATIVE_SUMMARY_NAMED_MAX, mergedTransition, transitionKey, transitionRepoKey,
  updatedTransition, type PrChecks, type PrList, type RepoView, type Transition,
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
    // `prListAll` rather than `prList`: a merge is the disappearance of an open
    // pull request, and the open-only list could only ever report it as "gone".
    // Runs and issues are separate bounded reads; each is allowed to fail on its
    // own, because a repository with Actions disabled must not break the watch.
    const [view, prs] = await Promise.all([
      this.reader.repoView(ref),
      this.reader.prListAll(ref),
    ]);
    const normalized = await this.normalize(view, prs, ref);
    const snapshotJson = canonicalJson(normalized);
    const fingerprint = createHash('sha256').update(snapshotJson).digest('hex');
    const previous = parseSnapshot(watch.snapshotJson);
    const changed = watch.snapshotHash !== fingerprint;
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
      // send is in flight for is told by neither: the whole observation waits, unchanged.
      const excluded = new Set<string>();
      let rendered: Summary = { text: null, named: [] };
      if (changed) {
        for (let i = 0; i <= GITHUB_WATCH_MAX_PR_CHECKS * 2 + 2; i += 1) {
          rendered = summarizeChange(repo.slug, previous, normalized, excluded);
          let again = false;
          for (const t of rendered.named) {
            const probe = ledger.probeNative(this.ownerId, repoKey, t);
            if (probe === 'target_in_flight') return 'deferred' as const;
            if (probe === 'target_delivered') {
              excluded.add(transitionKey(t));
              again = true;
            }
          }
          if (!again) break;
        }
      }
      const summaryId = randomUUID();
      const events = [
        // `text === null`: everything that changed was an item an imported target delivered.
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
      });
      if (!committed) return 'lost' as const;
      // The named items are reserved with the outbox row that will tell them. INSERT OR IGNORE
      // keeps the first owner; a fingerprint that already had an outbox row reserves nothing new.
      if (events.some((e) => e.id === summaryId)) {
        const stored = this.store.db
          .prepare('SELECT id FROM github_watch_events WHERE id = ?')
          .get(summaryId) as { id: string } | undefined;
        if (stored) {
          for (const t of rendered.named) ledger.reserveNative(this.ownerId, repoKey, t, 'watch_summary', summaryId, atIso, atIso);
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
  ): Promise<NormalizedSnapshot> {
    const selected = prs.slice(0, GITHUB_WATCH_MAX_PR_CHECKS);
    const normalizedPrs = await Promise.all(selected.map(async (pr) => {
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
      const latest = reviews?.latestReviews ?? [];
      const changeRequests = latest.filter((r) => /CHANGES_REQUESTED/i.test(r.state ?? ''));
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
        approvals: latest.filter((r) => /APPROVED/i.test(r.state ?? '')).length,
        changesRequested: changeRequests.length,
        reviewComments: reviews?.comments?.length ?? 0,
        commits: reviews?.commits?.length ?? 0,
        latestChangeRequestAt: changeRequests
          .map((r) => r.submittedAt ?? '')
          .sort()
          .at(-1) ?? '',
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
      repoName: redact(view.name).slice(0, 180),
      defaultBranch: redact(view.defaultBranchRef?.name ?? 'unknown').slice(0, 180),
      // Only the ones still open: `prListAll` includes closed ones now.
      openPrCount: prs.filter((pr) => /open/i.test(pr.state)).length,
      prs: normalizedPrs,
      runs,
      openIssues,
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
    return candidate as NormalizedSnapshot;
  } catch {
    return undefined;
  }
}

function normalizeChecks(checks: PrChecks): string[] {
  return checks
    .map((check) => `${redact(check.name).slice(0, 80)}:${redact(check.bucket ?? check.state ?? 'unknown').slice(0, 40)}`)
    .sort();
}

/** A rendered summary and the exact items its text NAMES (never a count, never an unnamed aggregate). */
interface Summary {
  readonly text: string | null;
  readonly named: readonly Transition[];
}

/**
 * What changed, in words, and which items the words actually name.
 *
 * `excluded` holds the transition keys of items an imported target has already DELIVERED; those
 * items are left out of the lines that name them and the summary is built around the rest. Nothing
 * else is left out: a count, an aggregate or an unnamed piece is never dropped on the theory that
 * an imported target will eventually tell it, because there is no promise to rely on. `text` is
 * null only when removing delivered items left nothing to say.
 *
 * The named items come from the SAME slices the text is written from, so a receipt can only exist
 * for an item the owner was actually shown: at most three pull request updates and three merges.
 * An update is named only when the provider's `updatedAt` itself moved (a check flipping on the
 * head names the pull request but is not that update), and a pull request new to the snapshot is
 * not an "opened" receipt (the list is capped; its absence before proves nothing about creation).
 */
function summarizeChange(
  slug: string,
  previous: NormalizedSnapshot | undefined,
  current: NormalizedSnapshot,
  excluded: ReadonlySet<string> = new Set(),
): Summary {
  if (!previous) {
    return {
      text: clampSummary(`Started watching \`${slug}\`: ${current.openPrCount} open pull request(s).`),
      named: [],
    };
  }
  const named: Transition[] = [];
  let removed = false;
  const before = new Map(previous.prs.map((pr) => [pr.number, pr]));
  const updateOf = (pr: NormalizedPr): Transition | null => {
    const old = before.get(pr.number);
    return old !== undefined && old.updatedAt !== pr.updatedAt ? updatedTransition(pr.number, pr.updatedAt) : null;
  };
  const onlyUpdatedAtMoved = (pr: NormalizedPr): boolean => {
    const old = before.get(pr.number);
    return old !== undefined && canonicalJson(old.checks) === canonicalJson(pr.checks) &&
      old.headRefOid === pr.headRefOid;
  };
  const newOrUpdated = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    const changedPr = !old || old.state !== pr.state || old.title !== pr.title || old.updatedAt !== pr.updatedAt ||
      canonicalJson(old.checks) !== canonicalJson(pr.checks) ||
      old.headRefOid !== pr.headRefOid;
    if (!changedPr) return false;
    const t = updateOf(pr);
    if (t !== null && excluded.has(transitionKey(t)) && onlyUpdatedAtMoved(pr)) {
      removed = true;
      return false;
    }
    return true;
  });
  const currentNumbers = new Set(current.prs.map((pr) => pr.number));
  const closed = previous.prs.filter((pr) => !currentNumbers.has(pr.number));
  const failedChecks = current.prs.filter((pr) => pr.checks.some((check) => /fail|error|cancel/i.test(check)));
  const parts: string[] = [];
  if (newOrUpdated.length > 0) {
    const shown = newOrUpdated.slice(0, NATIVE_SUMMARY_NAMED_MAX);
    for (const pr of shown) {
      const t = updateOf(pr);
      if (t !== null) named.push(t);
    }
    const names = shown.map((pr) => `#${pr.number} ${pr.title}`).join('; ');
    parts.push(`${newOrUpdated.length} pull request update(s): ${names}`);
  }
  if (closed.length > 0) parts.push(`${closed.length} previously listed pull request(s) are no longer open`);
  if (failedChecks.length > 0) parts.push(`${failedChecks.length} pull request(s) have failing checks`);

  // ---- what the wider surface added -------------------------------------
  //
  // Each of these compares the SAME normalized fields the fingerprint is built
  // from, so a line can only appear when something the snapshot records actually
  // moved. Nothing here fetches anything.
  const merged = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    if (!(isSet(pr.mergedAt) && (!old || !isSet(old.mergedAt)))) return false;
    const t = mergedTransition(pr.number, pr.mergedAt);
    if (t !== null && excluded.has(transitionKey(t))) {
      removed = true;
      return false;
    }
    return true;
  });
  if (merged.length > 0) {
    const shown = merged.slice(0, NATIVE_SUMMARY_NAMED_MAX);
    for (const pr of shown) {
      const t = mergedTransition(pr.number, pr.mergedAt);
      if (t !== null) named.push(t);
    }
    parts.push(`merged: ${shown.map((pr) => `#${pr.number} ${pr.title}`).join('; ')}`);
  }

  const newlyApproved = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return /APPROVED/i.test(pr.reviewDecision ?? '') && !/APPROVED/i.test(old?.reviewDecision ?? '');
  });
  if (newlyApproved.length > 0) parts.push(`approved: ${newlyApproved.map((pr) => `#${pr.number}`).join(', ')}`);

  const newlyBlocked = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return isChangesRequested(pr) &&
      (!old || old.latestChangeRequestAt !== pr.latestChangeRequestAt);
  });
  if (newlyBlocked.length > 0) parts.push(`changes requested on ${newlyBlocked.map((pr) => `#${pr.number}`).join(', ')}`);

  const moreComments = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return (pr.reviewComments ?? 0) > (old?.reviewComments ?? 0);
  });
  if (moreComments.length > 0) parts.push(`new review comment(s) on ${moreComments.map((pr) => `#${pr.number}`).join(', ')}`);

  const runSummary = summarizeRuns(previous.runs ?? [], current.runs ?? []);
  if (runSummary) parts.push(runSummary);

  const issueSummary = summarizeIssues(previous.openIssues ?? [], current.openIssues ?? []);
  if (issueSummary) parts.push(issueSummary);

  // Only items an imported target DELIVERED were taken out, and nothing remains to say.
  if (parts.length === 0 && removed) return { text: null, named: [] };
  if (parts.length === 0) parts.push('The repository snapshot changed.');
  return { text: clampSummary(`Update for \`${slug}\`: ${parts.join('. ')}.`), named };
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
