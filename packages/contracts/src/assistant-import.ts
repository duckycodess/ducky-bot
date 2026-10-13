import { z } from 'zod';
import { cleanUntrusted } from './discord.js';
import { DISCORD_SNOWFLAKE_RE } from './ids.js';
import {
  ASSISTANT_IMPORT_MAX_BRIEFING_DELIVERIES, ASSISTANT_IMPORT_MAX_CAPTURES,
  ASSISTANT_IMPORT_MAX_EVENTS_PER_TARGET, ASSISTANT_IMPORT_MAX_REMINDERS,
  ASSISTANT_IMPORT_MAX_TASKS, ASSISTANT_IMPORT_MAX_WATCH_EVENTS,
  ASSISTANT_REMINDER_OFFSET_MAX_MINUTES, ASSISTANT_REMINDER_POLICY_MAX_OFFSETS,
  ASSISTANT_WATCH_MAX_TARGETS, CAPTURE_MAX, CAPTURE_MIN, SCHEDULE_EXCEPTIONS_MAX,
  SCHEDULE_RULES_MAX, TASK_TITLE_MAX, TASK_TITLE_MIN,
} from './limits.js';
import { DUCKY_PROFILES } from './profile.js';
import { SCHEDULE_EXCEPTION_KINDS, isCivilDate } from './schedule-rules.js';
import { TASK_PRIORITIES, TASK_STATES } from './assistant.js';
import { isValidTimeZone } from './time.js';
import {
  TIME_CURSOR_SURFACES, WATCH_EVENT_KINDS, WATCH_EVENT_SURFACE, WATCH_SURFACES,
  WatchEventPayloadSchema, watchTargetKey,
} from './assistant-watch.js';
import { GH_OWNER_RE, GH_REPO_RE } from './github.js';

/**
 * The interchange document: what an operator-run transformer hands the importer.
 *
 * It is STRICT in every sense. Unknown keys are refused (an active source value
 * Ducky cannot represent is a failure, not a thing to drop), every instant is an
 * explicit UTC instant, every date is a real calendar date, every list is
 * bounded, and every cross-reference must resolve. The importer validates the
 * WHOLE document before it writes anything, so a failure leaves nothing behind.
 *
 * Failures are reported as COUNTS per category and rule. A message that quoted a
 * field would put the owner's data into a log, which is the one thing this
 * boundary must not do.
 */

export const ASSISTANT_IMPORT_SCHEMA_ID = 'ducky-assistant-import/v1' as const;

const SourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** An explicit UTC instant, normalised so equal instants compare equal as text. */
const Instant = z
  .string()
  .max(32)
  .regex(UTC_INSTANT)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'instant')
  .transform((s) => new Date(s).toISOString());

const CivilDate = z.string().refine(isCivilDate, 'civil_date');
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const text = (min: number, max: number) =>
  z.string().transform(cleanUntrusted).pipe(z.string().min(min).max(max));
const optionalLabel = (max: number) =>
  z
    .string()
    .transform((s) => cleanUntrusted(s).trim())
    .pipe(z.string().min(1).max(max))
    .nullable();

const Due = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('instant'), at: Instant }),
    z.strictObject({ kind: z.literal('date'), date: CivilDate }),
  ])
  .nullable();

export const ImportedReminderPolicySchema = z.strictObject({
  enabled: z.boolean(),
  /** null means the owner's default list. */
  offsetsMinutes: z
    .array(z.number().int().min(1).max(ASSISTANT_REMINDER_OFFSET_MAX_MINUTES))
    .min(1)
    .max(ASSISTANT_REMINDER_POLICY_MAX_OFFSETS)
    .nullable(),
});
export type ImportedReminderPolicy = z.infer<typeof ImportedReminderPolicySchema>;

export const ImportedTaskSchema = z.strictObject({
  sourceId: SourceId,
  title: text(TASK_TITLE_MIN, TASK_TITLE_MAX),
  status: z.enum(TASK_STATES),
  priority: z.enum(TASK_PRIORITIES),
  due: Due,
  createdAt: Instant,
  updatedAt: Instant,
  closedAt: Instant.nullable(),
  reminderPolicy: ImportedReminderPolicySchema.nullable(),
});
export type ImportedTask = z.infer<typeof ImportedTaskSchema>;

export const IMPORTED_REMINDER_KINDS = ['offset', 'snooze'] as const;
export const IMPORTED_REMINDER_STATES = ['pending', 'delivered', 'cancelled'] as const;

export const ImportedReminderSchema = z.strictObject({
  sourceId: SourceId,
  taskSourceId: SourceId,
  kind: z.enum(IMPORTED_REMINDER_KINDS),
  offsetMinutes: z.number().int().min(0).max(ASSISTANT_REMINDER_OFFSET_MAX_MINUTES).nullable(),
  fireAt: Instant,
  state: z.enum(IMPORTED_REMINDER_STATES),
  deliveredAt: Instant.nullable(),
  createdAt: Instant,
});
export type ImportedReminder = z.infer<typeof ImportedReminderSchema>;

export const IMPORTED_CAPTURE_STATES = [
  'inbox', 'converted_to_task', 'saved_as_note', 'archived', 'deleted',
] as const;

export const ImportedCaptureSchema = z.strictObject({
  sourceId: SourceId,
  /** Absent for a deleted capture: only its identity is kept. */
  text: text(CAPTURE_MIN, CAPTURE_MAX).optional(),
  state: z.enum(IMPORTED_CAPTURE_STATES),
  createdAt: Instant,
  processedAt: Instant.nullable(),
});
export type ImportedCapture = z.infer<typeof ImportedCaptureSchema>;

export const ImportedScheduleRuleSchema = z.strictObject({
  sourceId: SourceId,
  weekday: z.number().int().min(0).max(6),
  startTime: ClockTime,
  endTime: ClockTime,
  label: text(1, 200),
  courseCode: optionalLabel(64),
  section: optionalLabel(64),
  room: optionalLabel(64),
  uncertain: z.array(z.string().min(1).max(40)).max(8),
  effectiveFrom: CivilDate.nullable(),
  effectiveUntil: CivilDate.nullable(),
});
export type ImportedScheduleRule = z.infer<typeof ImportedScheduleRuleSchema>;

export const ImportedScheduleBatchSchema = z.strictObject({
  sourceId: SourceId,
  /** Only an active batch drives behavior; a replaced one is kept inert. */
  status: z.enum(['active', 'replaced']),
  rules: z.array(ImportedScheduleRuleSchema).max(SCHEDULE_RULES_MAX),
});

export const ImportedScheduleExceptionSchema = z.strictObject({
  sourceId: SourceId,
  date: CivilDate,
  courseCode: optionalLabel(64),
  label: optionalLabel(200),
  kind: z.enum(SCHEDULE_EXCEPTION_KINDS),
  note: optionalLabel(200),
  createdAt: Instant,
});
export type ImportedScheduleException = z.infer<typeof ImportedScheduleExceptionSchema>;

export const ImportedPreferencesSchema = z.strictObject({
  timeZone: z.string().max(64).refine(isValidTimeZone, 'time_zone'),
  morningEnabled: z.boolean(),
  morningTime: ClockTime,
  eveningEnabled: z.boolean(),
  eveningTime: ClockTime,
  weekendBriefings: z.boolean(),
  lookaheadDays: z.number().int().min(0).max(30),
  includeWeather: z.boolean(),
  includeGithub: z.boolean(),
  includeCaptures: z.boolean(),
  /** Meals are not a migrated category; a preference that includes them is refused. */
  includeMeal: z.boolean(),
  /** AI wording of a briefing has no provider path here; an active one is refused. */
  assistantWording: z.boolean(),
  defaultReminderOffsetsMinutes: z
    .array(z.number().int().min(1).max(ASSISTANT_REMINDER_OFFSET_MAX_MINUTES))
    .min(1)
    .max(ASSISTANT_REMINDER_POLICY_MAX_OFFSETS),
});
export type ImportedPreferences = z.infer<typeof ImportedPreferencesSchema>;

export const ImportedBriefingDeliverySchema = z.strictObject({
  kind: z.enum(['morning', 'evening']),
  localDate: CivilDate,
  status: z.enum(['delivered', 'skipped', 'failed']),
  at: Instant,
});
export type ImportedBriefingDelivery = z.infer<typeof ImportedBriefingDeliverySchema>;

const Reference = z
  .string()
  .max(201)
  .refine((s) => {
    const parts = s.split('/');
    return parts.length === 2 && GH_OWNER_RE.test(parts[0]!) && GH_REPO_RE.test(parts[1]!);
  }, 'reference');

export const ImportedWatchCheckpointSchema = z.strictObject({
  surface: z.enum(WATCH_SURFACES),
  /** An instant for a time surface, a branch name or a CI state otherwise. */
  cursor: z.string().min(1).max(255),
  updatedAt: Instant,
});
export type ImportedWatchCheckpoint = z.infer<typeof ImportedWatchCheckpointSchema>;

export const ImportedWatchEventSchema = z.strictObject({
  kind: z.enum(WATCH_EVENT_KINDS),
  identity: z.string().min(1).max(200),
  occurredAt: Instant,
  payload: WatchEventPayloadSchema,
  alertedAt: Instant.nullable(),
  digestedAt: Instant.nullable(),
});
export type ImportedWatchEvent = z.infer<typeof ImportedWatchEventSchema>;

export const ImportedWatchTargetSchema = z.strictObject({
  sourceId: SourceId,
  reference: Reference,
  /** A muted or unmonitored source repository is kept cancelled, never dropped. */
  state: z.enum(['active', 'cancelled']),
  defaultBranch: z.string().min(1).max(255).nullable(),
  lastObservedAt: Instant.nullable(),
  checkpoints: z.array(ImportedWatchCheckpointSchema).max(WATCH_SURFACES.length),
  events: z.array(ImportedWatchEventSchema).max(ASSISTANT_IMPORT_MAX_EVENTS_PER_TARGET),
});
export type ImportedWatchTarget = z.infer<typeof ImportedWatchTargetSchema>;

export const ImportedWatchSchema = z.strictObject({
  /** The source's global switch. Off is refused: there is no paused state here. */
  monitoringEnabled: z.boolean(),
  targets: z.array(ImportedWatchTargetSchema).max(ASSISTANT_WATCH_MAX_TARGETS),
});

export const AssistantImportDocumentSchema = z.strictObject({
  schema: z.literal(ASSISTANT_IMPORT_SCHEMA_ID),
  /** Must equal the profile being imported into. A rehearsal file never lands in production. */
  profile: z.enum(DUCKY_PROFILES),
  /** Must equal the profile's FROZEN owner id; never a source preference. */
  ownerId: z.string().regex(DISCORD_SNOWFLAKE_RE),
  timeZone: z.string().max(64).refine(isValidTimeZone, 'time_zone'),
  /** A short stable label for the source, part of every identity. */
  namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  exportedAt: Instant,
  tasks: z.array(ImportedTaskSchema).max(ASSISTANT_IMPORT_MAX_TASKS).default([]),
  reminders: z.array(ImportedReminderSchema).max(ASSISTANT_IMPORT_MAX_REMINDERS).default([]),
  captures: z.array(ImportedCaptureSchema).max(ASSISTANT_IMPORT_MAX_CAPTURES).default([]),
  schedule: z
    .strictObject({
      batches: z.array(ImportedScheduleBatchSchema).max(8),
      exceptions: z.array(ImportedScheduleExceptionSchema).max(SCHEDULE_EXCEPTIONS_MAX),
    })
    .nullable()
    .default(null),
  preferences: ImportedPreferencesSchema.nullable().default(null),
  briefingDeliveries: z
    .array(ImportedBriefingDeliverySchema)
    .max(ASSISTANT_IMPORT_MAX_BRIEFING_DELIVERIES)
    .default([]),
  watch: ImportedWatchSchema.nullable().default(null),
});
export type AssistantImportDocument = z.infer<typeof AssistantImportDocumentSchema>;

/** One rule that failed, and how many records it failed for. Never a value. */
export interface ImportIssue {
  readonly category: string;
  readonly rule: string;
  readonly count: number;
}

export type ImportValidation =
  | { readonly ok: true; readonly doc: AssistantImportDocument }
  | { readonly ok: false; readonly issues: readonly ImportIssue[] };

/** The category an import issue is reported under. */
export const IMPORT_CATEGORIES = [
  'document', 'tasks', 'reminders', 'captures', 'schedule', 'preferences',
  'briefingDeliveries', 'watch',
] as const;

class IssueBag {
  private readonly counts = new Map<string, number>();
  add(category: string, rule: string, n = 1): void {
    if (n <= 0) return;
    const k = `${category}\u0000${rule}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }
  toList(): ImportIssue[] {
    return [...this.counts.entries()]
      .map(([k, count]) => {
        const [category, rule] = k.split('\u0000') as [string, string];
        return { category, rule, count };
      })
      .sort((a, b) => (a.category + a.rule < b.category + b.rule ? -1 : 1));
  }
  get empty(): boolean {
    return this.counts.size === 0;
  }
}

const dupes = <T>(items: readonly T[], key: (t: T) => string): number => {
  const seen = new Set<string>();
  let n = 0;
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) n += 1;
    seen.add(k);
  }
  return n;
};

/**
 * Validates a whole document and reports counts only.
 *
 * Two layers: the schema (shape, bounds, formats), then the checks that need
 * more than one field or more than one record. Both feed one report, so an
 * operator sees every failing rule at once rather than fixing one per run.
 */
export function validateAssistantImport(raw: unknown): ImportValidation {
  const bag = new IssueBag();
  const parsed = AssistantImportDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = typeof issue.path[0] === 'string' ? issue.path[0] : 'document';
      const category = (IMPORT_CATEGORIES as readonly string[]).includes(head) ? head : 'document';
      // Field names are the public contract's own. Array indexes and any value
      // the issue might quote are dropped; only the code stays.
      const where = issue.path.filter((p) => typeof p === 'string').join('.');
      bag.add(category, `${where || 'document'}:${issue.code}`);
    }
    return { ok: false, issues: bag.toList() };
  }
  const doc = parsed.data;
  semanticChecks(doc, bag);
  return bag.empty ? { ok: true, doc } : { ok: false, issues: bag.toList() };
}

function semanticChecks(doc: AssistantImportDocument, bag: IssueBag): void {
  // ---- tasks --------------------------------------------------------------
  bag.add('tasks', 'duplicate_source_id', dupes(doc.tasks, (t) => t.sourceId));
  const taskById = new Map(doc.tasks.map((t) => [t.sourceId, t] as const));
  for (const t of doc.tasks) {
    const closed = t.status !== 'open';
    if (closed !== (t.closedAt !== null)) bag.add('tasks', 'closed_at_mismatch');
    if (t.createdAt > t.updatedAt) bag.add('tasks', 'updated_before_created');
    if (t.closedAt !== null && t.closedAt < t.createdAt) bag.add('tasks', 'closed_before_created');
    // An all-day deadline has no time of day an offset could be subtracted from;
    // its reminder is the morning of the day. A custom offset list on one would
    // have to be invented into something, so it is refused instead.
    if (t.due?.kind === 'date' && t.reminderPolicy?.offsetsMinutes) {
      bag.add('tasks', 'all_day_with_offsets_unsupported');
    }
  }

  // ---- reminders ----------------------------------------------------------
  bag.add('reminders', 'duplicate_source_id', dupes(doc.reminders, (r) => r.sourceId));
  bag.add(
    'reminders',
    'duplicate_instant',
    dupes(doc.reminders, (r) => `${r.taskSourceId}|${r.kind}|${r.fireAt}`),
  );
  for (const r of doc.reminders) {
    const task = taskById.get(r.taskSourceId);
    if (!task) {
      bag.add('reminders', 'unknown_task');
    } else if (r.state === 'pending' && task.status !== 'open') {
      bag.add('reminders', 'pending_for_closed_task');
    }
    if ((r.state === 'delivered') !== (r.deliveredAt !== null)) {
      bag.add('reminders', 'delivered_at_mismatch');
    }
    if ((r.kind === 'offset') !== (r.offsetMinutes !== null)) bag.add('reminders', 'offset_mismatch');
  }

  // ---- captures -----------------------------------------------------------
  bag.add('captures', 'duplicate_source_id', dupes(doc.captures, (c) => c.sourceId));
  for (const c of doc.captures) {
    if ((c.state === 'deleted') !== (c.text === undefined)) bag.add('captures', 'text_presence');
  }

  // ---- schedule -----------------------------------------------------------
  if (doc.schedule) {
    const batches = doc.schedule.batches;
    if (batches.filter((b) => b.status === 'active').length > 1) {
      bag.add('schedule', 'multiple_active_batches');
    }
    bag.add('schedule', 'duplicate_batch_id', dupes(batches, (b) => b.sourceId));
    const rules = batches.flatMap((b) => b.rules);
    if (rules.length > SCHEDULE_RULES_MAX) bag.add('schedule', 'too_many_rules');
    bag.add('schedule', 'duplicate_rule_id', dupes(rules, (r) => r.sourceId));
    for (const r of rules) {
      if (r.startTime >= r.endTime) bag.add('schedule', 'end_not_after_start');
      if (r.effectiveFrom && r.effectiveUntil && r.effectiveFrom > r.effectiveUntil) {
        bag.add('schedule', 'effective_range_inverted');
      }
    }
    bag.add('schedule', 'duplicate_exception_id', dupes(doc.schedule.exceptions, (e) => e.sourceId));
  }

  // ---- preferences: unsupported ACTIVE behavior is refused, never dropped --
  const prefs = doc.preferences;
  if (prefs) {
    if (prefs.timeZone !== doc.timeZone) bag.add('preferences', 'time_zone_disagrees');
    if (prefs.includeMeal) bag.add('preferences', 'meal_unsupported');
    if (prefs.assistantWording) bag.add('preferences', 'assistant_wording_unsupported');
  }

  // ---- briefing delivery markers ------------------------------------------
  bag.add(
    'briefingDeliveries',
    'duplicate_slot',
    dupes(doc.briefingDeliveries, (b) => `${b.kind}|${b.localDate}`),
  );

  // ---- watch --------------------------------------------------------------
  const watch = doc.watch;
  if (watch) {
    if (!watch.monitoringEnabled) bag.add('watch', 'monitoring_disabled_unsupported');
    bag.add('watch', 'duplicate_source_id', dupes(watch.targets, (t) => t.sourceId));
    bag.add('watch', 'duplicate_reference', dupes(watch.targets, (t) => watchTargetKey(t.reference)));
    let events = 0;
    for (const t of watch.targets) {
      events += t.events.length;
      bag.add('watch', 'duplicate_checkpoint', dupes(t.checkpoints, (c) => c.surface));
      bag.add('watch', 'duplicate_event', dupes(t.events, (e) => `${e.kind}|${e.identity}`));
      for (const c of t.checkpoints) {
        if (
          (TIME_CURSOR_SURFACES as readonly string[]).includes(c.surface) &&
          !UTC_INSTANT.test(c.cursor)
        ) {
          bag.add('watch', 'cursor_not_an_instant');
        }
        if (c.surface === 'ci_state' && c.cursor !== 'failing' && c.cursor !== 'passing') {
          bag.add('watch', 'ci_state_unknown');
        }
      }
      const surfaces = new Set(t.checkpoints.map((c) => c.surface));
      for (const e of t.events) {
        // An event whose surface has no checkpoint says the cursor was lost:
        // importing it would let the surface be re-read as a first sight and the
        // event announced again.
        if (!surfaces.has(WATCH_EVENT_SURFACE[e.kind])) bag.add('watch', 'event_without_checkpoint');
      }
    }
    if (events > ASSISTANT_IMPORT_MAX_WATCH_EVENTS) bag.add('watch', 'too_many_events');
  }
}

/** Every distinct event kind a document's watch targets carry or may need. */
export function importedWatchKinds(doc: AssistantImportDocument): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of doc.watch?.targets ?? []) for (const e of t.events) out.add(e.kind);
  return out;
}
