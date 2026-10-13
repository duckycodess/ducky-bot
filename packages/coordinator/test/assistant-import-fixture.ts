import { WATCH_EVENT_KINDS } from '@ducky/contracts';
import { acquireRuntimeLock, type RuntimeLockHandle, type Store } from '@ducky/persistence';
import type { ImportEnvironment } from '../src/domain/assistant-import.service.js';
import { OWNER } from './helpers.js';

/** Invented data only. Nothing here is, or resembles, a real record. */
export const MANILA = 'Asia/Manila';

export function importDoc(): Record<string, any> {
  return {
    schema: 'ducky-assistant-import/v1',
    profile: 'development',
    ownerId: OWNER,
    timeZone: MANILA,
    namespace: 'fixture',
    exportedAt: '2026-10-12T00:00:00Z',
    tasks: [
      {
        sourceId: 't-open', title: 'Water the plants', status: 'open', priority: 'normal',
        due: { kind: 'instant', at: '2026-10-20T15:59:00Z' },
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', closedAt: null,
        reminderPolicy: { enabled: true, offsetsMinutes: [60] },
      },
      {
        sourceId: 't-late', title: 'Return the book', status: 'open', priority: 'low',
        due: { kind: 'instant', at: '2026-10-11T10:00:00Z' },
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', closedAt: null,
        reminderPolicy: null,
      },
      {
        sourceId: 't-done', title: 'Pay the invoice', status: 'done', priority: 'high',
        due: { kind: 'date', date: '2026-09-30' },
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
        closedAt: '2026-09-29T00:00:00Z', reminderPolicy: null,
      },
    ],
    reminders: [
      {
        sourceId: 'r-pending', taskSourceId: 't-open', kind: 'offset', offsetMinutes: 60,
        fireAt: '2026-10-20T14:59:00Z', state: 'pending', deliveredAt: null, createdAt: '2026-09-01T00:00:00Z',
      },
      {
        sourceId: 'r-overdue', taskSourceId: 't-late', kind: 'offset', offsetMinutes: 60,
        fireAt: '2026-10-11T09:00:00Z', state: 'pending', deliveredAt: null, createdAt: '2026-09-01T00:00:00Z',
      },
      {
        sourceId: 'r-delivered', taskSourceId: 't-done', kind: 'offset', offsetMinutes: 1440,
        fireAt: '2026-09-29T15:59:00Z', state: 'delivered', deliveredAt: '2026-09-29T15:59:30Z',
        createdAt: '2026-09-01T00:00:00Z',
      },
      {
        sourceId: 'r-cancelled', taskSourceId: 't-done', kind: 'offset', offsetMinutes: 60,
        fireAt: '2026-09-30T14:59:00Z', state: 'cancelled', deliveredAt: null, createdAt: '2026-09-01T00:00:00Z',
      },
    ],
    captures: [
      { sourceId: 'c-inbox', text: 'a loose thought', state: 'inbox', createdAt: '2026-09-01T00:00:00Z', processedAt: null },
      { sourceId: 'c-gone', state: 'deleted', createdAt: '2026-09-01T00:00:00Z', processedAt: '2026-09-02T00:00:00Z' },
    ],
    schedule: {
      batches: [
        {
          sourceId: 'b-1', status: 'active',
          rules: [
            { sourceId: 'k-1', weekday: 1, startTime: '09:00', endTime: '10:30', label: 'Algebra',
              courseCode: 'MATH 1', section: null, room: 'Room 4', uncertain: [], effectiveFrom: null, effectiveUntil: null },
          ],
        },
        {
          sourceId: 'b-0', status: 'replaced',
          rules: [
            { sourceId: 'k-0', weekday: 3, startTime: '13:00', endTime: '14:00', label: 'Old class',
              courseCode: null, section: null, room: null, uncertain: ['room'], effectiveFrom: null, effectiveUntil: null },
          ],
        },
      ],
      exceptions: [
        { sourceId: 'x-1', date: '2026-10-27', courseCode: null, label: null, kind: 'cancelled', note: 'storm', createdAt: '2026-10-12T00:00:00Z' },
      ],
    },
    preferences: {
      timeZone: MANILA, morningEnabled: true, morningTime: '07:00', eveningEnabled: true, eveningTime: '21:00',
      weekendBriefings: true, lookaheadDays: 3, includeWeather: true, includeGithub: true, includeCaptures: true,
      includeMeal: false, assistantWording: false, defaultReminderOffsetsMinutes: [1440, 60],
    },
    briefingDeliveries: [{ kind: 'morning', localDate: '2026-10-12', status: 'delivered', at: '2026-10-12T00:00:10Z' }],
    watch: {
      monitoringEnabled: true,
      targets: [
        {
          sourceId: 'w-1', reference: 'Acme/Widgets', state: 'active', defaultBranch: 'main',
          lastObservedAt: '2026-10-12T00:00:00Z',
          checkpoints: [
            { surface: 'pulls', cursor: '2026-10-11T10:00:00Z', updatedAt: '2026-10-12T00:00:00Z' },
            { surface: 'default_branch', cursor: 'main', updatedAt: '2026-10-12T00:00:00Z' },
            { surface: 'runs', cursor: '2026-10-11T10:00:00Z', updatedAt: '2026-10-12T00:00:00Z' },
            { surface: 'ci_state', cursor: 'failing', updatedAt: '2026-10-12T00:00:00Z' },
          ],
          events: [
            { kind: 'pr_opened', identity: '12:opened', occurredAt: '2026-10-11T09:00:00Z',
              payload: { number: 12, title: 'Add a thing' }, alertedAt: null, digestedAt: '2026-10-12T00:00:00Z' },
            { kind: 'review_requested_changes', identity: '12:review:9', occurredAt: '2026-10-11T09:30:00Z',
              payload: { number: 12, title: 'Add a thing', summary: 'Please add tests' }, alertedAt: null, digestedAt: null },
          ],
        },
        {
          sourceId: 'w-2', reference: 'acme/muted', state: 'cancelled', defaultBranch: null, lastObservedAt: null,
          checkpoints: [], events: [],
        },
      ],
    },
  };
}

export const importEnv = (over: Partial<ImportEnvironment> = {}): ImportEnvironment => ({
  profile: 'development',
  ownerId: OWNER,
  timeZone: MANILA,
  importedPreferencesSelected: true,
  briefing: {
    enabled: true, morningAt: '07:00', eveningAt: '21:00', morningExplicit: false, eveningExplicit: false,
    delivery: 'dm',
  },
  weatherConfigured: true,
  // A test reader that can see everything: it proves the importer, not a live bridge.
  watchCapabilities: { observableKinds: [...WATCH_EVENT_KINDS], discovery: false },
  ...over,
});

/** The shared runtime lock, taken as the importer takes it. */
export const takeLock = (store: Store): RuntimeLockHandle => {
  const out = acquireRuntimeLock(store.db, 'importer', { host: 'test-host', pid: 424242, isPidAlive: () => true });
  if (!out.ok) throw new Error('lock unavailable in test');
  return out.handle;
};

/** Every row the importer could have written, so "nothing was written" is checkable. */
export const rowCounts = (store: Store): Record<string, number> => {
  const tables = [
    'tasks', 'reminders', 'reminder_occurrences', 'captures', 'schedule_rules', 'schedule_exceptions',
    'owner_preferences', 'briefing_deliveries', 'assistant_watch_targets', 'assistant_watch_checkpoints',
    'assistant_watch_events', 'assistant_import_identities',
  ];
  return Object.fromEntries(
    tables.map((t) => [t, Number((store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n)]),
  );
};
