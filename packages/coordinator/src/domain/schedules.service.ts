import { randomUUID } from 'node:crypto';
import { DuckyError, ScheduleDraftSchema, type ScheduleDraft } from '@ducky/contracts';
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

  private expiredMessage(): string {
    return 'This schedule preview expired (the assistant may have restarted). Send it again.';
  }
}
