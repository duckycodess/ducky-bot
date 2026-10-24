import { describe, expect, it } from 'vitest';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import {
  ROLLBACK_DELTA_SCHEMA, buildRollbackDelta, deltaCounts, type CategoryDelta, type RollbackDelta,
} from '../src/domain/rollback-delta.service.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MANILA, importDoc, importEnv, takeLock } from './assistant-import-fixture.js';

/**
 * The rollback-delta export, over a real imported database and real native use.
 * Invented data only.
 *
 * "Replay" below is a MODEL of the source built from the import document, to prove
 * the export is complete and idempotent. It is not a source bridge and proves none
 * exists.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;

const boot = () => {
  const clock = new TestClock(NOW, MANILA);
  const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA } });
  const apply = (doc: unknown = importDoc()) => {
    const lock = takeLock(h.store);
    try {
      return new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() })
        .run(doc, { apply: true, lock });
    } finally {
      lock.release();
    }
  };
  return { h, clock, apply };
};

const exportDelta = (h: Harness, over: { rowCap?: number } = {}): RollbackDelta =>
  buildRollbackDelta({ store: h.store, ownerId: OWNER, profile: 'development', nowIso: '2026-10-14T00:00:00.000Z', ...over });

const target = (h: Harness, category: 'task' | 'reminder' | 'capture' | 'schedule_rule' | 'schedule_exception' | 'watch_target', sourceId: string) =>
  h.store.assistantImport.identity('fixture', category, sourceId)!.targetId!;
const pub = (h: Harness, category: 'task' | 'reminder', sourceId: string) => {
  const id = target(h, category, sourceId);
  return category === 'task' ? h.store.tasks.byId(OWNER, id)!.publicId : h.store.reminders.byId(id)!.publicId;
};
const names = (d: CategoryDelta, key: 'title' | 'status' | 'text' | 'content' = 'title') =>
  [...d.changed.map((c) => String(c.record[key])), ...d.added.map((a) => String(a[key]))].sort();

describe('right after an import there is nothing to roll back', () => {
  it('reports every imported record as unchanged, and says it is complete', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    const d = exportDelta(h);
    expect(d.schema).toBe(ROLLBACK_DELTA_SCHEMA);
    expect(d.complete).toBe(true);
    expect(d.incomplete).toEqual([]);
    expect(d.tasks).toMatchObject({ unchanged: 3, added: [], deleted: [] });
    expect(d.tasks.changed).toEqual([]);
    expect(d.reminders.unchanged).toBe(4);
    expect(d.captures.unchanged).toBe(1);
    expect(d.scheduleRules.unchanged).toBe(2);
    expect(d.scheduleExceptions.unchanged).toBe(1);
    expect(d.preferences.unchanged).toBe(1);
    expect(d.watchTargets.unchanged).toBe(2);
    expect(d.baseline.namespaces).toHaveLength(1);
    expect(d.baseline.namespaces[0]!.importedAt).toBe(NOW);
    h.close();
  });

  it('is byte-for-byte the same when exported twice', () => {
    const { h, apply } = boot();
    apply();
    expect(JSON.stringify(exportDelta(h))).toBe(JSON.stringify(exportDelta(h)));
    h.close();
  });
});

describe('what the owner and Ducky did since', () => {
  const act = () => {
    const ctx = boot();
    const { h, clock } = ctx;
    const doc = importDoc() as Record<string, any>;
    doc['schedule'].batches[1].replacedAt = '2026-09-20T00:00:00Z';
    ctx.apply(doc);
    clock.advance(10 * MIN);
    // edits, completions and snoozes
    const open = pub(h, 'task', 't-open');
    h.app.tasks.setDeadline(h.owner, open, h.app.tasks.parseDeadline('2026-10-25 17:00'));
    h.app.tasks.snooze(h.owner, open);
    h.app.tasks.complete(h.owner, pub(h, 'task', 't-late'));
    // native additions
    const native = h.app.tasks.add(h.owner, { title: 'A native task' });
    h.app.reminders.add(h.owner, { text: 'A native reminder', at: '2026-10-30 09:00' });
    // a cancelled reminder
    h.app.reminders.cancel(h.owner, pub(h, 'reminder', 'r-overdue'));
    // deletions, each by its own path
    h.app.forget.forgetEntity(h.owner, 'schedule', target(h, 'schedule_exception', 'x-1').slice(0, 8));
    h.app.captures.delete(h.owner, target(h, 'capture', 'c-inbox'));
    h.store.withDeletionCause('retention', () => {
      h.store.retention.deleteClosedTasks('2026-10-12T00:00:00.000Z', 10);
    });
    // watch and schedule state
    h.app.assistantWatch.cancel(h.owner, h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!.publicId);
    h.store.assistantWatch.insertTarget({
      id: 'disc-1', publicId: 'wzzzzz', discordUserId: OWNER, repoKey: 'acme/found', display: 'acme/found',
      defaultBranch: null, state: 'active', lastObservedAt: null, createdAt: clock.nowIso(), cancelledAt: null,
    });
    // Both owner controls, through their services: the same writes the commands make.
    expect(h.app.assistantWatch.setMonitoring(h.owner, false)).toMatchObject({ ok: true, changed: true });
    const preview = h.app.schedules.previewRollback(h.owner);
    expect(preview.ok && h.app.schedules.confirmRollback(h.owner, preview.code)).toMatchObject({ ok: true });
    h.store.briefings.insertSettled({
      id: 'slot-new', discordUserId: OWNER, kind: 'evening', dayKey: '2026-10-13', target: 'owner_dm',
      dueAt: clock.nowIso(), status: 'delivered', settledAt: clock.nowIso(),
    });
    return { ...ctx, native };
  };

  it('lists changed imported records with their identity, and the native ones as added', () => {
    const { h, native } = act();
    const d = exportDelta(h);
    expect(d.complete).toBe(true);
    // edited (deadline), completed
    expect(names(d.tasks)).toEqual(['A native task', 'Return the book', 'Water the plants']);
    expect(d.tasks.changed.map((c) => c.identity.sourceId).sort()).toEqual(['t-late', 't-open']);
    expect(d.tasks.changed.every((c) => c.baseline === 'known')).toBe(true);
    expect(d.tasks.added).toHaveLength(1);
    expect(d.tasks.added[0]!['handle']).toBe(native.publicId);
    // The retention pass removed the finished, imported task: identity and cause only.
    expect(d.tasks.deleted).toEqual([
      { identity: { namespace: 'fixture', category: 'task', sourceId: 't-done' }, cause: 'retention' },
    ]);
    h.close();
  });

  it('carries snoozes, cancellations and delivered occurrences with the reminders', () => {
    const { h } = act();
    const d = exportDelta(h);
    // r-overdue cancelled by the owner; r-pending resynced by the deadline edit.
    expect(d.reminders.changed.map((c) => c.identity.sourceId).sort()).toEqual(['r-overdue', 'r-pending']);
    for (const c of d.reminders.changed) expect(c.record['status']).toBe('cancelled');
    // The snooze and the native reminder are added, each linked to its task.
    const added = d.reminders.added;
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(added.some((r) => (r['task'] as { identity?: { sourceId: string } } | null)?.identity?.sourceId === 't-open')).toBe(true);
    expect(added.every((r) => Array.isArray(r['occurrences']))).toBe(true);
    // Reminders of the retention-deleted task are gone with it, each with the cause.
    expect(d.reminders.deleted.map((x) => x.identity.sourceId).sort()).toEqual(['r-cancelled', 'r-delivered']);
    expect(new Set(d.reminders.deleted.map((x) => x.cause))).toEqual(new Set(['retention']));
    h.close();
  });

  it('tells Forget, an owner deletion and retention apart, by one word', () => {
    const { h } = act();
    const d = exportDelta(h);
    expect(d.scheduleExceptions.deleted).toEqual([
      { identity: { namespace: 'fixture', category: 'schedule_exception', sourceId: 'x-1' }, cause: 'forget' },
    ]);
    expect(d.captures.deleted).toEqual([
      // Deleted at the source before the import: it never existed here, and nothing is to be undone.
      { identity: { namespace: 'fixture', category: 'capture', sourceId: 'c-gone' }, cause: 'import_suppressed' },
      { identity: { namespace: 'fixture', category: 'capture', sourceId: 'c-inbox' }, cause: 'owner_delete' },
    ]);
    expect(d.tasks.deleted[0]!.cause).toBe('retention');
    h.close();
  });

  it('carries the watch, schedule, briefing and switch state', () => {
    const { h } = act();
    const d = exportDelta(h);
    expect(d.watchTargets.changed.map((c) => c.record['state'])).toEqual(['cancelled']);
    expect(d.watchTargets.added.map((a) => a['repoKey'])).toEqual(['acme/found']);
    // The rollback flipped the batches, and nothing was deleted.
    expect(d.scheduleRules.changed).toHaveLength(2);
    expect(d.scheduleRules.deleted).toEqual([]);
    expect(d.state.watchMonitoringEnabled).toBe(false);
    expect(d.state.briefingSlots.some((s) => s['dayKey'] === '2026-10-13' && s['kind'] === 'evening')).toBe(true);
    expect(d.state.watchCheckpoints.length).toBeGreaterThan(0);
    // Events Ducky settled or found since: the imported event the owner's briefing/alert has not touched is NOT here.
    expect(d.state.watchEvents.every((e) => e['origin'] === 'observed' || e['alertedAt'] != null || e['digestedAt'] != null || e['alertAbandonedAt'] != null)).toBe(true);
    h.close();
  });

  it('is deterministic and replays to the state Ducky is in, twice over', () => {
    const { h } = act();
    const d = exportDelta(h);
    expect(JSON.stringify(exportDelta(h))).toBe(JSON.stringify(d));

    // A model of the source, built from the import document alone.
    const doc = importDoc() as Record<string, any>;
    type Model = { tasks: Map<string, { title: string; status: string }>; captures: Set<string>; targets: Map<string, string> };
    const source = (): Model => ({
      tasks: new Map((doc['tasks'] as any[]).map((t) => [t.sourceId as string, { title: t.title as string, status: t.status === 'open' ? 'open' : t.status as string }])),
      captures: new Set(['c-inbox']),
      targets: new Map([['w-1', 'active'], ['w-2', 'cancelled']]),
    });
    const replay = (m: Model, delta: RollbackDelta): Model => {
      for (const c of delta.tasks.changed) m.tasks.set(c.identity.sourceId, { title: String(c.record['title']), status: String(c.record['status']) });
      for (const x of delta.tasks.deleted) m.tasks.delete(x.identity.sourceId);
      for (const a of delta.tasks.added) m.tasks.set(`native:${String(a['handle'])}`, { title: String(a['title']), status: String(a['status']) });
      for (const x of delta.captures.deleted) m.captures.delete(x.identity.sourceId);
      for (const c of delta.watchTargets.changed) m.targets.set(c.identity.sourceId, String(c.record['state']));
      return m;
    };
    const once = replay(source(), d);
    const twice = replay(replay(source(), d), d);
    expect([...twice.tasks]).toEqual([...once.tasks]);

    // The model now equals what Ducky holds, record for record.
    const live = new Map<string, { title: string; status: string }>();
    for (const t of h.app.tasks.list(h.owner, 'all', 100)) live.set(t.title, { title: t.title, status: t.status });
    const fromModel = new Map([...once.tasks.values()].map((t) => [t.title, t]));
    expect([...fromModel].sort()).toEqual([...live].sort());
    expect([...once.captures]).toEqual([]);
    expect(once.targets.get('w-1')).toBe('cancelled');
    h.close();
  });

  it('puts counts on the terminal and no record content anywhere', () => {
    const { h } = act();
    const counts = JSON.stringify(deltaCounts(exportDelta(h)));
    for (const text of ['Water the plants', 'Return the book', 'A native task', 'a loose thought', 'acme', 'Widgets']) {
      expect(counts).not.toContain(text);
    }
    h.close();
  });
});

describe('what it refuses to claim', () => {
  it('is incomplete when a deletion has no recorded cause, and never invents one', () => {
    const { h, apply } = boot();
    apply();
    // A deletion that reached the database with no deletion path wrapped around it.
    h.store.db.prepare('DELETE FROM captures WHERE id = ?').run(target(h, 'capture', 'c-inbox'));
    const d = exportDelta(h);
    expect(d.complete).toBe(false);
    expect(d.incomplete).toEqual([{ category: 'capture', rule: 'deletion_cause_unknown', count: 1 }]);
    expect(d.captures.deleted).toContainEqual(
      { identity: { namespace: 'fixture', category: 'capture', sourceId: 'c-inbox' }, cause: 'unknown' },
    );
    h.close();
  });

  it('is incomplete when a record has no baseline, and exports it in full flagged unknown', () => {
    const { h, apply } = boot();
    apply();
    h.store.db.prepare("UPDATE assistant_import_identities SET stored_hash = NULL WHERE category = 'capture'").run();
    const d = exportDelta(h);
    expect(d.complete).toBe(false);
    expect(d.incomplete).toContainEqual({ category: 'capture', rule: 'baseline_unknown', count: 1 });
    expect(d.captures.changed[0]).toMatchObject({ baseline: 'unknown' });
    h.close();
  });

  it('is incomplete when a table is past the read cap', () => {
    const { h, apply } = boot();
    apply();
    const d = exportDelta(h, { rowCap: 2 });
    expect(d.complete).toBe(false);
    expect(d.incomplete.some((i) => i.rule === 'over_cap')).toBe(true);
    h.close();
  });

  it('leaves a tombstone with no content, only identity and a cause', () => {
    const { h, apply } = boot();
    apply();
    h.app.forget.forgetEntity(h.owner, 'task', pub(h, 'task', 't-late'));
    const row = h.store.db
      .prepare("SELECT * FROM assistant_import_identities WHERE category = 'task' AND source_id = 't-late'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({ state: 'tombstone', target_id: null, fingerprint: null, stored_hash: null, tombstone_cause: 'forget' });
    // Nothing in the whole row is the deleted record's text.
    expect(JSON.stringify(row)).not.toContain('Return the book');
    h.close();
  });

  it('does not export Forget as a deletion of content: no title survives for a deleted record', () => {
    const { h, apply } = boot();
    apply();
    h.app.forget.forgetEntity(h.owner, 'task', pub(h, 'task', 't-late'));
    expect(JSON.stringify(exportDelta(h))).not.toContain('Return the book');
    h.close();
  });
});

describe('what a crash or a concurrent writer cannot be allowed to hide', () => {
  it('is incomplete when a cause row was left behind by a process that died mid-deletion', () => {
    const { h, apply } = boot();
    apply();
    h.store.db.prepare("INSERT INTO deletion_context (id, cause) VALUES (1, 'retention')").run();
    const d = exportDelta(h);
    expect(d.complete).toBe(false);
    expect(d.incomplete).toContainEqual({ category: 'deletion', rule: 'deletion_context_stale', count: 1 });
    h.close();
  });

  it('is incomplete when the snapshot breaks a foreign key', () => {
    const { h, apply } = boot();
    apply();
    h.store.db.exec('PRAGMA foreign_keys = OFF');
    h.store.db.prepare(
      `INSERT INTO reminder_occurrences (id, reminder_id, occurrence_no, scheduled_for, created_at)
       VALUES ('o-bad','no-such-reminder',1,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`,
    ).run();
    const d = exportDelta(h);
    expect(d.complete).toBe(false);
    expect(d.incomplete.some((i) => i.rule === 'foreign_key_violation')).toBe(true);
    h.close();
  });

  it('prints a presence count for the monitoring setting, never its value', () => {
    const { h, apply } = boot();
    apply();
    h.store.assistantWatch.setMonitoring(OWNER, false, NOW);
    const counts = JSON.stringify(deltaCounts(exportDelta(h)));
    expect(counts).not.toContain('watchMonitoringEnabled');
    expect(counts).toContain('"watchMonitoringSettingPresent":1');
    expect(counts).not.toContain('false');
    h.close();
  });

  it('includes an alert Ducky abandoned after the import', () => {
    const { h, apply } = boot();
    apply();
    const target = h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!;
    const alert = h.store.assistantWatch.eventsFor(target.id).find((e) => e.kind === 'review_requested_changes')!;
    h.store.assistantWatch.recordAlertFailure(alert.id, '2026-10-13T01:00:00.000Z', 1);
    const d = exportDelta(h);
    expect(d.state.watchEvents.some((e) => e['kind'] === 'review_requested_changes' && e['alertAbandonedAt'] != null)).toBe(true);
    h.close();
  });
});

describe('the v4 export says what exact native reconciliation recorded', () => {
  const claim = (h: Harness) => {
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'pr_opened', item: '7', stamp: null, hash: null, attempt: null }, 'feed_event', 'f1', NOW, NOW);
    h.store.nativeTransitions.markNativeDelivered('feed_event', 'f1', 'owner_dm', NOW);
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'commit', item: 'abc1234', stamp: null, hash: null, attempt: null }, 'feed_commit', 'abc1234', NOW, NOW);
  };

  it('carries pause periods, the ledger boundary and every receipt and reservation, identifiers only', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    h.store.assistantWatch.setMonitoring(OWNER, false, NOW, 'import');
    claim(h);
    const d = exportDelta(h);
    expect(d.schema).toBe(ROLLBACK_DELTA_SCHEMA);
    expect(d.schema).toBe('ducky-rollback-delta/v5');
    expect(d.complete).toBe(true);
    expect(d.state.pausePeriods).toEqual([
      expect.objectContaining({ startedAt: null, startedOrigin: 'import', startBoundAt: NOW, endedAt: null }),
    ]);
    expect(d.state.nativeLedger.boundary).toMatchObject({ fresh: 1 });
    expect(d.state.nativeLedger.claims.map((c) => `${c['state']}:${c['kind']}:${c['item']}`).sort())
      .toEqual(['delivered:pr_opened:7', 'reserved:commit:abc1234']);
    const counts = deltaCounts(d) as { state: Record<string, number> };
    expect(counts.state).toMatchObject({ pausePeriods: 1, nativeClaims: 2 });
    // Counts only on the terminal: nothing about a repository leaves it.
    expect(JSON.stringify(counts)).not.toContain('acme');
    h.close();
  });

  it('marks a withheld event and an event a native receipt settled, which is neither delivered nor baseline', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    const targetId = (h.store.db.prepare('SELECT id FROM assistant_watch_targets LIMIT 1').get() as { id: string }).id;
    const ins = h.store.db.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at, withheld_reason, settled_by, digested_at)
       VALUES (?, ?, 'pr_opened', 'pulls', ?, ?, '{}', 'observed', ?, ?, ?, ?)`,
    );
    ins.run('wh', targetId, '91:opened', NOW, NOW, 'legacy_unproven', null, null);
    ins.run('st', targetId, '92:opened', NOW, NOW, null, 'native_receipt', NOW);
    const d = exportDelta(h);
    const by = (id: string) => d.state.watchEvents.find((e) => e['identity'] === id)!;
    expect(by('91:opened')).toMatchObject({ withheldReason: 'legacy_unproven', settledBy: null, digestedAt: null, baselineMarker: false });
    expect(by('92:opened')).toMatchObject({ withheldReason: null, settledBy: 'native_receipt', baselineMarker: false });
    const counts = deltaCounts(d) as { state: Record<string, number> };
    expect(counts.state).toMatchObject({ watchEventsWithheld: 1, watchEventsSettledByNativeReceipt: 1 });
    expect(d.replay.join(' ')).toMatch(/withheldReason.*never delivered.*never settled/s);
    h.close();
  });

  it('is incomplete, never guessed, when the ledger boundary cannot be read', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    h.store.db.exec('DELETE FROM native_ledger_boundary');
    const d = exportDelta(h);
    expect(d.complete).toBe(false);
    expect(d.incomplete).toContainEqual({ category: 'native_ledger', rule: 'native_ledger_unreadable', count: 1 });
    expect(d.state.nativeLedger.boundary).toBeNull();
    h.close();
  });

  it('carries what the migration staged and no reader has seeded yet, and the count of held native cards', () => {
    const raw = openDatabase({ location: ':memory:' });
    runMigrations(raw, { upTo: 35 });
    raw.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, delivered_at, delivered_to, created_at)
       VALUES ('f1','pr_opened:acme/demo#7','pr_opened','acme/demo','selected',NULL,'delivered',?, 'owner_dm', ?)`,
    ).run(NOW, NOW);
    runMigrations(raw);
    const store = createStore(raw);
    raw.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at, held_reason)
       VALUES ('h1','changes_requested:acme/demo#7:X','changes_requested','acme/demo','selected',NULL,'pending',?, 'ambiguous_review')`,
    ).run(NOW);
    expect(store.nativeTransitions.boundary()?.seededAt).toBeNull(); // nobody knew the owner yet
    const d = buildRollbackDelta({ store, ownerId: OWNER, profile: 'development', nowIso: '2026-10-14T00:00:00.000Z' });
    expect(d.state.nativeLedger.claims).toEqual([]);
    expect(d.state.nativeLedger.staged).toEqual([
      expect.objectContaining({ repoKey: 'acme/demo', kind: 'pr_opened', item: '7', deliveredTo: 'owner_dm' }),
    ]);
    expect(d.state.nativeLedger.heldNativeCards).toBe(1);
    expect(d.replay.join(' ')).toMatch(/staged.*same kind of fact/s);
    // Once seeded the same facts are claims, and the stage is empty: the export never says less than the database holds.
    store.nativeTransitions.ensureSeeded(OWNER, '2026-10-14T00:00:01.000Z');
    const after = buildRollbackDelta({ store, ownerId: OWNER, profile: 'development', nowIso: '2026-10-14T00:00:02.000Z' });
    expect(after.state.nativeLedger.staged).toEqual([]);
    expect(after.state.nativeLedger.claims).toHaveLength(1);
  });
});

describe('the v4 export lists every native holder and every held ordinary fact', () => {
  const REST = 'a'.repeat(64);
  const pr = { kind: 'pr_opened' as const, item: '7', stamp: null, hash: null, attempt: null };
  const cr = { kind: 'changes_requested' as const, item: '7', stamp: null, hash: REST, attempt: null };

  it('exports one claims row per holder of a transition, not one per transition', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', pr, 'feed_event', 'f1', NOW, NOW);
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', pr, 'watch_summary', 's1', NOW, NOW);
    h.store.nativeTransitions.markNativeDelivered('watch_summary', 's1', 'owner_dm', NOW);
    const rows = exportDelta(h).state.nativeLedger.claims.filter((c) => c['item'] === '7');
    expect(rows.map((c) => `${c['via']}:${c['state']}`).sort()).toEqual(['feed_event:reserved', 'watch_summary:delivered']);
    expect(exportDelta(h).replay.join(' ')).toMatch(/several `claims` rows, one per native holder/);
    h.close();
  });

  it('lists a held ordinary fact by hash, handle and instant, keeps it after the watch is cancelled, and counts it', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    h.store.db.prepare(
      `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key)
       VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo')`,
    ).run(OWNER, NOW, NOW, NOW);
    expect(h.store.githubWatches.observe({
      id: 'w1', expectedNextCheckAt: NOW, expectedRepoKey: 'acme/demo', repoKey: 'acme/demo', snapshotHash: 'h', snapshotJson: '{}',
      nextCheckAt: NOW, atIso: NOW, changed: true, readBoundaryAt: NOW,
      held: [{ id: 'h1', heldKey: `changes_requested:7:${cr.hash}`, summary: 'held, not sent', providerAt: NOW }],
    })).toBe(true);
    h.store.githubWatches.cancel(OWNER, 'w1', NOW);
    const d = exportDelta(h);
    expect(d.complete).toBe(true);
    expect(d.state.nativeLedger.heldOrdinary).toEqual([
      expect.objectContaining({
        watchHandle: 'wabcde', watchState: 'cancelled', repoKey: 'acme/demo', heldReason: 'ambiguous_review',
        heldKey: `changes_requested:7:${REST}`, providerAt: NOW,
      }),
    ]);
    expect((deltaCounts(d) as { state: Record<string, number> }).state).toMatchObject({ heldOrdinaryReviews: 1 });
    // Identifiers only: the held row's summary text and any raw review id never leave.
    expect(JSON.stringify(d.state.nativeLedger.heldOrdinary)).not.toContain('held, not sent');
    h.close();
  });
});

describe('the v5 export says what the observed-state review families recorded', () => {
  const H = 'c'.repeat(64);

  const watchRow = (h: ReturnType<typeof boot>['h'], snapshot: string | null = null): void => {
    h.store.db.prepare(
      `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key, snapshot_json)
       VALUES ('w1','wabcde',?, 'demo', 15, ?, 'active', ?, ?, 'acme/demo', ?)`,
    ).run(OWNER, NOW, NOW, NOW, snapshot);
  };

  it('is a new schema: older documents are never inferred, and the replay rules say what a dismissal and a domain mean', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    const d = exportDelta(h);
    expect(d.schema).toBe('ducky-rollback-delta/v5');
    const rules = d.replay.join(' ');
    expect(rules).toMatch(/OBSERVED STATE/);
    expect(rules).toMatch(/never a dismissal time/);
    expect(rules).toMatch(/hashDomain/);
    expect(rules).toMatch(/state_conflict/);
    h.close();
  });

  it('exports every review claim with its state, its hash domain and the review\'s ORIGINAL submission instant', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    const provider = { kind: 'review_dismissed' as const, item: '7', stamp: null, hash: H, attempt: null, domain: 'provider' as const, state: 'DISMISSED' as const };
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', provider, 'watch_summary', 's1', NOW, NOW, '2026-10-01T01:00:00.000Z');
    h.store.nativeTransitions.markNativeDelivered('watch_summary', 's1', 'owner_dm', NOW);
    h.store.nativeTransitions.reserveTarget(
      OWNER, 'acme/demo',
      {
        kind: 'review_commented', identity: '8:review:9', occurredAt: NOW, providerHash: null, attempt: null,
        providerState: null, providerAt: null, createdAt: NOW,
      },
      'target_alert', 'e1', NOW,
    );
    const rows = exportDelta(h).state.nativeLedger.claims.filter((c) => String(c['kind']).startsWith('review_'));
    expect(rows.map((c) => [c['kind'], c['hashDomain'], c['providerState'], c['providerAt'], c['path']])).toEqual(expect.arrayContaining([
      ['review_dismissed', 'provider', 'DISMISSED', '2026-10-01T01:00:00.000Z', 'native'],
      ['review_commented', 'source_identity', 'COMMENTED|DISMISSED', null, 'target'],
    ]));
    // No dismissal time anywhere in the export of a dismissal.
    expect(JSON.stringify(rows)).not.toMatch(/dismissedAt/);
    h.close();
  });

  it('lists the per-author review lines that were delivered without exact identity, after the watch itself is gone', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    watchRow(h);
    h.store.db.prepare(
      `INSERT INTO github_watch_gap_markers (owner_id, watch_id, repo_key, pr_number, review_class, reason, shown, outbox_ref, delivered_at)
       VALUES (?, 'w1', 'acme/demo', 7, 'approval', 'unavailable', 'shown', 's1', ?),
              (?, 'w1', 'acme/demo', 8, 'changes_requested', 'truncated', 'delivered_not_provably_shown', 's2', ?),
              (?, 'w1', 'acme/demo', 9, 'approval', 'not_conveyed', 'shown', 's3', ?)`,
    ).run(OWNER, NOW, OWNER, NOW, OWNER, NOW);
    h.store.db.prepare('DELETE FROM github_watches').run();
    const d = exportDelta(h);
    expect(d.complete).toBe(true);
    expect(d.state.nativeLedger.gapMarkers.map((m) => [m['prNumber'], m['reviewClass'], m['reason'], m['shown']])).toEqual([
      [7, 'approval', 'unavailable', 'shown'],
      [8, 'changes_requested', 'truncated', 'delivered_not_provably_shown'],
      [9, 'approval', 'not_conveyed', 'shown'],
    ]);
    expect(d.state.nativeLedger.gapMarkers[0]).toMatchObject({ watchHandle: null, repoKey: 'acme/demo', outboxRef: 's1' });
    expect((deltaCounts(d) as { state: Record<string, number> }).state).toMatchObject({ gapMarkers: 3, gapMarkersNotProvablyShown: 1 });
    // Identifiers and reasons only.
    expect(JSON.stringify(d.state.nativeLedger.gapMarkers)).not.toMatch(/summary|title|body/i);
    h.close();
  });

  it('carries the state, hash domain and instant of an imported review row, and a withheld state conflict', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    const target = h.store.db.prepare('SELECT id FROM assistant_watch_targets').get() as { id: string };
    h.store.db.prepare(
      `INSERT INTO assistant_watch_events
         (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at, withheld_reason, provider_hash, provider_state, provider_at)
       VALUES ('x1', ?, 'review_approved', 'pulls', '7:review:1', ?, '{}', 'observed', ?, 'state_conflict', ?, 'APPROVED', ?)`,
    ).run(target.id, NOW, NOW, H, NOW);
    const d = exportDelta(h);
    const ev = d.state.watchEvents.find((e) => e['identity'] === '7:review:1')!;
    expect(ev).toMatchObject({
      kind: 'review_approved', withheldReason: 'state_conflict', providerState: 'APPROVED', hashDomain: 'provider', providerAt: NOW,
    });
    expect((deltaCounts(d) as { state: Record<string, number> }).state).toMatchObject({ watchEventsStateConflict: 1, watchEventsWithheld: 1 });
    h.close();
  });

  it('counts the pull requests whose exact review facts are refused, and the ones at the list bound, never naming one', () => {
    const { h, apply } = boot();
    expect(apply().ok).toBe(true);
    const snapshot = JSON.stringify({
      v: 3, repoName: 'demo', defaultBranch: 'main', openPrCount: 2,
      prs: [
        { number: 7, title: 't', state: 'OPEN', isDraft: false, headRefName: 'f', updatedAt: NOW, checks: [], rf: { s: 'unavailable', known: true, pb: null, x: 'lifecycle', rv: [] } },
        { number: 8, title: 't', state: 'OPEN', isDraft: false, headRefName: 'f', updatedAt: NOW, checks: [], rf: { s: 'truncated', known: true, pb: null, rv: [] } },
      ],
    });
    watchRow(h, snapshot);
    const d = exportDelta(h);
    expect(d.state.nativeLedger.reviewEvidence).toEqual({ refusedPullRequests: 1, truncatedPullRequests: 1 });
    expect((deltaCounts(d) as { state: Record<string, number> }).state).toMatchObject({ refusedReviewPullRequests: 1 });
    h.close();
  });
});
