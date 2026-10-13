import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { acquireRuntimeLock } from '../src/runtime-lock.js';
import { createStore, type Store } from '../src/index.js';

/** Invented data only. */
const OWNER = '100000000000000001';
const OTHER = '100000000000000009';
const T0 = '2026-10-01T00:00:00.000Z';

let store: Store;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  store = createStore(db);
});

const task = (id: string, over: Partial<Parameters<Store['assistantImport']['insertTask']>[0]> = {}) =>
  store.assistantImport.insertTask({
    id, publicId: `t${id.padEnd(5, 'x').slice(0, 5)}`, discordUserId: OWNER, title: 'Water the plants',
    dueAt: '2026-10-05T15:59:00.000Z', dueAllDay: false, priority: 'normal', status: 'open',
    createdAt: T0, updatedAt: T0, closedAt: null, reminderPolicy: null, ...over,
  });

describe('a task keeps its reminder policy', () => {
  it('round-trips a policy and treats absence as the native defaults', () => {
    task('a1', { reminderPolicy: { enabled: true, offsetsMinutes: [1440, 60] } });
    task('a2');
    const a1 = store.tasks.byId(OWNER, 'a1')!;
    const a2 = store.tasks.byId(OWNER, 'a2')!;
    expect(a1.reminderPolicy).toEqual({ enabled: true, offsetsMinutes: [1440, 60] });
    expect(a2.reminderPolicy).toBeNull();
  });

  it('reads an unreadable policy as the native default, never as silence', () => {
    task('a3');
    db.prepare(`UPDATE tasks SET reminder_policy = 'not json' WHERE id = 'a3'`).run();
    expect(store.tasks.byId(OWNER, 'a3')!.reminderPolicy).toBeNull();
  });

  it('writes a closed task as closed, without the open-only insert path', () => {
    task('a4', { status: 'done', closedAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' });
    const row = store.tasks.byId(OWNER, 'a4')!;
    expect(row.status).toBe('done');
    expect(row.closedAt).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('imported reminders are written in the state they already had', () => {
  const reminder = (id: string, over: Partial<Parameters<Store['assistantImport']['insertReminder']>[0]> = {}) =>
    store.assistantImport.insertReminder({
      id, publicId: `r${id.padEnd(5, 'x').slice(0, 5)}`, discordUserId: OWNER, taskId: 'a1', text: 'Water the plants',
      status: 'scheduled', fireAt: '2026-09-01T00:00:00.000Z', deliveredAt: null, createdAt: T0,
      closedAt: null, ...over,
    });

  beforeEach(() => task('a1'));

  it('keeps an overdue pending reminder scheduled, so the ledger delivers it late once', () => {
    reminder('p1');
    const row = store.reminders.byId('p1')!;
    expect(row.status).toBe('scheduled');
    expect(row.nextFireAt).toBe('2026-09-01T00:00:00.000Z');
    expect(store.reminders.dueForMaterialization('2026-10-10T00:00:00.000Z', 10).map((r) => r.id)).toEqual(['p1']);
  });

  it('writes a delivered reminder as completed with its delivered occurrence and no cursor', () => {
    reminder('d1', { status: 'completed', deliveredAt: '2026-09-01T00:00:30.000Z' });
    const row = store.reminders.byId('d1')!;
    expect(row.status).toBe('completed');
    expect(row.nextFireAt).toBeNull();
    expect(row.firedCount).toBe(1);
    const occ = store.reminders.occurrencesFor('d1');
    expect(occ).toHaveLength(1);
    expect(occ[0]!.deliveredAt).toBe('2026-09-01T00:00:30.000Z');
    // A settled reminder is never owed: nothing is materializable or pending.
    expect(store.reminders.dueForMaterialization('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
    expect(store.reminders.pendingOccurrences(10)).toEqual([]);
  });

  it('writes a cancelled reminder as cancelled and never owed', () => {
    reminder('c1', { status: 'cancelled', closedAt: '2026-09-02T00:00:00.000Z' });
    const row = store.reminders.byId('c1')!;
    expect(row.status).toBe('cancelled');
    expect(row.firedCount).toBe(0);
    expect(store.reminders.dueForMaterialization('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
  });
});

describe('the correlation ledger', () => {
  const live = (category: Parameters<Store['assistantImport']['recordLive']>[0]['category'], sourceId: string, targetId: string) =>
    store.assistantImport.recordLive({ namespace: 'fx', category, sourceId, targetId, fingerprint: 'f'.repeat(64), at: T0 });

  it('finds a live identity and refuses a second one for the same key', () => {
    task('a1');
    live('task', 's1', 'a1');
    expect(store.assistantImport.identity('fx', 'task', 's1')).toMatchObject({ state: 'live', targetId: 'a1' });
    expect(() => live('task', 's1', 'a1')).toThrow();
    // Namespaces and categories are part of the identity.
    expect(store.assistantImport.identity('other', 'task', 's1')).toBeUndefined();
    expect(store.assistantImport.identity('fx', 'capture', 's1')).toBeUndefined();
  });

  it('cannot hold a half-formed identity', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO assistant_import_identities (namespace, category, source_id, state, created_at)
         VALUES ('fx','task','x','live',?)`,
      ).run(T0),
    ).toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO assistant_import_identities
           (namespace, category, source_id, target_id, state, fingerprint, created_at, tombstoned_at)
         VALUES ('fx','task','y','t','tombstone','fp',?,?)`,
      ).run(T0, T0),
    ).toThrow();
  });

  it('turns a deleted task into an identity-only tombstone, whoever deleted it', () => {
    task('a1');
    live('task', 's1', 'a1');
    db.prepare('DELETE FROM tasks WHERE id = ?').run('a1');
    const id = store.assistantImport.identity('fx', 'task', 's1')!;
    expect(id.state).toBe('tombstone');
    expect(id.targetId).toBeNull();
    expect(id.fingerprint).toBeNull();
    expect(id.tombstonedAt).not.toBeNull();
  });

  it('tombstones a reminder when its task is deleted, through the foreign-key cascade', () => {
    task('a1');
    store.assistantImport.insertReminder({
      id: 'r1', publicId: 'rr1xx', discordUserId: OWNER, taskId: 'a1', text: 't', status: 'scheduled',
      fireAt: '2026-10-05T00:00:00.000Z', deliveredAt: null, createdAt: T0, closedAt: null,
    });
    live('task', 's1', 'a1');
    live('reminder', 'sr1', 'r1');
    db.prepare('DELETE FROM tasks WHERE id = ?').run('a1');
    expect(store.assistantImport.identity('fx', 'reminder', 'sr1')!.state).toBe('tombstone');
    expect(store.reminders.byId('r1')).toBeUndefined();
  });

  it('tombstones captures, rules, exceptions and watch targets on deletion', () => {
    store.assistantImport.insertCapture({
      id: 'c1', discordUserId: OWNER, content: 'x', status: 'open', createdAt: T0, updatedAt: T0,
    });
    store.scheduleRules.insertRule({
      id: 'k1', discordUserId: OWNER, batchKey: 'b', active: true, weekday: 1, startTime: '09:00',
      endTime: '10:00', label: 'L', courseCode: null, section: null, room: null, uncertain: [],
      effectiveFrom: null, effectiveUntil: null, createdAt: T0,
    });
    store.scheduleRules.insertException({
      id: 'x1', discordUserId: OWNER, date: '2026-10-06', courseCode: null, label: null,
      kind: 'cancelled', note: null, createdAt: T0,
    });
    store.assistantWatch.insertTarget({
      id: 'w1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/widgets', display: 'acme/widgets',
      defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
    });
    live('capture', 'sc', 'c1');
    live('schedule_rule', 'sk', 'k1');
    live('schedule_exception', 'sx', 'x1');
    live('watch_target', 'sw', 'w1');
    store.scheduleRules.deleteRule(OWNER, 'k1');
    store.scheduleRules.deleteException(OWNER, 'x1');
    store.captures.delete('c1');
    db.prepare('DELETE FROM assistant_watch_targets WHERE id = ?').run('w1');
    for (const [cat, sid] of [['capture', 'sc'], ['schedule_rule', 'sk'], ['schedule_exception', 'sx'], ['watch_target', 'sw']] as const) {
      expect(store.assistantImport.identity('fx', cat, sid)!.state, cat).toBe('tombstone');
    }
  });

  it('records a source-deleted record as a tombstone from the start', () => {
    store.assistantImport.recordTombstone({ namespace: 'fx', category: 'capture', sourceId: 'gone', at: T0 });
    expect(store.assistantImport.identity('fx', 'capture', 'gone')).toMatchObject({
      state: 'tombstone', targetId: null, fingerprint: null,
    });
  });

  it('reports counts only', () => {
    task('a1');
    live('task', 's1', 'a1');
    store.assistantImport.recordTombstone({ namespace: 'fx', category: 'task', sourceId: 'gone', at: T0 });
    const counts = store.assistantImport.identityCounts('fx');
    expect(counts.task).toEqual({ live: 1, tombstone: 1 });
    expect(counts.capture).toEqual({ live: 0, tombstone: 0 });
  });
});

describe('schedule rules and exceptions', () => {
  const rule = (id: string, over: Partial<Parameters<Store['scheduleRules']['insertRule']>[0]> = {}) =>
    store.scheduleRules.insertRule({
      id, discordUserId: OWNER, batchKey: 'b1', active: true, weekday: 1, startTime: '09:00',
      endTime: '10:30', label: 'Algebra', courseCode: 'MATH 1', section: null, room: null,
      uncertain: [], effectiveFrom: null, effectiveUntil: null, createdAt: T0, ...over,
    });

  it('returns only ACTIVE rules to a reader that wants behavior', () => {
    rule('k-active');
    rule('k-replaced', { active: false, batchKey: 'b0' });
    expect(store.scheduleRules.activeRules(OWNER).map((r) => r.id)).toEqual(['k-active']);
    expect(store.scheduleRules.listAllRulesForOwner(OWNER, 10).map((r) => r.id)).toEqual(['k-active', 'k-replaced']);
  });

  it('scopes every read and delete to the owner in SQL', () => {
    rule('k1');
    rule('k2', { discordUserId: OTHER });
    expect(store.scheduleRules.activeRules(OTHER).map((r) => r.id)).toEqual(['k2']);
    expect(store.scheduleRules.ruleByIdForOwner(OWNER, 'k2')).toBeUndefined();
    expect(store.scheduleRules.deleteRule(OWNER, 'k2')).toBe(0);
    expect(store.scheduleRules.deleteRule(OTHER, 'k2')).toBe(1);
  });

  it('refuses a rule that ends before it starts and an inverted effective range', () => {
    expect(() => rule('bad1', { startTime: '10:00', endTime: '09:00' })).toThrow();
    expect(() => rule('bad2', { effectiveFrom: '2026-12-01', effectiveUntil: '2026-01-01' })).toThrow();
    expect(() => rule('bad3', { weekday: 7 })).toThrow();
  });

  it('finds a handle across both tables and reports an ambiguous prefix as such', () => {
    rule('ab-rule');
    store.scheduleRules.insertException({
      id: 'ab-exc', discordUserId: OWNER, date: '2026-10-06', courseCode: null, label: null,
      kind: 'cancelled', note: null, createdAt: T0,
    });
    expect(store.scheduleRules.idsByPrefix(OWNER, 'ab-r')).toEqual([{ kind: 'rule', id: 'ab-rule' }]);
    expect(store.scheduleRules.idsByPrefix(OWNER, 'ab-')).toHaveLength(2);
    expect(store.scheduleRules.idsByPrefix(OTHER, 'ab-')).toEqual([]);
    // A handle is not a pattern: % and _ are literal.
    expect(store.scheduleRules.idsByPrefix(OWNER, '%')).toEqual([]);
    expect(store.scheduleRules.idsByPrefix(OWNER, 'a_-')).toEqual([]);
  });

  it('selects exceptions by half-open date window', () => {
    for (const [id, d] of [['e1', '2026-10-05'], ['e2', '2026-10-06'], ['e3', '2026-10-07']] as const) {
      store.scheduleRules.insertException({
        id, discordUserId: OWNER, date: d, courseCode: null, label: null, kind: 'cancelled', note: null, createdAt: T0,
      });
    }
    expect(store.scheduleRules.exceptionsBetween(OWNER, '2026-10-06', '2026-10-07').map((e) => e.id)).toEqual(['e2']);
  });
});

describe('notification-only watch targets', () => {
  const target = (id: string, key: string, over: Partial<Parameters<Store['assistantWatch']['insertTarget']>[0]> = {}) =>
    store.assistantWatch.insertTarget({
      id, publicId: `w${id.padEnd(5, 'x').slice(0, 5)}`, discordUserId: OWNER, repoKey: key, display: key,
      defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null, ...over,
    });
  const cp = (targetId: string, surface: 'pulls' | 'issues' | 'commits', due: string, over: { state?: 'unbaselined' | 'imported' | 'ready'; cursor?: string | null } = {}) =>
    store.assistantWatch.insertCheckpoint({
      targetId, surface, state: over.state ?? 'imported', cursor: over.cursor === undefined ? T0 : over.cursor,
      nextDueAt: due, updatedAt: T0,
    });

  it('keeps targets independent of the engineering allowlist', () => {
    // No repos row exists and none is needed.
    target('w1', 'acme/not-allowlisted');
    expect(store.assistantWatch.byRepoKey(OWNER, 'acme/not-allowlisted')?.state).toBe('active');
    const allowJobs = db.prepare(`SELECT COUNT(*) AS n FROM repos`).get() as { n: number };
    expect(Number(allowJobs.n)).toBe(0);
  });

  it('allows one target per owner and repository, case-folded by the caller', () => {
    target('w1', 'acme/widgets');
    expect(() => target('w2', 'acme/widgets')).toThrow();
    expect(() => target('w3', 'acme/widgets', { discordUserId: OTHER })).not.toThrow();
  });

  it('cancels with a preserved state and abandons only unsent alerts', () => {
    target('w1', 'acme/widgets');
    cp('w1', 'pulls', T0);
    store.assistantWatch.insertImportedEvent({
      id: 'e1', targetId: 'w1', kind: 'review_requested_changes', identity: '1:review:9',
      occurredAt: T0, payloadJson: '{}', alertedAt: null, digestedAt: null, createdAt: T0,
    });
    expect(store.assistantWatch.cancel(OWNER, 'w1', T0)).toBe(true);
    expect(store.assistantWatch.cancel(OWNER, 'w1', T0)).toBe(false);
    expect(store.assistantWatch.eventsFor('w1')[0]!.alertAbandonedAt).toBe(T0);
    expect(store.assistantWatch.byPublicId(OWNER, 'ww1xxx')?.state).toBe('cancelled');
    // Cancelled targets are never due and never counted active.
    expect(store.assistantWatch.dueCheckpoints('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
    expect(store.assistantWatch.countActive(OWNER)).toBe(0);
    expect(store.assistantWatch.countAll(OWNER)).toBe(1);
  });

  it('serves the longest-waiting checkpoint first and skips blocked ones', () => {
    target('w1', 'a/one');
    target('w2', 'a/two');
    cp('w1', 'pulls', '2026-10-01T00:10:00.000Z');
    cp('w2', 'pulls', '2026-10-01T00:05:00.000Z');
    cp('w2', 'issues', '2026-10-01T00:20:00.000Z');
    cp('w1', 'issues', '2026-10-01T00:01:00.000Z');
    store.assistantWatch.block('w1', 'issues', 'unobservable', T0);
    const due = store.assistantWatch.dueCheckpoints('2026-10-01T01:00:00.000Z', 10);
    expect(due.map((d) => `${d.targetId}:${d.surface}`)).toEqual(['w2:pulls', 'w1:pulls', 'w2:issues']);
    expect(store.assistantWatch.dueCheckpoints('2026-10-01T00:06:00.000Z', 10).map((d) => d.targetId)).toEqual(['w2']);
    expect(store.assistantWatch.dueCheckpoints('2026-10-01T01:00:00.000Z', 2)).toHaveLength(2);
  });

  it('commits an observation under a compare-and-set, once', () => {
    target('w1', 'acme/widgets');
    cp('w1', 'pulls', T0);
    const ev = (id: string, identity: string, settled = false) => ({
      id, kind: 'pr_opened' as const, identity, occurredAt: T0, payloadJson: '{}', settled,
    });
    const first = store.assistantWatch.commitObservation({
      targetId: 'w1', surface: 'pulls', expectedUpdatedAt: T0, cursor: '2026-10-02T00:00:00.000Z',
      nextDueAt: '2026-10-02T00:15:00.000Z', atIso: '2026-10-02T00:00:00.000Z',
      events: [ev('n1', '1:opened'), ev('n2', '2:opened', true)],
    });
    expect(first).toBe(2);
    // A second committer holding the old version changes nothing.
    const stale = store.assistantWatch.commitObservation({
      targetId: 'w1', surface: 'pulls', expectedUpdatedAt: T0, cursor: '2026-10-03T00:00:00.000Z',
      nextDueAt: T0, atIso: '2026-10-03T00:00:00.000Z', events: [ev('n3', '3:opened')],
    });
    expect(stale).toBeUndefined();
    expect(store.assistantWatch.checkpoint('w1', 'pulls')).toMatchObject({
      state: 'ready', cursor: '2026-10-02T00:00:00.000Z', pendingPage: 0,
    });
    // An event that is settled at birth is never announced; the other is owed.
    const events = store.assistantWatch.eventsFor('w1');
    expect(events.find((e) => e.identity === '2:opened')!.digestedAt).not.toBeNull();
    expect(events.find((e) => e.identity === '1:opened')!.digestedAt).toBeNull();
    // The identity is the dedupe: the same event again is recorded once.
    const again = store.assistantWatch.checkpoint('w1', 'pulls')!;
    expect(
      store.assistantWatch.commitObservation({
        targetId: 'w1', surface: 'pulls', expectedUpdatedAt: again.updatedAt, cursor: '2026-10-04T00:00:00.000Z',
        nextDueAt: T0, atIso: '2026-10-04T00:00:00.000Z', events: [ev('n4', '1:opened')],
      }),
    ).toBe(0);
  });

  it('keeps the committed cursor through pending progress and through a failure', () => {
    target('w1', 'acme/widgets');
    cp('w1', 'commits', T0);
    expect(
      store.assistantWatch.savePending({
        targetId: 'w1', surface: 'commits', expectedUpdatedAt: T0, pendingCursor: '2026-10-05T00:00:00.000Z',
        pendingPage: 2, nextDueAt: T0, atIso: '2026-10-05T00:00:01.000Z',
      }),
    ).toBe(true);
    const mid = store.assistantWatch.checkpoint('w1', 'commits')!;
    expect(mid).toMatchObject({ cursor: T0, pendingCursor: '2026-10-05T00:00:00.000Z', pendingPage: 2 });
    expect(
      store.assistantWatch.recordFailure({
        targetId: 'w1', surface: 'commits', expectedUpdatedAt: mid.updatedAt, nextDueAt: '2026-10-05T01:00:00.000Z',
        errorCode: 'read_failed', atIso: '2026-10-05T00:30:00.000Z',
      }),
    ).toBe(true);
    expect(store.assistantWatch.checkpoint('w1', 'commits')).toMatchObject({
      cursor: T0, pendingPage: 2, failures: 1, lastError: 'read_failed',
    });
  });

  it('cannot represent a baseline-less checkpoint that has a cursor, or the reverse', () => {
    target('w1', 'acme/widgets');
    expect(() => cp('w1', 'pulls', T0, { state: 'unbaselined', cursor: T0 })).toThrow();
    expect(() => cp('w1', 'issues', T0, { state: 'ready', cursor: null })).toThrow();
    expect(() => cp('w1', 'commits', T0, { state: 'unbaselined', cursor: null })).not.toThrow();
  });

  describe('events and settlement', () => {
    beforeEach(() => {
      target('w1', 'acme/widgets');
      const ev = (id: string, kind: Parameters<Store['assistantWatch']['insertImportedEvent']>[0]['kind'], identity: string, over: { alertedAt?: string | null; digestedAt?: string | null } = {}) =>
        store.assistantWatch.insertImportedEvent({
          id, targetId: 'w1', kind, identity, occurredAt: T0, payloadJson: '{"title":"t"}',
          alertedAt: over.alertedAt ?? null, digestedAt: over.digestedAt ?? null, createdAt: T0,
        });
      ev('e-alert', 'review_requested_changes', '1:review:1');
      ev('e-digest', 'pr_opened', '2:opened');
      ev('e-settled', 'pr_merged', '3:merged', { digestedAt: T0 });
      ev('e-marker', 'review_pending', '1:pending');
    });

    it('keeps a waiting alert out of the digest so it never appears twice', () => {
      expect(store.assistantWatch.pendingAlerts(10).map((e) => e.id)).toEqual(['e-alert']);
      expect(store.assistantWatch.undigested(10).map((e) => e.id)).toEqual(['e-digest']);
    });

    it('lets the digest carry an alert once it was sent, or its alert was abandoned', () => {
      expect(store.assistantWatch.markAlerted('e-alert', T0)).toBe(true);
      expect(store.assistantWatch.markAlerted('e-alert', T0)).toBe(false);
      expect(store.assistantWatch.undigested(10).map((e) => e.id).sort()).toEqual(['e-alert', 'e-digest']);
      store.assistantWatch.markDigested(['e-alert'], T0);
      expect(store.assistantWatch.undigested(10).map((e) => e.id)).toEqual(['e-digest']);
    });

    it('abandons an alert after repeated failures and hands it to the digest', () => {
      for (let i = 0; i < 3; i += 1) store.assistantWatch.recordAlertFailure('e-alert', T0, 3);
      expect(store.assistantWatch.pendingAlerts(10)).toEqual([]);
      expect(store.assistantWatch.undigested(10).map((e) => e.id)).toContain('e-alert');
    });

    it('never shows a silent marker, and settles it by itself', () => {
      expect(store.assistantWatch.undigested(10).map((e) => e.id)).not.toContain('e-marker');
      expect(store.assistantWatch.settleSilent(T0)).toBe(1);
      expect(store.assistantWatch.settleSilent(T0)).toBe(0);
    });

    it('scrubs the content of a settled event and keeps its identity', () => {
      expect(store.assistantWatch.scrubSettledPayloads('2099-01-01T00:00:00.000Z')).toBe(1);
      const settled = store.assistantWatch.eventsFor('w1').find((e) => e.id === 'e-settled')!;
      expect(settled.payloadJson).toBe('{}');
      expect(store.assistantWatch.eventExists('w1', 'pr_merged', '3:merged')).toBe(true);
      // An unsettled event keeps its content.
      expect(store.assistantWatch.eventsFor('w1').find((e) => e.id === 'e-digest')!.payloadJson).toContain('title');
    });

    it('excludes a cancelled target from alerts and digests', () => {
      store.assistantWatch.cancel(OWNER, 'w1', T0);
      expect(store.assistantWatch.pendingAlerts(10)).toEqual([]);
      expect(store.assistantWatch.undigested(10)).toEqual([]);
    });
  });

  it('sums the rolling call budget by minute and prunes old buckets', () => {
    store.assistantWatch.chargeCalls('2026-10-01T00:00', 5);
    store.assistantWatch.chargeCalls('2026-10-01T00:00', 3);
    store.assistantWatch.chargeCalls('2026-10-01T00:30', 4);
    expect(store.assistantWatch.callsSince('2026-10-01T00:00')).toBe(12);
    expect(store.assistantWatch.callsSince('2026-10-01T00:10')).toBe(4);
    expect(store.assistantWatch.pruneCalls('2026-10-01T00:10')).toBe(1);
    expect(store.assistantWatch.callsSince('2026-09-01T00:00')).toBe(4);
  });

  it('reports counts, never a name', () => {
    target('w1', 'acme/widgets');
    target('w2', 'acme/gadgets', { state: 'cancelled', cancelledAt: T0 });
    expect(store.assistantWatch.counts(OWNER)).toMatchObject({ targets: 2, active: 1, cancelled: 1 });
  });
});

describe('the shared runtime lock', () => {
  const same = { host: 'h1', pid: 100 };

  it('is taken once and refused to a second live holder on the same host', () => {
    const a = acquireRuntimeLock(db, 'coordinator', { ...same, isPidAlive: () => true });
    expect(a.ok).toBe(true);
    const b = acquireRuntimeLock(db, 'importer', { host: 'h1', pid: 200, isPidAlive: () => true });
    expect(b).toEqual({ ok: false, heldBy: 'coordinator' });
  });

  it('is recovered at once when the holder process is gone on the same host', () => {
    acquireRuntimeLock(db, 'coordinator', { ...same, isPidAlive: () => true });
    const b = acquireRuntimeLock(db, 'importer', { host: 'h1', pid: 200, isPidAlive: () => false });
    expect(b.ok).toBe(true);
  });

  it('trusts a fresh heartbeat from another host and recovers a stale one', () => {
    let now = Date.parse(T0);
    const clock = () => now;
    acquireRuntimeLock(db, 'coordinator', { host: 'h1', pid: 100, nowMs: clock });
    const refused = acquireRuntimeLock(db, 'importer', { host: 'h2', pid: 5, nowMs: clock });
    expect(refused).toEqual({ ok: false, heldBy: 'coordinator' });
    now += 4 * 60_000;
    expect(acquireRuntimeLock(db, 'importer', { host: 'h2', pid: 5, nowMs: clock }).ok).toBe(true);
  });

  it('refreshes while held, and tells a taken-over holder to stop', () => {
    let now = Date.parse(T0);
    const clock = () => now;
    const a = acquireRuntimeLock(db, 'coordinator', { host: 'h1', pid: 100, nowMs: clock, isPidAlive: () => true });
    if (!a.ok) throw new Error('expected the lock');
    now += 60_000;
    expect(a.handle.heartbeat()).toBe(true);
    expect(a.handle.held()).toBe(true);
    const b = acquireRuntimeLock(db, 'importer', { host: 'h1', pid: 200, nowMs: clock, isPidAlive: () => false });
    expect(b.ok).toBe(true);
    expect(a.handle.heartbeat()).toBe(false);
    expect(a.handle.held()).toBe(false);
  });

  it('releases, and a released handle neither refreshes nor holds', () => {
    const a = acquireRuntimeLock(db, 'importer', { ...same });
    if (!a.ok) throw new Error('expected the lock');
    a.handle.release();
    expect(a.handle.heartbeat()).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runtime_lock').get()).toEqual({ n: 0 });
    expect(acquireRuntimeLock(db, 'coordinator', { host: 'h1', pid: 300 }).ok).toBe(true);
  });

  it('lets the same process re-acquire its own lock', () => {
    expect(acquireRuntimeLock(db, 'coordinator', { ...same, isPidAlive: () => true }).ok).toBe(true);
    expect(acquireRuntimeLock(db, 'coordinator', { ...same, isPidAlive: () => true }).ok).toBe(true);
  });
});

describe('owner preferences', () => {
  it('stores text and never rewrites it', () => {
    store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: '{"a":1}', source: 'import', at: T0 });
    expect(store.ownerPreferences.get(OWNER)).toMatchObject({ prefsJson: '{"a":1}', source: 'import' });
    expect(() =>
      store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: '{"a":2}', source: 'import', at: T0 }),
    ).toThrow();
    expect(store.ownerPreferences.get(OTHER)).toBeUndefined();
  });
});
