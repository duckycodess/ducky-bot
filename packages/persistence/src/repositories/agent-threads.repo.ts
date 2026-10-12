import type { AgentCardStatus, SkillCommand } from '@ducky/contracts';
import type { Db } from '../db.js';
import { fromBool, toBool, type AgentThreadRow } from './types.js';

/**
 * How many of the owner's own grill lines one thread remembers, and how long
 * each may be.
 *
 * Small on purpose. These are the lines `$ticket` turns into acceptance
 * criteria, so the useful amount is "the decisions that were settled", not a
 * transcript. The cap is enforced HERE, in the same statement as the write,
 * rather than by a caller remembering to trim -- a bound a caller can forget
 * is not a bound.
 */
export const AGENT_INTENT_NOTES_MAX = 24;
export const AGENT_INTENT_NOTE_MAX_CHARS = 400;

const map = (r: Record<string, unknown>): AgentThreadRow => ({
  discordUserId: String(r['discord_user_id']),
  threadKey: String(r['thread_key']),
  repository: r['repository'] == null ? null : String(r['repository']),
  checkoutRoot: r['checkout_root'] == null ? null : String(r['checkout_root']),
  grilling: toBool(r['grilling']),
  grillStartedAt: r['grill_started_at'] == null ? null : String(r['grill_started_at']),
  intentNotes: parseNotes(r['intent_notes']),
  ticketUuid: r['ticket_uuid'] == null ? null : String(r['ticket_uuid']),
  issueNumber: r['issue_number'] == null ? null : Number(r['issue_number']),
  issueUrl: r['issue_url'] == null ? null : String(r['issue_url']),
  runId: r['run_id'] == null ? null : String(r['run_id']),
  runCommand: r['run_command'] == null ? null : (String(r['run_command']) as SkillCommand),
  runStatus: r['run_status'] == null ? null : (String(r['run_status']) as AgentCardStatus),
  runDetail: r['run_detail'] == null ? null : String(r['run_detail']),
  runReady: toBool(r['run_ready']),
  runQueued: toBool(r['run_queued']),
  runStartedAt: r['run_started_at'] == null ? null : String(r['run_started_at']),
  runFinishedAt: r['run_finished_at'] == null ? null : String(r['run_finished_at']),
  cardChannelId: r['card_channel_id'] == null ? null : String(r['card_channel_id']),
  cardMessageId: r['card_message_id'] == null ? null : String(r['card_message_id']),
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
});

/**
 * A stored notes column is untrusted on read as well as on write: a value that
 * is not an array of strings reads as empty rather than throwing, because a
 * corrupt row must not make a thread permanently unusable.
 */
function parseNotes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(-AGENT_INTENT_NOTES_MAX);
  } catch {
    return [];
  }
}

/**
 * The repository-workflow binding for one Discord thread.
 *
 * EVERY method takes the owner id and puts it in the WHERE clause. There is no
 * `byThread`, no `listAll` and no thread-only read, for the same reason
 * `ConversationsRepo` has none: a method that could return another account's
 * binding is a method a later change could reach for.
 */
export class AgentThreadsRepo {
  constructor(private readonly db: Db) {}

  get(ownerId: string, threadKey: string): AgentThreadRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM agent_threads WHERE discord_user_id = ? AND thread_key = ?')
      .get(ownerId, threadKey) as Record<string, unknown> | undefined;
    return r ? map(r) : undefined;
  }

  /** Creates the row if it is absent. Returns it either way. */
  ensure(ownerId: string, threadKey: string, nowIso: string): AgentThreadRow {
    this.db
      .prepare(
        `INSERT INTO agent_threads (discord_user_id, thread_key, created_at, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(discord_user_id, thread_key) DO NOTHING`,
      )
      .run(ownerId, threadKey, nowIso, nowIso);
    return this.get(ownerId, threadKey)!;
  }

  /**
   * Binds, or rebinds, the thread's repository.
   *
   * A rebind CLEARS the publication state. That is deliberate: the canonical
   * id, the issue number and the issue URL all belong to the repository they
   * were minted against, and carrying them across would let a retry in a
   * rebound thread try to enrich an issue in a different repository.
   */
  bindRepository(
    ownerId: string,
    threadKey: string,
    repository: string,
    checkoutRoot: string | null,
    nowIso: string,
  ): AgentThreadRow {
    this.ensure(ownerId, threadKey, nowIso);
    const existing = this.get(ownerId, threadKey)!;
    const rebinding = existing.repository !== null && existing.repository !== repository;
    this.db
      .prepare(
        `UPDATE agent_threads
            SET repository = ?, checkout_root = ?, updated_at = ?
                ${rebinding ? ', ticket_uuid = NULL, issue_number = NULL, issue_url = NULL' : ''}
          WHERE discord_user_id = ? AND thread_key = ?`,
      )
      .run(repository, checkoutRoot, nowIso, ownerId, threadKey);
    return this.get(ownerId, threadKey)!;
  }

  setGrilling(
    ownerId: string,
    threadKey: string,
    grilling: boolean,
    nowIso: string,
  ): AgentThreadRow {
    this.ensure(ownerId, threadKey, nowIso);
    this.db
      .prepare(
        `UPDATE agent_threads
            SET grilling = ?, grill_started_at = CASE WHEN ? = 1 THEN ? ELSE grill_started_at END,
                updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ?`,
      )
      .run(fromBool(grilling), fromBool(grilling), nowIso, nowIso, ownerId, threadKey);
    return this.get(ownerId, threadKey)!;
  }

  /**
   * Appends one of the owner's own lines, truncating both the line and the
   * list in the same statement as the write.
   */
  appendNote(ownerId: string, threadKey: string, note: string, nowIso: string): AgentThreadRow {
    const row = this.ensure(ownerId, threadKey, nowIso);
    const trimmed = note.trim().slice(0, AGENT_INTENT_NOTE_MAX_CHARS);
    if (trimmed === '') return row;
    const notes = [...row.intentNotes, trimmed].slice(-AGENT_INTENT_NOTES_MAX);
    this.db
      .prepare(
        `UPDATE agent_threads SET intent_notes = ?, updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ?`,
      )
      .run(JSON.stringify(notes), nowIso, ownerId, threadKey);
    return this.get(ownerId, threadKey)!;
  }

  clearNotes(ownerId: string, threadKey: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE agent_threads SET intent_notes = '[]', updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ?`,
      )
      .run(nowIso, ownerId, threadKey);
  }

  /** The canonical id for this thread's publication, minted once and reused. */
  setTicketUuid(ownerId: string, threadKey: string, uuid: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE agent_threads SET ticket_uuid = ?, updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ? AND ticket_uuid IS NULL`,
      )
      .run(uuid, nowIso, ownerId, threadKey);
  }

  /**
   * Records the issue this RUN published.
   *
   * Keyed on `run_id`, and that is the whole point. A publication is a fact
   * about the run that made it, and a helper call can outlive the run that
   * started it: the owner cancels, starts something else, and the subprocess
   * comes back a moment later. Without the run in the WHERE clause that late
   * answer writes its issue number onto whatever the thread is doing NOW, and
   * the next `$ticket` enriches an issue nobody connected to it.
   *
   * A cancelled run still OWNS its thread, so its issue is still recorded --
   * which is correct, because the issue exists and a retry should find it. A
   * SUPERSEDED run does not, so its write lands nowhere.
   */
  setPublication(
    ownerId: string,
    threadKey: string,
    runId: string,
    publication: { issueNumber: number | null; issueUrl: string | null },
    nowIso: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_threads SET issue_number = ?, issue_url = ?, updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ? AND run_id = ?`,
      )
      .run(publication.issueNumber, publication.issueUrl, nowIso, ownerId, threadKey, runId);
    return Number(result.changes) > 0;
  }

  /**
   * Opens a run on this thread, or refuses because one is still live.
   *
   * ONE RUN AT A TIME, enforced in the statement rather than by a caller
   * remembering to look first. Two Discord messages arriving a moment apart
   * are two concurrent handlers, and before this guard the second one
   * replaced the first one's `run_id` mid-flight -- after which the first
   * run's remaining writes either vanished or landed on the second run's
   * card. A thread is a conversation, and a conversation does one thing at a
   * time.
   *
   * `undefined` means a live run already owns the thread. The caller reports
   * that rather than queueing, because a queue of workflow commands is a way
   * to publish something the owner has stopped thinking about.
   */
  startRun(
    ownerId: string,
    threadKey: string,
    run: {
      runId: string;
      command: SkillCommand;
      status: AgentCardStatus;
      ready: boolean;
      detail: string | null;
    },
    nowIso: string,
  ): AgentThreadRow | undefined {
    this.ensure(ownerId, threadKey, nowIso);
    const result = this.db
      .prepare(
        `UPDATE agent_threads
            SET run_id = ?, run_command = ?, run_status = ?, run_detail = ?, run_ready = ?,
                run_queued = 0, run_started_at = ?, run_finished_at = NULL,
                card_channel_id = NULL, card_message_id = NULL, updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ?
            AND (run_id IS NULL OR run_finished_at IS NOT NULL)`,
      )
      .run(
        run.runId, run.command, run.status, run.detail, fromBool(run.ready),
        nowIso, nowIso, ownerId, threadKey,
      );
    return Number(result.changes) > 0 ? this.get(ownerId, threadKey)! : undefined;
  }

  /** The run that currently owns this thread and has not finished, if any. */
  liveRun(ownerId: string, threadKey: string): AgentThreadRow | undefined {
    const row = this.get(ownerId, threadKey);
    return row?.runId !== null && row?.runFinishedAt === null ? row : undefined;
  }

  /**
   * Whether `runId` still owns this thread AND has not reached a terminal
   * status.
   *
   * The question every step of a multi-call command asks before it writes
   * anything: a helper call can outlive both the owner's patience and the run
   * itself.
   */
  runIsLive(ownerId: string, threadKey: string, runId: string): boolean {
    const row = this.get(ownerId, threadKey);
    return row?.runId === runId && row.runFinishedAt === null;
  }

  /**
   * Moves the named run forward.
   *
   * An OMITTED field means unchanged, including `detail`: a status change that
   * has nothing new to say keeps what the last one said, which is why a card
   * that moves from scanning to publishing still shows what the scan found.
   * There is deliberately no way to blank a detail -- nothing needs one, and a
   * second meaning for `null` would be a trap.
   */
  updateRun(
    ownerId: string,
    threadKey: string,
    runId: string,
    patch: {
      status: AgentCardStatus;
      /** Omitted or null: unchanged. */
      detail?: string | null;
      queued?: boolean;
      finished?: boolean;
    },
    nowIso: string,
  ): AgentThreadRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE agent_threads
            SET run_status = ?,
                run_detail = COALESCE(?, run_detail),
                run_queued = COALESCE(?, run_queued),
                run_finished_at = CASE WHEN ? = 1 THEN ? ELSE run_finished_at END,
                updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ? AND run_id = ?
            AND run_finished_at IS NULL`,
      )
      .run(
        patch.status,
        patch.detail ?? null,
        patch.queued === undefined ? null : fromBool(patch.queued),
        fromBool(patch.finished ?? false),
        nowIso,
        nowIso,
        ownerId,
        threadKey,
        runId,
      );
    // `undefined` for a run that is gone, superseded, or ALREADY TERMINAL.
    // A terminal status is final: without that clause a subprocess returning
    // after the owner pressed Cancel rewrote the card to "queued", which is
    // the most consequential false report this surface could make.
    return Number(result.changes) > 0 ? this.get(ownerId, threadKey) : undefined;
  }

  /** Records which message the card IS, so a later pass edits it rather than reposting. */
  setCard(
    ownerId: string,
    threadKey: string,
    runId: string,
    card: { channelId: string; messageId: string },
    nowIso: string,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_threads SET card_channel_id = ?, card_message_id = ?, updated_at = ?
          WHERE discord_user_id = ? AND thread_key = ? AND run_id = ?`,
      )
      .run(card.channelId, card.messageId, nowIso, ownerId, threadKey, runId);
  }

  /** Owner-scoped, like everything else. A run id alone finds nothing. */
  byRunId(ownerId: string, runId: string): AgentThreadRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM agent_threads WHERE discord_user_id = ? AND run_id = ?')
      .get(ownerId, runId) as Record<string, unknown> | undefined;
    return r ? map(r) : undefined;
  }

  /**
   * Removes the owner's stored workflow notes and bindings.
   *
   * Reached from `/forget conversation` only. Returns the COUNT, never the
   * content -- a record of a deletion that quoted what it deleted would defeat
   * the deletion.
   */
  deleteForOwner(ownerId: string): number {
    const before = this.countForOwner(ownerId);
    this.db.prepare('DELETE FROM agent_threads WHERE discord_user_id = ?').run(ownerId);
    return before;
  }

  countForOwner(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM agent_threads WHERE discord_user_id = ?')
      .get(ownerId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  }
}
