import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, DuckyError, GITHUB_WATCH_BATCH, GITHUB_WATCH_EVENT_BATCH,
  isDuckyError,
  MAX_GITHUB_WATCHES_PER_OWNER,
  GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS, GITHUB_WATCH_MAX_FOLLOWUPS,
  GITHUB_WATCH_MAX_ISSUES, GITHUB_WATCH_MAX_PR_CHECKS, GITHUB_WATCH_MAX_RUNS,
  GITHUB_WATCH_SUMMARY_MAX, GitHubWatchAddInputSchema, newPublicWatchId,
  PublicWatchIdSchema,
  type PrChecks, type PrList, type RepoView,
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
    };

    for (const watch of due) {
      try {
        const changed = await this.observe(watch);
        result.observed += 1;
        if (changed) result.changed += 1;
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
        this.store.githubWatches.markEventDelivered(event.id, now);
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
    return result;
  }

  private async observe(watch: GitHubWatchRow): Promise<boolean> {
    const repo = this.allowlist.resolve(watch.repoSlug);
    if (!repo.github) throw new DuckyError('invalid_input', 'The watched repository has no GitHub mapping.');
    const ref = { owner: repo.github.owner, repo: repo.github.repo };
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
    const summary = changed ? summarizeChange(repo.slug, previous, normalized) : '';
    const nowMs = this.clock.nowMs();
    const nextCheckAt = new Date(nowMs + watch.intervalMinutes * 60_000).toISOString();

    // Follow-up proposals are enqueued whether or not the whole snapshot moved:
    // a review that asked for changes is worth proposing once even if nothing
    // else about the repository differs. The unique `(watch, fingerprint)` index
    // is what makes "once" true.
    const followUps = followUpProposals(repo.slug, normalized).map((f) => ({
      id: randomUUID(),
      fingerprint: f.fingerprint,
      summary: f.summary,
    }));

    const events = [
      ...(changed ? [{ id: randomUUID(), fingerprint, summary }] : []),
      ...followUps,
    ];

    const committed = withTransaction(this.store.db, () => this.store.githubWatches.observe({
      id: watch.id,
      expectedNextCheckAt: watch.nextCheckAt!,
      snapshotHash: fingerprint,
      snapshotJson,
      nextCheckAt,
      atIso: new Date(nowMs).toISOString(),
      changed,
      events,
    }));
    // `observe` reports whether the cursor CAS committed; the public tick
    // metric reports whether the snapshot itself changed.
    return committed && changed;
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
      if (!this.store.githubWatches.publicIdExists(id)) return id;
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

function summarizeChange(
  slug: string,
  previous: NormalizedSnapshot | undefined,
  current: NormalizedSnapshot,
): string {
  if (!previous) {
    return clampSummary(
      `Started watching \`${slug}\`: ${current.openPrCount} open pull request(s).`,
    );
  }
  const before = new Map(previous.prs.map((pr) => [pr.number, pr]));
  const newOrUpdated = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return !old || old.state !== pr.state || old.title !== pr.title || old.updatedAt !== pr.updatedAt ||
      canonicalJson(old.checks) !== canonicalJson(pr.checks) ||
      old.headRefOid !== pr.headRefOid;
  });
  const currentNumbers = new Set(current.prs.map((pr) => pr.number));
  const closed = previous.prs.filter((pr) => !currentNumbers.has(pr.number));
  const failedChecks = current.prs.filter((pr) => pr.checks.some((check) => /fail|error|cancel/i.test(check)));
  const parts: string[] = [];
  if (newOrUpdated.length > 0) {
    const names = newOrUpdated.slice(0, 3).map((pr) => `#${pr.number} ${pr.title}`).join('; ');
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
    return isSet(pr.mergedAt) && (!old || !isSet(old.mergedAt));
  });
  if (merged.length > 0) {
    parts.push(`merged: ${merged.slice(0, 3).map((pr) => `#${pr.number} ${pr.title}`).join('; ')}`);
  }

  const newlyApproved = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return /APPROVED/i.test(pr.reviewDecision ?? '') && !/APPROVED/i.test(old?.reviewDecision ?? '');
  });
  if (newlyApproved.length > 0) {
    parts.push(`approved: ${newlyApproved.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  const newlyBlocked = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return isChangesRequested(pr) &&
      (!old || old.latestChangeRequestAt !== pr.latestChangeRequestAt);
  });
  if (newlyBlocked.length > 0) {
    parts.push(`changes requested on ${newlyBlocked.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  const moreComments = current.prs.filter((pr) => {
    const old = before.get(pr.number);
    return (pr.reviewComments ?? 0) > (old?.reviewComments ?? 0);
  });
  if (moreComments.length > 0) {
    parts.push(`new review comment(s) on ${moreComments.map((pr) => `#${pr.number}`).join(', ')}`);
  }

  const runSummary = summarizeRuns(previous.runs ?? [], current.runs ?? []);
  if (runSummary) parts.push(runSummary);

  const issueSummary = summarizeIssues(previous.openIssues ?? [], current.openIssues ?? []);
  if (issueSummary) parts.push(issueSummary);

  if (parts.length === 0) parts.push('The repository snapshot changed.');
  return clampSummary(`Update for \`${slug}\`: ${parts.join('. ')}.`);
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
