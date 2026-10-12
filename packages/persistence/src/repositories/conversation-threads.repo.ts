import type { Db } from '../db.js';
import { nowIso } from '../db.js';

/** How a thread came to exist. A branch records where its one anchor came from. */
export type ConversationThreadOrigin = 'starter' | 'branch';

export interface ConversationThreadRow {
  threadId: string;
  parentChannelId: string;
  guildId: string;
  starterMessageId: string;
  startedBy: string;
  origin: ConversationThreadOrigin;
  branchedFrom: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface ConversationCheckpointRow {
  threadId: string;
  summary: string;
  throughRowid: number;
  turnsCovered: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Proof that one person really has taken part in one thread.
 *
 * The brand is not the guarantee; **where the value comes from** is. The only
 * function that returns one is `proveParticipation`, and it returns `undefined`
 * unless a row exists in `conversation_participants`. So a thread-scoped read
 * cannot be called at all without a participation row having been written
 * first, and the check cannot be skipped by a caller that forgot it -- there is
 * no overload that takes a bare thread id.
 *
 * It carries the user id as well as the thread id, so the read it authorizes is
 * still scoped to one person's view of that thread rather than to the thread at
 * large.
 */
declare const participationBrand: unique symbol;
export interface ParticipationProof {
  readonly [participationBrand]: 'conversation-participation';
  readonly threadId: string;
  readonly discordUserId: string;
}

const mapThread = (r: Record<string, unknown>): ConversationThreadRow => ({
  threadId: String(r['thread_id']),
  parentChannelId: String(r['parent_channel_id']),
  guildId: String(r['guild_id']),
  starterMessageId: String(r['starter_message_id']),
  startedBy: String(r['started_by']),
  origin: String(r['origin']) as ConversationThreadOrigin,
  branchedFrom: r['branched_from'] === null || r['branched_from'] === undefined
    ? null
    : String(r['branched_from']),
  createdAt: String(r['created_at']),
  closedAt: r['closed_at'] === null || r['closed_at'] === undefined
    ? null
    : String(r['closed_at']),
});

/**
 * Native thread conversations: the mapping, who is in them, their compact
 * checkpoint, and the provider session identities they have caused to exist.
 *
 * Four tables in one repository because they are four halves of one object and
 * every caller that touches one touches another in the same transaction. The
 * split that DOES matter -- transcript versus prompt context -- is kept: turns
 * live in `ConversationsRepo` and nothing here can delete one.
 */
export class ConversationThreadsRepo {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------- mapping --

  /**
   * Records a thread, or returns the one that already exists for that starter.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` on the UNIQUE starter message id, then
   * read back. Two concurrent starters for one message therefore produce one
   * thread and one conversation, and a retry after a crash finds the first
   * attempt rather than opening a second thread beside it.
   */
  record(row: {
    threadId: string;
    parentChannelId: string;
    guildId: string;
    starterMessageId: string;
    startedBy: string;
    origin: ConversationThreadOrigin;
    branchedFrom?: string | null;
  }): ConversationThreadRow {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_threads
           (thread_id, parent_channel_id, guild_id, starter_message_id, started_by,
            origin, branched_from, created_at, closed_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(starter_message_id) DO NOTHING`,
      )
      .run(
        row.threadId, row.parentChannelId, row.guildId, row.starterMessageId,
        row.startedBy, row.origin, row.branchedFrom ?? null, ts,
      );
    return this.byStarterMessage(row.starterMessageId) ?? this.byThreadId(row.threadId)!;
  }

  byThreadId(threadId: string): ConversationThreadRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM conversation_threads WHERE thread_id = ?')
      .get(threadId) as Record<string, unknown> | undefined;
    return r ? mapThread(r) : undefined;
  }

  byStarterMessage(messageId: string): ConversationThreadRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM conversation_threads WHERE starter_message_id = ?')
      .get(messageId) as Record<string, unknown> | undefined;
    return r ? mapThread(r) : undefined;
  }

  /** Marks a thread gone. Removes nothing: retention decides what that means. */
  close(threadId: string, atIso = nowIso()): void {
    this.db
      .prepare('UPDATE conversation_threads SET closed_at = ? WHERE thread_id = ? AND closed_at IS NULL')
      .run(atIso, threadId);
  }

  countOpen(): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM conversation_threads WHERE closed_at IS NULL')
      .get() as { n: number };
    return Number(r.n);
  }

  // -------------------------------------------------------- participation --

  /**
   * Records that somebody spoke in a thread.
   *
   * Called when a turn is committed and never from a read path, which is what
   * keeps "participant" meaning *took part* rather than *could see it*.
   */
  observeParticipant(threadId: string, discordUserId: string, atIso = nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO conversation_participants
           (thread_id, discord_user_id, first_seen_at, last_seen_at)
         VALUES (?,?,?,?)
         ON CONFLICT(thread_id, discord_user_id)
           DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(threadId, discordUserId, atIso, atIso);
  }

  isParticipant(threadId: string, discordUserId: string): boolean {
    const r = this.db
      .prepare(
        'SELECT 1 AS n FROM conversation_participants WHERE thread_id = ? AND discord_user_id = ?',
      )
      .get(threadId, discordUserId) as { n: number } | undefined;
    return r !== undefined;
  }

  /**
   * The ONLY way to obtain a `ParticipationProof`.
   *
   * Returns undefined when there is no participation row, so a caller cannot
   * read a thread's turns by asserting that somebody belongs in it.
   */
  proveParticipation(threadId: string, discordUserId: string): ParticipationProof | undefined {
    if (!this.isParticipant(threadId, discordUserId)) return undefined;
    return { threadId, discordUserId } as unknown as ParticipationProof;
  }

  /** Everyone who has spoken in a thread. Ids only; never their words. */
  participantsOf(threadId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT discord_user_id FROM conversation_participants WHERE thread_id = ? ORDER BY first_seen_at',
        )
        .all(threadId) as { discord_user_id: string }[]
    ).map((r) => String(r.discord_user_id));
  }

  /** Every thread one person has taken part in. Used by deletion, not by reads. */
  threadsFor(discordUserId: string): string[] {
    return (
      this.db
        .prepare('SELECT thread_id FROM conversation_participants WHERE discord_user_id = ?')
        .all(discordUserId) as { thread_id: string }[]
    ).map((r) => String(r.thread_id));
  }

  // ----------------------------------------------------------- checkpoint --

  checkpointFor(threadId: string): ConversationCheckpointRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM conversation_checkpoints WHERE thread_id = ?')
      .get(threadId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      threadId: String(r['thread_id']),
      summary: String(r['summary']),
      throughRowid: Number(r['through_rowid']),
      turnsCovered: Number(r['turns_covered']),
      createdAt: String(r['created_at']),
      updatedAt: String(r['updated_at']),
    };
  }

  /** Writes or replaces the compact checkpoint. Never touches a stored turn. */
  putCheckpoint(row: {
    threadId: string;
    summary: string;
    throughRowid: number;
    turnsCovered: number;
  }): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_checkpoints
           (thread_id, summary, through_rowid, turns_covered, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary       = excluded.summary,
           through_rowid = excluded.through_rowid,
           turns_covered = excluded.turns_covered,
           updated_at    = excluded.updated_at`,
      )
      .run(row.threadId, row.summary, row.throughRowid, row.turnsCovered, ts, ts);
  }

  deleteCheckpoint(threadId: string): number {
    const r = this.db
      .prepare('DELETE FROM conversation_checkpoints WHERE thread_id = ?')
      .run(threadId);
    return Number(r.changes ?? 0);
  }

  // ---------------------------------------------------- provider sessions --

  /**
   * The current epoch for one (thread, user) provider session.
   *
   * Absent means zero: a conversation that has never been forgotten is on its
   * first session, and recording a row for it would be bookkeeping with no
   * reader.
   */
  epochFor(threadKey: string, discordUserId: string): number {
    const r = this.db
      .prepare(
        'SELECT epoch FROM conversation_provider_sessions WHERE thread_key = ? AND discord_user_id = ?',
      )
      .get(threadKey, discordUserId) as { epoch: number } | undefined;
    return r ? Number(r.epoch) : 0;
  }

  /** Records that a provider session for this pair exists, at its current epoch. */
  observeSession(threadKey: string, discordUserId: string): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_provider_sessions
           (thread_key, discord_user_id, epoch, rotated_at, created_at, updated_at)
         VALUES (?,?,0,NULL,?,?)
         ON CONFLICT(thread_key, discord_user_id)
           DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(threadKey, discordUserId, ts, ts);
  }

  /**
   * Bumps the epoch for one pair, so the next turn opens a DIFFERENT provider
   * session.
   *
   * This is rotation, not deletion, and the difference is the honest part: the
   * old session still exists in the provider's own store. What it can no longer
   * do is come back as context.
   */
  rotate(threadKey: string, discordUserId: string): number {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_provider_sessions
           (thread_key, discord_user_id, epoch, rotated_at, created_at, updated_at)
         VALUES (?,?,1,?,?,?)
         ON CONFLICT(thread_key, discord_user_id)
           DO UPDATE SET epoch      = epoch + 1,
                         rotated_at = excluded.rotated_at,
                         updated_at = excluded.updated_at`,
      )
      .run(threadKey, discordUserId, ts, ts, ts);
    return this.epochFor(threadKey, discordUserId);
  }

  /** Every (thread_key, user) pair one person's conversation has produced. */
  sessionsFor(discordUserId: string): { threadKey: string; epoch: number }[] {
    return (
      this.db
        .prepare(
          'SELECT thread_key, epoch FROM conversation_provider_sessions WHERE discord_user_id = ?',
        )
        .all(discordUserId) as { thread_key: string; epoch: number }[]
    ).map((r) => ({ threadKey: String(r.thread_key), epoch: Number(r.epoch) }));
  }

  /**
   * Everybody whose provider session was contaminated by one SHARED thread.
   *
   * A shared thread writes one provider session per speaker, so deleting the
   * conversation has to reach all of them rather than only the person who
   * asked. Ids only.
   */
  sessionActorsFor(threadKey: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT discord_user_id FROM conversation_provider_sessions WHERE thread_key = ?',
        )
        .all(threadKey) as { discord_user_id: string }[]
    ).map((r) => String(r.discord_user_id));
  }
}
