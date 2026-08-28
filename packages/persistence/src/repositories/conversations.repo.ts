import type { ConversationRole } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { ConversationTurnRow } from './types.js';

const map = (r: Record<string, unknown>): ConversationTurnRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  threadKey: String(r['thread_key']),
  role: String(r['role']) as ConversationRole,
  content: String(r['content']),
  createdAt: String(r['created_at']),
});

/**
 * Stored conversation turns, scoped to one (user, thread) everywhere.
 *
 * EVERY method takes the user id, and it is always in the WHERE clause -- there
 * is deliberately no `byId`, no `listAll` and no thread-only read. A method
 * that could return another account's words would be the whole risk of this
 * table in one signature, and the way to not have it is to not write it.
 *
 * Rows are the owner's own words, so the repository offers exactly what the
 * feature needs: append, read the tail of one thread, count, and delete.
 */
export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Appends one turn and trims the thread back to its cap, in ONE transaction.
   *
   * The cap is enforced here rather than by a scheduled sweep because an
   * unbounded thread is a transcript, and the moment it can grow past the cap
   * is the moment a row is added. Trimming keeps the NEWEST rows: history is
   * useful because it is recent.
   */
  append(row: {
    id: string;
    discordUserId: string;
    threadKey: string;
    role: ConversationRole;
    content: string;
    rowCap: number;
  }): ConversationTurnRow {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_turns
           (id, discord_user_id, thread_key, role, content, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.id, row.discordUserId, row.threadKey, row.role, row.content, ts);

    this.db
      .prepare(
        `DELETE FROM conversation_turns
          WHERE discord_user_id = ? AND thread_key = ?
            AND id NOT IN (
              SELECT id FROM conversation_turns
               WHERE discord_user_id = ? AND thread_key = ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
            )`,
      )
      .run(row.discordUserId, row.threadKey, row.discordUserId, row.threadKey, row.rowCap);

    return {
      id: row.id,
      discordUserId: row.discordUserId,
      threadKey: row.threadKey,
      role: row.role,
      content: row.content,
      createdAt: ts,
    };
  }

  /**
   * The tail of one thread, oldest first, which is prompt order.
   *
   * Ordered by `rowid` after `created_at`, not by `id`. Both turns of one
   * exchange are written in the same transaction and therefore carry the SAME
   * ISO timestamp -- ordering by a random uuid then shuffles the question and
   * the answer, which is exactly the kind of nondeterminism a replayed context
   * must not have. `rowid` is monotonic per insert.
   */
  recent(discordUserId: string, threadKey: string, limit: number): ConversationTurnRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_turns
          WHERE discord_user_id = ? AND thread_key = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(discordUserId, threadKey, limit)
      .map((r) => map(r as Record<string, unknown>));
    return rows.reverse();
  }

  countForUser(discordUserId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM conversation_turns WHERE discord_user_id = ?')
      .get(discordUserId) as { n: number };
    return Number(r.n);
  }

  countForThread(discordUserId: string, threadKey: string): number {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM conversation_turns WHERE discord_user_id = ? AND thread_key = ?',
      )
      .get(discordUserId, threadKey) as { n: number };
    return Number(r.n);
  }

  /** Every stored turn for ONE user. Returns the count, never the content. */
  deleteForUser(discordUserId: string): number {
    const r = this.db
      .prepare('DELETE FROM conversation_turns WHERE discord_user_id = ?')
      .run(discordUserId);
    return Number(r.changes ?? 0);
  }

  /** One thread of one user. */
  deleteThread(discordUserId: string, threadKey: string): number {
    const r = this.db
      .prepare('DELETE FROM conversation_turns WHERE discord_user_id = ? AND thread_key = ?')
      .run(discordUserId, threadKey);
    return Number(r.changes ?? 0);
  }

  /**
   * Retention. Two cutoffs, because the owner's own history and a whitelist
   * user's are not the same thing: the owner is talking to their own assistant,
   * everyone else is a guest whose words Ducky keeps for as short a time as the
   * feature allows.
   *
   * Batched like every other retention delete, so one pass is short.
   */
  pruneOlderThan(input: {
    ownerId: string;
    ownerCutoffIso: string;
    otherCutoffIso: string;
    batch: number;
  }): number {
    const r = this.db
      .prepare(
        `DELETE FROM conversation_turns
          WHERE id IN (
            SELECT id FROM conversation_turns
             WHERE (discord_user_id = ?  AND created_at < ?)
                OR (discord_user_id <> ? AND created_at < ?)
             LIMIT ?
          )`,
      )
      .run(
        input.ownerId, input.ownerCutoffIso,
        input.ownerId, input.otherCutoffIso,
        input.batch,
      );
    return Number(r.changes ?? 0);
  }
}
