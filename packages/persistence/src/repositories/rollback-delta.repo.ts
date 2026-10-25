import { createHash } from 'node:crypto';
import { canonicalJson } from '@ducky/contracts';
import type { Db } from '../db.js';
import type { IdentityCategory } from './assistant-import.repo.js';

/** A raw row, as the database holds it. Every key is a column name. */
export type RawRow = Record<string, unknown>;

/**
 * The columns that make up an imported record's BASELINE VERSION, per category.
 *
 * These are the fields Ducky wrote at import and that a later edit, completion,
 * snooze, cancellation or replacement can change. They deliberately exclude every
 * column the system rewrites on its own (a task's `updated_at`, a watch target's
 * default branch and last-observed time), because a baseline that moved when
 * nothing the owner did had changed would report a change that never happened.
 */
const BASELINE: Readonly<Record<IdentityCategory, { table: string; key: string; columns: readonly string[] }>> = {
  task: {
    table: 'tasks', key: 'id',
    columns: ['title', 'status', 'priority', 'urgent', 'category', 'due_at', 'due_all_day', 'closed_at', 'reminder_policy'],
  },
  reminder: {
    table: 'reminders', key: 'id',
    columns: ['status', 'first_fire_at', 'next_fire_at', 'fired_count', 'closed_at', 'text', 'task_id'],
  },
  capture: { table: 'captures', key: 'id', columns: ['content', 'status'] },
  schedule_rule: {
    table: 'schedule_rules', key: 'id',
    columns: [
      'active', 'weekday', 'start_time', 'end_time', 'label', 'course_code', 'section', 'room', 'uncertain',
      'effective_from', 'effective_until', 'replaced_at',
    ],
  },
  schedule_exception: {
    table: 'schedule_exceptions', key: 'id', columns: ['local_date', 'course_code', 'label', 'kind', 'note'],
  },
  preferences: { table: 'owner_preferences', key: 'discord_user_id', columns: ['prefs_json'] },
  watch_target: { table: 'assistant_watch_targets', key: 'id', columns: ['state', 'cancel_reason'] },
};

export const baselineHash = (category: IdentityCategory, row: RawRow): string => {
  const picked: Record<string, unknown> = { v: 1, category };
  for (const c of BASELINE[category].columns) picked[c] = row[c] ?? null;
  return createHash('sha256').update(canonicalJson(picked)).digest('hex');
};

/** Rows read for an export, by table, with whether any table hit its cap. */
export interface OwnerStateSnapshot {
  readonly identities: RawRow[];
  readonly tasks: RawRow[];
  readonly reminders: RawRow[];
  readonly occurrences: RawRow[];
  readonly captures: RawRow[];
  readonly schedules: RawRow[];
  readonly scheduleRules: RawRow[];
  readonly scheduleExceptions: RawRow[];
  readonly preferences: RawRow[];
  readonly briefingSlots: RawRow[];
  readonly watchTargets: RawRow[];
  readonly watchCheckpoints: RawRow[];
  readonly watchEvents: RawRow[];
  readonly discoveryTombstones: RawRow[];
  readonly watchSwitch: RawRow | null;
  /** When monitoring was paused and by whom: provenance, never authority. */
  readonly pausePeriods: RawRow[];
  /** Native receipts and reservations by exact transition (identifiers only, no text). */
  readonly nativeClaims: RawRow[];
  /** Where the native ledger starts; null when it cannot be read. */
  readonly nativeBoundary: RawRow | null;
  /** Rows the migration staged for the first reader that knows the owner (empty once seeded). */
  readonly nativeStaged: RawRow[];
  /** Native requested-changes cards on hold (a count: their keys carry a native review id). */
  readonly heldNativeCards: number;
  /**
   * Ordinary-summary requested-changes facts on hold, identifiers only (a HASH of the review id, the owner's
   * own watch handle and the provider instant), including those of a cancelled or identity-stopped watch.
   */
  readonly heldOrdinaryReviews: RawRow[];
  /**
   * Per-author review lines delivered while no exact review list could identify them (migration 38): owner,
   * watch, bound repository, pull request, class, reason, how provably shown, outbox reference, delivery time.
   * Never a title, a body or a review id.
   */
  readonly gapMarkers: RawRow[];
  /**
   * Historical imported closes that carried a delivery or settlement marker before migration 39 (permanent, never a
   * receipt): owner, canonical repository, scope, pull request, exact transition key (empty for a same-item fallback),
   * origin, marker class, multiplicity, the representative event reference and its earliest marker. Identifiers only.
   */
  readonly closeUncertainty: RawRow[];
  /** Imported closes still pending (unsettled, unwithheld, unheld) on an active target: a count and the oldest creation. */
  readonly pendingCloses: { readonly count: number; readonly oldestCreatedAt: string | null };
  /** Native exact closes held because of the uncertainty above, identifiers only (watch handle, repository, key). */
  readonly heldCloses: RawRow[];
  /** Names of tables that held more than the cap, so the read was cut. */
  readonly truncated: string[];
  /** A deletion cause row present at read time: a process died mid-deletion. */
  readonly deletionContext: RawRow | null;
  /** Rows that break a foreign key. A snapshot that does is not a consistent one. */
  readonly foreignKeyViolations: number;
}

/**
 * Owner-scoped, READ-ONLY reads for the rollback-delta export (ADR 0033), and the
 * baseline hash an import records.
 *
 * Every read is scoped to one owner in SQL, bounded, and writes nothing. The
 * export runs only while the runtime lock is held or against a verified backup,
 * so these reads see one consistent state.
 */
export class RollbackDeltaRepo {
  constructor(private readonly db: Db) {}

  /** The baseline hash of one record as it stands now, or undefined if it is gone. */
  currentHash(category: IdentityCategory, targetId: string): string | undefined {
    const b = BASELINE[category];
    const row = this.db
      .prepare(`SELECT ${b.columns.join(', ')} FROM ${b.table} WHERE ${b.key} = ?`)
      .get(targetId) as RawRow | undefined;
    return row ? baselineHash(category, row) : undefined;
  }

  /**
   * Every read below happens inside ONE read transaction, so the tables agree with
   * each other even if the file is being written by someone else (a live WAL
   * database cannot make reminders and their occurrences disagree). `hooks` exists
   * for a test to write between two reads and prove exactly that.
   */
  snapshot(ownerId: string, cap: number, hooks: { afterFirstRead?: () => void } = {}): OwnerStateSnapshot {
    this.db.exec('BEGIN');
    try {
      return this.snapshotInner(ownerId, cap, hooks);
    } finally {
      this.db.exec('COMMIT');
    }
  }

  private snapshotInner(ownerId: string, cap: number, hooks: { afterFirstRead?: () => void }): OwnerStateSnapshot {
    const truncated: string[] = [];
    const read = (name: string, sql: string, ...args: unknown[]): RawRow[] => {
      const rows = this.db.prepare(`${sql} LIMIT ${cap + 1}`).all(...(args as string[])) as RawRow[];
      if (rows.length > cap) {
        truncated.push(name);
        return rows.slice(0, cap);
      }
      return rows;
    };
    const owner = ownerId;
    const identities = read('identities', 'SELECT * FROM assistant_import_identities ORDER BY namespace, category, source_id');
    hooks.afterFirstRead?.();
    return {
      identities,
      tasks: read('tasks', 'SELECT * FROM tasks WHERE discord_user_id = ? ORDER BY created_at, id', owner),
      reminders: read('reminders', 'SELECT * FROM reminders WHERE discord_user_id = ? ORDER BY created_at, id', owner),
      occurrences: read(
        'reminder_occurrences',
        `SELECT o.* FROM reminder_occurrences o JOIN reminders r ON r.id = o.reminder_id
          WHERE r.discord_user_id = ? ORDER BY o.reminder_id, o.occurrence_no`,
        owner,
      ),
      captures: read('captures', 'SELECT * FROM captures WHERE discord_user_id = ? ORDER BY created_at, id', owner),
      schedules: read('schedules', 'SELECT * FROM schedules WHERE discord_user_id = ? ORDER BY created_at, id', owner),
      scheduleRules: read('schedule_rules', 'SELECT * FROM schedule_rules WHERE discord_user_id = ? ORDER BY created_at, id', owner),
      scheduleExceptions: read(
        'schedule_exceptions', 'SELECT * FROM schedule_exceptions WHERE discord_user_id = ? ORDER BY created_at, id', owner,
      ),
      preferences: read('owner_preferences', 'SELECT * FROM owner_preferences WHERE discord_user_id = ?', owner),
      briefingSlots: read(
        'briefing_deliveries',
        'SELECT * FROM briefing_deliveries WHERE discord_user_id = ? ORDER BY day_key, kind, target',
        owner,
      ),
      watchTargets: read(
        'assistant_watch_targets', 'SELECT * FROM assistant_watch_targets WHERE discord_user_id = ? ORDER BY repo_key', owner,
      ),
      watchCheckpoints: read(
        'assistant_watch_checkpoints',
        `SELECT c.*, t.repo_key FROM assistant_watch_checkpoints c JOIN assistant_watch_targets t ON t.id = c.target_id
          WHERE t.discord_user_id = ? ORDER BY t.repo_key, c.surface`,
        owner,
      ),
      watchEvents: read(
        'assistant_watch_events',
        `SELECT e.*, t.repo_key FROM assistant_watch_events e JOIN assistant_watch_targets t ON t.id = e.target_id
          WHERE t.discord_user_id = ? ORDER BY t.repo_key, e.kind, e.identity`,
        owner,
      ),
      discoveryTombstones: read(
        'assistant_watch_discovery_tombstones',
        'SELECT * FROM assistant_watch_discovery_tombstones WHERE discord_user_id = ? ORDER BY repo_key',
        owner,
      ),
      watchSwitch:
        (this.db.prepare('SELECT * FROM assistant_watch_settings WHERE discord_user_id = ?').get(owner) as RawRow | undefined) ??
        null,
      pausePeriods: read(
        'assistant_watch_pause_periods',
        'SELECT * FROM assistant_watch_pause_periods WHERE discord_user_id = ? ORDER BY id',
        owner,
      ),
      nativeClaims: read(
        'native_transition_claims',
        'SELECT * FROM native_transition_claims WHERE owner_id = ? ORDER BY repo_key, transition_key',
        owner,
      ),
      nativeBoundary: (this.db.prepare('SELECT * FROM native_ledger_boundary WHERE id = 1').get() as RawRow | undefined) ?? null,
      nativeStaged: read('native_legacy_seed', 'SELECT * FROM native_legacy_seed ORDER BY repo_key, transition_key'),
      heldNativeCards: Number(
        (this.db.prepare("SELECT COUNT(*) AS n FROM github_feed_events WHERE status = 'pending' AND held_reason IS NOT NULL").get() as
          { n: number }).n,
      ),
      heldOrdinaryReviews: read(
        'github_watch_events_held',
        `SELECT w.public_id AS watch_handle, w.state AS watch_state, e.repo_key, e.held_reason, e.held_key,
                e.hash_domain, e.provider_at, e.created_at
           FROM github_watch_events e JOIN github_watches w ON w.id = e.watch_id
          WHERE w.discord_user_id = ? AND e.held_reason IS NOT NULL AND substr(e.held_key, 1, 10) != 'pr_closed:'
          ORDER BY e.created_at, e.id`,
        owner,
      ),
      gapMarkers: read(
        'github_watch_gap_markers',
        `SELECT m.id, m.watch_id, w.public_id AS watch_handle, m.repo_key, m.pr_number, m.review_class, m.reason, m.shown,
                m.outbox_ref, m.delivered_at
           FROM github_watch_gap_markers m LEFT JOIN github_watches w ON w.id = m.watch_id
          WHERE m.owner_id = ? ORDER BY m.id`,
        owner,
      ),
      closeUncertainty: read(
        'native_close_uncertainty', 'SELECT * FROM native_close_uncertainty WHERE owner_id = ? ORDER BY id', owner,
      ),
      pendingCloses: (() => {
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS n, MIN(e.created_at) AS oldest FROM assistant_watch_events e
               JOIN assistant_watch_targets t ON t.id = e.target_id
              WHERE t.discord_user_id = ? AND t.state = 'active' AND e.kind = 'pr_closed'
                AND e.digested_at IS NULL AND e.withheld_reason IS NULL AND e.held = 0`,
          )
          .get(owner) as { n: number; oldest: string | null };
        return { count: Number(r.n), oldestCreatedAt: r.oldest };
      })(),
      heldCloses: read(
        'github_watch_events_held_closes',
        `SELECT w.public_id AS watch_handle, w.state AS watch_state, e.repo_key, e.held_key, e.created_at
           FROM github_watch_events e JOIN github_watches w ON w.id = e.watch_id
          WHERE w.discord_user_id = ? AND e.held_reason IS NOT NULL AND substr(e.held_key, 1, 10) = 'pr_closed:'
          ORDER BY e.created_at, e.id`,
        owner,
      ),
      truncated,
      deletionContext: (this.db.prepare('SELECT * FROM deletion_context WHERE id = 1').get() as RawRow | undefined) ?? null,
      foreignKeyViolations: this.db.prepare('PRAGMA foreign_key_check').all().length,
    };
  }
}
