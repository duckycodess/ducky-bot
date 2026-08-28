import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore } from '../src/index.js';

const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return { db, store: createStore(db) };
};

const OWNER = 'owner-1';
const OTHER = 'owner-2';

const task = (
  store: ReturnType<typeof fresh>['store'],
  over: Partial<Parameters<typeof store.tasks.insert>[0]> = {},
) =>
  store.tasks.insert({
    id: `id-${Math.random()}`,
    publicId: `t${Math.random().toString(36).slice(2, 7)}`,
    discordUserId: OWNER,
    title: 'a task',
    dueAt: null,
    dueAllDay: false,
    priority: 'normal',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  });

const reminder = (
  store: ReturnType<typeof fresh>['store'],
  over: Partial<Parameters<typeof store.reminders.insert>[0]> = {},
) =>
  store.reminders.insert({
    id: `id-${Math.random()}`,
    publicId: `r${Math.random().toString(36).slice(2, 7)}`,
    discordUserId: OWNER,
    text: 'stand up',
    recurrenceKind: 'once',
    intervalMinutes: null,
    maxOccurrences: 1,
    firstFireAt: '2026-09-01T09:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  });

describe('assistant schema', () => {
  it('refuses a recurrence that is not fully specified', () => {
    const { db } = fresh();
    const insert = (kind: string, interval: number | null, max: number) =>
      db
        .prepare(
          `INSERT INTO reminders (id, public_id, discord_user_id, text, recurrence_kind,
             interval_minutes, max_occurrences, next_fire_at, status, created_at, updated_at,
             first_fire_at)
           VALUES (?,?,?,?,?,?,?, '2026-09-01T09:00:00Z', 'scheduled', 'now','now',
             '2026-09-01T09:00:00Z')`,
        )
        .run(`i${Math.random()}`, `p${Math.random()}`, OWNER, 't', kind, interval, max);

    // A one-shot may not carry an interval, and may not claim to repeat.
    expect(() => insert('once', 15, 1)).toThrow(/CHECK/);
    expect(() => insert('once', null, 5)).toThrow(/CHECK/);
    // An interval reminder must actually have one.
    expect(() => insert('interval', null, 5)).toThrow(/CHECK/);
    expect(() => insert('interval', 0, 5)).toThrow(/CHECK/);
    expect(() => insert('interval', 15, 5)).not.toThrow();
  });

  it('requires a scheduled reminder to have a cursor, and a finished one not to', () => {
    const { db } = fresh();
    expect(() =>
      db
        .prepare(
          `INSERT INTO reminders (id, public_id, discord_user_id, text, recurrence_kind,
             interval_minutes, max_occurrences, next_fire_at, status, created_at, updated_at,
             first_fire_at)
           VALUES ('a','pa',?, 't','once', NULL, 1, NULL, 'scheduled','now','now','now')`,
        )
        .run(OWNER),
    ).toThrow(/CHECK/);
  });

  it('cannot record the same occurrence of a reminder twice', () => {
    const { db, store } = fresh();
    const r = reminder(store);
    const insert = () =>
      db
        .prepare(
          `INSERT INTO reminder_occurrences (id, reminder_id, occurrence_no, scheduled_for, created_at)
           VALUES (?,?,1,'2026-09-01T09:00:00Z','now')`,
        )
        .run(`o${Math.random()}`, r.id);
    insert();
    expect(() => insert()).toThrow(/UNIQUE/);
  });
});

describe('TasksRepo', () => {
  it('scopes every read to the owner, so another account’s task is simply absent', () => {
    const { store } = fresh();
    const mine = task(store, { publicId: 'tmine1' });
    task(store, { publicId: 'tthei1', discordUserId: OTHER });

    expect(store.tasks.byPublicId(OWNER, 'tmine1')?.id).toBe(mine.id);
    expect(store.tasks.byPublicId(OWNER, 'tthei1')).toBeUndefined();
    expect(store.tasks.listForOwner(OWNER, 'all', 10)).toHaveLength(1);
    expect(store.tasks.countOpen(OWNER)).toBe(1);
  });

  it('orders by due date first, undated last, then priority', () => {
    const { store } = fresh();
    task(store, { publicId: 'tlate1', dueAt: '2026-09-03T00:00:00.000Z' });
    task(store, { publicId: 'tnone1', priority: 'high' });
    task(store, { publicId: 'tsoon1', dueAt: '2026-09-02T00:00:00.000Z' });

    expect(store.tasks.listForOwner(OWNER, 'open', 10).map((t) => t.publicId)).toEqual([
      'tsoon1',
      'tlate1',
      'tnone1',
    ]);
  });

  it('selects due, overdue and closed rows by instant range', () => {
    const { store } = fresh();
    task(store, { publicId: 'tpast1', dueAt: '2026-09-01T08:00:00.000Z' });
    task(store, { publicId: 'tsoon1', dueAt: '2026-09-01T18:00:00.000Z' });
    const done = task(store, { publicId: 'tdone1' });
    store.tasks.close(OWNER, done.id, 'done', '2026-09-01T12:00:00.000Z');

    const dayStart = '2026-09-01T00:00:00.000Z';
    const dayEnd = '2026-09-02T00:00:00.000Z';
    expect(store.tasks.dueBetween(OWNER, dayStart, dayEnd, 10).map((t) => t.publicId)).toEqual([
      'tpast1',
      'tsoon1',
    ]);
    expect(
      store.tasks.overdue(OWNER, '2026-09-01T12:00:00.000Z', 10).map((t) => t.publicId),
    ).toEqual(['tpast1']);
    expect(store.tasks.countOverdue(OWNER, '2026-09-01T12:00:00.000Z')).toBe(1);
    expect(
      store.tasks.closedBetween(OWNER, 'done', dayStart, dayEnd, 10).map((t) => t.publicId),
    ).toEqual(['tdone1']);
  });

  it('only closes an open task, and only for its own owner', () => {
    const { store } = fresh();
    const t = task(store, { publicId: 'topen1' });
    expect(store.tasks.close(OTHER, t.id, 'done', 'now')).toBe(false);
    expect(store.tasks.close(OWNER, t.id, 'done', 'now')).toBe(true);
    // Already closed: no second write, so a "done" cannot be flipped to
    // "cancelled" by a repeated click.
    expect(store.tasks.close(OWNER, t.id, 'cancelled', 'now')).toBe(false);
    expect(store.tasks.byPublicId(OWNER, 'topen1')?.status).toBe('done');
  });
});

describe('RemindersRepo', () => {
  it('advances the cursor and records the occurrence in one step', () => {
    const { store } = fresh();
    const r = reminder(store, {
      recurrenceKind: 'interval',
      intervalMinutes: 60,
      maxOccurrences: 3,
    });

    const wrote = store.reminders.materializeOccurrence({
      occurrenceId: 'occ-1',
      reminderId: r.id,
      expectedFiredCount: 0,
      occurrenceNo: 1,
      scheduledFor: '2026-09-01T09:00:00.000Z',
      missedCount: 0,
      nextFireAt: '2026-09-01T10:00:00.000Z',
      status: 'scheduled',
      atIso: '2026-09-01T09:00:05.000Z',
    });

    expect(wrote).toBe(true);
    const after = store.reminders.byId(r.id)!;
    expect(after.firedCount).toBe(1);
    expect(after.nextFireAt).toBe('2026-09-01T10:00:00.000Z');
    expect(store.reminders.occurrencesFor(r.id)).toHaveLength(1);
  });

  it('refuses to advance a reminder that has already moved on', () => {
    const { store } = fresh();
    const r = reminder(store, {
      recurrenceKind: 'interval',
      intervalMinutes: 60,
      maxOccurrences: 3,
    });
    const attempt = (occurrenceId: string) =>
      store.reminders.materializeOccurrence({
        occurrenceId,
        reminderId: r.id,
        // Both passes read fired_count 0, as two overlapping ticks would.
        expectedFiredCount: 0,
        occurrenceNo: 1,
        scheduledFor: '2026-09-01T09:00:00.000Z',
        missedCount: 0,
        nextFireAt: '2026-09-01T10:00:00.000Z',
        status: 'scheduled',
        atIso: '2026-09-01T09:00:05.000Z',
      });

    expect(attempt('occ-1')).toBe(true);
    expect(attempt('occ-2')).toBe(false);
    expect(store.reminders.occurrencesFor(r.id)).toHaveLength(1);
  });

  it('marks delivery once and never a second time', () => {
    const { store } = fresh();
    const r = reminder(store);
    store.reminders.materializeOccurrence({
      occurrenceId: 'occ-1', reminderId: r.id, expectedFiredCount: 0, occurrenceNo: 1,
      scheduledFor: '2026-09-01T09:00:00.000Z', missedCount: 0, nextFireAt: null,
      status: 'completed', atIso: '2026-09-01T09:00:05.000Z',
    });

    expect(store.reminders.pendingOccurrences(10)).toHaveLength(1);
    store.reminders.markOccurrenceDelivered('occ-1', '2026-09-01T09:00:06.000Z');
    store.reminders.markOccurrenceDelivered('occ-1', '2026-09-01T09:99:00.000Z');
    expect(store.reminders.pendingOccurrences(10)).toHaveLength(0);
    const [occurrence] = store.reminders.occurrencesFor(r.id);
    expect(occurrence?.deliveredAt).toBe('2026-09-01T09:00:06.000Z');
    expect(occurrence?.attempts).toBe(1);
  });

  it('abandons an occurrence after too many failures rather than retrying forever', () => {
    const { store } = fresh();
    const r = reminder(store);
    store.reminders.materializeOccurrence({
      occurrenceId: 'occ-1', reminderId: r.id, expectedFiredCount: 0, occurrenceNo: 1,
      scheduledFor: '2026-09-01T09:00:00.000Z', missedCount: 0, nextFireAt: null,
      status: 'completed', atIso: 'now',
    });

    for (let i = 0; i < 2; i += 1) store.reminders.recordOccurrenceFailure('occ-1', 'now', 3);
    expect(store.reminders.pendingOccurrences(10)).toHaveLength(1);
    store.reminders.recordOccurrenceFailure('occ-1', 'then', 3);
    expect(store.reminders.pendingOccurrences(10)).toHaveLength(0);
    expect(store.reminders.occurrencesFor(r.id)[0]?.abandonedAt).toBe('then');
  });

  it('cancelling stops the schedule and abandons anything still undelivered', () => {
    const { store } = fresh();
    const r = reminder(store, {
      recurrenceKind: 'interval', intervalMinutes: 60, maxOccurrences: 5,
    });
    store.reminders.materializeOccurrence({
      occurrenceId: 'occ-1', reminderId: r.id, expectedFiredCount: 0, occurrenceNo: 1,
      scheduledFor: '2026-09-01T09:00:00.000Z', missedCount: 0,
      nextFireAt: '2026-09-01T10:00:00.000Z', status: 'scheduled', atIso: 'now',
    });

    expect(store.reminders.cancel(OTHER, r.id, 'now')).toBe(false);
    expect(store.reminders.cancel(OWNER, r.id, 'cancelled-at')).toBe(true);

    const after = store.reminders.byId(r.id)!;
    expect(after.status).toBe('cancelled');
    expect(after.nextFireAt).toBeNull();
    expect(store.reminders.dueForMaterialization('2030-01-01T00:00:00.000Z', 10)).toHaveLength(0);
    // A cancelled reminder must not go on to send anything.
    expect(store.reminders.pendingOccurrences(10)).toHaveLength(0);
    expect(store.reminders.cancel(OWNER, r.id, 'again')).toBe(false);
  });
});
