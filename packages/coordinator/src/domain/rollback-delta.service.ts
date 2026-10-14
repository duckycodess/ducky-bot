import type { IdentityCategory, IdentityRow, OwnerStateSnapshot, RawRow, Store } from '@ducky/persistence';
import { baselineHash } from '@ducky/persistence';

/**
 * The rollback-delta export (ADR 0033): everything that changed in Ducky since an
 * import, in a form a reverse bridge could apply to the source, and an honest
 * statement of what it could not say.
 *
 * It is READ-ONLY and builds a document; it writes nothing and contacts nothing.
 * The CLI that runs it holds the shared runtime lock (or reads a verified backup),
 * so what it reads is one consistent state.
 *
 * - **Baseline.** An imported record's baseline is the hash of the fields Ducky
 *   wrote (`stored_hash`, taken inside the import transaction). A record whose
 *   current hash differs was CHANGED since the import (edited, completed,
 *   snoozed, cancelled, replaced); one that matches is only counted.
 * - **Native.** A record with no ledger identity was ADDED in Ducky.
 * - **Deleted.** A ledger tombstone is identity only, plus one word for WHY it went
 *   (`forget`, `owner_delete`, `retention`, `unknown`). Content is never exported
 *   for a deleted record and cannot be reconstructed; `unknown` makes the export
 *   incomplete rather than guessed.
 * - **State.** Things that are one latest value, applied idempotently, not a delta:
 *   watch checkpoints, briefing slots, the monitoring switch.
 *
 * A reverse bridge is NOT built here. A delta that replays cleanly in a synthetic
 * test proves the export is complete and idempotent; it does not prove a source
 * bridge exists, and it never authorizes restoring stale data.
 */
export const ROLLBACK_DELTA_SCHEMA = 'ducky-rollback-delta/v1';
/** The most rows of any one table an export reads before it calls itself incomplete. */
export const ROLLBACK_DELTA_ROW_CAP = 20_000;

export type DeletionCause = 'forget' | 'owner_delete' | 'retention' | 'import_suppressed' | 'unknown';

export interface IdentityRef {
  readonly namespace: string;
  readonly category: IdentityCategory;
  readonly sourceId: string;
}

export interface CategoryDelta {
  /** Imported records whose baseline hash still matches: counted, never listed. */
  readonly unchanged: number;
  /** Imported records changed since the import, with their full current state. */
  readonly changed: readonly { readonly identity: IdentityRef; readonly baseline: 'known' | 'unknown'; readonly record: Record<string, unknown> }[];
  /** Records Ducky created: no source identity. */
  readonly added: readonly Record<string, unknown>[];
  /** Imported records that are gone, identity and cause only. */
  readonly deleted: readonly { readonly identity: IdentityRef; readonly cause: DeletionCause }[];
}

export interface IncompleteReason {
  readonly category: string;
  readonly rule:
    | 'baseline_unknown' | 'deletion_cause_unknown' | 'over_cap' | 'ledger_orphan';
  readonly count: number;
}

export interface RollbackDelta {
  readonly schema: typeof ROLLBACK_DELTA_SCHEMA;
  readonly profile: string;
  readonly ownerId: string;
  readonly exportedAt: string;
  readonly baseline: {
    readonly namespaces: readonly {
      readonly namespace: string;
      readonly importedAt: string;
      readonly live: Readonly<Record<string, number>>;
      readonly tombstones: Readonly<Record<string, number>>;
    }[];
  };
  /** False whenever anything below could not be said. A bridge must not run on false. */
  readonly complete: boolean;
  readonly incomplete: readonly IncompleteReason[];
  readonly replay: readonly string[];
  readonly tasks: CategoryDelta;
  readonly reminders: CategoryDelta;
  readonly captures: CategoryDelta;
  readonly scheduleRules: CategoryDelta;
  readonly scheduleExceptions: CategoryDelta;
  readonly preferences: CategoryDelta;
  readonly watchTargets: CategoryDelta;
  /** One-off schedule rows are native only: the source's schedule is weekly rules. */
  readonly oneOffSchedules: readonly Record<string, unknown>[];
  readonly state: {
    readonly watchCheckpoints: readonly Record<string, unknown>[];
    /** Events Ducky observed, and imported events whose settlement happened after the import. */
    readonly watchEvents: readonly Record<string, unknown>[];
    readonly briefingSlots: readonly Record<string, unknown>[];
    /** True or false once stated; null when never stated (watching was never paused). */
    readonly watchMonitoringEnabled: boolean | null;
    readonly discoveryTombstones: readonly string[];
  };
}

export const REPLAY_RULES: readonly string[] = [
  'Apply only when `complete` is true. An incomplete export names what it could not say; do not run on it.',
  '`added`: create in the source unless a record with that native handle already exists (idempotent by handle).',
  '`changed`: set the source record named by `identity` to the state given; never reopen what the delta says is closed.',
  '`deleted` with cause forget or owner_delete: the record must not exist in the source, and must never be resurrected.',
  '`deleted` with cause retention: a finished record that aged out; remove it or leave it to the source\'s own pruning.',
  '`deleted` with cause import_suppressed: the import chose not to write it (deleted at the source, or superseded by what the owner did since); nothing to undo.',
  '`deleted` with cause unknown: STOP. The export is incomplete; history already lost is not reconstructible.',
  '`state`: one latest value per key, applied idempotently; applying it twice changes nothing.',
  'This export is not a bridge and authorizes no restore of stale data.',
];

const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const rec = (row: RawRow, drop: readonly string[] = []): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!drop.includes(k)) out[camel(k)] = v;
  }
  return out;
};


interface Builder {
  unchanged: number;
  changed: CategoryDelta['changed'][number][];
  added: Record<string, unknown>[];
  deleted: CategoryDelta['deleted'][number][];
}
const newBuilder = (): Builder => ({ unchanged: 0, changed: [], added: [], deleted: [] });
const finish = (b: Builder): CategoryDelta => ({ unchanged: b.unchanged, changed: b.changed, added: b.added, deleted: b.deleted });

export interface RollbackDeltaInput {
  readonly store: Store;
  readonly ownerId: string;
  readonly profile: string;
  readonly nowIso: string;
  /** Overrides the read cap, for tests. */
  readonly rowCap?: number;
}

/** Builds the delta from one consistent read. Pure over the snapshot: it writes nothing. */
export function buildRollbackDelta(input: RollbackDeltaInput): RollbackDelta {
  const snap = input.store.rollbackDelta.snapshot(input.ownerId, input.rowCap ?? ROLLBACK_DELTA_ROW_CAP);
  return assemble(snap, input);
}

function assemble(snap: OwnerStateSnapshot, input: RollbackDeltaInput): RollbackDelta {
  const incomplete = new Map<string, IncompleteReason>();
  const note = (category: string, rule: IncompleteReason['rule'], n = 1): void => {
    const k = `${category}|${rule}`;
    const prior = incomplete.get(k);
    incomplete.set(k, { category, rule, count: (prior?.count ?? 0) + n });
  };
  for (const t of snap.truncated) note(t, 'over_cap');

  // ---- the ledger: what was imported, and what is gone ----
  const ledger: IdentityRow[] = snap.identities.map((r) => ({
    namespace: String(r['namespace']),
    category: String(r['category']) as IdentityCategory,
    sourceId: String(r['source_id']),
    targetId: r['target_id'] == null ? null : String(r['target_id']),
    state: String(r['state']) as 'live' | 'tombstone',
    fingerprint: r['fingerprint'] == null ? null : String(r['fingerprint']),
    createdAt: String(r['created_at']),
    tombstonedAt: r['tombstoned_at'] == null ? null : String(r['tombstoned_at']),
    storedHash: r['stored_hash'] == null ? null : String(r['stored_hash']),
    tombstoneCause: r['tombstone_cause'] == null ? null : (String(r['tombstone_cause']) as DeletionCause),
  }));
  const liveBy = new Map<string, IdentityRow>();
  for (const l of ledger) if (l.state === 'live' && l.targetId) liveBy.set(`${l.category}|${l.targetId}`, l);

  const refOf = (l: IdentityRow): IdentityRef => ({ namespace: l.namespace, category: l.category, sourceId: l.sourceId });

  const importedAt = new Map<string, string>();
  const namespaces = new Map<string, { live: Record<string, number>; tombstones: Record<string, number> }>();
  for (const l of ledger) {
    const prior = importedAt.get(l.namespace);
    if (prior === undefined || l.createdAt < prior) importedAt.set(l.namespace, l.createdAt);
    const ns = namespaces.get(l.namespace) ?? { live: {}, tombstones: {} };
    const bucket = l.state === 'live' ? ns.live : ns.tombstones;
    bucket[l.category] = (bucket[l.category] ?? 0) + 1;
    namespaces.set(l.namespace, ns);
  }
  const baselineAt = [...importedAt.values()].sort()[0] ?? null;

  /** Classifies one category's rows against the ledger. */
  const classify = (
    category: IdentityCategory,
    rows: readonly RawRow[],
    keyOf: (r: RawRow) => string,
    shape: (r: RawRow) => Record<string, unknown>,
  ): CategoryDelta => {
    const b = newBuilder();
    const seen = new Set<string>();
    for (const row of rows) {
      const key = keyOf(row);
      const l = liveBy.get(`${category}|${key}`);
      if (!l) {
        b.added.push(shape(row));
        continue;
      }
      seen.add(key);
      if (l.storedHash === null) {
        note(category, 'baseline_unknown');
        b.changed.push({ identity: refOf(l), baseline: 'unknown', record: shape(row) });
      } else if (l.storedHash === baselineHash(category, row)) {
        b.unchanged += 1;
      } else {
        b.changed.push({ identity: refOf(l), baseline: 'known', record: shape(row) });
      }
    }
    // A live identity whose record is not in the rows: it should have been tombstoned.
    for (const l of ledger) {
      if (l.category === category && l.state === 'live' && l.targetId && !seen.has(l.targetId)) {
        if (!snap.truncated.includes(tableOf(category))) note(category, 'ledger_orphan');
      }
    }
    for (const l of ledger) {
      if (l.category !== category || l.state !== 'tombstone') continue;
      const cause = l.tombstoneCause ?? 'unknown';
      if (cause === 'unknown') note(category, 'deletion_cause_unknown');
      b.deleted.push({ identity: refOf(l), cause });
    }
    return finish(b);
  };

  // ---- tasks and their reminders ----
  const occurrencesBy = new Map<string, Record<string, unknown>[]>();
  for (const o of snap.occurrences) {
    const list = occurrencesBy.get(String(o['reminder_id'])) ?? [];
    list.push(rec(o, ['id', 'reminder_id']));
    occurrencesBy.set(String(o['reminder_id']), list);
  }
  const taskRef = new Map<string, Record<string, unknown>>();
  for (const t of snap.tasks) {
    const l = liveBy.get(`task|${String(t['id'])}`);
    taskRef.set(String(t['id']), l ? { identity: refOf(l) } : { native: String(t['public_id']) });
  }

  const tasks = classify('task', snap.tasks, (r) => String(r['id']), (r) => ({
    ...rec(r, ['id', 'discord_user_id']), handle: String(r['public_id']),
  }));
  const reminders = classify('reminder', snap.reminders, (r) => String(r['id']), (r) => ({
    ...rec(r, ['id', 'discord_user_id', 'task_id']),
    handle: String(r['public_id']),
    task: r['task_id'] == null ? null : taskRef.get(String(r['task_id'])) ?? null,
    occurrences: occurrencesBy.get(String(r['id'])) ?? [],
  }));
  const captures = classify('capture', snap.captures, (r) => String(r['id']), (r) => rec(r, ['discord_user_id']));
  const scheduleRules = classify('schedule_rule', snap.scheduleRules, (r) => String(r['id']), (r) => rec(r, ['discord_user_id']));
  const scheduleExceptions = classify('schedule_exception', snap.scheduleExceptions, (r) => String(r['id']), (r) => rec(r, ['discord_user_id']));
  const preferences = classify('preferences', snap.preferences, (r) => String(r['discord_user_id']), (r) => rec(r, ['discord_user_id']));
  const watchTargets = classify('watch_target', snap.watchTargets, (r) => String(r['id']), (r) => ({
    ...rec(r, ['id', 'discord_user_id']), handle: String(r['public_id']),
  }));

  // ---- state: latest values, applied idempotently ----
  const targetKeys = new Map(snap.watchTargets.map((t) => [String(t['id']), String(t['repo_key'])]));
  const watchCheckpoints = snap.watchCheckpoints.map((c) => ({
    repoKey: String(c['repo_key']), ...rec(c, ['target_id', 'repo_key']),
  }));
  const watchEvents = snap.watchEvents
    .filter((e) => {
      if (String(e['origin']) === 'observed') return true;
      // An imported event Ducky settled after the import: its alert or digest time is
      // later than the import itself, which no time in the source document can be.
      return baselineAt !== null && (
        (e['alerted_at'] != null && String(e['alerted_at']) > baselineAt) ||
        (e['digested_at'] != null && String(e['digested_at']) > baselineAt)
      );
    })
    .map((e) => ({ repoKey: targetKeys.get(String(e['target_id'])) ?? String(e['repo_key']), ...rec(e, ['id', 'target_id', 'repo_key']) }));

  const out: RollbackDelta = {
    schema: ROLLBACK_DELTA_SCHEMA,
    profile: input.profile,
    ownerId: input.ownerId,
    exportedAt: input.nowIso,
    baseline: {
      namespaces: [...namespaces.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([namespace, v]) => ({
        namespace, importedAt: importedAt.get(namespace)!, live: v.live, tombstones: v.tombstones,
      })),
    },
    complete: incomplete.size === 0,
    incomplete: [...incomplete.values()].sort((a, b) => `${a.category}${a.rule}`.localeCompare(`${b.category}${b.rule}`)),
    replay: REPLAY_RULES,
    tasks, reminders, captures, scheduleRules, scheduleExceptions, preferences, watchTargets,
    oneOffSchedules: snap.schedules.map((r) => rec(r, ['discord_user_id'])),
    state: {
      watchCheckpoints,
      watchEvents,
      briefingSlots: snap.briefingSlots.map((r) => rec(r, ['id', 'discord_user_id'])),
      watchMonitoringEnabled: snap.watchSwitch === null ? null : Number(snap.watchSwitch['monitoring_enabled']) === 1,
      discoveryTombstones: snap.discoveryTombstones.map((r) => String(r['repo_key'])),
    },
  };
  return out;
}

const tableOf = (c: IdentityCategory): string => ({
  task: 'tasks', reminder: 'reminders', capture: 'captures', schedule_rule: 'schedule_rules',
  schedule_exception: 'schedule_exceptions', preferences: 'owner_preferences', watch_target: 'assistant_watch_targets',
})[c];

/** Counts only, for the terminal: never a title, an id or a repository. */
export function deltaCounts(d: RollbackDelta): Record<string, unknown> {
  const c = (x: CategoryDelta) => ({
    unchanged: x.unchanged, changed: x.changed.length, added: x.added.length, deleted: x.deleted.length,
    deletedByCause: x.deleted.reduce<Record<string, number>>((m, e) => ({ ...m, [e.cause]: (m[e.cause] ?? 0) + 1 }), {}),
  });
  return {
    schema: d.schema, complete: d.complete, incomplete: d.incomplete,
    tasks: c(d.tasks), reminders: c(d.reminders), captures: c(d.captures), scheduleRules: c(d.scheduleRules),
    scheduleExceptions: c(d.scheduleExceptions), preferences: c(d.preferences), watchTargets: c(d.watchTargets),
    oneOffSchedules: d.oneOffSchedules.length,
    state: {
      watchCheckpoints: d.state.watchCheckpoints.length, watchEvents: d.state.watchEvents.length,
      briefingSlots: d.state.briefingSlots.length, discoveryTombstones: d.state.discoveryTombstones.length,
      watchMonitoringEnabled: d.state.watchMonitoringEnabled,
    },
  };
}

