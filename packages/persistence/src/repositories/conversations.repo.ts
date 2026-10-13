import { CONVERSATION_THREAD_READ_MAX, type ConversationRole } from '@ducky/contracts';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { ParticipationProof } from './conversation-threads.repo.js';
import type { ConversationTurnRow } from './types.js';

const map = (r: Record<string, unknown>): ConversationTurnRow => ({
  id: String(r['id']),
  discordUserId: String(r['discord_user_id']),
  threadKey: String(r['thread_key']),
  role: String(r['role']) as ConversationRole,
  content: String(r['content']),
  messageId: r['message_id'] === null || r['message_id'] === undefined
    ? null
    : String(r['message_id']),
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
   * Appends one turn, and trims the thread back to its cap when it has one.
   *
   * **`rowCap: 0` means no trim, and it is not an oversight.** ADR 0021 capped
   * every thread because an unbounded one is a transcript nobody asked for.
   * Issue #4 asks for exactly that transcript, for a NATIVE THREAD, while the
   * thread exists -- so the cap became a property of the caller rather than of
   * the table. `ConversationMemoryService` passes the cap for an ordinary
   * channel or DM, and passes 0 for a thread it has a `conversation_threads`
   * row for. Nothing else may pass 0, and the retention pass is what bounds a
   * thread once it is closed.
   *
   * Append and trim remain ONE transaction either way: the moment a thread can
   * grow past its cap is the moment a row is added. Trimming keeps the NEWEST
   * rows, because history is useful because it is recent.
   */
  append(row: {
    id: string;
    discordUserId: string;
    threadKey: string;
    role: ConversationRole;
    content: string;
    /** The Discord message this turn came from, when there was one. */
    messageId?: string | null;
    /** Zero means uncapped. See above. */
    rowCap: number;
  }): ConversationTurnRow {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_turns
           (id, discord_user_id, thread_key, role, content, message_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.discordUserId, row.threadKey, row.role, row.content,
        row.messageId ?? null, ts,
      );

    if (row.rowCap > 0) {
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
    }

    return {
      id: row.id,
      discordUserId: row.discordUserId,
      threadKey: row.threadKey,
      role: row.role,
      content: row.content,
      messageId: row.messageId ?? null,
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

  /**
   * The turns of one SHARED thread, oldest first, for somebody who is in it.
   *
   * The only read in this file that is not scoped to one user -- and the only
   * way to call it is to hold a `ParticipationProof`, which can be obtained
   * exclusively from `ConversationThreadsRepo.proveParticipation` and only
   * when a participation row exists. There is deliberately no overload taking
   * a bare thread id: the check cannot be skipped, because there is no
   * signature that omits it.
   *
   * This is the structural guard that lets ADR 0021 §2's "no thread-only read"
   * be superseded without giving the property up. §2 made the rule "every
   * method takes a user id"; this makes it "every thread read takes a proof
   * that somebody took part". The second is what a shared conversation needs,
   * and it is not weaker: a reader who never spoke still cannot produce one.
   *
   * `sinceRowid` is exclusive and lets a caller read only what a checkpoint
   * does not already cover.
   */
  threadTurns(
    proof: ParticipationProof,
    opts: { sinceRowid?: number; limit?: number } = {},
  ): ConversationTurnRow[] {
    const limit = Math.min(opts.limit ?? CONVERSATION_THREAD_READ_MAX, CONVERSATION_THREAD_READ_MAX);
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_turns
          WHERE thread_key = ? AND rowid > ?
          ORDER BY rowid DESC
          LIMIT ?`,
      )
      .all(proof.threadId, opts.sinceRowid ?? 0, limit)
      .map((r) => map(r as Record<string, unknown>));
    return rows.reverse();
  }

  /**
   * One turn of a thread, by the Discord message it came from.
   *
   * Proof-gated like every other thread read, and scoped to the proof's thread
   * -- so a message id from somewhere else resolves to nothing rather than to
   * another conversation's words. That is what makes a Branch anchor
   * *explicitly selected and permitted* rather than merely named.
   */
  threadTurnByMessageId(
    proof: ParticipationProof,
    messageId: string,
  ): ConversationTurnRow | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM conversation_turns
          WHERE thread_key = ? AND message_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(proof.threadId, messageId) as Record<string, unknown> | undefined;
    return r ? map(r) : undefined;
  }

  /**
   * How many turns a thread holds, and the rowid of its newest.
   *
   * Takes the proof for the same reason the read does: a count is a small
   * disclosure about a conversation, and a conversation somebody is not in is
   * not theirs to measure.
   */
  threadExtent(proof: ParticipationProof): { turns: number; newestRowid: number } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS newest FROM conversation_turns WHERE thread_key = ?',
      )
      .get(proof.threadId) as { n: number; newest: number };
    return { turns: Number(r.n), newestRowid: Number(r.newest) };
  }

  /**
   * Every turn of one thread, whoever said it. Returns the COUNT, never the
   * content.
   *
   * Deletion is not a read, so it takes no proof: `/forget` reaches it only
   * after `ForgetService` has required the owner, and retention reaches it only
   * for a thread that is already closed. It is also the one place a shared
   * thread's rows can go at all -- `deleteThread` is per user and would leave
   * everybody else's behind.
   */
  deleteThreadForEveryone(threadKey: string): number {
    const r = this.db
      .prepare('DELETE FROM conversation_turns WHERE thread_key = ?')
      .run(threadKey);
    return Number(r.changes ?? 0);
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
             WHERE ((discord_user_id = ?  AND created_at < ?)
                OR (discord_user_id <> ? AND created_at < ?))
               -- A NATIVE THREAD is governed by its own lifecycle, never by
               -- these age windows. Issue #4 asks for the full transcript
               -- while a thread lives, and closedThreadDays plus
               -- purgeThread is what bounds one once it is gone.
               --
               -- The exclusion covers CLOSED threads too, and that is the
               -- point rather than an oversight. Scoping it to open threads
               -- made the windows incoherent: a closed thread would shed a
               -- guest's turns at 7 days and the owner's at 30 while the
               -- whole thread was due for purge at 14, so a conversation
               -- would be deleted piecemeal in an order nobody chose. Worse,
               -- closed_at is set from a signal that can be WRONG --
               -- ThreadDelete also fires when the bot merely loses access --
               -- so a live conversation could silently lose its history to a
               -- window that was never meant to govern it.
               --
               -- One path removes a native thread's turns: purgeThread, which
               -- refuses a thread that is not closed and takes the whole
               -- conversation at once.
               AND thread_key NOT IN (SELECT thread_id FROM conversation_threads)
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
