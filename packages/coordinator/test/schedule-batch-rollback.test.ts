import { describe, expect, it } from 'vitest';
import { OWNER, STRANGER, TestClock, makeHarness, replyText, type Harness } from './helpers.js';

/** Rolling the weekly schedule back one batch. Invented data only. */
const NOW = '2026-10-13T00:00:00.000Z';

const SHARED = '900000000000000001';
const GITHUB = '900000000000000014';
const GUILD = '800000000000000001';
let clock: TestClock;
const boot = (env: Record<string, string> = {}) => {
  clock = new TestClock(NOW, 'UTC');
  return makeHarness({ clock, env });
};
/** The newest stamp in these fixtures is 2026-09-01, so the clock is strictly after it. */
const preview = (h: Harness) => h.app.schedules.previewRollback(h.owner);
/** A deliberate rollback: a fresh preview, then its code. */
const roll = (h: Harness) => {
  const p = preview(h);
  return p.ok ? h.app.schedules.confirmRollback(h.owner, p.code) : p;
};
const auditRows = (h: Harness) =>
  h.store.auditLog.recent(50).filter((r) => r.event === 'schedule.batch_rolled_back');
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

describe('previewing a rollback', () => {
  it('reports counts and a code, names nothing, and writes nothing', () => {
    const h = boot();
    rule(h, 'b3', true, 'Secret Course', null);
    rule(h, 'b3', true, 'Another Class', null);
    rule(h, 'b2', false, 'Hidden Older', '2026-09-01T00:00:00Z');
    const before = state(h);
    const p = preview(h);
    expect(p).toMatchObject({ ok: true, activeBatches: 1, activeRules: 2, restoreRules: 1 });
    if (!p.ok) throw new Error('unreachable');
    expect(p.code).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(p)).not.toMatch(/Secret|Another|Hidden|b3|b2/);
    expect(state(h)).toEqual(before);
    expect(auditRows(h)).toHaveLength(0);
    h.close();
  });

  it('is owner-only', () => {
    const h = boot();
    expect(() => h.app.schedules.previewRollback(h.stranger)).toThrow();
    h.close();
  });

  it('refuses where a rollback would, with the same reasons', () => {
    const none = boot();
    rule(none, 'b1', true, 'only', null);
    expect(preview(none)).toEqual({ ok: false, reason: 'nothing_to_restore' });
    none.close();
    const unknown = boot();
    rule(unknown, 'b2', true, 'current', null);
    rule(unknown, 'b1', false, 'mystery', null);
    expect(preview(unknown)).toEqual({ ok: false, reason: 'order_unknown' });
    unknown.close();
    const tie = boot();
    rule(tie, 'b3', true, 'current', null);
    rule(tie, 'b2', false, 'one', '2026-09-01T00:00:00Z');
    rule(tie, 'b1', false, 'two', '2026-09-01T00:00:00Z');
    expect(preview(tie)).toEqual({ ok: false, reason: 'order_unknown' });
    tie.close();
  });
});

describe('ambiguous or inconsistent history is refused, however much of it is known', () => {
  it('refuses when ANY replaced batch has no known time, even beside batches of known order', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'known', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'unknown', null); // might be the latest
    expect(preview(h)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(roll(h)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(h.app.schedules.confirmRollback(h.owner, '0'.repeat(16))).toEqual({ ok: false, reason: 'order_unknown' });
    expect(state(h)).toEqual(['current:on', 'known:off', 'unknown:off']);
    expect(auditRows(h)).toHaveLength(0);
    h.close();
  });

  it('refuses a replaced batch whose stamp cannot be read', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'known', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'garbled', 'last tuesday');
    expect(preview(h)).toEqual({ ok: false, reason: 'order_unknown' });
    h.close();
  });

  it('refuses a batch split between active and replaced rules', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b3', false, 'straggler', '2026-09-15T00:00:00Z');
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    expect(preview(h)).toEqual({ ok: false, reason: 'inconsistent_batch' });
    expect(roll(h)).toEqual({ ok: false, reason: 'inconsistent_batch' });
    expect(state(h)).toEqual(['current:on', 'older:off', 'straggler:off']);
    h.close();
  });

  it('refuses a replaced batch whose rules carry different replacement times', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'one', '2026-09-01T00:00:00Z');
    rule(h, 'b2', false, 'two', '2026-09-02T00:00:00Z');
    expect(preview(h)).toEqual({ ok: false, reason: 'inconsistent_batch' });
    h.close();
  });

  it('refuses an active rule that carries a replacement time, and one replaced rule without one', () => {
    const stamped = boot();
    rule(stamped, 'b2', true, 'odd', null);
    // The repository never writes this; a damaged row could carry it.
    stamped.store.db.exec("UPDATE schedule_rules SET replaced_at = '2026-09-20T00:00:00Z' WHERE label = 'odd'");
    rule(stamped, 'b1', false, 'older', '2026-09-01T00:00:00Z');
    expect(preview(stamped)).toEqual({ ok: false, reason: 'inconsistent_batch' });
    stamped.close();
    const partial = boot();
    rule(partial, 'b2', true, 'current', null);
    rule(partial, 'b1', false, 'one', '2026-09-01T00:00:00Z');
    rule(partial, 'b1', false, 'two', null);
    expect(preview(partial)).toEqual({ ok: false, reason: 'inconsistent_batch' });
    partial.close();
  });

  it('makes a code stale when one rule is replaced by another with the same counts', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b3', true, 'second', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    // Same batch, same counts, different rule.
    const victim = h.store.scheduleRules.listAllRulesForOwner(OWNER, 10).find((r) => r.label === 'second')!;
    h.store.scheduleRules.deleteRule(OWNER, victim.id);
    rule(h, 'b3', true, 'swapped', null);
    const q = preview(h);
    expect(q).toMatchObject({ ok: true, activeBatches: 1, activeRules: 2, restoreRules: 1 });
    expect(q.ok && q.code !== p.code).toBe(true);
    expect(h.app.schedules.confirmRollback(h.owner, p.code)).toEqual({ ok: false, reason: 'stale' });
    expect(state(h)).toEqual(['current:on', 'older:off', 'swapped:on']);
    h.close();
  });
});

describe('rolling the schedule back one batch', () => {
  it('flips the active batch to replaced and the most recently replaced one to active, deleting nothing', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'oldest', '2026-08-01T00:00:00Z');
    const before = h.store.scheduleRules.countRules(OWNER);
    const out = roll(h);
    expect(out).toEqual({ ok: true, restoredRules: 1, replacedRules: 1 });
    expect(state(h)).toEqual(['current:off', 'older:on', 'oldest:off']);
    expect(h.store.scheduleRules.countRules(OWNER)).toBe(before);
    // Only the restored batch drives behavior.
    expect(h.store.scheduleRules.activeRules(OWNER).map((r) => r.label)).toEqual(['older']);
    h.close();
  });

  it('audits the change by counts, with the injected time, the fixed owner reference and a config subject', () => {
    const h = boot();
    rule(h, 'b3', true, 'Secret Course', null);
    rule(h, 'b2', false, 'Hidden Older', '2026-09-01T00:00:00Z');
    expect(roll(h)).toMatchObject({ ok: true });
    const rows = auditRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: NOW, actorKind: 'owner', actorRef: 'owner', subjectKind: 'config', subjectRef: 'schedule.batches',
      outcome: 'ok', detail: 'restored 1 replaced 1',
    });
    expect(JSON.stringify(rows[0])).not.toMatch(/Secret|Hidden|b3|b2|rule-|\b1000000/);
    h.close();
  });

  it('a stale code changes nothing, and neither does a replay of a used one', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    clock.advance(60_000);
    expect(h.app.schedules.confirmRollback(h.owner, p.code)).toMatchObject({ ok: true });
    expect(state(h)).toEqual(['current:off', 'older:on']);
    // Replay: the flip it authorised changed the state it was issued for.
    clock.advance(60_000);
    expect(h.app.schedules.confirmRollback(h.owner, p.code)).toEqual({ ok: false, reason: 'stale' });
    expect(state(h)).toEqual(['current:off', 'older:on']);
    expect(auditRows(h)).toHaveLength(1);
    // A code that was never issued.
    expect(h.app.schedules.confirmRollback(h.owner, '0'.repeat(16))).toEqual({ ok: false, reason: 'stale' });
    h.close();
  });

  it('binds EVERY batch: a second active batch, or a changed rule count, makes a code stale', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b4', true, 'also active', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    expect(p.activeBatches).toBe(2);
    // A rule joins the SECOND active batch, which the target alone would not notice.
    rule(h, 'b4', true, 'one more', null);
    expect(h.app.schedules.confirmRollback(h.owner, p.code)).toEqual({ ok: false, reason: 'stale' });
    const q = preview(h);
    if (!q.ok) throw new Error('unreachable');
    expect(q.code).not.toBe(p.code);
    // A change inside a replaced batch moves it too.
    rule(h, 'b2', false, 'older two', '2026-09-01T00:00:00Z');
    expect(h.app.schedules.confirmRollback(h.owner, q.code)).toEqual({ ok: false, reason: 'stale' });
    expect(state(h)).toEqual(['also active:on', 'current:on', 'older two:off', 'older:off', 'one more:on']);
    h.close();
  });

  it('a fresh deliberate second rollback flips again, from its own preview, and can return', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'oldest', '2026-08-01T00:00:00Z');
    const first = preview(h);
    expect(roll(h)).toMatchObject({ ok: true }); // older is active; current replaced now
    clock.advance(5 * 60_000);
    const second = preview(h);
    expect(second).toMatchObject({ ok: true });
    expect(second.ok && first.ok && second.code !== first.code).toBe(true);
    expect(roll(h)).toMatchObject({ ok: true }); // current (replaced most recently) comes back
    expect(state(h)).toEqual(['current:on', 'older:off', 'oldest:off']);
    expect(auditRows(h)).toHaveLength(2);
    h.close();
  });

  it('refuses a stamp that is not newer than every stored one, because it would create a tie', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    clock.set('2026-09-01T00:00:00.000Z'); // the same instant as the stored stamp
    expect(roll(h)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(state(h)).toEqual(['current:on', 'older:off']);
    expect(auditRows(h)).toHaveLength(0);
    h.close();
  });

  it('is atomic with its audit row: a failed audit write undoes the flip', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'older', '2026-09-01T00:00:00Z');
    h.store.db.exec(
      "CREATE TRIGGER no_audit BEFORE INSERT ON audit_log WHEN NEW.event = 'schedule.batch_rolled_back' " +
      "BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    expect(() => h.app.schedules.confirmRollback(h.owner, p.code)).toThrow(/audit unavailable/);
    expect(state(h)).toEqual(['current:on', 'older:off']);
    // Nothing was spent: with the audit available again the SAME code still confirms.
    h.store.db.exec('DROP TRIGGER no_audit');
    expect(h.app.schedules.confirmRollback(h.owner, p.code)).toMatchObject({ ok: true });
    expect(state(h)).toEqual(['current:off', 'older:on']);
    h.close();
  });

  it('refuses when there is nothing to restore, and changes nothing', () => {
    const h = boot();
    rule(h, 'b1', true, 'only', null);
    expect(roll(h)).toEqual({ ok: false, reason: 'nothing_to_restore' });
    expect(h.app.schedules.confirmRollback(h.owner, '0'.repeat(16))).toEqual({ ok: false, reason: 'nothing_to_restore' });
    expect(state(h)).toEqual(['only:on']);
    h.close();
  });

  it('refuses to guess when the order of the replaced batches is unknown', () => {
    const h = boot();
    rule(h, 'b2', true, 'current', null);
    rule(h, 'b1', false, 'mystery', null);
    expect(roll(h)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(state(h)).toEqual(['current:on', 'mystery:off']);
    h.close();
  });

  it('refuses when two replaced batches carry the same instant', () => {
    const h = boot();
    rule(h, 'b3', true, 'current', null);
    rule(h, 'b2', false, 'one', '2026-09-01T00:00:00Z');
    rule(h, 'b1', false, 'two', '2026-09-01T00:00:00Z');
    expect(roll(h)).toEqual({ ok: false, reason: 'order_unknown' });
    expect(state(h)).toEqual(['current:on', 'one:off', 'two:off']);
    h.close();
  });

  it('never touches another owner’s schedule, and is owner-only', () => {
    const h = boot();
    rule(h, 'b2', true, 'mine', null);
    rule(h, 'b1', false, 'mine-old', '2026-09-01T00:00:00Z');
    rule(h, 'x2', true, 'theirs', null, STRANGER);
    rule(h, 'x1', false, 'theirs-old', '2026-09-01T00:00:00Z', STRANGER);
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    expect(() => h.app.schedules.confirmRollback(h.stranger, p.code)).toThrow();
    expect(state(h)).toEqual(['mine-old:off', 'mine:on']);
    roll(h);
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
    roll(h);
    expect(h.store.scheduleRules.countExceptions(OWNER)).toBe(1);
    h.close();
  });
});

describe('/schedule rollback through the command', () => {
  const dispatch = (h: Harness, options: Record<string, string | number | boolean | undefined>, extra: object = {}) =>
    h.transport.dispatch({ kind: 'command', name: 'schedule', userId: OWNER, options, ...extra } as never);
  const seed = (h: Harness) => {
    rule(h, 'b3', true, 'Secret Course', null);
    rule(h, 'b2', false, 'Hidden Older', '2026-09-01T00:00:00Z');
  };

  it('previews, then confirms with the code, privately and without naming anything', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    seed(h);
    const shown = await dispatch(h, { rollback: 'preview' });
    expect(shown?.ephemeral).toBe(true);
    const code = /rollback:([0-9a-f]{16})/.exec(replyText(shown))?.[1];
    expect(code).toBeDefined();
    expect(replyText(shown)).not.toMatch(/Secret|Hidden|b3|b2/);
    expect(state(h)).toEqual(['Hidden Older:off', 'Secret Course:on']);

    const done = await dispatch(h, { rollback: code! });
    expect(done?.ephemeral).toBe(true);
    expect(replyText(done)).toMatch(/rolled back: 1 rule replaced, 1 restored/);
    expect(replyText(done)).not.toMatch(/Secret|Hidden/);
    expect(state(h)).toEqual(['Hidden Older:on', 'Secret Course:off']);
    expect(auditRows(h)).toHaveLength(1);

    // Replayed: refused, unchanged.
    clock.advance(60_000);
    const again = await dispatch(h, { rollback: code! });
    expect(replyText(again)).toMatch(/no longer matches/);
    expect(state(h)).toEqual(['Hidden Older:on', 'Secret Course:off']);
    h.close();
  });

  it('refuses a mixture with text or a file, and anything that is neither preview nor a code', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    seed(h);
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    const withText = await dispatch(h, { rollback: p.code, text: 'Monday 09:00 Maths' });
    expect(replyText(withText)).toMatch(/on its own/);
    const withFile = await dispatch(h, { rollback: p.code }, {
      attachment: { filename: 's.csv', contentType: 'text/csv', size: 10, url: 'https://cdn.example/s.csv' },
    });
    expect(replyText(withFile)).toMatch(/on its own/);
    for (const bad of ['', 'yes', 'ROLLBACK', 'preview now', p.code.slice(0, 8), `${p.code}0`, 'g'.repeat(16)]) {
      const out = await dispatch(h, { rollback: bad });
      expect(replyText(out), bad).toMatch(/Send `\/schedule rollback:preview` first/);
    }
    expect(state(h)).toEqual(['Hidden Older:off', 'Secret Course:on']);
    expect(h.store.schedules.count()).toBe(0);
    expect(auditRows(h)).toHaveLength(0);
    h.close();
  });

  it('still previews text exactly as before when rollback is absent', async () => {
    const h = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const out = await dispatch(h, { text: '2026-09-01 09:00 | Standup | Room 3' });
    expect(JSON.stringify(out)).toContain('Nothing is saved yet');
    expect(out?.rows?.[0]?.buttons).toHaveLength(3);
    expect(h.store.schedules.count()).toBe(0);
    h.close();
  });

  it('refuses a non-owner before any service runs, in a DM, a shared channel and the github channel', async () => {
    const h = boot({ DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED, DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB });
    await h.transport.start((e) => h.app.router.handle(e));
    seed(h);
    const p = preview(h);
    if (!p.ok) throw new Error('unreachable');
    for (const context of [
      undefined, { channelId: SHARED, guildId: GUILD }, { channelId: GITHUB, guildId: GUILD },
    ]) {
      for (const rollback of ['preview', p.code]) {
        const out = await h.transport.dispatch({
          kind: 'command', name: 'schedule', userId: STRANGER, options: { rollback },
          ...(context ? { context } : {}),
        } as never);
        expect(replyText(out)).toMatch(/not authorized/i);
        expect(replyText(out)).not.toMatch(/Secret|Hidden|rolled back|restore/);
      }
    }
    expect(state(h)).toEqual(['Hidden Older:off', 'Secret Course:on']);
    expect(auditRows(h)).toHaveLength(0);
    h.close();
  });

  it('answers the owner privately even in a shared or github channel', async () => {
    const h = boot({ DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED, DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB });
    await h.transport.start((e) => h.app.router.handle(e));
    seed(h);
    for (const channelId of [SHARED, GITHUB]) {
      const out = await dispatch(h, { rollback: 'preview' }, { context: { channelId, guildId: GUILD } });
      expect(out?.ephemeral).toBe(true);
      expect(replyText(out)).not.toMatch(/Secret|Hidden/);
    }
    h.close();
  });
});
