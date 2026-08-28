import { randomUUID } from 'node:crypto';
import {
  BRIEFING_DELIVERY_BATCH, BRIEFING_MAX_DELIVERY_ATTEMPTS, BRIEFING_STALE_AFTER_MS,
  instantOfZonedWallClock, zonedDateKey, zonedParts,
} from '@ducky/contracts';
import type { BriefingSlotKind, Store } from '@ducky/persistence';
import { dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { briefingMessage } from '../discord/assistant-presenters.js';
import type { OwnerClock } from './owner-clock.js';
import type { BriefingService } from './briefing.service.js';
import type { ActorContext } from '../security/authz.js';

export interface BriefingScheduleConfig {
  /** OFF unless an operator says otherwise. A briefing is pushed, not pulled. */
  readonly enabled: boolean;
  /** Local wall-clock times in the owner's zone, `HH:MM`. */
  readonly morningAt: string;
  readonly eveningAt: string;
}

export interface BriefingNotifierDeps {
  readonly store: Store;
  readonly transport: DiscordTransport;
  /** Frozen configuration, never a stored row -- the rule authorization follows. */
  readonly ownerId: string;
  readonly clock: OwnerClock;
  readonly briefing: BriefingService;
  readonly config: BriefingScheduleConfig;
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
  private ticking: Promise<BriefingTickResult> | null = null;

  constructor(deps: BriefingNotifierDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.clock = deps.clock;
    this.briefing = deps.briefing;
    this.config = deps.config;
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

    let claimed = 0;
    for (const [kind, at] of [
      ['morning', this.config.morningAt],
      ['evening', this.config.eveningAt],
    ] as const) {
      const dueMs = slotInstantMs(dayKey, at, tz);
      if (dueMs === undefined || dueMs > nowMs) continue;
      const wrote = this.store.briefings.claimSlot({
        id: randomUUID(),
        discordUserId: this.ownerId,
        kind,
        dayKey,
        dueAt: new Date(dueMs).toISOString(),
      });
      if (wrote) claimed += 1;
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

    for (const row of pending) {
      const nowIso = this.clock.nowIso();

      // A row addressed to a DIFFERENT account than the configured owner is
      // never re-addressed to the new one: that would hand one person's day to
      // another. Retired visibly.
      if (row.discordUserId !== this.ownerId) {
        this.store.briefings.markSkipped(row.id, nowIso);
        skippedStale += 1;
        continue;
      }

      const dueMs = Date.parse(row.dueAt);
      if (Number.isFinite(dueMs) && this.clock.nowMs() - dueMs > BRIEFING_STALE_AFTER_MS) {
        this.store.briefings.markSkipped(row.id, nowIso);
        skippedStale += 1;
        continue;
      }

      try {
        const actor: ActorContext = { discordUserId: this.ownerId, role: 'owner' };
        const body = this.briefing.build(actor, row.kind);
        await this.transport.send(dmTarget(this.ownerId), briefingMessage(body));
        this.store.briefings.markDelivered(row.id, nowIso);
        delivered += 1;
      } catch {
        this.store.briefings.recordFailure(row.id, nowIso, BRIEFING_MAX_DELIVERY_ATTEMPTS);
        if (row.attempts + 1 >= BRIEFING_MAX_DELIVERY_ATTEMPTS) abandoned += 1;
        else failed += 1;
      }
    }
    return { delivered, failed, abandoned, skippedStale };
  }
}

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
