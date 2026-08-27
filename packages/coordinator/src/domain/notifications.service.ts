import type { JobState } from '@ducky/contracts';
import type { PendingNotificationRow, Store } from '@ducky/persistence';
import type { DiscordTransport } from '../discord/transport.js';
import type { OutboundEmbedField, OutboundMessage } from '../discord/message.js';

/**
 * States worth waking the owner up for. `queued` and `waiting_for_executor`
 * are not: they are either the immediate result of an owner action (already
 * answered synchronously) or not yet actionable.
 */
const NOTIFIABLE_STATES: ReadonlySet<JobState> = new Set([
  'running',
  'needs_owner_input',
  'needs_approval',
  'completed',
  'failed',
  'cancelled',
]);

const humanize = (s: string): string => s.replace(/_/g, ' ');

export interface JobNotifierDeps {
  readonly store: Store;
  readonly transport: DiscordTransport;
  readonly ownerId: string;
}

export interface NotificationSweepResult {
  readonly delivered: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * Delivers high-level job lifecycle updates to the owner's Discord DM.
 *
 * Reads only the durable job_transitions ledger that jobs.repo already writes
 * on every state change, plus (when one exists for the job) the already
 * sanitized `summary_redacted` column of job_results -- the same record of
 * truth `/job status` reads for interactive display. Never touches raw
 * executor output, workspace paths, task/context text, or job_events
 * messages. Whatever is sent still passes through `transport.send`, so the
 * same sanitizeOutbound boundary every other outbound message goes through
 * applies here too, as a second line of defense.
 *
 * Delivery is idempotent and retry-safe: a transition is marked delivered
 * only after the send resolves (or after being deliberately skipped), so an
 * interrupted sweep resumes exactly where it left off and never double-sends.
 * One job's failed send is isolated -- it does not stop the rest of the
 * batch, and it is retried on the next sweep rather than dropped.
 *
 * A sweep is also re-entrancy safe: `deliverPending` returns the SAME
 * in-flight promise if one is already running, rather than starting a second
 * pass over the same pending rows. Two overlapping sweeps would both read a
 * row as "not yet delivered" and could both send it before either marks it,
 * which would defeat the delivery ledger's idempotency guarantee even though
 * each sweep individually is correct.
 */
export class JobNotifier {
  private readonly store: Store;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;
  private sweeping: Promise<NotificationSweepResult> | null = null;

  constructor(deps: JobNotifierDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
  }

  deliverPending(limit = 50): Promise<NotificationSweepResult> {
    if (this.sweeping) return this.sweeping;
    const run = this.runSweep(limit).finally(() => {
      this.sweeping = null;
    });
    this.sweeping = run;
    return run;
  }

  /**
   * Resolves once any in-flight sweep has settled, without starting a new
   * one. Callers (shutdown) await this before closing the store so a sweep
   * already mid-write is never cut off underneath it.
   */
  async waitForIdle(): Promise<void> {
    if (this.sweeping) await this.sweeping.catch(() => undefined);
  }

  private async runSweep(limit: number): Promise<NotificationSweepResult> {
    const pending = this.store.notifications.pending(limit);
    let delivered = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of pending) {
      if (!this.shouldNotify(row)) {
        this.store.notifications.markDelivered(row.transitionId, row.jobId);
        skipped += 1;
        continue;
      }
      try {
        await this.transport.send({ userId: this.ownerId }, this.buildMessage(row));
        this.store.notifications.markDelivered(row.transitionId, row.jobId);
        delivered += 1;
      } catch {
        // Left undelivered on purpose: the next sweep retries this exact
        // transition. Do not mark it and do not let it stop the batch.
        failed += 1;
      }
    }
    return { delivered, skipped, failed };
  }

  /**
   * Owner-initiated transitions (cancel, answer, approve/reject) already got
   * a synchronous reply in the same request, so a DM would just be an echo.
   */
  private shouldNotify(row: PendingNotificationRow): boolean {
    if (row.actor.startsWith('owner:')) return false;
    return NOTIFIABLE_STATES.has(row.toState);
  }

  /**
   * Always targets the currently configured owner, never `row.discordUserId`.
   * Authorization in this codebase never reads the database (see AGENTS.md);
   * the frozen env config is the sole authority on who the owner is, so that
   * is who is DMed even if a historical row's stored id were ever stale.
   */
  private buildMessage(row: PendingNotificationRow): OutboundMessage {
    const fields: OutboundEmbedField[] = [{ name: 'Reason', value: humanize(row.reason) }];
    const result = this.store.results.byJobId(row.jobId);
    if (result) {
      fields.push({ name: 'Result', value: result.summaryRedacted });
    }
    return {
      embeds: [
        {
          title: `Job ${row.publicId}`,
          description: `${row.repoSlug} — ${humanize(row.toState)}`,
          fields,
        },
      ],
    };
  }
}
