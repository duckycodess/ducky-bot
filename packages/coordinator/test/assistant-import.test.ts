import { describe, expect, it } from 'vitest';
import { ASSISTANT_WATCH_MAX_TARGETS, MAX_OPEN_TASKS_PER_OWNER, MAX_SCHEDULED_REMINDERS_PER_OWNER } from '@ducky/contracts';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { controlId } from '../src/discord/message.js';
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
