import { ownerNextStep, ownerStateLabel, type JobState } from '@ducky/contracts';
import type { NotificationTarget, PendingNotificationRow, Store } from '@ducky/persistence';
import type { ComponentSigner } from '../security/component-signing.js';
import type { DiscordTransport } from '../discord/transport.js';
import type { OutboundEmbedField, OutboundMessage, OutboundRow } from '../discord/message.js';
import { channelTarget, dmTarget } from '../discord/message.js';
import type { SharedChannelPolicy } from './shared-visibility.js';
import type { SharedJobsService } from './shared-jobs.service.js';
import { sharedJobNotification } from '../discord/shared-presenters.js';

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

/** Mirrors the `/job status` presenter's bound on how many pending actions get buttons. */
const MAX_APPROVAL_ROWS = 4;
const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const humanize = (s: string): string => s.replace(/_/g, ' ');

export interface JobNotifierDeps {
  readonly store: Store;
  readonly transport: DiscordTransport;
  readonly ownerId: string;
  readonly signer: ComponentSigner;
  /**
   * Omitting either disables shared-channel delivery entirely -- every
   * shared target is skipped and marked so, and only the owner DM is sent.
   * Failing closed here matters: a wiring mistake must lose visibility, never
   * publish something.
   */
  readonly sharedPolicy?: SharedChannelPolicy;
  readonly sharedJobs?: SharedJobsService;
}

export interface NotificationSweepResult {
  readonly delivered: number;
  readonly skipped: number;
  readonly failed: number;
  /** Per-target breakdown of `delivered`, so a test can prove each ran once. */
  readonly deliveredByTarget: Readonly<Record<NotificationTarget, number>>;
}

/**
 * Delivers job lifecycle updates to up to two independent places: the
 * owner's Discord DM, and -- when the job was submitted from a configured
 * shared channel and that channel is STILL configured -- a deliberately
 * coarser projection posted in that channel.
 *
 * The two are not variants of one message. The DM carries the private
 * detail and the signed controls; the shared post carries only
 * `SharedJobProjection`, built by `SharedJobsService` and rendered by a
 * presenter that accepts nothing else, so no owner-only field can reach a
 * channel even by mistake. They are also delivered independently: separate
 * ledger rows, separate retries, and a failure of one neither blocks nor
 * duplicates the other.
 *
 * Reads only the durable job_transitions ledger that jobs.repo already writes
 * on every state change, plus (when one exists for the job) the already
 * sanitized job_results row -- the same record of truth `/job status` reads
 * for interactive display. Never touches raw executor output, the result
 * snapshot's file list, workspace paths, task/context text, or job_events
 * messages. Whatever is sent still passes through `transport.send`, so the
 * same sanitizeOutbound boundary every other outbound message goes through
 * applies here too, as a second line of defense.
 *
 * `needs_owner_input` and `needs_approval` notifications carry the same
 * signed Discord components the interactive `/job status` presenter builds
 * (`ComponentSigner.sign`, the exact `job_answer` / `approve` / `reject`
 * kinds), so a click from this DM is verified by the router through the
 * IDENTICAL path as a click from an interactive reply -- there is no
 * DM-specific authorization logic. Approval buttons are built from a live
 * `store.approvals.forJob` read at send time, not from anything cached on the
 * transition row, so an approval already decided through another channel
 * before the sweep runs simply gets no button rather than a stale one.
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
  private readonly signer: ComponentSigner;
  private readonly sharedPolicy: SharedChannelPolicy | undefined;
  private readonly sharedJobs: SharedJobsService | undefined;
  private sweeping: Promise<NotificationSweepResult> | null = null;

  constructor(deps: JobNotifierDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.ownerId = deps.ownerId;
    this.signer = deps.signer;
    this.sharedPolicy = deps.sharedPolicy;
    this.sharedJobs = deps.sharedJobs;
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
    const deliveredByTarget: Record<NotificationTarget, number> = {
      owner_dm: 0,
      shared_channel: 0,
    };

    for (const row of pending) {
      // Each target is decided, sent and marked INDEPENDENTLY. A transition
      // owing both an owner DM and a shared-channel message has two ledger
      // rows, so one failing leaves exactly that one pending: the other is
      // neither re-sent nor lost.
      for (const target of this.outstandingTargets(row)) {
        const message = this.messageFor(row, target);
        if (!message) {
          // Deliberately skipped counts as delivered, or the sweep would
          // reconsider the same non-notifiable transition forever.
          this.store.notifications.markDelivered(row.transitionId, row.jobId, target.target);
          skipped += 1;
          continue;
        }
        try {
          await this.transport.send(message.to, message.body);
          this.store.notifications.markDelivered(row.transitionId, row.jobId, target.target);
          delivered += 1;
          deliveredByTarget[target.target] += 1;
        } catch {
          // Left undelivered on purpose: the next sweep retries this exact
          // (transition, target). Do not mark it, and do not let it stop the
          // rest of the batch or the other target.
          failed += 1;
        }
      }
    }
    return { delivered, skipped, failed, deliveredByTarget };
  }

  /** Only the targets this transition still owes something to. */
  private outstandingTargets(row: PendingNotificationRow): { target: NotificationTarget }[] {
    const out: { target: NotificationTarget }[] = [];
    if (!row.ownerDelivered) out.push({ target: 'owner_dm' });
    if (!row.sharedDelivered) out.push({ target: 'shared_channel' });
    return out;
  }

  private messageFor(
    row: PendingNotificationRow,
    target: { target: NotificationTarget },
  ): { to: ReturnType<typeof dmTarget>; body: OutboundMessage } | undefined {
    if (target.target === 'owner_dm') {
      if (!this.shouldNotifyOwner(row)) return undefined;
      return { to: dmTarget(this.ownerId), body: this.buildMessage(row) };
    }
    const channelId = this.shareableChannel(row);
    if (!channelId) return undefined;
    const body = this.buildSharedMessage(row, channelId);
    if (!body) return undefined;
    return { to: channelTarget(channelId), body };
  }

  /**
   * Owner-initiated transitions (cancel, answer, approve/reject) already got
   * a synchronous reply in the same request, so a DM would just be an echo.
   */
  private shouldNotifyOwner(row: PendingNotificationRow): boolean {
    if (row.actor.startsWith('owner:')) return false;
    return NOTIFIABLE_STATES.has(row.toState);
  }

  /**
   * The shared channel to post this transition to, or undefined.
   *
   * The stored id is NOT trusted on its own. It is re-checked against the
   * live, frozen configuration every time, so removing a channel from
   * `DUCKY_SHARED_CHANNEL_IDS` immediately stops updates for jobs that were
   * already submitted from it -- the same "configuration is the sole
   * authority, never the database" rule authorization follows.
   */
  private shareableChannel(row: PendingNotificationRow): string | undefined {
    if (!this.sharedPolicy || !this.sharedJobs) return undefined;
    const id = row.originSharedChannelId;
    if (!id || !this.sharedPolicy.has(id)) return undefined;
    return id;
  }

  /**
   * Unlike the owner DM, an owner-authored transition IS worth posting here:
   * the owner's own reply was ephemeral, so nobody in the channel saw it. A
   * job that vanishes from the channel the moment its owner cancels it is
   * exactly the confusion this milestone exists to remove.
   */
  private buildSharedMessage(
    row: PendingNotificationRow,
    channelId: string,
  ): OutboundMessage | undefined {
    if (!NOTIFIABLE_STATES.has(row.toState)) return undefined;
    try {
      // Scoped to the channel being posted to, which for a notification is by
      // definition the job's own origin -- so this is a consistency check
      // rather than a filter, and it goes through the SAME channel-scoped
      // read the interactive path uses. There is no unscoped lookup for a
      // future change to reach for.
      //
      // Reported as of THIS transition, not as the job stands now: a sweep
      // that runs after several transitions must post the sequence, not the
      // same current state several times over.
      const projection = this.sharedJobs?.detail(channelId, row.publicId, row.toState);
      return projection ? sharedJobNotification(projection) : undefined;
    } catch {
      // A job that cannot be projected has nothing safe to say about it.
      // Returning undefined marks the target skipped; letting the throw
      // escape would count as a failure and retry it forever.
      return undefined;
    }
  }

  /**
   * Always targets the currently configured owner, never `row.discordUserId`.
   * Authorization in this codebase never reads the database (see AGENTS.md);
   * the frozen env config is the sole authority on who the owner is, so that
   * is who is DMed even if a historical row's stored id were ever stale.
   */
  private buildMessage(row: PendingNotificationRow): OutboundMessage {
    const fields: OutboundEmbedField[] = [
      { name: 'What happens next', value: ownerNextStep(row.toState) },
      { name: 'Reason', value: humanize(row.reason) },
    ];
    const rows: OutboundRow[] = [];

    const result = this.store.results.byJobId(row.jobId);
    if (result) {
      fields.push({ name: 'Result', value: result.summaryRedacted });
      fields.push({ name: 'Verdict', value: humanize(result.verdict) });
    }

    if (row.toState === 'needs_owner_input') {
      this.addOwnerInputComponents(row, result, fields, rows);
    } else if (row.toState === 'needs_approval') {
      this.addApprovalComponents(row, fields, rows);
    }

    return {
      embeds: [
        {
          title: `Job ${row.publicId}`,
          // The plain-language label, not the raw state identifier. The
          // persisted state machine is unchanged; only the wording is.
          description: `${row.repoSlug} — ${ownerStateLabel(row.toState)}`,
          fields,
        },
      ],
      ...(rows.length > 0 ? { rows } : {}),
    };
  }

  /**
   * The question is already redacted and length-clamped at persist time
   * (`sanitizeResult` in result-intake.ts), the same guarantee `/job status`
   * relies on -- this reads the identical `job_results` snapshot, never raw
   * executor output.
   *
   * Only attached while the job is still actually awaiting an answer: a live
   * `store.jobs.byId` check, not anything cached on the transition row, so an
   * owner who already answered through another channel before this sweep ran
   * gets no button to click.
   */
  private addOwnerInputComponents(
    row: PendingNotificationRow,
    result: ReturnType<Store['results']['byJobId']>,
    fields: OutboundEmbedField[],
    rows: OutboundRow[],
  ): void {
    const job = this.store.jobs.byId(row.jobId);
    if (!job || job.state !== 'needs_owner_input') return;

    if (result?.snapshot.verdict === 'needs_owner_input') {
      fields.push({ name: 'Question', value: result.snapshot.question });
    }

    rows.push({
      buttons: [
        {
          customId: this.signer.sign({
            kind: 'job_answer',
            entityId: row.publicId,
            actorUserId: this.ownerId,
          }),
          label: 'Answer',
          style: 'primary',
        },
      ],
    });
  }

  /**
   * Mirrors the `/job status` presenter exactly: pending approvals only,
   * bounded to `MAX_APPROVAL_ROWS`, one row of Approve/Reject per action,
   * descriptions clamped the same way (`short(description, 100)`).
   *
   * `store.approvals.forJob` is a live read at send time. An approval decided
   * through the interactive path between the transition landing and this
   * sweep running simply is not 'pending' any more and gets no button --
   * there is nothing to unwind, the click-time re-check in
   * ApprovalsService.decide is what actually enforces staleness either way.
   */
  private addApprovalComponents(
    row: PendingNotificationRow,
    fields: OutboundEmbedField[],
    rows: OutboundRow[],
  ): void {
    const pending = this.store.approvals.forJob(row.jobId).filter((a) => a.state === 'pending');
    if (pending.length === 0) return;

    fields.push({
      name: 'Proposed actions',
      value: pending
        .slice(0, MAX_APPROVAL_ROWS)
        .map((a) => `• #${a.actionIndex + 1} ${a.actionKind}: ${short(a.description, 100)}`)
        .join('\n'),
    });

    rows.push(
      ...pending.slice(0, MAX_APPROVAL_ROWS).map((a) => ({
        buttons: (['approve', 'reject', 'approval_details'] as const).map((kind) => ({
          customId: this.signer.sign({ kind, entityId: a.id, actorUserId: this.ownerId }),
          label: `${kind === 'approval_details' ? 'details' : kind} #${a.actionIndex + 1}`,
          style: kind === 'approve'
            ? ('success' as const)
            : kind === 'reject'
              ? ('danger' as const)
              : ('primary' as const),
        })),
      })),
    );
  }
}
