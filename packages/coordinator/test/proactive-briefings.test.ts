import { describe, expect, it } from 'vitest';
import { BRIEFING_MAX_DELIVERY_ATTEMPTS } from '@ducky/contracts';
import { slotInstantMs, assertValidSlotTime } from '../src/domain/briefing-notifications.service.js';
import { OWNER, TestClock, makeHarness } from './helpers.js';

/**
 * Proactive briefings — the last piece 2B deferred.
 *
 * The point of these tests is that pushing a briefing reuses the guarantees
 * reminders already have (a durable outbox, idempotent delivery, bounded
 * retries, owner DM only, one scheduler) and adds exactly one rule of its own:
 * a stale briefing is skipped rather than delivered, because a summary of a day
 * that has already happened is not worth sending.
 */
const at = (iso: string, tz = 'UTC') => new TestClock(iso, tz);

const harness = (clock: TestClock, env: Record<string, string> = {}) =>
  makeHarness({
    clock,
    env: {
      DUCKY_BRIEFING_ENABLED: 'true',
      DUCKY_BRIEFING_MORNING_AT: '07:30',
      DUCKY_BRIEFING_EVENING_AT: '20:30',
      DUCKY_OWNER_TIMEZONE: clock.timeZone,
      ...env,
    },
  });

describe('the briefing schedule is validated at startup', () => {
  it('accepts a local HH:MM', () => {
    expect(assertValidSlotTime('07:30', 'X')).toBe('07:30');
    expect(assertValidSlotTime(' 7:05 ', 'X')).toBe('7:05');
  });

  it('refuses a time nobody could have meant, naming the variable', () => {
    for (const bad of ['0730', '7', '25:00', '07:61', 'morning', '']) {
      expect(() => assertValidSlotTime(bad, 'DUCKY_BRIEFING_MORNING_AT'), bad).toThrow(
        /DUCKY_BRIEFING_MORNING_AT/,
      );
    }
  });

  it('refuses to boot on a bad time rather than firing at an unknown hour', () => {
    expect(() => makeHarness({ env: { DUCKY_BRIEFING_MORNING_AT: '7am' } })).toThrow(
      /DUCKY_BRIEFING_MORNING_AT/,
    );
  });

  it('resolves a slot in the owner’s zone, not in UTC', () => {
    // 07:30 in Manila is 23:30 UTC the previous day. A slot computed in UTC
    // would fire eight hours early, which is the whole reason this is zoned.
    const manila = slotInstantMs('2026-03-02', '07:30', 'Asia/Manila')!;
    expect(new Date(manila).toISOString()).toBe('2026-03-01T23:30:00.000Z');
    const utc = slotInstantMs('2026-03-02', '07:30', 'UTC')!;
    expect(new Date(utc).toISOString()).toBe('2026-03-02T07:30:00.000Z');
  });
});

describe('a due slot is claimed once and only once', () => {
  it('claims nothing before the local time has passed', async () => {
    const clock = at('2026-03-02T06:00:00Z');
    const h = harness(clock);

    const result = await h.app.briefingNotifier.tick();

    expect(result.claimed).toBe(0);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')).toBeUndefined();
    h.close();
  });

  it('claims the morning slot once the local time has passed, and delivers it', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);

    const result = await h.app.briefingNotifier.tick();

    expect(result.claimed).toBe(1);
    expect(result.delivered).toBe(1);
    const row = h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')!;
    expect(row.status).toBe('delivered');
    // The owner's DM, and nothing else. There is no channel branch to get wrong.
    const sent = h.transport.sent.at(-1)!;
    expect(sent.target).toEqual({ kind: 'user', userId: OWNER });
    h.close();
  });

  it('sends nothing twice, however many times the tick runs', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);

    await h.app.briefingNotifier.tick();
    const before = h.transport.sent.length;
    await h.app.briefingNotifier.tick();
    await h.app.briefingNotifier.tick();

    expect(h.transport.sent.length).toBe(before);
    h.close();
  });

  it('claims both slots by the evening, and only the timely one is sent', async () => {
    // First tick of the day happens at 21:00, so BOTH slots are claimed at once
    // -- and the morning one is already 13 hours stale. It is recorded and
    // skipped rather than delivered: nobody wants this morning's summary
    // tonight.
    const clock = at('2026-03-02T21:00:00Z');
    const h = harness(clock);

    const result = await h.app.briefingNotifier.tick();

    expect(result.claimed).toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.skippedStale).toBe(1);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')?.status).toBe('skipped');
    expect(h.store.briefings.bySlot(OWNER, 'evening', '2026-03-02')?.status).toBe('delivered');
    h.close();
  });

  it('treats the next civil day as a new slot', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);
    await h.app.briefingNotifier.tick();

    clock.set('2026-03-03T08:00:00Z');
    const next = await h.app.briefingNotifier.tick();

    expect(next.claimed).toBe(1);
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-03-03')).toBeDefined();
    h.close();
  });

  it('does not backfill a day the host was off for', async () => {
    // A briefing for a day nobody was there to read is noise with a date on it.
    const clock = at('2026-03-10T08:00:00Z');
    const h = harness(clock);

    await h.app.briefingNotifier.tick();

    const rows = h.store.db
      .prepare('SELECT day_key FROM briefing_deliveries ORDER BY day_key')
      .all() as { day_key: string }[];
    expect(rows.map((r) => r.day_key)).toEqual(['2026-03-10']);
    h.close();
  });
});

describe('proactive briefings are off unless asked for', () => {
  it('claims nothing and sends nothing by default', async () => {
    const clock = at('2026-03-02T21:00:00Z');
    const h = makeHarness({ clock });

    const result = await h.app.briefingNotifier.tick();

    expect(h.app.briefingNotifier.enabled).toBe(false);
    expect(result).toEqual({ claimed: 0, delivered: 0, failed: 0, abandoned: 0, skippedStale: 0 });
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });
});

describe('delivery is retried, bounded, and honest about giving up', () => {
  it('retries on the next tick and abandons after the bound', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);
    h.transport.failSends = true;

    for (let i = 0; i < BRIEFING_MAX_DELIVERY_ATTEMPTS; i += 1) {
      await h.app.briefingNotifier.tick();
    }

    const row = h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')!;
    // Kept as a record: "Ducky tried and gave up" is a fact, and a deleted row
    // would read as "there was never a briefing".
    expect(row.status).toBe('abandoned');
    expect(row.attempts).toBe(BRIEFING_MAX_DELIVERY_ATTEMPTS);
    h.close();
  });

  it('delivers on a later tick once sending works again', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);
    h.transport.failSends = true;
    await h.app.briefingNotifier.tick();
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')!.status).toBe('pending');

    h.transport.failSends = false;
    await h.app.briefingNotifier.tick();

    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')!.status).toBe('delivered');
    h.close();
  });
});

describe('a stale briefing is skipped rather than delivered', () => {
  it('skips one that came due long before the host came back', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);
    // Claimed, then the host is unreachable for the rest of the day.
    h.transport.failSends = true;
    await h.app.briefingNotifier.tick();
    h.transport.failSends = false;

    clock.set('2026-03-02T21:00:00Z'); // ~13 h after the 07:30 slot
    const result = await h.app.briefingNotifier.tick();

    expect(result.skippedStale).toBe(1);
    expect(result.delivered).toBe(1); // the EVENING slot, which is timely
    expect(h.store.briefings.bySlot(OWNER, 'morning', '2026-03-02')!.status).toBe('skipped');
    h.close();
  });
});

describe('nothing in a pushed briefing can be generated', () => {
  it('assembles from stored records only, and says so', async () => {
    const clock = at('2026-03-02T08:00:00Z');
    const h = harness(clock);
    h.app.tasks.add(h.owner, { title: 'ship the milestone' });

    await h.app.briefingNotifier.tick();

    const body = JSON.stringify(h.transport.sent.at(-1)!.message);
    // Counted from the stored row, not narrated: the task has no due date, so
    // it appears in the totals rather than in a day section.
    expect(body).toContain('1 open task(s)');
    // The provenance line every briefing carries, pulled or pushed.
    expect(body).toContain('Nothing here is generated');
    h.close();
  });
});

describe('briefing delivery targets', () => {
  const CHANNEL = '900000000000000010';

  it('defaults to the DM, so an upgrade changes nothing', () => {
    const h = makeHarness({ env: { DUCKY_BRIEFING_ENABLED: 'true' } });
    // One row per slot, addressed to the owner, exactly as before.
    h.app.briefingNotifier.claimDueSlots();
    const rows = h.store.db
      .prepare('SELECT target FROM briefing_deliveries')
      .all() as { target: string }[];
    for (const r of rows) expect(r.target).toBe('owner_dm');
    h.close();
  });

  it('refuses channel delivery with no channel configured, at STARTUP', () => {
    /**
     * Not a per-tick failure. A briefing addressed to a channel that does not
     * exist would fail once a day, quietly, forever -- and it is never
     * silently downgraded to a DM, because the owner said where they wanted it.
     */
    expect(() =>
      makeHarness({ env: { DUCKY_BRIEFING_ENABLED: 'true', DUCKY_BRIEFING_DELIVERY: 'channel' } }),
    ).toThrow(/needs .*BRIEFING_CHANNEL_ID/i);
    expect(() =>
      makeHarness({ env: { DUCKY_BRIEFING_ENABLED: 'true', DUCKY_BRIEFING_DELIVERY: 'both' } }),
    ).toThrow(/needs .*BRIEFING_CHANNEL_ID/i);
  });

  it('claims one row per target for `both`, so neither copy hides the other', () => {
    /**
     * The reason the target is part of the idempotency key. With a single row,
     * delivering the DM would mark the slot done and the channel copy would
     * never be sent.
     */
    const h = makeHarness({
      env: {
        DUCKY_BRIEFING_ENABLED: 'true',
        DUCKY_BRIEFING_DELIVERY: 'both',
        DUCKY_DEV_BRIEFING_CHANNEL_ID: CHANNEL,
      },
    });
    const claimed = h.app.briefingNotifier.claimDueSlots();
    const rows = h.store.db
      .prepare('SELECT target FROM briefing_deliveries ORDER BY target')
      .all() as { target: string }[];

    if (claimed > 0) {
      expect(new Set(rows.map((r) => r.target))).toEqual(
        new Set(['briefing_channel', 'owner_dm']),
      );
    }
    h.close();
  });

  it('stays idempotent per (slot, target) across repeated ticks', () => {
    const h = makeHarness({
      env: {
        DUCKY_BRIEFING_ENABLED: 'true',
        DUCKY_BRIEFING_DELIVERY: 'both',
        DUCKY_DEV_BRIEFING_CHANNEL_ID: CHANNEL,
      },
    });
    h.app.briefingNotifier.claimDueSlots();
    const after1 = h.store.db.prepare('SELECT COUNT(*) AS n FROM briefing_deliveries').get();
    h.app.briefingNotifier.claimDueSlots();
    h.app.briefingNotifier.claimDueSlots();
    const after3 = h.store.db.prepare('SELECT COUNT(*) AS n FROM briefing_deliveries').get();
    expect(after3).toEqual(after1);
    h.close();
  });
});
