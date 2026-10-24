import { randomUUID } from 'node:crypto';
import {
  BRIEFING_DELIVERY_BATCH, BRIEFING_MAX_DELIVERY_ATTEMPTS, BRIEFING_STALE_AFTER_MS,
  instantOfZonedWallClock, weekdayOfCivilDate, zonedDateKey, zonedParts,
  type ImportedPreferences,
} from '@ducky/contracts';
import type { BriefingSlotKind, Store, BriefingTarget } from '@ducky/persistence';
import { channelTarget, dmTarget, type SendTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { briefingMessage } from '../discord/assistant-presenters.js';
import type { OwnerClock } from './owner-clock.js';
import type { BriefingService } from './briefing.service.js';
import type { AssistantWatchService } from './assistant-watch.service.js';
import type { OwnerPreferencesService } from './owner-preferences.service.js';
import type { ActorContext } from '../security/authz.js';

/** How many times a briefing is rebuilt when an event its digest held drops out before the send. */
const DIGEST_RESERVE_ATTEMPTS = 3;

export interface BriefingScheduleConfig {
  /** OFF unless an operator says otherwise. A briefing is pushed, not pulled. */
  readonly enabled: boolean;
  /** Local wall-clock times in the owner's zone, `HH:MM`. */
  readonly morningAt: string;
  readonly eveningAt: string;
  /**
   * Where a briefing goes: the owner's DM, their configured briefing channel,
   * or both.
   *
   * `dm` is the default and is what every existing instance already does, so
   * an upgrade changes nothing. `channel` and `both` require
   * `DUCKY_*_BRIEFING_CHANNEL_ID`, refused at startup otherwise -- a briefing
   * configured to go somewhere that does not exist would fail once a day,
   * quietly, forever.
   */
  readonly delivery: BriefingDelivery;
  /** The configured briefing channel, when one is. */
  readonly channelId?: string | undefined;
  /**
   * True when the operator SET the slot time. An imported preference may replace
   * the documented default but never an explicit value: that disagreement is a
   * parity conflict the importer refuses, not something resolved here silently.
   */
  readonly morningExplicit?: boolean | undefined;
  readonly eveningExplicit?: boolean | undefined;
}

export interface BriefingNotifierDeps {
  readonly store: Store;
  readonly transport: DiscordTransport;
  /** Frozen configuration, never a stored row -- the rule authorization follows. */
  readonly ownerId: string;
  readonly clock: OwnerClock;
  readonly briefing: BriefingService;
  readonly config: BriefingScheduleConfig;
  /** Imported preferences, when the profile selected them. Never an authority. */
  readonly prefs?: OwnerPreferencesService | undefined;
  /** Settles the digest events a delivered briefing carried. */
  readonly watch?: AssistantWatchService | undefined;
}

export interface BriefingTickResult {
  /** Slots newly recorded as due. */
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly abandoned: number;
  /** Came due during an outage and is now describing a day that has passed. */
  readonly skippedStale: number;
}

/**
 * Pushes the morning and evening briefing to the owner's DM.
 *
 * The last piece of milestone 2B that was deferred, and it was deferred for a
 * real reason: a briefing is pulled, and pushing one needs a delivery time.
 * Now that it has one, everything else is deliberately NOT new:
 *
 * - the same durable-outbox architecture as reminders and job notifications --
 *   a row exists from the moment a slot comes due, a unique
 *   `(user, kind, day_key)` index makes recording delivery idempotent, one
 *   failure is isolated and retried on the next tick, and a row that fails
 *   enough times is ABANDONED as a record rather than retried forever;
 * - the same coordinator interval. No cron, no second scheduler, no per-slot
 *   timer, so a briefing is late by at most one `DUCKY_RECONCILE_INTERVAL_MS`;
 * - the same `BriefingService`, which holds no provider. Nothing in a pushed
 *   briefing can be generated, exactly as nothing in a pulled one can;
 * - the owner's DM and nowhere else. No shared policy is injected here and no
 *   channel branch exists, so DCStro's channel-role split has nothing to get
 *   wrong.
 *
 * ## One rule reminders do not have
 *
 * **A stale briefing is skipped, not delivered.** A reminder names a commitment
 * and is worth having late; a briefing is a summary OF A DAY, and yesterday
 * morning's briefing arriving this afternoon describes a day that has already
 * happened. Past `BRIEFING_STALE_AFTER_MS` the row is marked `skipped` -- kept
 * as a record, never silently dropped and never sent.
 */
export class BriefingNotifier {
  private readonly store: Store;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;
  private readonly clock: OwnerClock;
  private readonly briefing: BriefingService;
  private readonly config: BriefingScheduleConfig;
  private readonly prefs: OwnerPreferencesService | undefined;
  private readonly watch: AssistantWatchService | undefined;
  private ticking: Promise<BriefingTickResult> | null = null;

  constructor(deps: BriefingNotifierDeps) {
    this.prefs = deps.prefs;
    this.watch = deps.watch;
    this.store = deps.store;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.clock = deps.clock;
    this.briefing = deps.briefing;
    this.config = deps.config;
  }

  /** Where briefings land. Reported at boot and in `/status`. */
  get delivery(): BriefingDelivery {
    return this.config.delivery;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  tick(): Promise<BriefingTickResult> {
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

  private async runTick(): Promise<BriefingTickResult> {
    if (!this.config.enabled) {
      return { claimed: 0, delivered: 0, failed: 0, abandoned: 0, skippedStale: 0 };
    }
    const claimed = this.claimDueSlots();
    const sent = await this.deliverPending();
    return { claimed, ...sent };
  }

  /**
   * Records any slot whose local time has passed today, once.
   *
   * Nothing fires early: the slot's instant is computed from the owner's zone
   * and compared against now. Nothing fires twice: the unique index does that,
   * so two overlapping passes and a restart are the same as one pass.
   *
   * Only TODAY's slots are ever claimed. A day the host was off produces no row
   * at all -- there is no backfill, because a briefing for a day nobody was
   * there to read is not information, it is noise with a date on it.
   */
  claimDueSlots(): number {
    const nowMs = this.clock.nowMs();
    const tz = this.clock.timeZone;
    const dayKey = zonedDateKey(nowMs, tz);

    // Imported preferences narrow what the configuration allows, and replace a
    // documented default time; they never turn briefings ON (that is the
    // operator's flag) and never replace a time the operator set explicitly.
    const prefs = this.prefs?.effective();
    if (prefs && !prefs.weekendBriefings && weekdayOfCivilDate(dayKey) >= 5) return 0;

    let claimed = 0;
    for (const [kind, at] of this.slots(prefs)) {
      const dueMs = slotInstantMs(dayKey, at, tz);
      if (dueMs === undefined || dueMs > nowMs) continue;
      // One row PER TARGET. Two rows for `both`, so the DM and the channel
      // copy succeed, fail and retry independently -- a single row would mean
      // delivering one marked the slot done and the other was never sent.
      for (const target of this.targets()) {
        const wrote = this.store.briefings.claimSlot({
          id: randomUUID(),
          discordUserId: this.ownerId,
          kind,
          dayKey,
          target,
          dueAt: new Date(dueMs).toISOString(),
        });
        if (wrote) claimed += 1;
      }
    }
    return claimed;
  }

  /**
   * Sends what is outstanding to the owner's DM.
   *
   * The briefing is assembled at DELIVERY time, not at claim time, so it
   * describes the day as it actually stands when the owner reads it. It is also
   * why nothing is stored: there is no rendered snapshot to keep.
   */
  async deliverPending(limit = BRIEFING_DELIVERY_BATCH): Promise<Omit<BriefingTickResult, 'claimed'>> {
    const pending = this.store.briefings.pending(limit);
    let delivered = 0;
    let failed = 0;
    let abandoned = 0;
    let skippedStale = 0;
    const importedPrefs = this.prefs?.effective();

    for (const row of pending) {
      const nowIso = this.clock.nowIso();
      // The repository digest reserved for THIS send, so a failure can release exactly it.
      let reservedDigest: readonly string[] = [];

      // A row addressed to a DIFFERENT account than the configured owner is
      // never re-addressed to the new one: that would hand one person's day to
      // another. Retired visibly.
      if (row.discordUserId !== this.ownerId) {
        this.store.briefings.markSkipped(row.id, nowIso);
        skippedStale += 1;
        continue;
      }

      if (this.isStale(row, importedPrefs)) {
        this.store.briefings.markSkipped(row.id, nowIso);
        skippedStale += 1;
        continue;
      }

      try {
        const actor: ActorContext = { discordUserId: this.ownerId, role: 'owner' };
        // Captures and the repository digest are the owner's private imported data.
        // A copy bound for a channel never carries them: the channel's readers are
        // not something Ducky can check, and leaving the sections out is the
        // direction that cannot widen who sees them.
        let body = await this.briefing.assemble(actor, row.kind, {
          includePrivate: row.target === 'owner_dm',
        });
        // Only what can be told now goes into the briefing. The digest's items are reserved for this
        // one send (a native path that delivered one in the meantime settles it instead, one it
        // holds waits); if any item drops out the briefing is rebuilt around the rest, and what did
        // not go is carried forward to the next briefing rather than lost or sent twice.
        if (this.watch && body.github && body.github.eventIds.length > 0) {
          for (let attempt = 0; attempt < DIGEST_RESERVE_ATTEMPTS; attempt += 1) {
            const ids = body.github?.eventIds ?? [];
            const kept = this.watch.reserveDigest(ids);
            if (kept.length === ids.length) {
              reservedDigest = kept;
              break;
            }
            this.watch.releaseDigest(kept);
            body = await this.briefing.assemble(actor, row.kind, { includePrivate: row.target === 'owner_dm' });
            if (!body.github || body.github.eventIds.length === 0) break;
            if (attempt === DIGEST_RESERVE_ATTEMPTS - 1) body = { ...body, github: undefined };
          }
        }
        const to = this.targetFor(row.target);
        if (!to) {
          // The channel was configured when this row was claimed and is not
          // any more. Retired visibly rather than retried against nothing, and
          // never silently redirected to the DM: the owner chose where this
          // goes.
          this.store.briefings.markSkipped(row.id, nowIso);
          skippedStale += 1;
          // Nothing will be sent: the reservation made for this briefing goes, so the events are not
          // left looking like a send in flight.
          if (reservedDigest.length > 0) this.watch?.releaseDigest(reservedDigest);
          continue;
        }
        await this.transport.send(to, briefingMessage(body));
        this.store.briefings.markDelivered(row.id, nowIso);
        delivered += 1;
        reservedDigest = [];
        // The digest is settled only now, after it was SENT. Only the DM copy ever
        // carries it, so it is that copy's delivery that settles it; a channel copy
        // has no digest to settle and cannot hold the events open.
        if (body.github && body.github.eventIds.length > 0) {
          this.watch?.markDigested(body.github.eventIds);
        }
      } catch {
        // Nothing was sent (or the send failed): the reservation goes and the events stay pending.
        if (reservedDigest.length > 0) this.watch?.releaseDigest(reservedDigest);
        this.store.briefings.recordFailure(row.id, nowIso, BRIEFING_MAX_DELIVERY_ATTEMPTS);
        if (row.attempts + 1 >= BRIEFING_MAX_DELIVERY_ATTEMPTS) abandoned += 1;
        else failed += 1;
      }
    }
    return { delivered, failed, abandoned, skippedStale };
  }

  /**
   * Whether a pending briefing is too late to send.
   *
   * Natively a briefing is stale six hours after its slot. The source's rule, used
   * when the profile selects imported preferences, is different: a morning briefing
   * is due until the EVENING time has been reached (then it is recorded skipped,
   * never sent late as a morning greeting), an evening briefing is due until the
   * end of its day, and nothing survives into a later day.
   */
  private isStale(
    row: { readonly kind: 'morning' | 'evening'; readonly dayKey: string; readonly dueAt: string },
    prefs: ImportedPreferences | undefined,
  ): boolean {
    const nowMs = this.clock.nowMs();
    if (!prefs) {
      const dueMs = Date.parse(row.dueAt);
      return Number.isFinite(dueMs) && nowMs - dueMs > BRIEFING_STALE_AFTER_MS;
    }
    const tz = this.clock.timeZone;
    if (row.dayKey !== zonedDateKey(nowMs, tz)) return true;
    if (row.kind !== 'morning') return false;
    const eveningAt = !this.config.eveningExplicit ? prefs.eveningTime : this.config.eveningAt;
    const morningAt = !this.config.morningExplicit ? prefs.morningTime : this.config.morningAt;
    const eveningMs = slotInstantMs(row.dayKey, eveningAt, tz);
    const morningMs = slotInstantMs(row.dayKey, morningAt, tz);
    // "Due until the evening" only means something when the evening comes AFTER the
    // morning. If the configured times are not in that order (or unreadable) the rule
    // cannot be applied as the source meant it, and a morning briefing would be stale the
    // instant it was due; it then stays due until the end of its day.
    if (eveningMs === undefined || morningMs === undefined || eveningMs <= morningMs) return false;
    return nowMs >= eveningMs;
  }

  /** The slots that may fire today, and when, after preferences are applied. */
  private slots(prefs: ImportedPreferences | undefined): readonly (readonly ['morning' | 'evening', string])[] {
    const morningAt = !this.config.morningExplicit && prefs ? prefs.morningTime : this.config.morningAt;
    const eveningAt = !this.config.eveningExplicit && prefs ? prefs.eveningTime : this.config.eveningAt;
    const out: (readonly ['morning' | 'evening', string])[] = [];
    if (prefs?.morningEnabled ?? true) out.push(['morning', morningAt]);
    if (prefs?.eveningEnabled ?? true) out.push(['evening', eveningAt]);
    return out;
  }

  /** The targets a due slot is claimed for, from configuration. */
  private targets(): readonly BriefingTarget[] {
    switch (this.config.delivery) {
      case 'dm':
        return ['owner_dm'];
      case 'channel':
        return ['briefing_channel'];
      case 'both':
        return ['owner_dm', 'briefing_channel'];
    }
  }

  /** Where one recorded target actually sends, or undefined if it cannot. */
  private targetFor(target: BriefingTarget): SendTarget | undefined {
    if (target === 'owner_dm') return dmTarget(this.ownerId);
    const channelId = this.config.channelId;
    return channelId === undefined ? undefined : channelTarget(channelId);
  }
}

/** Where a briefing is delivered. */
export const BRIEFING_DELIVERY_MODES = ['dm', 'channel', 'both'] as const;
export type BriefingDelivery = (typeof BRIEFING_DELIVERY_MODES)[number];

/**
 * The instant a `HH:MM` local slot falls on for one civil day.
 *
 * Returns undefined for a malformed time rather than guessing one: a briefing
 * that fired at an hour nobody configured would be worse than none, and
 * configuration is validated at startup anyway.
 */
export function slotInstantMs(dayKey: string, at: string, timeZone: string): number | undefined {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const time = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!day || !time) return undefined;
  const [hour, minute] = [Number(time[1]), Number(time[2])];
  if (hour > 23 || minute > 59) return undefined;
  return instantOfZonedWallClock(
    timeZone, Number(day[1]), Number(day[2]), Number(day[3]), hour, minute,
  );
}

/** Validated at startup, so a typo fails at boot rather than at 07:00. */
export function assertValidSlotTime(at: string, variableName: string): string {
  const trimmed = at.trim();
  if (!/^\d{1,2}:\d{2}$/.test(trimmed)) {
    throw new Error(`${variableName} must be a local time as HH:MM (got ${JSON.stringify(at)}).`);
  }
  const [h, m] = trimmed.split(':').map(Number) as [number, number];
  if (h > 23 || m > 59) {
    throw new Error(`${variableName} is not a real time of day (${trimmed}).`);
  }
  return trimmed;
}

/** Exported for the tick's own diagnostics; keeps `zonedParts` in one place. */
export const localHour = (ms: number, tz: string): number => zonedParts(ms, tz).hour;

export type { BriefingSlotKind };
