import type { TaskPriority } from '@ducky/contracts';
import type { Db } from '../db.js';
import type {
  TaskPreviewItem, TaskPreviewRow, TaskPreviewSource, TaskPreviewStatus,
} from './types.js';

/**
 * Reads the stored items defensively.
 *
 * The column is JSON this process wrote, but a row read back from disk after
 * an upgrade is still input: a shape that is not an array of plain items reads
 * as ABSENT rather than being trusted, which turns a corrupt row into an
 * expired preview instead of a crash on the save path.
 */
function readItems(raw: unknown): TaskPreviewItem[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return null;
    const items: TaskPreviewItem[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) return null;
      const e = entry as Record<string, unknown>;
      if (typeof e['title'] !== 'string' || e['title'] === '') return null;
      const dueAt = e['dueAt'];
      if (dueAt !== null && typeof dueAt !== 'string') return null;
      items.push({
        title: e['title'],
        dueAt: dueAt === null ? null : String(dueAt),
        dueAllDay: e['dueAllDay'] === true,
        priority: (e['priority'] === 'high' || e['priority'] === 'low'
          ? e['priority']
          : 'normal') as TaskPriority,
      });
    }
    return items;
  } catch {
    return null;
  }
}

const readIds = (raw: unknown): string[] | null => {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return null;
  }
};

const map = (r: Record<string, unknown>): TaskPreviewRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  source: String(r['source']) as TaskPreviewSource,
  status: String(r['status']) as TaskPreviewStatus,
  itemCount: Number(r['item_count']),
  items: readItems(r['items_json']),
  savedPublicIds: readIds(r['saved_ids_json']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
  expiresAt: String(r['expires_at']),
  settledAt: r['settled_at'] == null ? null : String(r['settled_at']),
});

/**
 * Pasted-list previews: the owner's task text between being read back and
 * being kept.
 *
 * Owner-scoped in SQL on every read, like tasks and captures, so another
 * account's preview is ABSENT rather than forbidden. Two further rules are
 * particular to this table and are the reason it is durable at all:
 *
 * - **Settling clears the text.** `markSaved` and `markDiscarded` both null
 *   `items_json`, so the only preview rows holding what the owner wrote are
 *   the ones they have not decided about yet.
 * - **A saved preview replays rather than repeats.** It keeps the public ids
 *   it produced, so a retried or double-pressed save answers with the SAME
 *   tasks instead of writing a second set.
 */
export class TaskPreviewsRepo {
  constructor(private readonly db: Db) {}

  insert(row: {
    id: string;
    discordUserId: string;
    source: TaskPreviewSource;
    items: readonly TaskPreviewItem[];
    createdAt: string;
    expiresAt: string;
  }): TaskPreviewRow {
    this.db
      .prepare(
        `INSERT INTO task_previews
           (id, discord_user_id, source, status, item_count, items_json,
            saved_ids_json, created_at, updated_at, expires_at, settled_at)
         VALUES (?,?,?,'pending',?,?,NULL,?,?,?,NULL)`,
      )
      .run(
        row.id,
        row.discordUserId,
        row.source,
        row.items.length,
        JSON.stringify(row.items),
        row.createdAt,
        row.createdAt,
        row.expiresAt,
      );
    return {
      id: row.id,
      discordUserId: row.discordUserId,
      source: row.source,
      status: 'pending',
      itemCount: row.items.length,
      items: [...row.items],
      savedPublicIds: null,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      expiresAt: row.expiresAt,
      settledAt: null,
    };
  }

  get(ownerId: string, id: string): TaskPreviewRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM task_previews WHERE discord_user_id = ? AND id = ?')
      .get(ownerId, id);
    return r ? map(r as Record<string, unknown>) : undefined;
  }

  countPending(ownerId: string, nowIso: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_previews
          WHERE discord_user_id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .get(ownerId, nowIso) as { n: number };
    return Number(r.n);
  }

  /** Oldest pending previews first: what a cap evicts. */
  oldestPending(ownerId: string, limit: number): TaskPreviewRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_previews
          WHERE discord_user_id = ? AND status = 'pending'
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(ownerId, limit)
      .map((r) => map(r as Record<string, unknown>));
  }

  /** Replaces the items of a pending preview; an edited list is re-parsed first. */
  replaceItems(
    ownerId: string,
    id: string,
    items: readonly TaskPreviewItem[],
    atIso: string,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE task_previews SET items_json = ?, item_count = ?, updated_at = ?
          WHERE id = ? AND discord_user_id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(items), items.length, atIso, id, ownerId);
    return Number(info.changes) === 1;
  }

  /**
   * Settles a preview as saved, recording ONLY the public ids it produced.
   *
   * The WHERE clause requires it to still be pending, so two concurrent saves
   * cannot both claim it: the loser changes no row, re-reads, and reports the
   * same tasks the winner created.
   */
  markSaved(ownerId: string, id: string, publicIds: readonly string[], atIso: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE task_previews
            SET status = 'saved', items_json = NULL, saved_ids_json = ?,
                updated_at = ?, settled_at = ?
          WHERE id = ? AND discord_user_id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify([...publicIds]), atIso, atIso, id, ownerId);
    return Number(info.changes) === 1;
  }

  markDiscarded(ownerId: string, id: string, atIso: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE task_previews
            SET status = 'discarded', items_json = NULL, updated_at = ?, settled_at = ?
          WHERE id = ? AND discord_user_id = ? AND status = 'pending'`,
      )
      .run(atIso, atIso, id, ownerId);
    return Number(info.changes) === 1;
  }

  delete(ownerId: string, id: string): number {
    const info = this.db
      .prepare('DELETE FROM task_previews WHERE id = ? AND discord_user_id = ?')
      .run(id, ownerId);
    return Number(info.changes);
  }

  /**
   * Removes previews nobody can act on any more: expired pending ones, and
   * settled ones past their short keep window.
   *
   * Bounded per call and run from the reconciler, so a preview's lifetime does
   * not depend on retention being configured. This is not a retention policy:
   * it removes drafts that have already expired, never a record of something
   * the owner kept.
   */
  deleteExpired(nowIso: string, settledBeforeIso: string, limit: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM task_previews WHERE id IN (
           SELECT id FROM task_previews
            WHERE (status = 'pending' AND expires_at <= ?)
               OR (status <> 'pending' AND settled_at IS NOT NULL AND settled_at <= ?)
            LIMIT ?)`,
      )
      .run(nowIso, settledBeforeIso, limit);
    return Number(info.changes);
  }

  /** Every preview belonging to one owner. Used by the retention report. */
  countForOwner(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM task_previews WHERE discord_user_id = ?')
      .get(ownerId) as { n: number };
    return Number(r.n);
  }
}
