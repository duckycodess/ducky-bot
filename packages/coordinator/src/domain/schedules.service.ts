import { randomUUID } from 'node:crypto';
import { DuckyError, ScheduleDraftSchema, WEEKDAY_NAMES, type ScheduleDraft } from '@ducky/contracts';
import type { ScheduleExtractionProvider, ScheduleSource } from '@ducky/adapters';
import { withTransaction, type Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { PendingDraft, PendingScheduleStore } from './pending-schedules.js';

export interface SchedulesServiceDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly pending: PendingScheduleStore;
  readonly extractor: ScheduleExtractionProvider;
}

export type PreviewOutcome =
  | { kind: 'draft'; draft: PendingDraft }
  | { kind: 'empty' };

/**
 * Extraction produces a preview and NOTHING is persisted. The draft lives only
 * in the in-memory pending store until the owner explicitly confirms, at which
 * point the confirmed entries are written to `schedules` in one transaction.
 *
 * A restart discards pending previews on purpose: confirming an unknown draft
 * reports that it expired rather than reconstructing anything.
 */
export class SchedulesService {
  private readonly store: Store;
  private readonly authz: Authorizer;
  private readonly pending: PendingScheduleStore;
  private readonly extractor: ScheduleExtractionProvider;

  constructor(deps: SchedulesServiceDeps) {
    this.store = deps.store;
    this.authz = deps.authz;
    this.pending = deps.pending;
    this.extractor = deps.extractor;
  }

  get providerName(): string {
    return this.extractor.name;
  }

  get supportsBinary(): boolean {
    return this.extractor.supportsBinary;
  }

  async preview(actor: ActorContext, source: ScheduleSource): Promise<PreviewOutcome> {
    this.authz.requireOwner(actor);
    const entries = await this.extractor.extract(source);
    // Never fabricate: no candidates means no preview and no rows.
    if (entries.length === 0) return { kind: 'empty' };
    return { kind: 'draft', draft: this.pending.put(actor.discordUserId, entries, source.kind) };
  }

  /** The pending draft, so a correction can be pre-filled with what we parsed. */
  pendingDraft(actor: ActorContext, draftId: string): PendingDraft | undefined {
    this.authz.requireOwner(actor);
    return this.pending.get(draftId, actor.discordUserId);
  }

  /**
   * Re-parses corrected text through the same extractor as the original.
   *
   * Corrections go through validation rather than being written straight into
   * the draft, so an edit cannot introduce a value the extractor itself could
   * never have produced. Still nothing is persisted.
   */
  async correctFromText(actor: ActorContext, draftId: string, text: string): Promise<PendingDraft> {
    this.authz.requireOwner(actor);
    const existing = this.pending.get(draftId, actor.discordUserId);
    if (!existing) throw new DuckyError('extraction_expired', this.expiredMessage());

    const entries = await this.extractor.extract({ kind: existing.sourceKind, text });
    const updated = this.pending.replace(draftId, actor.discordUserId, entries);
    if (!updated) throw new DuckyError('extraction_expired', this.expiredMessage());
    return updated;
  }

  correct(actor: ActorContext, draftId: string, entries: ScheduleDraft): PendingDraft {
    this.authz.requireOwner(actor);
    const parsed = ScheduleDraftSchema.parse(entries);
    const updated = this.pending.replace(draftId, actor.discordUserId, parsed);
    if (!updated) throw new DuckyError('extraction_expired', this.expiredMessage());
    return updated;
  }

  confirm(actor: ActorContext, draftId: string): { saved: number } {
    this.authz.requireOwner(actor);
    const draft = this.pending.take(draftId, actor.discordUserId);
    if (!draft) throw new DuckyError('extraction_expired', this.expiredMessage());

    const saved = withTransaction(this.store.db, () =>
      this.store.schedules.insertMany(
        actor.discordUserId,
        draft.entries,
        draft.sourceKind,
        draft.entries.map(() => randomUUID()),
      ),
    );
    return { saved };
  }

  discard(actor: ActorContext, draftId: string): boolean {
    this.authz.requireOwner(actor);
    return this.pending.discard(draftId, actor.discordUserId);
  }

  list(actor: ActorContext, limit = 25): ReturnType<Store['schedules']['listForOwner']> {
    this.authz.requireOwner(actor);
    return this.store.schedules.listForOwner(actor.discordUserId, limit);
  }

  /**
   * Every schedule record the owner can delete, as a handle and a description:
   * confirmed one-off rows, weekly rules (including a replaced batch, which is
   * inert but still the owner's) and exceptions. Handles are the first eight
   * characters of the id; an ambiguous one is refused by `/forget`, not guessed.
   */
  listRecords(actor: ActorContext, limit = 25): { id: string; describes: string }[] {
    this.authz.requireOwner(actor);
    const owner = actor.discordUserId;
    const oneOff = this.store.schedules.listForOwner(owner, limit).map((row) => ({
      id: row.id.slice(0, 8),
      describes: `${row.startsAt} · ${row.title}`,
    }));
    const rules = this.store.scheduleRules.listAllRulesForOwner(owner, limit).map((r) => ({
      id: r.id.slice(0, 8),
      describes: `every ${WEEKDAY_NAMES[r.weekday]} ${r.startTime} · ${r.label}` +
        (r.active ? '' : ' (replaced batch)'),
    }));
    const exceptions = this.store.scheduleRules.listExceptionsForOwner(owner, limit).map((e) => ({
      id: e.id.slice(0, 8),
      describes: `${e.date} · ${e.kind} · ${e.courseCode ?? e.label ?? 'all classes'}`,
    }));
    return [...oneOff, ...rules, ...exceptions].slice(0, limit);
  }

  /**
   * Flips the weekly schedule back one batch: the active batch becomes replaced
   * and the most recently replaced one with a KNOWN replacement time becomes
   * active, which is the source's "roll back to the previous schedule".
   *
   * It changes state and deletes no row, touches no exception, and returns counts
   * only. A replaced batch whose order is unknown (or two stamped the same
   * instant) is never chosen: that is a refusal, not a guess. Owner-only, like
   * every other schedule control.
   *
   * NOTE: this is a SERVICE control. The owner-only command manifest was not
   * widened for it, so no Discord command reaches it yet; that missing control is
   * a named blocker in `docs/CURRENT_STATE.md`.
   */
  rollbackBatch(actor: ActorContext, atIso: string):
    | { readonly ok: true; readonly restoredRules: number; readonly replacedRules: number }
    | { readonly ok: false; readonly reason: 'nothing_to_restore' | 'order_unknown' } {
    this.authz.requireOwner(actor);
    return this.store.scheduleRules.rollbackBatch(actor.discordUserId, atIso);
  }

  private expiredMessage(): string {
    return 'This schedule preview expired (the assistant may have restarted). Send it again.';
  }
}
