import { randomUUID } from 'node:crypto';
import {
  REMINDER_DELIVERY_BATCH, REMINDER_MATERIALIZE_BATCH, REMINDER_MAX_DELIVERY_ATTEMPTS,
  type ReminderState,
} from '@ducky/contracts';
import type { ReminderRow, Store } from '@ducky/persistence';
import { withTransaction } from '@ducky/persistence';
import { dmTarget } from '../discord/message.js';
import type { DiscordTransport } from '../discord/transport.js';
import { reminderDm } from '../discord/assistant-presenters.js';
import { isoOf, type OwnerClock } from './owner-clock.js';

export interface ReminderNotifierDeps {
  readonly store: Store;
  readonly transport: DiscordTransport;
  /**
   * The CONFIGURED owner. Read from frozen env configuration, never from a
   * stored row -- the same rule authorization follows.
   */
  readonly ownerId: string;
  readonly clock: OwnerClock;
}

export interface ReminderTickResult {
  /** Occurrences newly recorded as due. */
  readonly materialized: number;
  /** Occurrences successfully DMed. */
  readonly delivered: number;
  /** Sends that failed and will be retried on a later tick. */
  readonly failed: number;
  /** Occurrences retired without delivery: too many failures, or not ours to send. */
  readonly abandoned: number;
}

/**
 * Turns due reminders into delivered DMs.
 *
 * It is the SAME architecture the job notifier uses, not a second one:
 *
 * - a durable ledger row per delivery (`reminder_occurrences`) rather than an
 *   in-memory timer, so a restart mid-outage loses nothing;
 * - a unique key that makes recording a delivery idempotent, so a retried or
 *   overlapping sweep cannot double-send;
 * - one failure isolated from the rest of the batch, retried on the next
 *   sweep rather than dropped or allowed to stall the queue;
 * - the same `transport.send` egress choke point, so `sanitizeOutbound` runs
 *   over reminder text exactly as it does over everything else;
 * - a re-entrancy guard, because two overlapping sweeps would both read a row
 *   as undelivered.
 *
 * It runs on the coordinator's EXISTING interval. There is no second
 * scheduler, no cron and no per-reminder timer, so the worst-case lateness of
 * a reminder is one reconcile interval and is bounded by configuration rather
 * than by how many reminders exist.
 *
 * ## Missed-reminder policy (conservative, and deliberate)
 *
 * When the host has been off, every rule below is chosen to prefer "one
 * honest, late message" over both "a storm of messages" and "silence":
 *
 * 1. **At most one message per reminder per tick.** However long the outage,
 *    a repeating reminder produces ONE occurrence, standing for the most
 *    recent slot that came due.
 * 2. **Skipped occurrences are counted, never invented and never hidden.**
 *    The collapsed slots are recorded as `missed_count` on that occurrence and
 *    named in the message ("4 earlier occurrences were missed").
 * 3. **A late reminder is still delivered.** It is never dropped for being
 *    stale; the Discord relative timestamp says plainly how late it is.
 * 4. **Nothing fires early.** An occurrence is materialized only once its
 *    scheduled instant has actually passed.
 * 5. **The recurrence advances exactly once.** Materializing an occurrence and
 *    moving the cursor happen in one transaction guarded by a compare-and-set
 *    on the fired count, so a repeated tick advances nothing a second time.
 * 6. **Delivery gives up loudly, not silently.** After
 *    `REMINDER_MAX_DELIVERY_ATTEMPTS` failures an occurrence is marked
 *    abandoned and stays in the ledger as a record. It is never deleted and
 *    never retried forever.
 */
export class ReminderNotifier {
  private readonly store: Store;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;
  private readonly clock: OwnerClock;
  private ticking: Promise<ReminderTickResult> | null = null;

  constructor(deps: ReminderNotifierDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.clock = deps.clock;
  }

  /**
   * One pass: record what has come due, then deliver what is outstanding.
   *
   * Returns the SAME in-flight promise if a pass is already running. Two
   * overlapping passes would both read an occurrence as undelivered and could
   * both send it, which would defeat the ledger's whole purpose.
   */
  tick(): Promise<ReminderTickResult> {
    if (this.ticking) return this.ticking;
    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  /** Settles any in-flight pass without starting a new one. Used by shutdown. */
  async waitForIdle(): Promise<void> {
    if (this.ticking) await this.ticking.catch(() => undefined);
  }

  private async runTick(): Promise<ReminderTickResult> {
    const materialized = this.materializeDue();
    const sent = await this.deliverPending();
    return { materialized, ...sent };
  }

  /**
   * Records every reminder that has come due, and advances each one past what
   * it recorded. Synchronous and transactional; it touches no network.
   */
  materializeDue(limit = REMINDER_MATERIALIZE_BATCH): number {
    const nowMs = this.clock.nowMs();
    const nowIso = isoOf(nowMs);
    const due = this.store.reminders.dueForMaterialization(nowIso, limit);

    let count = 0;
    for (const reminder of due) {
      const plan = planOccurrence(reminder, nowMs);
      if (!plan) continue;
      // One transaction per reminder: a reminder whose write fails leaves
      // every other one already recorded, and is simply retried next tick.
      const wrote = withTransaction(this.store.db, () =>
        this.store.reminders.materializeOccurrence({
          occurrenceId: randomUUID(),
          reminderId: reminder.id,
          expectedFiredCount: reminder.firedCount,
          occurrenceNo: plan.occurrenceNo,
          scheduledFor: isoOf(plan.scheduledForMs),
          missedCount: plan.missedCount,
          nextFireAt: plan.nextFireAtMs === null ? null : isoOf(plan.nextFireAtMs),
          status: plan.status,
          atIso: nowIso,
        }),
      );
      if (wrote) count += 1;
    }
    return count;
  }

  /**
   * Sends outstanding occurrences to the owner's DM.
   *
   * The target is ALWAYS the owner's DM. There is no channel branch here at
   * all: a reminder is personal data with no safe shared projection, so the
   * only way one could reach a channel would be for somebody to add a branch
   * that does not exist.
   */
  async deliverPending(limit = REMINDER_DELIVERY_BATCH): Promise<Omit<ReminderTickResult, 'materialized'>> {
    const pending = this.store.reminders.pendingOccurrences(limit);
    let delivered = 0;
    let failed = 0;
    let abandoned = 0;

    for (const row of pending) {
      const nowIso = this.clock.nowIso();

      // A reminder created by a DIFFERENT account than the one currently
      // configured as owner is never re-addressed to the new owner: that
      // would hand one person's private reminder to another. It is abandoned
      // in the ledger, visibly, rather than delivered or silently dropped.
      if (row.discordUserId !== this.ownerId) {
        this.store.reminders.recordOccurrenceFailure(row.occurrenceId, nowIso, 0);
        abandoned += 1;
        continue;
      }

      try {
        await this.transport.send(dmTarget(this.ownerId), reminderDm(row, this.clock.timeZone));
        this.store.reminders.markOccurrenceDelivered(row.occurrenceId, nowIso);
        delivered += 1;
      } catch {
        // Left undelivered on purpose: the next tick retries this exact
        // occurrence. One failure never stops the rest of the batch.
        this.store.reminders.recordOccurrenceFailure(
          row.occurrenceId,
          nowIso,
          REMINDER_MAX_DELIVERY_ATTEMPTS,
        );
        if (row.attempts + 1 >= REMINDER_MAX_DELIVERY_ATTEMPTS) abandoned += 1;
        else failed += 1;
      }
    }
    return { delivered, failed, abandoned };
  }
}

interface OccurrencePlan {
  readonly occurrenceNo: number;
  readonly scheduledForMs: number;
  readonly missedCount: number;
  readonly nextFireAtMs: number | null;
  readonly status: ReminderState;
}

/**
 * What a due reminder owes right now.
 *
 * Pure and clock-injected, so every branch -- a single overdue occurrence, a
 * long outage collapsing several, the final occurrence of a bounded series --
 * is testable without waiting for real time.
 *
 * The collapse in `elapsed` is rule 1 of the missed-reminder policy: however
 * many slots went by, exactly one occurrence is produced, standing for the
 * most recent one, and the rest are counted into `missedCount`.
 */
export function planOccurrence(reminder: ReminderRow, nowMs: number): OccurrencePlan | undefined {
  if (reminder.status !== 'scheduled' || reminder.nextFireAt === null) return undefined;
  const nextMs = Date.parse(reminder.nextFireAt);
  if (Number.isNaN(nextMs) || nextMs > nowMs) return undefined;

  const remaining = reminder.maxOccurrences - reminder.firedCount;
  if (remaining <= 0) return undefined;

  const intervalMs =
    reminder.recurrenceKind === 'interval' && reminder.intervalMinutes
      ? reminder.intervalMinutes * 60_000
      : 0;

  // How many slots have come due, including this one. A one-shot (or a
  // malformed interval) is always exactly one.
  const elapsed = intervalMs > 0 ? Math.floor((nowMs - nextMs) / intervalMs) + 1 : 1;
  const dueNow = Math.min(elapsed, remaining);

  const occurrenceNo = reminder.firedCount + dueNow;
  const scheduledForMs = nextMs + (dueNow - 1) * intervalMs;
  const exhausted = occurrenceNo >= reminder.maxOccurrences || intervalMs === 0;

  return {
    occurrenceNo,
    scheduledForMs,
    missedCount: dueNow - 1,
    nextFireAtMs: exhausted ? null : nextMs + dueNow * intervalMs,
    status: exhausted ? 'completed' : 'scheduled',
  };
}
