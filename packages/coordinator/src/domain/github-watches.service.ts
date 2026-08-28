import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, DuckyError, GITHUB_WATCH_BATCH, GITHUB_WATCH_EVENT_BATCH,
  MAX_GITHUB_WATCHES_PER_OWNER,
  GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS, GITHUB_WATCH_MAX_PR_CHECKS,
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
}

interface NormalizedSnapshot {
  repoName: string;
  defaultBranch: string;
  openPrCount: number;
  prs: NormalizedPr[];
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
    const changed = this.store.githubWatches.cancel(actor.discordUserId, id, this.clock.nowIso());
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
      } catch {
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
    const [view, prs] = await Promise.all([
      this.reader.repoView(ref),
      this.reader.prList(ref),
    ]);
    const normalized = await this.normalize(view, prs, ref);
    const snapshotJson = canonicalJson(normalized);
    const fingerprint = createHash('sha256').update(snapshotJson).digest('hex');
    const previous = parseSnapshot(watch.snapshotJson);
    const changed = watch.snapshotHash !== fingerprint;
    const summary = changed ? summarizeChange(repo.slug, previous, normalized) : '';
    const nowMs = this.clock.nowMs();
    const nextCheckAt = new Date(nowMs + watch.intervalMinutes * 60_000).toISOString();

    const committed = withTransaction(this.store.db, () => this.store.githubWatches.observe({
      id: watch.id,
      expectedNextCheckAt: watch.nextCheckAt!,
      snapshotHash: fingerprint,
      snapshotJson,
      nextCheckAt,
      atIso: new Date(nowMs).toISOString(),
      changed,
      ...(changed
        ? { event: { id: randomUUID(), fingerprint, summary } }
        : {}),
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
      return {
        number: pr.number,
        title: redact(pr.title).slice(0, 180),
        state: redact(pr.state).slice(0, 40),
        isDraft: pr.isDraft === true,
        headRefName: redact(pr.headRefName ?? '').slice(0, 180),
        updatedAt: pr.updatedAt ?? '',
        checks,
      };
    }));
    return {
      repoName: redact(view.name).slice(0, 180),
      defaultBranch: redact(view.defaultBranchRef?.name ?? 'unknown').slice(0, 180),
      openPrCount: prs.length,
      prs: normalizedPrs,
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
      canonicalJson(old.checks) !== canonicalJson(pr.checks);
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
  if (parts.length === 0) parts.push('The repository snapshot changed.');
  return clampSummary(`Update for \`${slug}\`: ${parts.join('. ')}.`);
}

function clampSummary(value: string): string {
  const cleaned = redact(value);
  return cleaned.length <= GITHUB_WATCH_SUMMARY_MAX
    ? cleaned
    : `${cleaned.slice(0, GITHUB_WATCH_SUMMARY_MAX - 1)}…`;
}
