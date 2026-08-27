import type { JobState } from '@ducky/contracts';
import type { PendingNotificationRow, Store } from '@ducky/persistence';
import type { DiscordTransport } from '../discord/transport.js';
import type { OutboundMessage } from '../discord/message.js';

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
 * Reads only the durable job_transitions ledger that jobs.repo already
 * writes on every state change -- never raw executor output, workspace
 * paths, task/context text, or job_events messages. What is sent is a fixed
 * shape (public job id, repo slug, state, a canned reason code), and it still
 * passes through `transport.send`, so the same sanitizeOutbound boundary
 * every other outbound message goes through applies here too.
 *
 * Delivery is idempotent and retry-safe: a transition is marked delivered
 * only after the send resolves (or after being deliberately skipped), so an
 * interrupted sweep resumes exactly where it left off and never double-sends.
 * One job's failed send is isolated -- it does not stop the rest of the batch,
 * and it is retried on the next sweep rather than dropped.
 */
export class JobNotifier {
  private readonly store: Store;
  private readonly transport: DiscordTransport;
  private readonly ownerId: string;

  constructor(deps: JobNotifierDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
  }

  async deliverPending(limit = 50): Promise<NotificationSweepResult> {
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
        await this.transport.send({ userId: this.ownerId }, buildMessage(row));
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
}

function buildMessage(row: PendingNotificationRow): OutboundMessage {
  return {
    embeds: [
      {
        title: `Job ${row.publicId}`,
        description: `${row.repoSlug} — ${humanize(row.toState)}`,
        fields: [{ name: 'Reason', value: humanize(row.reason) }],
      },
    ],
  };
}
