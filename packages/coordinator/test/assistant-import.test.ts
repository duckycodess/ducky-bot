import { describe, expect, it } from 'vitest';
import { ASSISTANT_WATCH_MAX_TARGETS, MAX_OPEN_TASKS_PER_OWNER, MAX_SCHEDULED_REMINDERS_PER_OWNER } from '@ducky/contracts';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { controlId } from '../src/discord/message.js';
import { tasksList } from '../src/discord/assistant-presenters.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { OWNER, STRANGER, TestClock, makeHarness, replyText, type Harness } from './helpers.js';
import { MANILA, importDoc, importEnv, rowCounts, takeLock } from './assistant-import-fixture.js';

/**
 * The offline importer, through the real store, services and transport.
 * Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';

const boot = (env: Record<string, string> = {}) => {
  const clock = new TestClock(NOW, MANILA);
  const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA, ...env } });
  const svc = (over = {}) => new AssistantImportService({ store: h.store, env: importEnv(over), nowMs: () => clock.nowMs() });
  return { h, clock, svc };
};
const apply = (h: Harness, svc: AssistantImportService, doc: unknown = importDoc()) => {
  const lock = takeLock(h.store);
  try {
    return svc.run(doc, { apply: true, lock });
  } finally {
    lock.release();
  }
};
/** A deliberate rollback: a fresh preview, then the code it issued. */
const rollBack = (h: Harness) => {
  const p = h.app.schedules.previewRollback(h.owner);
  return p.ok ? h.app.schedules.confirmRollback(h.owner, p.code) : p;
};
const task = (h: Harness, ns: string, sourceId: string) => {
  const id = h.store.assistantImport.identity(ns, 'task', sourceId)!;
  return h.store.tasks.byId(OWNER, id.targetId!)!;
};

describe('validation and refusal write nothing', () => {
  it('does not write on a dry run, and says what it would do', () => {
    const { h, svc } = boot();
    const before = rowCounts(h.store);
    const out = svc().run(importDoc(), { apply: false });
    expect(out).toMatchObject({ mode: 'dry_run', ok: true, issues: [] });
    expect(out.counts.tasks).toEqual({ created: 3, existing: 0, suppressed: 0, conflicts: 0 });
    expect(out.counts.reminders.created).toBe(4);
    expect(out.counts.captures).toMatchObject({ created: 1, suppressed: 1 });
    expect(rowCounts(h.store)).toEqual(before);
    h.close();
  });

  it('refuses to apply without the runtime lock, mechanically', () => {
    const { h, svc } = boot();
    const out = svc().run(importDoc(), { apply: true });
    expect(out.ok).toBe(false);
    expect(out.issues).toEqual([{ category: 'document', rule: 'lock_not_held', count: 1 }]);
    expect(rowCounts(h.store).tasks).toBe(0);
    h.close();
  });

  it('refuses with a lock handle that was released', () => {
    const { h, svc } = boot();
    const lock = takeLock(h.store);
    lock.release();
    expect(svc().run(importDoc(), { apply: true, lock }).ok).toBe(false);
    expect(rowCounts(h.store).tasks).toBe(0);
    h.close();
  });

  it('cannot apply while a live coordinator holds the database', () => {
    const { h } = boot();
    // A coordinator took the lock; the importer cannot even obtain one.
    h.store.db.prepare(
      `INSERT INTO runtime_lock (id, holder, pid, host, token, acquired_at, heartbeat_at)
       VALUES (1,'coordinator',?,?, 'x', ?, ?)`,
    ).run(process.pid, 'test-host', NOW, NOW);
    expect(() => takeLock(h.store)).toThrow(/lock unavailable/);
    h.close();
  });

  it('hard-stops on an owner that is not the frozen configured owner', () => {
    const { h, svc } = boot();
    const doc = importDoc();
    doc['ownerId'] = STRANGER;
    const out = apply(h, svc(), doc);
    expect(out.issues).toContainEqual({ category: 'document', rule: 'owner_mismatch', count: 1 });
    expect(rowCounts(h.store).tasks).toBe(0);
    h.close();
  });

  it('refuses a file made for another profile or another timezone', () => {
    const { h, svc } = boot();
    const doc = importDoc();
    doc['profile'] = 'production';
    expect(apply(h, svc(), doc).issues.map((i) => i.rule)).toContain('profile_mismatch');
    const tz = importDoc();
    tz['timeZone'] = 'UTC';
    tz['preferences'].timeZone = 'UTC';
    expect(apply(h, svc(), tz).issues.map((i) => i.rule)).toContain('time_zone_mismatch');
    expect(rowCounts(h.store).tasks).toBe(0);
    h.close();
  });

  it('reports a malformed document as counts of rules, never as a value', () => {
    const { h, svc } = boot();
    const doc = importDoc();
    doc['tasks'][0].title = 'PERSONAL-MARKER-9';
    doc['tasks'][0].secret_source_column = 'PERSONAL-MARKER-10';
    const out = svc().run(doc, { apply: false });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('PERSONAL-MARKER');
    expect(JSON.stringify(out)).not.toContain('secret_source_column');
    h.close();
  });

  it('rolls everything back when any part fails', () => {
    const { h, svc } = boot();
    // A native target already holds the repository under another identity.
    h.store.assistantWatch.insertTarget({
      id: 'native', publicId: 'wnatv1', discordUserId: OWNER, repoKey: 'acme/widgets', display: 'acme/widgets',
      defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
    });
    const before = rowCounts(h.store);
    const out = apply(h, svc());
    expect(out.ok).toBe(false);
    expect(out.issues).toContainEqual({ category: 'watch', rule: 'reference_already_present', count: 1 });
    expect(rowCounts(h.store)).toEqual(before);
    h.close();
  });
});

describe('configuration is compared, never written', () => {
  const rulesOf = (h: Harness, svc: AssistantImportService, doc = importDoc()) =>
    apply(h, svc, doc).issues.map((i) => `${i.category}:${i.rule}`);

  it('refuses preferences the profile did not select', () => {
    const { h, svc } = boot();
    expect(rulesOf(h, svc({ importedPreferencesSelected: false }))).toContain('preferences:not_selected_by_profile');
    h.close();
  });

  it('refuses preferences that want briefings the operator has not enabled', () => {
    const { h, svc } = boot();
    expect(rulesOf(h, svc({ briefing: { ...importEnv().briefing, enabled: false } }))).toContain('preferences:briefings_disabled_in_config');
    h.close();
  });

  it('refuses a briefing time that disagrees with an explicitly configured one', () => {
    const { h, svc } = boot();
    const out = rulesOf(h, svc({ briefing: { ...importEnv().briefing, morningAt: '7:30', morningExplicit: true } }));
    expect(out).toContain('preferences:morning_time_conflict');
    // The same disagreement with a DEFAULT is not a conflict: the preference replaces a default.
    expect(rulesOf(h, svc({ briefing: { ...importEnv().briefing, morningAt: '07:30', morningExplicit: false } }))).toEqual([]);
    h.close();
  });

  it('accepts an explicit time that agrees, however it is padded', () => {
    const { h, svc } = boot();
    expect(rulesOf(h, svc({ briefing: { ...importEnv().briefing, morningAt: '7:00', morningExplicit: true } }))).toEqual([]);
    h.close();
  });

  it('refuses weather with no configured location', () => {
    const { h, svc } = boot();
    expect(rulesOf(h, svc({ weatherConfigured: false }))).toContain('preferences:weather_not_configured');
    h.close();
  });

  it('refuses meals and assistant wording rather than dropping them', () => {
    const { h, svc } = boot();
    const meals = importDoc();
    meals['preferences'].includeMeal = true;
    expect(rulesOf(h, svc(), meals)).toContain('preferences:meal_unsupported');
    const wording = importDoc();
    wording['preferences'].assistantWording = true;
    expect(rulesOf(h, svc(), wording)).toContain('preferences:assistant_wording_unsupported');
    expect(rowCounts(h.store).owner_preferences).toBe(0);
    h.close();
  });

  it('refuses watch targets the reader cannot observe, failing closed', () => {
    const { h, svc } = boot();
    const shipped = svc({ watchCapabilities: { observableKinds: [], discovery: false } });
    const out = apply(h, shipped);
    expect(out.ok).toBe(false);
    expect(out.issues).toContainEqual({ category: 'watch', rule: 'reader_cannot_observe', count: 16 });
    expect(rowCounts(h.store).assistant_watch_targets).toBe(0);
    expect(rowCounts(h.store).tasks).toBe(0);
    h.close();
  });

  it('names exactly the kinds a partial reader lacks', () => {
    const { h, svc } = boot();
    const partial = svc({ watchCapabilities: { observableKinds: ['commit', 'pr_opened'], discovery: false } });
    expect(apply(h, partial).issues).toContainEqual({ category: 'watch', rule: 'reader_cannot_observe', count: 14 });
    h.close();
  });

  it('does not require a reader for a document with no watch targets', () => {
    const { h, svc } = boot();
    const doc = importDoc();
    doc['watch'] = null;
    expect(apply(h, svc({ watchCapabilities: { observableKinds: [], discovery: false } }), doc).ok).toBe(true);
    h.close();
  });
});

describe('capacity', () => {
  it('refuses a document that would pass the open-task ceiling', () => {
    const { h, svc } = boot();
    for (let i = 0; i < MAX_OPEN_TASKS_PER_OWNER - 1; i += 1) {
      h.store.tasks.insert({
        id: `n${i}`, publicId: `tn${i}`.padEnd(6, 'x').slice(0, 6) + i, discordUserId: OWNER, title: 'x', dueAt: null,
        dueAllDay: false, priority: 'normal', createdAt: NOW,
      });
    }
    const before = rowCounts(h.store);
    const out = apply(h, svc());
    expect(out.issues).toContainEqual({ category: 'tasks', rule: 'over_open_capacity', count: 1 });
    expect(rowCounts(h.store)).toEqual(before);
    h.close();
  });

  it('refuses a document that would pass the scheduled-reminder ceiling', () => {
    const { h, svc } = boot();
    const t = h.app.tasks.add(h.owner, { title: 'native' });
    for (let i = 0; i < MAX_SCHEDULED_REMINDERS_PER_OWNER - 1; i += 1) {
      h.store.reminders.insert({
        id: `rm${i}`, publicId: `rm${i}`.padEnd(7, 'x'), discordUserId: OWNER, text: 'r', recurrenceKind: 'once',
        intervalMinutes: null, maxOccurrences: 1, firstFireAt: '2026-12-01T00:00:00.000Z', createdAt: NOW, taskId: t.id,
      });
    }
    expect(apply(h, svc()).issues).toContainEqual({ category: 'reminders', rule: 'over_scheduled_capacity', count: 1 });
    h.close();
  });

  it('refuses a document that would pass the fixed watch-target ceiling', () => {
    const { h, svc } = boot();
    for (let i = 0; i < ASSISTANT_WATCH_MAX_TARGETS - 1; i += 1) {
      h.store.assistantWatch.insertTarget({
        id: `x${i}`, publicId: `w${String(i).padStart(5, '0')}`.slice(0, 6), discordUserId: OWNER,
        repoKey: `o/r${i}`, display: `o/r${i}`, defaultBranch: null, state: 'active',
        lastObservedAt: null, createdAt: NOW, cancelledAt: null,
      });
    }
    expect(apply(h, svc()).issues).toContainEqual({ category: 'watch', rule: 'over_target_capacity', count: 1 });
    h.close();
  });
});

describe('what an applied import writes', () => {
  it('writes every category and reports counts', () => {
    const { h, svc } = boot();
    const out = apply(h, svc());
    expect(out).toMatchObject({ mode: 'applied', ok: true, issues: [] });
    expect(out.counts).toEqual({
      tasks: { created: 3, existing: 0, suppressed: 0, conflicts: 0 },
      reminders: { created: 4, existing: 0, suppressed: 0, conflicts: 0 },
      captures: { created: 1, existing: 0, suppressed: 1, conflicts: 0 },
      scheduleRules: { created: 2, existing: 0, suppressed: 0, conflicts: 0 },
      scheduleExceptions: { created: 1, existing: 0, suppressed: 0, conflicts: 0 },
      preferences: { created: 1, existing: 0, suppressed: 0, conflicts: 0 },
      briefingDeliveries: { created: 1, existing: 0, suppressed: 0, conflicts: 0 },
      watchTargets: { created: 2, existing: 0, suppressed: 0, conflicts: 0 },
    });
    expect(out.watch).toEqual({ checkpoints: 6 + 1 + 6, events: 2 });
    h.close();
  });

  it('keeps task state, times, priority and explicit deadline kind', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const open = task(h, 'fixture', 't-open');
    expect(open).toMatchObject({
      title: 'Water the plants', status: 'open', priority: 'normal', dueAt: '2026-10-20T15:59:00.000Z',
      dueAllDay: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', closedAt: null,
      reminderPolicy: { enabled: true, offsetsMinutes: [60] },
    });
    const done = task(h, 'fixture', 't-done');
    // An all-day deadline is that civil day's LOCAL midnight, chosen by the explicit date kind.
    expect(done).toMatchObject({
      status: 'done', priority: 'high', dueAllDay: true, dueAt: '2026-09-29T16:00:00.000Z',
      closedAt: '2026-09-29T00:00:00.000Z', reminderPolicy: null,
    });
    expect(open.publicId).toMatch(/^t[0-9a-z]{5}$/);
    h.close();
  });

  it('never makes a settled reminder owed, and keeps an overdue pending one for a single late send', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const owed = h.store.reminders.dueForMaterialization('2099-01-01T00:00:00.000Z', 50);
    // Only the two PENDING ones are ever candidates; delivered and cancelled never are.
    expect(owed.map((r) => r.firstFireAt).sort()).toEqual(['2026-10-11T09:00:00.000Z', '2026-10-20T14:59:00.000Z']);
    const delivered = h.store.assistantImport.identity('fixture', 'reminder', 'r-delivered')!;
    expect(h.store.reminders.byId(delivered.targetId!)).toMatchObject({ status: 'completed', firedCount: 1 });
    expect(h.store.reminders.occurrencesFor(delivered.targetId!)[0]!.deliveredAt).toBe('2026-09-29T15:59:30.000Z');
    expect(h.store.reminders.pendingOccurrences(50)).toEqual([]);
    h.close();
  });

  it('maps captures, remembers a source-deleted one, and never stores its text', () => {
    const { h, svc } = boot();
    apply(h, svc());
    expect(h.store.captures.listForOwner(OWNER, 'all', 10).map((c) => c.content)).toEqual(['a loose thought']);
    expect(h.store.assistantImport.identity('fixture', 'capture', 'c-gone')).toMatchObject({
      state: 'tombstone', targetId: null, fingerprint: null,
    });
    h.close();
  });

  it('writes schedule rules active or inert and exceptions as given', () => {
    const { h, svc } = boot();
    apply(h, svc());
    expect(h.store.scheduleRules.activeRules(OWNER).map((r) => r.label)).toEqual(['Algebra']);
    expect(h.store.scheduleRules.listAllRulesForOwner(OWNER, 10).map((r) => `${r.label}:${r.active}`)).toEqual([
      'Algebra:true', 'Old class:false',
    ]);
    expect(h.store.scheduleRules.listExceptionsForOwner(OWNER, 10)).toHaveLength(1);
    h.close();
  });

  it('writes notification targets with imported, unbaselined and settled state', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const w = h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!;
    expect(w).toMatchObject({ display: 'Acme/Widgets', state: 'active', defaultBranch: 'main' });
    expect(w.publicId).toMatch(/^w[0-9a-z]{5}$/);
    const cps = Object.fromEntries(h.store.assistantWatch.checkpointsFor(w.id).map((c) => [c.surface, c]));
    expect(cps['pulls']).toMatchObject({ state: 'imported', cursor: '2026-10-11T10:00:00.000Z' });
    expect(cps['default_branch']).toMatchObject({ state: 'imported', cursor: 'main' });
    // A surface the source never read is explicit, and has no cursor to mistake for one.
    expect(cps['commits']).toMatchObject({ state: 'unbaselined', cursor: null });
    expect(cps['releases']).toMatchObject({ state: 'unbaselined', cursor: null });
    expect(cps['ci_state']).toMatchObject({ state: 'ready', cursor: 'failing', nextDueAt: '9999-12-31T00:00:00.000Z' });
    // History the source had settled stays settled; an unalerted interruption stays owed.
    const events = h.store.assistantWatch.eventsFor(w.id);
    expect(events.find((e) => e.identity === '12:opened')).toMatchObject({ origin: 'imported', digestedAt: '2026-10-12T00:00:00.000Z' });
    expect(events.find((e) => e.identity === '12:review:9')).toMatchObject({ alertedAt: null, digestedAt: null });
    // A muted source repository is kept cancelled, not dropped and not watched.
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/muted')).toMatchObject({ state: 'cancelled' });
    expect(h.store.assistantWatch.dueCheckpoints('2099-01-01T00:00:00.000Z', 100).every((c) => c.targetId === w.id)).toBe(true);
    h.close();
  });

  it('keeps the briefing slot the source already delivered from being sent again today', async () => {
    const clock = new TestClock('2026-10-12T14:00:00.000Z', MANILA); // 22:00 local: both slots are due
    const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA, DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true' } });
    const svc = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() });
    apply(h, svc);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-10-12')).toMatchObject({ status: 'delivered' });
    const out = await h.app.briefingNotifier.tick();
    expect(out.claimed).toBe(1); // only the evening slot; the morning is already settled
    expect(h.store.briefings.bySlot(OWNER, 'evening', '2026-10-12')).toMatchObject({ status: 'delivered' });
    // Exactly one briefing went out, and it was the evening one.
    expect(h.transport.sent).toHaveLength(1);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-10-12')!.deliveredAt).toBe('2026-10-12T00:00:10.000Z');
    h.close();
  });

  it('keeps the owner’s ordinary handles collision-free across both watch kinds', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const handles = h.store.assistantWatch.listForOwner(OWNER, true, 10).map((t) => t.publicId);
    expect(new Set(handles).size).toBe(handles.length);
    h.close();
  });
});

describe('importing again', () => {
  it('adds nothing, advances nothing and sends nothing', async () => {
    const { h, svc } = boot();
    apply(h, svc());
    const snapshot = (): string =>
      JSON.stringify(h.store.db.prepare(
        `SELECT c.target_id, c.surface, c.state, c.cursor, c.updated_at FROM assistant_watch_checkpoints c ORDER BY 1,2`,
      ).all());
    const before = { rows: rowCounts(h.store), checkpoints: snapshot() };
    const out = apply(h, svc());
    expect(out.ok).toBe(true);
    for (const c of Object.values(out.counts)) expect(c.created).toBe(0);
    expect(out.counts.tasks.existing).toBe(3);
    expect(out.counts.reminders.existing).toBe(4);
    expect(out.counts.captures).toMatchObject({ existing: 1, suppressed: 1 });
    expect(rowCounts(h.store)).toEqual(before.rows);
    expect(snapshot()).toBe(before.checkpoints);
    expect(h.transport.sent).toEqual([]);
    h.close();
  });

  it('preserves everything the owner did in between', async () => {
    const { h, svc } = boot();
    apply(h, svc());
    const open = task(h, 'fixture', 't-open');
    const late = task(h, 'fixture', 't-late');
    h.app.tasks.complete(h.owner, late.publicId); // done
    h.app.tasks.setDeadline(h.owner, open.publicId, h.app.tasks.parseDeadline('2026-11-05 10:00'));
    h.app.tasks.snooze(h.owner, open.publicId);
    const done = task(h, 'fixture', 't-done');
    h.app.forget.forgetEntity(h.owner, 'task', done.publicId); // deleted, with its reminders
    const w = h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!;
    h.app.assistantWatch.cancel(h.owner, w.publicId);
    const rule = h.store.assistantImport.identity('fixture', 'schedule_rule', 'k-1')!;
    h.store.scheduleRules.deleteRule(OWNER, rule.targetId!);

    const before = rowCounts(h.store);
    const out = apply(h, svc());
    expect(out.ok).toBe(true);
    expect(rowCounts(h.store)).toEqual(before);
    expect(out.counts.tasks).toMatchObject({ created: 0, existing: 2, suppressed: 1 });
    expect(out.counts.reminders).toMatchObject({ created: 0, suppressed: 2 });
    expect(out.counts.scheduleRules).toMatchObject({ created: 0, suppressed: 1, existing: 1 });
    expect(h.store.tasks.byId(OWNER, late.id)!.status).toBe('done');
    expect(h.store.tasks.byId(OWNER, open.id)!.dueAt).not.toBe('2026-10-20T15:59:00.000Z');
    expect(h.store.tasks.byId(OWNER, done.id)).toBeUndefined();
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!.state).toBe('cancelled');
    expect(h.store.scheduleRules.activeRules(OWNER)).toEqual([]);
    h.close();
  });

  it('reports a source change as a content-free conflict and writes nothing at all', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const changed = importDoc();
    changed['tasks'][0].title = 'Water the cactus instead';
    changed['captures'].push({ sourceId: 'c-new', text: 'brand new', state: 'inbox', createdAt: '2026-10-12T00:00:00Z', processedAt: null });
    const before = rowCounts(h.store);
    const out = apply(h, svc(), changed);
    expect(out.ok).toBe(false);
    expect(out.issues).toContainEqual({ category: 'tasks', rule: 'source_changed', count: 1 });
    expect(JSON.stringify(out)).not.toContain('cactus');
    // The new capture was NOT imported either: one rule failing refuses the lot.
    expect(rowCounts(h.store)).toEqual(before);
    h.close();
  });

  it('imports a genuinely new record from a later export', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const later = importDoc();
    later['captures'].push({ sourceId: 'c-new', text: 'brand new', state: 'inbox', createdAt: '2026-10-12T00:00:00Z', processedAt: null });
    const out = apply(h, svc(), later);
    expect(out.ok).toBe(true);
    expect(out.counts.captures).toMatchObject({ created: 1, suppressed: 1 });
    h.close();
  });

  it('does not write a pending reminder for a task the owner has already closed', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const open = task(h, 'fixture', 't-open');
    h.app.tasks.complete(h.owner, open.publicId);
    const later = importDoc();
    later['reminders'].push({
      sourceId: 'r-new', taskSourceId: 't-open', kind: 'snooze', offsetMinutes: null,
      fireAt: '2026-10-21T00:00:00Z', state: 'pending', deliveredAt: null, createdAt: '2026-10-12T00:00:00Z',
    });
    const out = apply(h, svc(), later);
    expect(out.ok).toBe(true);
    expect(out.counts.reminders).toMatchObject({ created: 0, suppressed: 1 });
    expect(h.store.reminders.scheduledForTask(OWNER, open.id)).toEqual([]);
    h.close();
  });
});

describe('verification is counts only', () => {
  it('passes straight after an import', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const v = svc().verify(importDoc());
    expect(v).toMatchObject({ ok: true, parity: true });
    expect(v.categories['tasks']).toEqual({ expected: 3, present: 3, suppressed: 0, missing: 0, changedAtSource: 0, drifted: 0 });
    expect(v.categories['captures']).toMatchObject({ expected: 2, present: 1, suppressed: 1 });
    expect(JSON.stringify(v)).not.toContain('Water');
    h.close();
  });

  it('reports a missing record, a changed one, and drift after the owner acts', () => {
    const { h, svc } = boot();
    const missing = svc().verify(importDoc());
    expect(missing.ok).toBe(false);
    expect(missing.categories['tasks']!.missing).toBe(3);

    apply(h, svc());
    h.app.tasks.complete(h.owner, task(h, 'fixture', 't-open').publicId);
    const drifted = svc().verify(importDoc());
    expect(drifted.ok).toBe(true); // nothing missing, nothing changed at the source
    expect(drifted.parity).toBe(false);
    expect(drifted.categories['tasks']!.drifted).toBe(1);

    const changed = importDoc();
    changed['tasks'][1].priority = 'high';
    expect(svc().verify(changed)).toMatchObject({ ok: false });
    h.close();
  });

  it('is read only', () => {
    const { h, svc } = boot();
    apply(h, svc());
    const before = rowCounts(h.store);
    svc().verify(importDoc());
    expect(rowCounts(h.store)).toEqual(before);
    h.close();
  });
});

describe('imported tasks use the accepted card and the owner-only controls', () => {
  it('delivers an overdue pending reminder late, once, as the real card, and the controls are the owner’s', async () => {
    const { h, svc } = boot();
    apply(h, svc());
    await h.transport.start((e) => h.app.router.handle(e));
    await h.app.reminderNotifier.tick();
    const sent = h.transport.sent;
    expect(sent).toHaveLength(1); // the overdue one; the other is still in the future
    expect(sent[0]!.target).toEqual({ kind: 'user', userId: OWNER });
    const body = JSON.stringify(sent[0]!.message);
    expect(body).toContain('Return the book');
    // The accepted card: no timezone label and no reminder-offset line.
    expect(body).not.toMatch(/Asia\/Manila|Reminder: |before/);
    const buttons = sent[0]!.message.rows![0]!.buttons;
    expect(buttons.map((b) => b.label.split(' ')[0])).toEqual(['Done', 'Edit', 'Snooze']);

    // Not sent twice.
    await h.app.reminderNotifier.tick();
    expect(h.transport.sent).toHaveLength(1);

    // A reader who is not the owner is refused; the owner closes the task.
    const done = controlId(buttons[0]!);
    const refused = await h.transport.dispatch({ kind: 'component', customId: done, userId: STRANGER } as never);
    expect(replyText(refused)).toMatch(/not authorized/i);
    expect(task(h, 'fixture', 't-late').status).toBe('open');
    await h.transport.dispatch({ kind: 'component', customId: done, userId: OWNER } as never);
    expect(task(h, 'fixture', 't-late').status).toBe('done');
    h.close();
  });
});

describe('the source global monitoring switch', () => {
  const paused = (on: boolean) => {
    const doc = importDoc() as Record<string, any>;
    doc['watch']['monitoringEnabled'] = on;
    return doc;
  };

  it('is carried over when it is off, and the watch reads nothing until the owner turns it on', () => {
    const { h, svc } = boot();
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    const out = apply(h, svc(), paused(false));
    expect(out.ok).toBe(true);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    expect(svc().verify(paused(false)).categories['watchSwitch']).toMatchObject({ expected: 1, present: 1, drifted: 0 });
    // The document states the switch ONCE. The owner resumes it natively...
    expect(h.app.assistantWatch.setMonitoring(h.owner, true)).toMatchObject({ ok: true, changed: true });
    // ...and a repeat of the unchanged document neither re-pauses it nor hides the difference.
    expect(apply(h, svc(), paused(false)).ok).toBe(true);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    expect(svc().verify(paused(false)).categories['watchSwitch']).toMatchObject({ drifted: 1 });
    h.close();
  });

  it('keeps a native pause across a repeat of a document that says it is on', () => {
    const { h, svc } = boot();
    apply(h, svc(), paused(true));
    expect(h.app.assistantWatch.setMonitoring(h.owner, false)).toMatchObject({ ok: true, changed: true });
    expect(apply(h, svc(), paused(true)).ok).toBe(true);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    expect(svc().verify(paused(true)).categories['watchSwitch']).toMatchObject({ drifted: 1 });
    h.close();
  });

  it('keeps the owner’s choice made BEFORE the first import, and reports it as drift', () => {
    const { h, svc } = boot();
    h.app.assistantWatch.setMonitoring(h.owner, false);
    expect(apply(h, svc(), paused(true)).ok).toBe(true);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    expect(svc().verify(paused(true)).categories['watchSwitch']).toMatchObject({ drifted: 1 });
    h.close();
  });

  it('is reported as drift, not as a failure, when it differs from the document', () => {
    const { h, svc } = boot();
    apply(h, svc(), paused(false));
    h.store.assistantWatch.setMonitoring(OWNER, true, NOW);
    const report = svc().verify(paused(false));
    expect(report.categories['watchSwitch']).toMatchObject({ drifted: 1 });
    expect(report.ok).toBe(true);
    expect(report.parity).toBe(false);
    h.close();
  });
});

describe('a replaced schedule batch carries when it was replaced', () => {
  it('lets an imported batch be rolled back to, and refuses one whose order the source did not give', () => {
    const { h, svc } = boot();
    const doc = importDoc() as Record<string, any>;
    doc['schedule'].batches[1].replacedAt = '2026-09-20T00:00:00Z'; // b-0, the replaced one
    expect(apply(h, svc(), doc).ok).toBe(true);
    expect(rollBack(h)).toMatchObject({ ok: true, restoredRules: 1, replacedRules: 1 });
    expect(h.store.scheduleRules.activeRules(OWNER).map((r) => r.label)).toEqual(['Old class']);
    h.close();

    const second = boot();
    expect(apply(second.h, second.svc()).ok).toBe(true); // no replacedAt in the fixture
    expect(rollBack(second.h)).toEqual({ ok: false, reason: 'order_unknown' });
    second.h.close();
  });
});

describe('a native schedule rollback survives a repeated import', () => {
  it('leaves the owner’s active batch alone, and verification reports the drift', () => {
    const { h, clock, svc } = boot();
    const doc = importDoc() as Record<string, any>;
    doc['schedule'].batches[1].replacedAt = '2026-09-20T00:00:00Z';
    expect(apply(h, svc(), doc).ok).toBe(true);
    expect(h.store.scheduleRules.activeRules(OWNER).map((r) => r.label)).not.toEqual(['Old class']);
    expect(svc().verify(doc).parity).toBe(true);
    clock.advance(60_000);
    expect(rollBack(h)).toMatchObject({ ok: true });
    const after = h.store.scheduleRules.activeRules(OWNER).map((r) => r.label);
    expect(after).toEqual(['Old class']);

    const again = apply(h, svc(), doc);
    expect(again.ok).toBe(true);
    expect(again.counts.scheduleRules).toMatchObject({ created: 0, conflicts: 0 });
    expect(h.store.scheduleRules.activeRules(OWNER).map((r) => r.label)).toEqual(after);
    const report = svc().verify(doc);
    expect(report.ok).toBe(true);
    expect(report.parity).toBe(false);
    expect(report.categories['scheduleRules']!.drifted).toBeGreaterThan(0);
    h.close();
  });
});

describe('the source urgent priority and task categories', () => {
  const withTasks = () => {
    const doc = importDoc() as Record<string, any>;
    const base = { due: { kind: 'instant', at: '2026-10-20T15:59:00Z' }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', closedAt: null, reminderPolicy: null };
    doc['tasks'] = [
      { sourceId: 'u1', title: 'Hand in the report', status: 'open', priority: 'urgent', category: 'school', ...base },
      { sourceId: 'h1', title: 'Book the dentist', status: 'open', priority: 'high', category: 'personal', ...base },
      { sourceId: 'n1', title: 'Plain thing', status: 'open', priority: 'normal', category: null, ...base },
    ];
    doc['reminders'] = [];
    return doc;
  };

  it('keeps an urgent task urgent, ranked above a high one, and keeps the category', () => {
    const { h, svc } = boot();
    expect(apply(h, svc(), withTasks()).ok).toBe(true);
    const rows = h.app.tasks.list(h.owner, 'open');
    expect(rows.map((r) => r.title)).toEqual(['Hand in the report', 'Book the dentist', 'Plain thing']);
    const urgent = rows[0]!;
    // Stored beside the priority, which stays one of the native values.
    expect(urgent).toMatchObject({ priority: 'high', urgent: true, category: 'school' });
    expect(rows[1]).toMatchObject({ priority: 'high', urgent: false, category: 'personal' });
    expect(rows[2]).toMatchObject({ urgent: false, category: null });
    h.close();
  });

  it('shows urgent and the category in the list, distinguishing it from high', () => {
    const { h, svc } = boot();
    apply(h, svc(), withTasks());
    const text = JSON.stringify(tasksList(h.app.tasks.list(h.owner, 'open'), 'UTC', 'open', []));
    expect(text).toContain('!!! Hand in the report · school');
    expect(text).toContain('!! Book the dentist · personal');
    h.close();
  });

  it('is verified as parity, and a repeat import changes nothing', () => {
    const { h, svc } = boot();
    expect(apply(h, svc(), withTasks()).counts.tasks.created).toBe(3);
    expect(svc().verify(withTasks()).parity).toBe(true);
    const again = apply(h, svc(), withTasks());
    expect(again.counts.tasks).toEqual({ created: 0, existing: 3, suppressed: 0, conflicts: 0 });
    h.close();
  });

  it('refuses a priority or category the source does not have', () => {
    const { h, svc } = boot();
    const bad = withTasks();
    bad['tasks'][0].priority = 'critical';
    expect(svc().run(bad, { apply: false }).ok).toBe(false);
    const worse = withTasks();
    worse['tasks'][0].category = 'work';
    expect(svc().run(worse, { apply: false }).ok).toBe(false);
    h.close();
  });

  it('puts an urgent task in the lookahead, which lists high or urgent first', () => {
    const { h, svc } = boot({ DUCKY_IMPORTED_PREFERENCES: 'true' });
    const doc = withTasks();
    doc['tasks'].forEach((t: any) => { t.due = { kind: 'instant', at: '2026-10-14T15:59:00Z' }; });
    doc['tasks'][1].priority = 'normal'; // only the urgent one is high-or-urgent
    apply(h, svc(), doc);
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.lookahead?.tasks.rows.map((t) => t.title)).toEqual(['Hand in the report']);
    h.close();
  });
});

describe('a repository discovery found before the import is adopted, not collided with', () => {
  const discover = (h: Harness, keys: readonly string[]) => {
    const repo = h.store.assistantWatch;
    repo.ensureDiscovery(OWNER, NOW);
    repo.commitDiscoveryPage({
      ownerId: OWNER, expectedPage: 0, maxTargets: 1000, atIso: NOW,
      surfaces: ['commits', 'pulls', 'issues', 'runs', 'releases', 'default_branch'],
      next: { kind: 'done', incomplete: false, nextDueAt: '2099-01-01T00:00:00.000Z' },
      found: keys.map((k, i) => ({
        repoKey: k, display: k, pushedAt: '2026-10-12T00:00:00Z', archived: false, fork: false,
        relationship: 'owner' as const, id: `disc-${i}`, publicId: `wdisc${i}`.slice(0, 6),
      })),
    });
  };

  it('takes the source mute, the cursors Ducky has not read, and the events, without a conflict', () => {
    const { h, svc } = boot();
    discover(h, ['acme/widgets', 'acme/muted']);
    // Ducky has already baselined the pulls surface of one of them, silently, LATER than the
    // source's cursor: what happened in between must still be told.
    const widgets = h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!;
    h.store.assistantWatch.checkpointsFor(widgets.id); // exists, unbaselined
    h.store.db.prepare("UPDATE assistant_watch_checkpoints SET state='ready', cursor='2026-10-12T20:00:00.000Z' WHERE target_id = ? AND surface = 'pulls'").run(widgets.id);

    const out = apply(h, svc());
    expect(out.ok).toBe(true);
    expect(out.counts.watchTargets.conflicts).toBe(0);

    const rows = h.store.assistantWatch.listForOwner(OWNER, true, 10);
    expect(rows.map((r) => `${r.repoKey}:${r.state}:${r.origin}`).sort()).toEqual([
      'acme/muted:cancelled:imported', 'acme/widgets:active:imported',
    ]);
    const cps = new Map(h.store.assistantWatch.checkpointsFor(widgets.id).map((c) => [c.surface, c]));
    // The EARLIER cursor wins and the boundary is strict, so the gap is read, not skipped.
    expect(cps.get('pulls')).toMatchObject({ state: 'ready', cursor: '2026-10-11T10:00:00.000Z', boundaryKnown: false });
    expect(cps.get('default_branch')).toMatchObject({ state: 'imported', cursor: 'main' }); // not read yet: the source's
    expect(cps.get('ci_state')).toMatchObject({ cursor: 'failing' });
    expect(h.store.assistantWatch.eventsFor(widgets.id).map((e) => e.identity).sort()).toEqual(['12:opened', '12:review:9']);
    // It now has a ledger identity and a baseline, like any imported target, and no extra target exists.
    expect(h.store.assistantImport.identity('fixture', 'watch_target', 'w-1')?.targetId).toBe(widgets.id);
    expect(h.store.assistantWatch.countAll(OWNER)).toBe(2);
    expect(svc().verify(importDoc()).parity).toBe(true);
    h.close();
  });

  it('is the same on a repeat import, and never overrides a mute the owner made here', () => {
    const { h, svc } = boot();
    discover(h, ['acme/widgets']);
    const widgets = h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!;
    h.store.assistantWatch.cancel(OWNER, widgets.id, NOW); // the owner muted it in Ducky first
    expect(apply(h, svc()).ok).toBe(true);
    expect(h.store.assistantWatch.byRepoKey(OWNER, 'acme/widgets')!.state).toBe('cancelled');
    const again = apply(h, svc());
    expect(again.ok).toBe(true);
    expect(again.counts.watchTargets).toEqual({ created: 0, existing: 2, suppressed: 0, conflicts: 0 });
    h.close();
  });

  it('still refuses a different identity for a target that was IMPORTED, not discovered', () => {
    const { h, svc } = boot();
    expect(apply(h, svc()).ok).toBe(true);
    const doc = importDoc() as Record<string, any>;
    doc['watch'].targets[0].sourceId = 'w-other';
    expect(apply(h, svc(), doc).issues).toContainEqual({ category: 'watch', rule: 'reference_already_present', count: 1 });
    h.close();
  });
});

describe('adoption reconciles what discovery baselined with what the source had settled', () => {
  const adoptedWorld = () => {
    const clock = new TestClock(NOW, MANILA);
    const reader = new FakeWatchReader();
    const h = makeHarness({ clock, assistantWatchReader: reader, env: { DUCKY_OWNER_TIMEZONE: MANILA } });
    const svc = () => new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() });
    return { h, clock, reader, svc };
  };
  const discoverWidgets = (h: Harness) => {
    const repo = h.store.assistantWatch;
    repo.ensureDiscovery(OWNER, NOW);
    repo.commitDiscoveryPage({
      ownerId: OWNER, expectedPage: 0, maxTargets: 1000, atIso: NOW,
      surfaces: ['commits', 'pulls', 'issues', 'runs', 'releases', 'default_branch'],
      next: { kind: 'done', incomplete: false, nextDueAt: '2099-01-01T00:00:00.000Z' },
      found: [{
        repoKey: 'acme/widgets', display: 'acme/widgets', pushedAt: null, archived: false, fork: false,
        relationship: 'owner' as const, id: 'disc-0', publicId: 'wdisc0',
      }],
    });
    return repo.byRepoKey(OWNER, 'acme/widgets')!;
  };

  it('tells an event between the source cursor and a later silent baseline, exactly once', async () => {
    const { h, clock, reader, svc } = adoptedWorld();
    const target = discoverWidgets(h);
    // Discovery baselined pulls silently at B, later than the source's cursor S (2026-10-11T10:00).
    h.store.db.prepare(
      "UPDATE assistant_watch_checkpoints SET state='ready', cursor='2026-10-12T20:00:00.000Z', boundary_known=1 WHERE target_id = ? AND surface = 'pulls'",
    ).run(target.id);
    const lock = takeLock(h.store);
    expect(svc().run(importDoc(), { apply: true, lock }).ok).toBe(true);
    lock.release();
    // An event between S and B: a pull request opened at 2026-10-12T00:00.
    reader.pullsBy.set('acme/widgets', [{
      number: 40, title: 'In the gap', state: 'open', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
      mergedAt: null, closedAt: null,
    }]);
    await h.app.assistantWatch.tick();
    clock.advance(20 * 60_000);
    await h.app.assistantWatch.tick();
    const events = h.store.assistantWatch.eventsFor(target.id).filter((e) => e.identity === '40:opened');
    expect(events).toHaveLength(1);
    h.close();
  });

  it('keeps an unsettled floor a pending runs read already had, instead of dropping it', () => {
    const { h, svc } = adoptedWorld();
    const target = discoverWidgets(h);
    h.store.db.prepare(
      "UPDATE assistant_watch_checkpoints SET state='ready', cursor='2026-10-12T20:00:00.000Z', scan_floor='2026-10-12T09:00:00.000Z' WHERE target_id = ? AND surface = 'runs'",
    ).run(target.id);
    const lock = takeLock(h.store);
    expect(svc().run(importDoc(), { apply: true, lock }).ok).toBe(true);
    lock.release();
    expect(h.store.assistantWatch.checkpoint(target.id, 'runs')).toMatchObject({
      cursor: '2026-10-11T10:00:00.000Z', scanFloor: '2026-10-12T09:00:00.000Z', boundaryKnown: false,
    });
    h.close();
  });

  it('never delivers again an event the source already settled, and never clears a Ducky settlement', () => {
    const { h, svc } = adoptedWorld();
    const target = discoverWidgets(h);
    const put = (id: string, identity: string, over: { alerted?: string | null; digested?: string | null }) =>
      h.store.assistantWatch.insertImportedEvent({
        id, targetId: target.id, kind: 'pr_opened', identity, occurredAt: '2026-10-11T09:00:00.000Z', payloadJson: '{}',
        alertedAt: over.alerted ?? null, digestedAt: over.digested ?? null, createdAt: NOW,
      });
    // Ducky saw '12:opened' itself, unsettled; the source had digested it.
    put('own-1', '12:opened', {});
    // Ducky already digested another that the source (in the fixture) has not mentioned.
    put('own-2', '99:opened', { digested: '2026-10-12T00:00:00.000Z' });
    const lock = takeLock(h.store);
    expect(svc().run(importDoc(), { apply: true, lock }).ok).toBe(true);
    lock.release();
    const byIdentity = new Map(h.store.assistantWatch.eventsFor(target.id).map((e) => [e.identity, e]));
    expect(byIdentity.get('12:opened')!.digestedAt).not.toBeNull(); // the source's settlement filled it in
    expect(byIdentity.get('99:opened')!.digestedAt).toBe('2026-10-12T00:00:00.000Z'); // Ducky's own is untouched
    expect(h.store.assistantWatch.undigested(OWNER, 20).map((e) => e.identity)).not.toContain('12:opened');
    h.close();
  });
});
