import { describe, expect, it } from 'vitest';
import { OWNER, STRANGER, TestClock, makeHarness, type Harness } from './helpers.js';

/** Rolling the weekly schedule back one batch. Invented data only. */
const NOW = '2026-10-13T00:00:00.000Z';

const boot = () => {
  const h = makeHarness({ clock: new TestClock(NOW, 'UTC') });
  return h;
};
let n = 0;
const rule = (
  h: Harness, batch: string, active: boolean, label: string, replacedAt: string | null, owner = OWNER,
) => {
  n += 1;
  h.store.scheduleRules.insertRule({
    id: `rule-${n}`, discordUserId: owner, batchKey: batch, active, weekday: 1, startTime: '09:00', endTime: '10:00',
    label, courseCode: null, section: null, room: null, uncertain: [], effectiveFrom: null, effectiveUntil: null,
    createdAt: NOW, replacedAt,
  });
};
const state = (h: Harness) =>
  h.store.scheduleRules.listAllRulesForOwner(OWNER, 50).map((r) => `${r.label}:${r.active ? 'on' : 'off'}`).sort();

describe('rolling the schedule back one batch', () => {
  it('flips the active batch to replaced and the most recently replaced one to active, deleting nothing', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'oldest', '2026-08-01T00:00:00Z');
    const before = h.store.scheduleRules.countRules(OWNER);
    const out = h.app.schedules.rollbackBatch(h.owner, NOW);
    expect(out).toEqual({ ok: true, restoredRules: 1, replacedRules: 1 });
    expect(state(h)).toEqual(['current:off', 'older:on', 'oldest:off']);
    expect(h.store.scheduleRules.countRules(OWNER)).toBe(before);
    // Only the restored batch drives behavior.
    expect(h.store.scheduleRules.activeRules(OWNER).map((r) => r.label)).toEqual(['older']);
    h.close();
  });

  it('goes back one more each time, most recently replaced first, and can return', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'oldest', '2026-08-01T00:00:00Z');
    h.app.schedules.rollbackBatch(h.owner, '2026-10-13T00:00:00Z'); // older is active; current replaced now
    h.app.schedules.rollbackBatch(h.owner, '2026-10-13T00:05:00Z'); // current (replaced most recently) comes back
    expect(state(h)).toEqual(['current:on', 'older:off', 'oldest:off']);
    h.close();
  });

  it('refuses when there is nothing to restore, and changes nothing', () => {
    const h = boot();
    rule(h, 'b1', true, 'only', null);
    expect(h.app.schedules.rollbackBatch(h.owner, NOW)).toEqual({ ok: false, reason: 'nothing_to_restore' });
    expect(state(h)).toEqual(['only:on']);
    h.close();
  });

  it('refuses to guess when the order of the replaced batches is unknown', () => {
    const h = boot();
    rule(h, 'b2', true, 'current', null);
    rule(h, 'b1', false, 'mystery', null);
    expect(h.app.schedules.rollbackBatch(h.owner, NOW)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(state(h)).toEqual(['current:on', 'mystery:off']);
    h.close();
  });

  it('refuses when two replaced batches carry the same instant', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'one', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'two', '2026-09-01T00:00:00Z');
    expect(h.app.schedules.rollbackBatch(h.owner, NOW)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(state(h)).toEqual(['current:on', 'one:off', 'two:off']);
    h.close();
  });

  it('never touches another owner’s schedule, and is owner-only', () => {
    const h = boot();
    rule(h, 'b2', true, 'mine', null);
    rule(h, 'b1', false, 'mine-old', '2026-09-01T00:00:00Z');
    rule(h, 'x2', true, 'theirs', null, STRANGER);
    rule(h, 'x1', false, 'theirs-old', '2026-09-01T00:00:00Z', STRANGER);
    expect(() => h.app.schedules.rollbackBatch(h.stranger, NOW)).toThrow();
    h.app.schedules.rollbackBatch(h.owner, NOW);
    expect(h.store.scheduleRules.listAllRulesForOwner(STRANGER, 10).map((r) => `${r.label}:${r.active}`).sort())
      .toEqual(['theirs-old:false', 'theirs:true']);
    h.close();
  });

  it('leaves the dated exceptions alone', () => {
    const h = boot();
    rule(h, 'b2', true, 'current', null);
    rule(h, 'b1', false, 'older', '2026-09-01T00:00:00Z');
    h.store.scheduleRules.insertException({
      id: 'x1', discordUserId: OWNER, date: '2026-10-27', courseCode: null, label: null, kind: 'cancelled', note: null, createdAt: NOW,
    });
    h.app.schedules.rollbackBatch(h.owner, NOW);
    expect(h.store.scheduleRules.countExceptions(OWNER)).toBe(1);
    h.close();
  });
});
