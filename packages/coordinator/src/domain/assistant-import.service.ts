import { createHash, randomUUID } from 'node:crypto';
import {
  ASSISTANT_WATCH_MAX_TARGETS, NATIVE_LEGACY_SKEW_MS, MAX_OPEN_TASKS_PER_OWNER, MAX_SCHEDULED_REMINDERS_PER_OWNER,
  REMINDER_TEXT_MAX, REQUIRED_WATCH_KINDS, SCHEDULE_EXCEPTIONS_MAX, SCHEDULE_RULES_MAX,
  TIME_CURSOR_SURFACES, WATCH_SURFACES, canonicalJson, instantOfZonedWallClock, newPublicReminderId, newPublicTaskId,
  newPublicWatchId, validateAssistantImport, watchTargetKey,
  type AssistantImportDocument, type DuckyProfile, type ImportIssue, type ImportedCapture,
  type ImportedScheduleException, type ImportedScheduleRule,
  type ImportedTask, type ImportedWatchTarget, type WatchReaderCapabilities, type WatchSurface,
} from '@ducky/contracts';
import type { RuntimeLockHandle, Store } from '@ducky/persistence';
import type { IdentityCategory } from '@ducky/persistence';
import type { BriefingDelivery } from './briefing-notifications.service.js';

/**
 * What the importer compares a document against: FROZEN configuration, never
 * the document and never the database. The owner, the profile and the timezone
 * come from here, so a document cannot name its own owner, and a preference can
 * be checked against what the operator configured instead of overwriting it.
 */
export interface ImportEnvironment {
  readonly profile: DuckyProfile;
  readonly ownerId: string;
  readonly timeZone: string;
  /** Whether this profile applies imported preferences at all. */
  readonly importedPreferencesSelected: boolean;
  readonly briefing: {
    readonly enabled: boolean;
    readonly morningAt: string;
    readonly eveningAt: string;
    readonly morningExplicit: boolean;
    readonly eveningExplicit: boolean;
    readonly delivery: BriefingDelivery;
  };
  readonly weatherConfigured: boolean;
  /** What the shipped typed reader can observe. Nothing, in this build. */
  readonly watchCapabilities: WatchReaderCapabilities;
}

export interface CategoryCounts {
  /** Records this run wrote. */
  created: number;
  /** Records already imported by an earlier run and left exactly as they are. */
  existing: number;
  /** Records the owner (or the source) had deleted: remembered, never recreated. */
  suppressed: number;
  /** Records whose source content changed since they were imported. */
  conflicts: number;
}

export const IMPORT_COUNT_CATEGORIES = [
  'tasks', 'reminders', 'captures', 'scheduleRules', 'scheduleExceptions', 'preferences',
  'briefingDeliveries', 'watchTargets',
] as const;
export type ImportCountCategory = (typeof IMPORT_COUNT_CATEGORIES)[number];

export interface ImportReport {
  readonly mode: 'dry_run' | 'applied';
  /** True only when every rule passed and (for an applied run) the data was committed. */
  readonly ok: boolean;
  /** Rule names and counts. Never a field, a title, a repository or a value. */
  readonly issues: readonly ImportIssue[];
  readonly counts: Readonly<Record<ImportCountCategory, CategoryCounts>>;
  readonly watch: { readonly checkpoints: number; readonly events: number };
}

const emptyCounts = (): Record<ImportCountCategory, CategoryCounts> =>
  Object.fromEntries(
    IMPORT_COUNT_CATEGORIES.map((c) => [c, { created: 0, existing: 0, suppressed: 0, conflicts: 0 }]),
  ) as Record<ImportCountCategory, CategoryCounts>;

/** Sentinel: stop and roll back, with the reasons. */
class Refused extends Error {
  constructor(readonly issues: readonly ImportIssue[]) {
    super('import refused');
  }
}

const fingerprint = (category: string, record: unknown): string =>
  createHash('sha256').update(canonicalJson({ v: 1, category, record })).digest('hex');

/** A far-future due time: a checkpoint nothing reads on its own (CI state). */
const NEVER = '9999-12-31T00:00:00.000Z';

const PREFERENCES_SOURCE_ID = 'owner';

/** What kind of write one record needs. */
type Disposition = 'create' | 'existing' | 'suppressed' | 'conflict';

/**
 * The offline, atomic import (ADR 0030).
 *
 * It is the ONLY writer of imported records and it is not reachable from Discord
 * or the phone page. It validates the whole document, compares it with frozen
 * configuration, classifies every record against the permanent correlation
 * ledger, refuses everything on any failure, and otherwise writes the lot in ONE
 * `BEGIN IMMEDIATE` transaction. A dry run is the same code path, rolled back.
 *
 * Re-running it is harmless by construction. A record already imported is left
 * exactly as it is, including after the owner edited, completed, snoozed or
 * deleted it; a deleted one is a tombstone and is never recreated; a delivered
 * reminder is written as delivered; and a briefing slot or a watch checkpoint is
 * never advanced. No transport and no network is reachable from here.
 *
 * Every report is counts and rule names. A refusal that quoted what it refused
 * would put the owner's data in a log.
 */
export class AssistantImportService {
  constructor(
    private readonly deps: {
      readonly store: Store;
      readonly env: ImportEnvironment;
      readonly nowMs?: () => number;
    },
  ) {}

  private get store(): Store {
    return this.deps.store;
  }
  private nowIso(): string {
    return new Date((this.deps.nowMs ?? Date.now)()).toISOString();
  }

  // ---- run ------------------------------------------------------------------------

  /**
   * Validates, and (when `apply` is set) writes.
   *
   * Applying requires the shared runtime lock: a flag that says the coordinator
   * is stopped proves nothing, and `BEGIN IMMEDIATE` alone does not stop a live
   * WAL coordinator writing a moment later.
   */
  run(raw: unknown, opts: { apply: boolean; lock?: RuntimeLockHandle }): ImportReport {
    const mode = opts.apply ? 'applied' : 'dry_run';
    const counts = emptyCounts();
    const watch = { checkpoints: 0, events: 0 };
    const refuse = (issues: readonly ImportIssue[]): ImportReport => ({
      mode, ok: false, issues, counts: emptyCounts(), watch: { checkpoints: 0, events: 0 },
    });

    const validated = validateAssistantImport(raw);
    if (!validated.ok) return refuse(validated.issues);
    const doc = validated.doc;

    const pre = this.contextIssues(doc);
    if (opts.apply && !(opts.lock?.held() ?? false)) {
      pre.push({ category: 'document', rule: 'lock_not_held', count: 1 });
    }
    if (pre.length > 0) return refuse(pre);

    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const plan = this.classify(doc);
      const capacity = this.capacityIssues(doc, plan);
      const conflicts = plan.conflicts;
      if (capacity.length + conflicts.length > 0) throw new Refused([...capacity, ...conflicts]);

      this.write(doc, plan, counts, watch);
      if (!opts.apply) throw new DryRun();
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the original error is the interesting one */
      }
      if (err instanceof DryRun) {
        return { mode, ok: true, issues: [], counts, watch };
      }
      if (err instanceof Refused) return refuse(err.issues);
      throw err;
    }
    return { mode, ok: true, issues: [], counts, watch };
  }

  // ---- configuration checks ----------------------------------------------------------

  private contextIssues(doc: AssistantImportDocument): ImportIssue[] {
    const e = this.deps.env;
    const out: ImportIssue[] = [];
    const add = (category: string, rule: string, count = 1): void => {
      out.push({ category, rule, count });
    };
    // A document never names its own owner. A mismatch is a hard stop.
    if (doc.ownerId !== e.ownerId) add('document', 'owner_mismatch');
    // Identities are scoped by namespace, so a mistyped one would look like a
    // brand-new source and import every record a second time. Once the ledger has
    // seen a source, only that source is accepted.
    const known = this.store.assistantImport.namespaces();
    if (known.length > 0 && !known.includes(doc.namespace)) add('document', 'namespace_mismatch');
    if (doc.profile !== e.profile) add('document', 'profile_mismatch');
    if (doc.timeZone !== e.timeZone) add('document', 'time_zone_mismatch');

    const p = doc.preferences;
    if (p) {
      if (!e.importedPreferencesSelected) add('preferences', 'not_selected_by_profile');
      if ((p.morningEnabled || p.eveningEnabled) && !e.briefing.enabled) {
        add('preferences', 'briefings_disabled_in_config');
      }
      const pad = (t: string): string => t.trim().padStart(5, '0');
      if (p.morningEnabled && e.briefing.morningExplicit && pad(e.briefing.morningAt) !== p.morningTime) {
        add('preferences', 'morning_time_conflict');
      }
      if (p.eveningEnabled && e.briefing.eveningExplicit && pad(e.briefing.eveningAt) !== p.eveningTime) {
        add('preferences', 'evening_time_conflict');
      }
      if (p.includeWeather && !e.weatherConfigured) add('preferences', 'weather_not_configured');
      // Captures and the repository digest are private to the owner. A briefing
      // posted to a channel could be read by others, so those sections are only
      // ever put in the owner's DM; delivery to a channel would either leak them
      // or silently drop them, and neither is acceptable, so it is refused.
      if ((p.includeGithub || p.includeCaptures) && e.briefing.delivery !== 'dm') {
        add('preferences', 'private_sections_need_dm_delivery');
      }
    }

    if (doc.watch && doc.watch.targets.length > 0) {
      const have = new Set<string>(e.watchCapabilities.observableKinds);
      const missing = REQUIRED_WATCH_KINDS.filter((k) => !have.has(k)).length;
      if (missing > 0) add('watch', 'reader_cannot_observe', missing);
    }
    return out;
  }

  // ---- classification against the ledger ----------------------------------------------

  private classify(doc: AssistantImportDocument): Plan {
    const ledger = this.store.assistantImport;
    const ns = doc.namespace;
    const plan: Plan = {
      conflicts: [],
      task: new Map(), reminder: new Map(), capture: new Map(), rule: new Map(),
      exception: new Map(), preferences: undefined, target: new Map(), adopt: new Map(),
    };
    const conflict = (category: string, rule = 'source_changed'): void => {
      const existing = plan.conflicts.find((c) => c.category === category && c.rule === rule);
      if (existing) (existing as { count: number }).count += 1;
      else plan.conflicts.push({ category, rule, count: 1 });
    };
    const decide = (
      category: IdentityCategory, sourceId: string, record: unknown,
    ): { disposition: Disposition; fp: string } => {
      const fp = fingerprint(category, record);
      const id = ledger.identity(ns, category, sourceId);
      if (!id) return { disposition: 'create', fp };
      if (id.state === 'tombstone') return { disposition: 'suppressed', fp };
      return { disposition: id.fingerprint === fp ? 'existing' : 'conflict', fp };
    };

    for (const t of doc.tasks) {
      const d = decide('task', t.sourceId, t);
      if (d.disposition === 'conflict') conflict('tasks');
      plan.task.set(t.sourceId, d);
    }
    for (const r of doc.reminders) {
      const d = decide('reminder', r.sourceId, r);
      if (d.disposition === 'conflict') conflict('reminders');
      plan.reminder.set(r.sourceId, d);
    }
    for (const c of doc.captures) {
      const d = decide('capture', c.sourceId, c);
      if (d.disposition === 'conflict') conflict('captures');
      plan.capture.set(c.sourceId, d);
    }
    for (const b of doc.schedule?.batches ?? []) {
      for (const r of b.rules) {
        const d = decide('schedule_rule', r.sourceId, { batch: { id: b.sourceId, status: b.status }, rule: r });
        if (d.disposition === 'conflict') conflict('schedule');
        plan.rule.set(r.sourceId, d);
      }
    }
    for (const x of doc.schedule?.exceptions ?? []) {
      const d = decide('schedule_exception', x.sourceId, x);
      if (d.disposition === 'conflict') conflict('schedule');
      plan.exception.set(x.sourceId, d);
    }
    if (doc.preferences) {
      plan.preferences = decide('preferences', PREFERENCES_SOURCE_ID, doc.preferences);
      if (plan.preferences.disposition === 'conflict') conflict('preferences');
    }
    for (const t of doc.watch?.targets ?? []) {
      const d = decide('watch_target', t.sourceId, t);
      if (d.disposition === 'conflict') conflict('watch');
      // A different identity for a repository that is already a target would
      // collide on the owner's unique key: say so rather than fail mid-write.
      const present = d.disposition === 'create'
        ? this.store.assistantWatch.byRepoKey(this.deps.env.ownerId, watchTargetKey(t.reference))
        : undefined;
      if (present) {
        // A repository discovery found before this import is adopted (its state, its
        // checkpoints it has not read yet, its events), so discovery running first can
        // never block the import or override a source mute. Anything else is a collision.
        if (present.origin === 'discovered' && !this.store.assistantImport.hasLiveTarget('watch_target', present.id)) {
          plan.adopt.set(t.sourceId, present.id);
        } else {
          conflict('watch', 'reference_already_present');
        }
      }
      plan.target.set(t.sourceId, d);
    }
    return plan;
  }

  private capacityIssues(doc: AssistantImportDocument, plan: Plan): ImportIssue[] {
    const owner = this.deps.env.ownerId;
    const out: ImportIssue[] = [];
    const creating = <T extends { sourceId: string }>(
      items: readonly T[], map: Map<string, { disposition: Disposition }>,
    ): T[] => items.filter((i) => map.get(i.sourceId)?.disposition === 'create');

    const newOpen = creating(doc.tasks, plan.task).filter((t) => t.status === 'open').length;
    if (this.store.tasks.countOpen(owner) + newOpen > MAX_OPEN_TASKS_PER_OWNER) {
      out.push({ category: 'tasks', rule: 'over_open_capacity', count: 1 });
    }

    // A pending reminder for a task that is open is a scheduled one.
    const openTasks = new Set(doc.tasks.filter((t) => t.status === 'open').map((t) => t.sourceId));
    const newScheduled = creating(doc.reminders, plan.reminder).filter(
      (r) => r.state === 'pending' && openTasks.has(r.taskSourceId),
    ).length;
    if (this.store.reminders.countScheduled(owner) + newScheduled > MAX_SCHEDULED_REMINDERS_PER_OWNER) {
      out.push({ category: 'reminders', rule: 'over_scheduled_capacity', count: 1 });
    }

    const rules = doc.schedule?.batches.flatMap((b) => b.rules) ?? [];
    if (this.store.scheduleRules.countRules(owner) + creating(rules, plan.rule).length > SCHEDULE_RULES_MAX) {
      out.push({ category: 'schedule', rule: 'over_rule_capacity', count: 1 });
    }
    if (
      this.store.scheduleRules.countExceptions(owner) +
        creating(doc.schedule?.exceptions ?? [], plan.exception).length > SCHEDULE_EXCEPTIONS_MAX
    ) {
      out.push({ category: 'schedule', rule: 'over_exception_capacity', count: 1 });
    }

    // An adopted target is already counted: it adds nothing.
    const newTargets = creating(doc.watch?.targets ?? [], plan.target).length - plan.adopt.size;
    if (this.store.assistantWatch.countAll(owner) + newTargets > ASSISTANT_WATCH_MAX_TARGETS) {
      out.push({ category: 'watch', rule: 'over_target_capacity', count: 1 });
    }
    return out;
  }

  // ---- the write pass ----------------------------------------------------------------

  private write(
    doc: AssistantImportDocument,
    plan: Plan,
    counts: Record<ImportCountCategory, CategoryCounts>,
    watch: { checkpoints: number; events: number },
  ): void {
    const at = this.nowIso();
    const owner = this.deps.env.ownerId;
    const tz = this.deps.env.timeZone;
    const ns = doc.namespace;
    const imp = this.store.assistantImport;
    // What the feed's own rows said at the ledger's cutoff becomes this owner's receipts BEFORE any
    // imported event is decided, inside this same transaction (the importer builds no application, so
    // nothing else would have read them back). An unreadable boundary refuses the whole import.
    this.store.nativeTransitions.ensureSeeded(owner, at);

    const tally = (cat: ImportCountCategory, d: Disposition): boolean => {
      if (d === 'create') {
        counts[cat].created += 1;
        return true;
      }
      if (d === 'existing') counts[cat].existing += 1;
      else if (d === 'suppressed') counts[cat].suppressed += 1;
      else counts[cat].conflicts += 1;
      return false;
    };

    // ---- tasks ----
    const taskTarget = new Map<string, string>();
    for (const t of doc.tasks) {
      const d = plan.task.get(t.sourceId)!;
      if (tally('tasks', d.disposition)) {
        const id = randomUUID();
        imp.insertTask(this.taskWrite(id, owner, tz, t));
        imp.recordLive({ namespace: ns, category: 'task', sourceId: t.sourceId, targetId: id, fingerprint: d.fp, at, storedHash: this.baseline('task', id) });
        taskTarget.set(t.sourceId, id);
      } else {
        const live = imp.identity(ns, 'task', t.sourceId);
        if (live?.targetId) taskTarget.set(t.sourceId, live.targetId);
      }
    }

    // ---- reminders ----
    const byTask = new Map(doc.tasks.map((t) => [t.sourceId, t] as const));
    for (const r of doc.reminders) {
      const d = plan.reminder.get(r.sourceId)!;
      const targetTask = taskTarget.get(r.taskSourceId);
      if (d.disposition !== 'create') {
        tally('reminders', d.disposition);
        continue;
      }
      // The task is gone (the owner deleted it): remember the reminder too, so a
      // later export cannot bring it back, and write nothing.
      const live = targetTask === undefined ? undefined : this.store.tasks.byId(owner, targetTask);
      if (targetTask === undefined || !live) {
        imp.recordTombstone({ namespace: ns, category: 'reminder', sourceId: r.sourceId, at });
        counts.reminders.suppressed += 1;
        continue;
      }
      // A pending reminder for a task the owner has since closed, or whose
      // deadline or policy the owner has since changed in Ducky, would be a send
      // derived from a state the owner has moved past (an edit already re-derived
      // that task's reminders). Remembered as suppressed, not written.
      const imported = byTask.get(r.taskSourceId);
      if (
        r.state === 'pending' &&
        (live.status !== 'open' || (imported !== undefined && live.updatedAt !== imported.updatedAt))
      ) {
        imp.recordTombstone({ namespace: ns, category: 'reminder', sourceId: r.sourceId, at });
        counts.reminders.suppressed += 1;
        continue;
      }
      const id = randomUUID();
      imp.insertReminder({
        id, publicId: this.freshReminderId(), discordUserId: owner, taskId: targetTask,
        text: (byTask.get(r.taskSourceId)?.title ?? live.title).slice(0, REMINDER_TEXT_MAX),
        status: r.state === 'pending' ? 'scheduled' : r.state === 'delivered' ? 'completed' : 'cancelled',
        fireAt: r.fireAt, deliveredAt: r.deliveredAt, createdAt: r.createdAt,
        closedAt: r.state === 'cancelled' ? doc.exportedAt : null,
      });
      imp.recordLive({ namespace: ns, category: 'reminder', sourceId: r.sourceId, targetId: id, fingerprint: d.fp, at, storedHash: this.baseline('reminder', id) });
      counts.reminders.created += 1;
    }

    // ---- captures ----
    for (const c of doc.captures) {
      const d = plan.capture.get(c.sourceId)!;
      if (d.disposition === 'create' && c.state === 'deleted') {
        // The source had already deleted it: only its identity is kept.
        imp.recordTombstone({ namespace: ns, category: 'capture', sourceId: c.sourceId, at });
        counts.captures.suppressed += 1;
        continue;
      }
      if (tally('captures', d.disposition)) {
        const id = randomUUID();
        imp.insertCapture({
          id, discordUserId: owner, content: c.text!, status: captureStatus(c),
          createdAt: c.createdAt, updatedAt: c.processedAt ?? c.createdAt,
        });
        imp.recordLive({ namespace: ns, category: 'capture', sourceId: c.sourceId, targetId: id, fingerprint: d.fp, at, storedHash: this.baseline('capture', id) });
      }
    }

    // ---- schedule ----
    for (const b of doc.schedule?.batches ?? []) {
      for (const r of b.rules) {
        const d = plan.rule.get(r.sourceId)!;
        if (tally('scheduleRules', d.disposition)) {
          const id = randomUUID();
          this.store.scheduleRules.insertRule({
            ...this.ruleWrite(id, owner, b.sourceId, b.status === 'active', r, at),
            replacedAt: b.status === 'replaced' ? b.replacedAt : null,
          });
          imp.recordLive({ namespace: ns, category: 'schedule_rule', sourceId: r.sourceId, targetId: id, fingerprint: d.fp, at, storedHash: this.baseline('schedule_rule', id) });
        }
      }
    }
    for (const x of doc.schedule?.exceptions ?? []) {
      const d = plan.exception.get(x.sourceId)!;
      if (tally('scheduleExceptions', d.disposition)) {
        const id = randomUUID();
        this.store.scheduleRules.insertException(this.exceptionWrite(id, owner, x));
        imp.recordLive({ namespace: ns, category: 'schedule_exception', sourceId: x.sourceId, targetId: id, fingerprint: d.fp, at, storedHash: this.baseline('schedule_exception', id) });
      }
    }

    // ---- preferences ----
    if (doc.preferences && plan.preferences) {
      if (tally('preferences', plan.preferences.disposition)) {
        this.store.ownerPreferences.insert({
          ownerId: owner, prefsJson: JSON.stringify(doc.preferences), source: 'import', at,
        });
        imp.recordLive({
          namespace: ns, category: 'preferences', sourceId: PREFERENCES_SOURCE_ID, targetId: owner,
          fingerprint: plan.preferences.fp, at, storedHash: this.baseline('preferences', owner),
        });
      }
    }

    // ---- briefing slots the source already settled ----
    for (const b of doc.briefingDeliveries) {
      let wrote = false;
      for (const target of briefingTargets(this.deps.env.briefing.delivery)) {
        wrote =
          this.store.briefings.insertSettled({
            id: randomUUID(), discordUserId: owner, kind: b.kind, dayKey: b.localDate, target,
            dueAt: b.at, status: b.status === 'delivered' ? 'delivered' : b.status === 'skipped' ? 'skipped' : 'abandoned',
            settledAt: b.at,
          }) || wrote;
      }
      if (wrote) counts.briefingDeliveries.created += 1;
      else counts.briefingDeliveries.existing += 1;
    }

    // ---- notification-only watch targets ----
    for (const t of doc.watch?.targets ?? []) {
      const d = plan.target.get(t.sourceId)!;
      if (!tally('watchTargets', d.disposition)) continue;
      const adopted = plan.adopt.get(t.sourceId);
      const id = adopted ?? randomUUID();
      const counted = adopted
        ? this.adoptTarget(adopted, t, doc.exportedAt, at)
        : this.insertTarget(id, owner, t, doc.exportedAt, at);
      watch.checkpoints += counted.checkpoints;
      watch.events += counted.events;
      imp.recordLive({ namespace: ns, category: 'watch_target', sourceId: t.sourceId, targetId: id, fingerprint: d.fp, at, storedHash: this.baseline('watch_target', id) });
    }
    // The source's global switch. It gates reads only (no target or cursor changes). The
    // document states it ONCE: when nothing has ever been stored. Once a row exists (an
    // earlier import wrote it, or the owner chose with `/watch monitoring`) the owner's
    // state stands, so a repeated import of an unchanged document can neither undo a
    // native choice nor re-pause what the owner resumed. `verify` reports the difference
    // as drift rather than this pass silently erasing it.
    if (doc.watch && this.store.assistantWatch.monitoringSetting(owner) === undefined) {
      // An imported pause has no real start: only the import time is known.
      this.store.assistantWatch.setMonitoring(owner, doc.watch.monitoringEnabled, at, 'import');
    }
  }

  /** The baseline version of a record just written, read back inside the same transaction. */
  private baseline(category: IdentityCategory, targetId: string): string {
    const h = this.store.rollbackDelta.currentHash(category, targetId);
    if (h === undefined) throw new Error('baseline: the record just written is not readable');
    return h;
  }

  /**
   * Takes over a target discovery created before the import.
   *
   * The source is what the owner decided, so its mute wins over discovery's default of
   * active; but what Ducky has ALREADY read is newer than anything the source had, so a
   * checkpoint Ducky has baselined or advanced is kept and only one it has not read
   * takes the source's cursor. Events are added where they are not already known.
   * Nothing here touches authorization: a watch target never did.
   */
  private adoptTarget(
    id: string, t: ImportedWatchTarget, exportedAt: string, at: string,
  ): { checkpoints: number; events: number } {
    const repo = this.store.assistantWatch;
    repo.adoptDiscovered(id, t.defaultBranch, t.state === 'cancelled' ? exportedAt : null, t.lastObservedAt, at);
    const given = new Map(t.checkpoints.map((c) => [c.surface, c] as const));
    let checkpoints = 0;
    for (const [surface, c] of given) {
      if (surface === 'ci_state') {
        repo.adoptCheckpoint(id, surface, c.cursor, at, NEVER);
      } else if (repo.adoptCheckpoint(id, surface, cursorText(surface, c.cursor), at, at)) {
        checkpoints += 1;
      }
    }
    let events = 0;
    for (const e of t.events) {
      if (repo.insertImportedEventIfNew({
        id: randomUUID(), targetId: id, kind: e.kind, identity: e.identity, occurredAt: e.occurredAt,
        payloadJson: JSON.stringify(e.payload), alertedAt: e.alertedAt, digestedAt: e.digestedAt, createdAt: at,
      })) events += 1;
    }
    return { checkpoints, events };
  }

  private insertTarget(
    id: string, owner: string, t: ImportedWatchTarget, exportedAt: string, at: string,
  ): { checkpoints: number; events: number } {
    const repo = this.store.assistantWatch;
    repo.insertTarget({
      id, publicId: this.freshWatchId(), discordUserId: owner, repoKey: watchTargetKey(t.reference),
      display: t.reference.trim(), defaultBranch: t.defaultBranch, state: t.state,
      lastObservedAt: t.lastObservedAt, createdAt: at, cancelledAt: t.state === 'cancelled' ? exportedAt : null,
    });

    // Every surface a target is watched through gets a checkpoint. One the source
    // had a cursor for is IMPORTED (reconciled across the stopped-notifier window
    // before it advances); one it never read is UNBASELINED, an explicit state
    // that is baselined silently on first sight -- never a NULL that reads as new.
    const given = new Map(t.checkpoints.map((c) => [c.surface, c] as const));
    let checkpoints = 0;
    const observed: WatchSurface[] = WATCH_SURFACES.filter((s) => s !== 'ci_state');
    for (const surface of observed) {
      const c = given.get(surface);
      repo.insertCheckpoint({
        targetId: id, surface, state: c ? 'imported' : 'unbaselined', cursor: c ? cursorText(surface, c.cursor) : null,
        nextDueAt: at, updatedAt: at,
      });
      checkpoints += 1;
    }
    const ci = given.get('ci_state');
    if (ci) {
      // Not a read of its own: it moves with the runs surface, so it is never due.
      repo.insertCheckpoint({ targetId: id, surface: 'ci_state', state: 'ready', cursor: ci.cursor, nextDueAt: NEVER, updatedAt: at });
      checkpoints += 1;
    }
    for (const e of t.events) {
      repo.insertImportedEvent({
        id: randomUUID(), targetId: id, kind: e.kind, identity: e.identity, occurredAt: e.occurredAt,
        payloadJson: JSON.stringify(e.payload), alertedAt: e.alertedAt, digestedAt: e.digestedAt, createdAt: at,
      });
    }
    return { checkpoints, events: t.events.length };
  }

  // ---- mapping ------------------------------------------------------------------------

  private taskWrite(id: string, owner: string, tz: string, t: ImportedTask) {
    let dueAt: string | null = null;
    let dueAllDay = false;
    if (t.due?.kind === 'instant') dueAt = t.due.at;
    else if (t.due?.kind === 'date') {
      // An all-day deadline is that civil day's local midnight, which is how every
      // native all-day task is stored. It is chosen by the document's explicit
      // `date` kind and never inferred from a midnight instant.
      const [y, m, d] = t.due.date.split('-').map(Number) as [number, number, number];
      dueAt = new Date(instantOfZonedWallClock(tz, y, m, d)).toISOString();
      dueAllDay = true;
    }
    return {
      id, publicId: this.freshTaskId(), discordUserId: owner, title: t.title, dueAt, dueAllDay,
      priority: t.priority === 'urgent' ? ('high' as const) : t.priority, urgent: t.priority === 'urgent',
      category: t.category, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
      closedAt: t.closedAt, reminderPolicy: t.reminderPolicy,
    };
  }

  private ruleWrite(id: string, owner: string, batchKey: string, active: boolean, r: ImportedScheduleRule, at: string) {
    return {
      id, discordUserId: owner, batchKey, active, weekday: r.weekday, startTime: r.startTime,
      endTime: r.endTime, label: r.label, courseCode: r.courseCode, section: r.section, room: r.room,
      uncertain: r.uncertain, effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil, createdAt: at,
    };
  }

  private exceptionWrite(id: string, owner: string, x: ImportedScheduleException) {
    return {
      id, discordUserId: owner, date: x.date, courseCode: x.courseCode, label: x.label,
      kind: x.kind, note: x.note, createdAt: x.createdAt,
    };
  }

  // ---- handles ------------------------------------------------------------------------

  private fresh(make: () => string, exists: (id: string) => boolean): string {
    for (let i = 0; i < 25; i += 1) {
      const id = make();
      if (!exists(id)) return id;
    }
    // A five-character handle collides rarely but not never; failing the whole
    // import is better than writing a record the owner cannot address.
    throw new Refused([{ category: 'document', rule: 'handle_allocation_failed', count: 1 }]);
  }
  private freshTaskId = (): string => this.fresh(newPublicTaskId, (id) => this.store.tasks.publicIdExists(id));
  private freshReminderId = (): string => this.fresh(newPublicReminderId, (id) => this.store.reminders.publicIdExists(id));
  private freshWatchId = (): string =>
    this.fresh(
      newPublicWatchId,
      (id) => this.store.githubWatches.publicIdExists(id) || this.store.assistantWatch.publicIdExists(id),
    );

  // ---- verification (read only, counts only) ------------------------------------------

  /**
   * Compares a document with what is stored, and reports counts.
   *
   * `missing` is a record that is neither imported nor remembered as deleted,
   * `changedAtSource` a record whose content differs from what was imported, and
   * `drifted` a record whose stored fields no longer equal what the import wrote
   * -- which is expected after the owner has used the assistant, and is
   * reported separately so it is read as that and not as a failure. No title, id
   * or value is ever included.
   */
  verify(raw: unknown): VerifyReport {
    const validated = validateAssistantImport(raw);
    if (!validated.ok) {
      return { ok: false, parity: false, issues: validated.issues, categories: {}, nativeLedger: null };
    }
    const doc = validated.doc;
    const owner = this.deps.env.ownerId;
    const tz = this.deps.env.timeZone;
    const ledger = this.store.assistantImport;
    const ns = doc.namespace;
    const cats: Record<string, VerifyCounts> = {};
    const bump = (cat: string, k: keyof VerifyCounts): void => {
      const c = (cats[cat] ??= { expected: 0, present: 0, suppressed: 0, missing: 0, changedAtSource: 0, drifted: 0 });
      c[k] += 1;
    };
    const check = (
      cat: string, category: IdentityCategory, sourceId: string, record: unknown, drifted: (targetId: string) => boolean,
    ): void => {
      bump(cat, 'expected');
      const id = ledger.identity(ns, category, sourceId);
      if (!id) return bump(cat, 'missing');
      if (id.state === 'tombstone') return bump(cat, 'suppressed');
      if (id.fingerprint !== fingerprint(category, record)) return bump(cat, 'changedAtSource');
      bump(cat, 'present');
      if (drifted(id.targetId!)) bump(cat, 'drifted');
    };

    for (const t of doc.tasks) {
      check('tasks', 'task', t.sourceId, t, (target) => {
        const row = this.store.tasks.byId(owner, target);
        if (!row) return true;
        const w = this.taskWrite(target, owner, tz, t);
        return (
          row.title !== w.title || row.status !== w.status || row.priority !== w.priority ||
          row.urgent !== w.urgent || row.category !== w.category ||
          row.dueAt !== w.dueAt || row.dueAllDay !== w.dueAllDay || row.closedAt !== w.closedAt ||
          row.createdAt !== w.createdAt ||
          JSON.stringify(row.reminderPolicy ?? null) !== JSON.stringify(w.reminderPolicy)
        );
      });
    }
    for (const r of doc.reminders) {
      check('reminders', 'reminder', r.sourceId, r, (target) => {
        const row = this.store.reminders.byId(target);
        if (!row) return true;
        const expected = r.state === 'pending' ? 'scheduled' : r.state === 'delivered' ? 'completed' : 'cancelled';
        return row.status !== expected || row.firstFireAt !== r.fireAt;
      });
    }
    for (const c of doc.captures) {
      if (c.state === 'deleted') {
        bump('captures', 'expected');
        const id = ledger.identity(ns, 'capture', c.sourceId);
        bump('captures', id?.state === 'tombstone' ? 'suppressed' : id ? 'changedAtSource' : 'missing');
        continue;
      }
      check('captures', 'capture', c.sourceId, c, (target) => {
        const row = this.store.captures.get(target);
        return !row || row.content !== c.text || row.status !== captureStatus(c);
      });
    }
    for (const b of doc.schedule?.batches ?? []) {
      for (const r of b.rules) {
        check('scheduleRules', 'schedule_rule', r.sourceId, { batch: { id: b.sourceId, status: b.status }, rule: r }, (target) => {
          const row = this.store.scheduleRules.ruleByIdForOwner(owner, target);
          return (
            !row || row.weekday !== r.weekday || row.startTime !== r.startTime || row.endTime !== r.endTime ||
            row.label !== r.label || row.active !== (b.status === 'active') || row.courseCode !== r.courseCode
          );
        });
      }
    }
    for (const x of doc.schedule?.exceptions ?? []) {
      check('scheduleExceptions', 'schedule_exception', x.sourceId, x, (target) => {
        const row = this.store.scheduleRules.exceptionByIdForOwner(owner, target);
        return !row || row.date !== x.date || row.kind !== x.kind || row.courseCode !== x.courseCode || row.label !== x.label;
      });
    }
    if (doc.preferences) {
      check('preferences', 'preferences', PREFERENCES_SOURCE_ID, doc.preferences, () => {
        const row = this.store.ownerPreferences.get(owner);
        return !row || row.prefsJson !== JSON.stringify(doc.preferences);
      });
    }
    for (const t of doc.watch?.targets ?? []) {
      check('watchTargets', 'watch_target', t.sourceId, t, (target) => {
        const row = this.store.assistantWatch.byRepoKey(owner, watchTargetKey(t.reference));
        if (!row || row.id !== target || row.state !== t.state) return true;
        // Events the source had are all still there, identity for identity.
        return t.events.some((e) => !this.store.assistantWatch.eventExists(target, e.kind, e.identity));
      });
    }

    if (doc.watch) {
      bump('watchSwitch', 'expected');
      bump('watchSwitch', 'present');
      if (this.store.assistantWatch.monitoringEnabled(owner) !== doc.watch.monitoringEnabled) bump('watchSwitch', 'drifted');
    }

    // The native ledger (ADR 0034), counts only. On a database that is not new, an active target whose
    // cursor sits at or before the cutoff (plus the skew margin) will read transitions the ledger cannot
    // place, and any withheld event is a notification that was never sent: neither is parity.
    const boundary = this.store.nativeTransitions.boundary();
    const held = this.store.assistantWatch.withheldCounts(owner);
    const cursorsBelow = boundary && !boundary.fresh
      ? this.store.assistantWatch.cursorsAtOrBefore(owner, Date.parse(boundary.cutoffAt) + NATIVE_LEGACY_SKEW_MS)
      : 0;
    // A native requested-changes card held because it cannot be told from a review the target delivered
    // is a notification that was not sent either.
    const heldCards = this.store.githubFeed.heldEventCount();
    const nativeLedger: NativeLedgerReport = {
      readable: boundary !== undefined,
      fresh: boundary?.fresh ?? false,
      withheldLegacy: held.legacyUnproven,
      withheldAmbiguous: held.ambiguousEvidence,
      cursorsAtOrBeforeCutoff: cursorsBelow,
      heldNativeCards: heldCards,
      clear: boundary !== undefined && held.legacyUnproven + held.ambiguousEvidence + cursorsBelow + heldCards === 0,
    };
    const totals = Object.values(cats);
    const ok = totals.every((c) => c.missing === 0 && c.changedAtSource === 0);
    const parity = ok && totals.every((c) => c.drifted === 0) && nativeLedger.clear;
    return { ok, parity, issues: [], categories: cats, nativeLedger };
  }
}

export interface VerifyCounts {
  expected: number;
  present: number;
  suppressed: number;
  missing: number;
  changedAtSource: number;
  drifted: number;
}

/** Counts only; never a repository or an event. */
export interface NativeLedgerReport {
  readonly readable: boolean;
  readonly fresh: boolean;
  readonly withheldLegacy: number;
  readonly withheldAmbiguous: number;
  readonly cursorsAtOrBeforeCutoff: number;
  /** Native requested-changes cards held, neither sent nor skipped (ADR 0034). */
  readonly heldNativeCards: number;
  /** Nothing withheld or held, no cursor below the cutoff, and the boundary readable. */
  readonly clear: boolean;
}

export interface VerifyReport {
  /** Nothing is missing and nothing changed at the source. */
  readonly ok: boolean;
  /** `ok`, and every present record still equals what the import wrote. */
  readonly parity: boolean;
  readonly issues: readonly ImportIssue[];
  readonly categories: Readonly<Record<string, VerifyCounts>>;
  readonly nativeLedger: NativeLedgerReport | null;
}

interface Plan {
  readonly conflicts: ImportIssue[];
  readonly task: Map<string, { disposition: Disposition; fp: string }>;
  readonly reminder: Map<string, { disposition: Disposition; fp: string }>;
  readonly capture: Map<string, { disposition: Disposition; fp: string }>;
  readonly rule: Map<string, { disposition: Disposition; fp: string }>;
  readonly exception: Map<string, { disposition: Disposition; fp: string }>;
  preferences: { disposition: Disposition; fp: string } | undefined;
  readonly target: Map<string, { disposition: Disposition; fp: string }>;
  /**
   * Source watch targets that are ALREADY targets here only because discovery found the
   * repository first (never imported). The import adopts them instead of colliding.
   */
  readonly adopt: Map<string, string>;
}

class DryRun extends Error {
  constructor() {
    super('dry run');
  }
}

/**
 * A time cursor is stored as one canonical instant, so two cursors for the same
 * moment are the same text. A branch name or a CI state is stored as it is.
 */
const cursorText = (surface: WatchSurface, cursor: string): string =>
  (TIME_CURSOR_SURFACES as readonly string[]).includes(surface) ? new Date(cursor).toISOString() : cursor;

const captureStatus = (c: ImportedCapture): 'open' | 'done' | 'archived' =>
  c.state === 'inbox' ? 'open' : c.state === 'archived' ? 'archived' : 'done';

const briefingTargets = (delivery: BriefingDelivery): readonly ('owner_dm' | 'briefing_channel')[] =>
  delivery === 'dm' ? ['owner_dm'] : delivery === 'channel' ? ['briefing_channel'] : ['owner_dm', 'briefing_channel'];
