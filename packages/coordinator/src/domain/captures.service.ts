import { randomUUID } from 'node:crypto';
import { CaptureInputSchema, DuckyError, INBOX_PAGE_SIZE, type CaptureState } from '@ducky/contracts';
import type { CaptureRow, Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';

/**
 * Captures and the inbox are private personal data. Every method here is
 * owner-only, and every row access additionally re-checks row ownership. The
 * chat whitelist can never reach any of it.
 */
export class CapturesService {
  constructor(
    private readonly store: Store,
    private readonly authz: Authorizer,
  ) {}

  create(actor: ActorContext, content: string): CaptureRow {
    this.authz.requireOwner(actor);
    const parsed = CaptureInputSchema.parse({ content });
    return this.store.captures.insert({
      id: randomUUID(),
      discordUserId: actor.discordUserId,
      content: parsed.content,
    });
  }

  list(actor: ActorContext, status: CaptureState | 'all' = 'open', page = 0): CaptureRow[] {
    this.authz.requireOwner(actor);
    return this.store.captures.listForOwner(
      actor.discordUserId,
      status,
      INBOX_PAGE_SIZE,
      page * INBOX_PAGE_SIZE,
    );
  }

  setStatus(actor: ActorContext, id: string, status: CaptureState): CaptureRow {
    this.authz.requireOwner(actor);
    const row = this.owned(actor, id);
    this.store.captures.setStatus(row.id, status);
    return this.store.captures.get(row.id)!;
  }

  delete(actor: ActorContext, id: string): void {
    this.authz.requireOwner(actor);
    const row = this.owned(actor, id);
    this.store.captures.delete(row.id);
  }

  private owned(actor: ActorContext, id: string): CaptureRow {
    const row = this.store.captures.get(id);
    if (!row || row.discordUserId !== actor.discordUserId) {
      throw new DuckyError('not_found', 'That capture no longer exists.');
    }
    return row;
  }
}
