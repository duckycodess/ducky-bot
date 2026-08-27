import { randomUUID } from 'node:crypto';
import {
  MAX_PENDING_DRAFTS_PER_OWNER, PENDING_SCHEDULE_TTL_MS, type ScheduleDraft,
} from '@ducky/contracts';

export interface PendingDraft {
  readonly draftId: string;
  readonly ownerUserId: string;
  readonly sourceKind: 'text' | 'file';
  readonly entries: ScheduleDraft;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Pending schedule previews live here and NOWHERE else.
 *
 * No extracted content reaches SQLite, Discord logs, or disk before the owner
 * explicitly confirms. A restart therefore loses pending previews by design:
 * the confirm handler reports that the preview expired rather than
 * reconstructing anything.
 */
export class PendingScheduleStore {
  readonly #byId = new Map<string, PendingDraft>();

  constructor(
    private readonly ttlMs = PENDING_SCHEDULE_TTL_MS,
    private readonly maxPerOwner = MAX_PENDING_DRAFTS_PER_OWNER,
    private readonly now: () => number = () => Date.now(),
  ) {}

  put(ownerUserId: string, entries: ScheduleDraft, sourceKind: 'text' | 'file'): PendingDraft {
    this.sweep();
    const mine = [...this.#byId.values()].filter((d) => d.ownerUserId === ownerUserId);
    while (mine.length >= this.maxPerOwner) {
      const oldest = mine.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      this.#byId.delete(oldest.draftId);
      mine.splice(mine.indexOf(oldest), 1);
    }
    const createdAt = this.now();
    const draft: PendingDraft = {
      draftId: randomUUID(),
      ownerUserId,
      sourceKind,
      entries,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.#byId.set(draft.draftId, draft);
    return draft;
  }

  /** Scoped by owner: a draft is only visible to the actor who created it. */
  get(draftId: string, ownerUserId: string): PendingDraft | undefined {
    this.sweep();
    const d = this.#byId.get(draftId);
    if (!d || d.ownerUserId !== ownerUserId) return undefined;
    return d;
  }

  replace(draftId: string, ownerUserId: string, entries: ScheduleDraft): PendingDraft | undefined {
    const existing = this.get(draftId, ownerUserId);
    if (!existing) return undefined;
    const updated: PendingDraft = { ...existing, entries };
    this.#byId.set(draftId, updated);
    return updated;
  }

  take(draftId: string, ownerUserId: string): PendingDraft | undefined {
    const d = this.get(draftId, ownerUserId);
    if (d) this.#byId.delete(draftId);
    return d;
  }

  discard(draftId: string, ownerUserId: string): boolean {
    return this.get(draftId, ownerUserId) !== undefined && this.#byId.delete(draftId);
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, d] of this.#byId) {
      if (d.expiresAt <= now) {
        this.#byId.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#byId.size;
  }
}
