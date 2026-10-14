import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore, type Store } from '../src/index.js';

/**
 * A checkpoint, its events, the held events it releases and its second
 * checkpoint change together or not at all. Faults are injected the only honest
 * way: by handing the repository something that fails PART WAY THROUGH.
 */
const OWNER = '100000000000000001';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-02T00:00:00.000Z';
let store: Store;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  store = createStore(db);
  store.assistantWatch.insertTarget({
    id: 't1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/widgets', display: 'acme/widgets',
    defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
  });
  store.assistantWatch.insertCheckpoint({ targetId: 't1', surface: 'pulls', state: 'imported', cursor: T0, nextDueAt: T0, updatedAt: T0 });
});

const ev = (id: string, kind: string, identity: string) => ({
  id, kind: kind as never, identity, occurredAt: T1, payloadJson: '{}', settled: false,
});
const snapshot = () => ({
  cp: db.prepare('SELECT state, cursor, pending_cursor, pending_page, boundary_known, updated_at FROM assistant_watch_checkpoints ORDER BY surface').all(),
  events: db.prepare('SELECT id, held FROM assistant_watch_events ORDER BY id').all(),
});

describe('commitObservation is all-or-nothing', () => {
  it('rolls the cursor back when an event fails part way', () => {
    const before = snapshot();
    expect(() =>
      store.assistantWatch.commitObservation({
        targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T1, nextDueAt: T1, atIso: T1,
        // The second event is of a kind with no surface: it fails AFTER the cursor moved and the first event was written.
        events: [ev('e1', 'pr_opened', '1:opened'), ev('e2', 'not_a_kind', '2:x')],
      }),
    ).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('rolls back events and cursor when the second checkpoint cannot be written', () => {
    const before = snapshot();
    expect(() =>
      store.assistantWatch.commitObservation({
        targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T1, nextDueAt: T1, atIso: T1,
        events: [ev('e1', 'pr_opened', '1:opened')],
        alsoSet: { surface: 'not_a_surface' as never, cursor: 'failing' },
      }),
    ).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('keeps held events held when a later commit fails', () => {
    expect(
      store.assistantWatch.savePending({
        targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, pendingCursor: T1, pendingPage: 1, nextDueAt: T0, atIso: T1,
        events: [ev('h1', 'pr_opened', '1:opened')],
      }),
    ).toBe(true);
    const mid = store.assistantWatch.checkpoint('t1', 'pulls')!;
    const before = snapshot();
    expect(() =>
      store.assistantWatch.commitObservation({
        targetId: 't1', surface: 'pulls', expectedUpdatedAt: mid.updatedAt, cursor: T1, nextDueAt: T1, atIso: T1,
        events: [ev('e2', 'bogus', '2:x')],
      }),
    ).toThrow();
    // The hold was NOT released by a commit that did not complete.
    expect(snapshot()).toEqual(before);
    expect(store.assistantWatch.eventsFor('t1').find((e) => e.id === 'h1')!.held).toBe(true);
  });

  it('writes all of it when nothing fails, and releases the holds in the same step', () => {
    store.assistantWatch.savePending({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, pendingCursor: T1, pendingPage: 1, nextDueAt: T0, atIso: T1,
      events: [ev('h1', 'pr_opened', '1:opened')],
    });
    const mid = store.assistantWatch.checkpoint('t1', 'pulls')!;
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: mid.updatedAt, cursor: T1, nextDueAt: T1, atIso: T1,
      events: [ev('e2', 'pr_merged', '2:merged')], boundaryKnown: true,
    });
    expect(store.assistantWatch.checkpoint('t1', 'pulls')).toMatchObject({ state: 'ready', cursor: T1, pendingPage: 0, boundaryKnown: true });
    expect(store.assistantWatch.eventsFor('t1').map((e) => e.held)).toEqual([false, false]);
  });

  it('is a savepoint inside an outer transaction, so an outer rollback still undoes it', () => {
    db.exec('BEGIN IMMEDIATE');
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T1, nextDueAt: T1, atIso: T1,
      events: [ev('e1', 'pr_opened', '1:opened')],
    });
    db.exec('ROLLBACK');
    expect(store.assistantWatch.checkpoint('t1', 'pulls')).toMatchObject({ state: 'imported', cursor: T0 });
    expect(store.assistantWatch.eventsFor('t1')).toEqual([]);
  });
});

describe('savePending and cancel are all-or-nothing too', () => {
  it('rolls the pending progress back when an event fails', () => {
    const before = snapshot();
    expect(() =>
      store.assistantWatch.savePending({
        targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, pendingCursor: T1, pendingPage: 2, nextDueAt: T0, atIso: T1,
        events: [ev('h1', 'pr_opened', '1:opened'), ev('h2', 'bogus', '2:x')],
      }),
    ).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('cancels and abandons the unsent alerts together', () => {
    store.assistantWatch.insertImportedEvent({
      id: 'a', targetId: 't1', kind: 'review_requested_changes', identity: '1:review:1', occurredAt: T0,
      payloadJson: '{}', alertedAt: null, digestedAt: null, createdAt: T0,
    });
    expect(store.assistantWatch.cancel(OWNER, 't1', T1)).toBe(true);
    expect(store.assistantWatch.eventsFor('t1')[0]!.alertAbandonedAt).toBe(T1);
  });
});

describe('what an observation says about the cursor boundary', () => {
  it('starts false and moves only when a pass says so', () => {
    expect(store.assistantWatch.checkpoint('t1', 'pulls')!.boundaryKnown).toBe(false);
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: T0, cursor: T0, nextDueAt: T1, atIso: T1, events: [],
    });
    expect(store.assistantWatch.checkpoint('t1', 'pulls')!.boundaryKnown).toBe(false);
    const c = store.assistantWatch.checkpoint('t1', 'pulls')!;
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: c.updatedAt, cursor: T1, nextDueAt: T1, atIso: T1, events: [], boundaryKnown: true,
    });
    expect(store.assistantWatch.checkpoint('t1', 'pulls')!.boundaryKnown).toBe(true);
    const d = store.assistantWatch.checkpoint('t1', 'pulls')!;
    // Omitted keeps it.
    store.assistantWatch.commitObservation({
      targetId: 't1', surface: 'pulls', expectedUpdatedAt: d.updatedAt, cursor: T1, nextDueAt: T1, atIso: T1, events: [],
    });
    expect(store.assistantWatch.checkpoint('t1', 'pulls')!.boundaryKnown).toBe(true);
  });
});

describe('observes() is scoped to its owner and to a healthy surface', () => {
  it('answers only for the owner who has the target', () => {
    expect(store.assistantWatch.observes(OWNER, 'acme/widgets', 'pulls')).toBe(true);
    expect(store.assistantWatch.observes('100000000000000099', 'acme/widgets', 'pulls')).toBe(false);
  });
  it('stops answering while the surface is failing, blocked, unbaselined or the target cancelled', () => {
    db.prepare(`UPDATE assistant_watch_checkpoints SET failures = 1`).run();
    expect(store.assistantWatch.observes(OWNER, 'acme/widgets', 'pulls')).toBe(false);
    db.prepare(`UPDATE assistant_watch_checkpoints SET failures = 0`).run();
    store.assistantWatch.block('t1', 'pulls', 'unobservable', T1);
    expect(store.assistantWatch.observes(OWNER, 'acme/widgets', 'pulls')).toBe(false);
    db.prepare(`UPDATE assistant_watch_checkpoints SET blocked_reason = NULL`).run();
    store.assistantWatch.cancel(OWNER, 't1', T1);
    expect(store.assistantWatch.observes(OWNER, 'acme/widgets', 'pulls')).toBe(false);
  });
});

describe('payload retention is bounded while identities stay', () => {
  const add = (id: string, identity: string, over: { held?: number; digestedAt?: string | null; createdAt?: string } = {}) => {
    db.prepare(
      `INSERT INTO assistant_watch_events
         (id, target_id, kind, surface, held, identity, occurred_at, payload_json, origin, digested_at, created_at)
       VALUES (?, 't1', 'pr_opened', 'pulls', ?, ?, ?, '{"title":"t"}', 'observed', ?, ?)`,
    ).run(id, over.held ?? 0, identity, T0, over.digestedAt ?? null, over.createdAt ?? T0);
  };
  const payload = (id: string): string =>
    (db.prepare('SELECT payload_json p FROM assistant_watch_events WHERE id = ?').get(id) as { p: string }).p;
  const CUTOFF = '2026-09-01T00:00:00.000Z';

  it('empties digested, long-held and cancelled-target content but never the identity', () => {
    add('digested', '1:o', { digestedAt: '2026-08-01T00:00:00.000Z' });
    add('held-old', '2:o', { held: 1, createdAt: '2026-08-01T00:00:00.000Z' });
    add('held-new', '3:o', { held: 1, createdAt: '2026-09-15T00:00:00.000Z' });
    add('recent', '4:o', { digestedAt: '2026-09-15T00:00:00.000Z' });
    add('undigested', '5:o');
    expect(store.assistantWatch.scrubSettledPayloads(CUTOFF)).toBe(2);
    expect(payload('digested')).toBe('{}');
    expect(payload('held-old')).toBe('{}');
    expect(payload('held-new')).toContain('title');
    expect(payload('recent')).toContain('title');
    expect(payload('undigested')).toContain('title');
    expect(store.assistantWatch.eventExists('t1', 'pr_opened', '1:o')).toBe(true);
    expect(store.assistantWatch.eventExists('t1', 'pr_opened', '2:o')).toBe(true);
  });

  it('empties the content of events whose target was cancelled long ago', () => {
    add('x', '6:o');
    db.prepare(`UPDATE assistant_watch_targets SET state = 'cancelled', cancelled_at = '2026-08-01T00:00:00.000Z' WHERE id = 't1'`).run();
    expect(store.assistantWatch.scrubSettledPayloads(CUTOFF)).toBe(1);
    expect(payload('x')).toBe('{}');
    expect(store.assistantWatch.eventExists('t1', 'pr_opened', '6:o')).toBe(true);
  });
});
