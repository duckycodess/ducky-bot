import { describe, expect, it } from 'vitest';
import { PendingScheduleStore } from '../src/domain/pending-schedules.js';
import { makeHarness } from './helpers.js';

const SCHEDULE_TEXT = '2026-09-01 09:00 | Standup | Room 3\n2026-09-02 15:30 | Retro | Room 1\n';

/** Dumps every string held anywhere in the database. */
function everyStoredString(h: ReturnType<typeof makeHarness>): string {
  const tables = (
    h.store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
  ).map((t) => t.name);
  const chunks: string[] = [];
  for (const table of tables) {
    for (const row of h.store.db.prepare(`SELECT * FROM "${table}"`).all()) {
      chunks.push(JSON.stringify(row));
    }
  }
  return chunks.join('\n');
}

describe('schedule preview never touches storage', () => {
  it('stores nothing anywhere until the owner confirms', async () => {
    const h = makeHarness();
    const outcome = await h.app.schedules.preview(h.owner, { kind: 'text', text: SCHEDULE_TEXT });
    expect(outcome.kind).toBe('draft');

    const dump = everyStoredString(h);
    expect(dump).not.toContain('Standup');
    expect(dump).not.toContain('Room 3');
    expect(h.store.schedules.count()).toBe(0);

    if (outcome.kind !== 'draft') throw new Error('unreachable');
    const { saved } = h.app.schedules.confirm(h.owner, outcome.draft.draftId);
    expect(saved).toBe(2);
    expect(h.store.schedules.count()).toBe(2);
    expect(everyStoredString(h)).toContain('Standup');
    h.close();
  });

  it('shows no preview and saves nothing when nothing parses', async () => {
    const h = makeHarness();
    const outcome = await h.app.schedules.preview(h.owner, { kind: 'text', text: 'lunch sometime' });
    expect(outcome.kind).toBe('empty');
    expect(h.store.schedules.count()).toBe(0);
    h.close();
  });

  it('applies corrections to the pending draft only', async () => {
    const h = makeHarness();
    const outcome = await h.app.schedules.preview(h.owner, { kind: 'text', text: SCHEDULE_TEXT });
    if (outcome.kind !== 'draft') throw new Error('unreachable');
    const corrected = h.app.schedules.correct(h.owner, outcome.draft.draftId, [
      { title: 'Daily standup', startsAt: '2026-09-01 09:15', endsAt: null, location: null, notes: null },
    ]);
    expect(corrected.entries).toHaveLength(1);
    expect(h.store.schedules.count()).toBe(0);
    h.app.schedules.confirm(h.owner, outcome.draft.draftId);
    expect(h.store.schedules.listForOwner(h.owner.discordUserId)[0]?.title).toBe('Daily standup');
    h.close();
  });

  it('reports an expired preview after a restart rather than reconstructing it', async () => {
    const h = makeHarness();
    const outcome = await h.app.schedules.preview(h.owner, { kind: 'text', text: SCHEDULE_TEXT });
    if (outcome.kind !== 'draft') throw new Error('unreachable');
    // A restart loses the in-memory store; confirming the old id must fail safely.
    const restarted = makeHarness();
    expect(() => restarted.app.schedules.confirm(restarted.owner, outcome.draft.draftId)).toThrow(
      /expired/,
    );
    expect(restarted.store.schedules.count()).toBe(0);
    restarted.close();
    h.close();
  });

  it('discards a draft without saving', async () => {
    const h = makeHarness();
    const outcome = await h.app.schedules.preview(h.owner, { kind: 'text', text: SCHEDULE_TEXT });
    if (outcome.kind !== 'draft') throw new Error('unreachable');
    expect(h.app.schedules.discard(h.owner, outcome.draft.draftId)).toBe(true);
    expect(() => h.app.schedules.confirm(h.owner, outcome.draft.draftId)).toThrow(/expired/);
    expect(h.store.schedules.count()).toBe(0);
    h.close();
  });
});

describe('PendingScheduleStore', () => {
  const entry = { title: 't', startsAt: '2026-09-01', endsAt: null, location: null, notes: null };

  it('expires drafts after the TTL', () => {
    let now = 1000;
    const store = new PendingScheduleStore(100, 20, () => now);
    const d = store.put('owner', [entry], 'text');
    expect(store.get(d.draftId, 'owner')).toBeDefined();
    now += 200;
    expect(store.get(d.draftId, 'owner')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('is scoped per owner', () => {
    const store = new PendingScheduleStore();
    const d = store.put('owner', [entry], 'text');
    expect(store.get(d.draftId, 'someone-else')).toBeUndefined();
  });

  it('evicts the oldest draft past the per-owner cap', () => {
    let now = 0;
    const store = new PendingScheduleStore(100_000, 2, () => (now += 1));
    const first = store.put('owner', [entry], 'text');
    store.put('owner', [entry], 'text');
    store.put('owner', [entry], 'text');
    expect(store.get(first.draftId, 'owner')).toBeUndefined();
    expect(store.size).toBe(2);
  });
});
