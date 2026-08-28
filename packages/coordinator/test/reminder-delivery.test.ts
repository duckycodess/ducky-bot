import { describe, expect, it } from 'vitest';
import { REMINDER_MAX_DELIVERY_ATTEMPTS } from '@ducky/contracts';
import { planOccurrence } from '../src/domain/reminder-notifications.service.js';
import type { ReminderRow } from '@ducky/persistence';
import { OWNER, TestClock, makeHarness } from './helpers.js';

const MANILA = 'Asia/Manila';
const START = '2026-09-01T02:00:00.000Z'; // 10:00 in Manila
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const boot = () => {
  const clock = new TestClock(START, MANILA);
  const h = makeHarness({ clock });
  return { h, clock };
};

const flat = (m: unknown): string => JSON.stringify(m);

describe('planOccurrence', () => {
  const base: ReminderRow = {
    id: 'r1', publicId: 'rabcde', discordUserId: OWNER, text: 'x',
    recurrenceKind: 'interval', intervalMinutes: 60, maxOccurrences: 5, firedCount: 0,
    nextFireAt: '2026-09-01T09:00:00.000Z', status: 'scheduled',
    createdAt: 'c', updatedAt: 'u', firstFireAt: '2026-09-01T09:00:00.000Z',
    lastFiredAt: null, closedAt: null,
  };
  const at = (iso: string) => Date.parse(iso);

  it('produces nothing before the scheduled instant', () => {
    expect(planOccurrence(base, at('2026-09-01T08:59:59.000Z'))).toBeUndefined();
  });

  it('produces exactly one occurrence when a single slot is due', () => {
    const plan = planOccurrence(base, at('2026-09-01T09:00:01.000Z'))!;
    expect(plan.occurrenceNo).toBe(1);
    expect(plan.missedCount).toBe(0);
    expect(plan.scheduledForMs).toBe(at('2026-09-01T09:00:00.000Z'));
    expect(plan.nextFireAtMs).toBe(at('2026-09-01T10:00:00.000Z'));
    expect(plan.status).toBe('scheduled');
  });

  it('collapses a whole outage into one occurrence and counts what it stands for', () => {
    // Three and a half hours late: slots at 09, 10, 11 and 12 have all passed.
    const plan = planOccurrence(base, at('2026-09-01T12:30:00.000Z'))!;
    expect(plan.occurrenceNo).toBe(4);
    expect(plan.missedCount).toBe(3);
    expect(plan.scheduledForMs).toBe(at('2026-09-01T12:00:00.000Z'));
    expect(plan.nextFireAtMs).toBe(at('2026-09-01T13:00:00.000Z'));
  });

  it('never exceeds the occurrence count, however long the outage', () => {
    // Days late on a five-occurrence series: it ends at five, not at hundreds.
    const plan = planOccurrence(base, at('2026-09-08T09:00:00.000Z'))!;
    expect(plan.occurrenceNo).toBe(5);
    expect(plan.missedCount).toBe(4);
    expect(plan.nextFireAtMs).toBeNull();
    expect(plan.status).toBe('completed');
  });

  it('finishes a one-shot in a single occurrence', () => {
    const once = { ...base, recurrenceKind: 'once' as const, intervalMinutes: null, maxOccurrences: 1 };
    const plan = planOccurrence(once, at('2026-09-05T00:00:00.000Z'))!;
    expect(plan).toMatchObject({ occurrenceNo: 1, missedCount: 0, nextFireAtMs: null, status: 'completed' });
  });

  it('produces nothing for a reminder that is not scheduled or has no cursor', () => {
    expect(planOccurrence({ ...base, status: 'cancelled', nextFireAt: null }, at('2030-01-01T00:00:00Z')))
      .toBeUndefined();
    expect(planOccurrence({ ...base, firedCount: 5 }, at('2030-01-01T00:00:00Z'))).toBeUndefined();
  });
});

describe('the assistant tick', () => {
  it('fires nothing before a reminder is due', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'call back', at: 'in 1h' });

    clock.advance(59 * MINUTE);
    expect(await h.app.reminderNotifier.tick()).toMatchObject({ materialized: 0, delivered: 0 });
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('delivers a due reminder to the owner’s DM and only there', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'call the dentist', at: 'in 1h' });

    clock.advance(HOUR + MINUTE);
    const result = await h.app.reminderNotifier.tick();
    expect(result).toMatchObject({ materialized: 1, delivered: 1, failed: 0, abandoned: 0 });

    expect(h.transport.sent).toHaveLength(1);
    const [sent] = h.transport.sent;
    expect(sent?.target).toEqual({ kind: 'user', userId: OWNER });
    expect(flat(sent?.message)).toContain('call the dentist');
    // A DM is not ephemeral, and a reminder carries no control.
    expect(sent?.message.ephemeral).toBe(false);
    expect(sent?.message.rows ?? []).toHaveLength(0);
    h.close();
  });

  it('renders the time as a Discord timestamp, not a fixed-locale string', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'x', at: 'in 1h' });
    clock.advance(HOUR + MINUTE);
    await h.app.reminderNotifier.tick();
    expect(flat(h.transport.sent[0]?.message)).toMatch(/<t:\d+:f>/);
    h.close();
  });

  it('does not send the same occurrence twice, however often the tick runs', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'once only', at: 'in 1h' });

    clock.advance(HOUR + MINUTE);
    await h.app.reminderNotifier.tick();
    await h.app.reminderNotifier.tick();
    await h.app.reminderNotifier.tick();

    expect(h.transport.sent).toHaveLength(1);
    expect(h.app.reminders.list(h.owner, 'all')[0]?.status).toBe('completed');
    h.close();
  });

  it('advances a recurrence once per tick, not once per call', async () => {
    const { h, clock } = boot();
    const r = h.app.reminders.add(h.owner, {
      text: 'drink water', at: 'in 1h', every: '1h', count: 3,
    });

    clock.advance(HOUR + MINUTE);
    await h.app.reminderNotifier.tick();
    await h.app.reminderNotifier.tick();
    expect(h.transport.sent).toHaveLength(1);
    expect(h.store.reminders.byId(r.id)?.firedCount).toBe(1);

    clock.advance(HOUR);
    await h.app.reminderNotifier.tick();
    expect(h.transport.sent).toHaveLength(2);
    expect(h.store.reminders.byId(r.id)?.firedCount).toBe(2);

    clock.advance(HOUR);
    await h.app.reminderNotifier.tick();
    expect(h.transport.sent).toHaveLength(3);
    const finished = h.store.reminders.byId(r.id)!;
    expect(finished.status).toBe('completed');
    expect(finished.nextFireAt).toBeNull();

    // Exhausted: no further tick produces anything.
    clock.advance(10 * HOUR);
    await h.app.reminderNotifier.tick();
    expect(h.transport.sent).toHaveLength(3);
    h.close();
  });

  it('collapses a day-long outage into ONE message that says what it stands for', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'hourly nudge', at: 'in 1h', every: '1h', count: 50 });

    // The host was off for a day. A message per missed hour would be a storm.
    clock.advance(25 * HOUR);
    const result = await h.app.reminderNotifier.tick();

    expect(result.materialized).toBe(1);
    expect(h.transport.sent).toHaveLength(1);
    const body = flat(h.transport.sent[0]?.message);
    expect(body).toContain('Catch-up');
    expect(body).toContain('24 earlier occurrences');
    h.close();
  });

  it('still delivers a one-shot that came due during an outage, plainly late', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'the thing', at: 'in 1h' });

    clock.advance(3 * 24 * HOUR);
    await h.app.reminderNotifier.tick();

    expect(h.transport.sent).toHaveLength(1);
    const body = flat(h.transport.sent[0]?.message);
    expect(body).toContain('the thing');
    // The relative timestamp is what says how late it is; nothing is dropped.
    expect(body).toMatch(/<t:\d+:R>/);
    h.close();
  });

  it('isolates a failed send, retries it, and gives up only after a bounded number of attempts', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'flaky one', at: 'in 1h' });
    h.app.reminders.add(h.owner, { text: 'the other one', at: 'in 1h' });
    clock.advance(HOUR + MINUTE);

    const original = h.transport.send.bind(h.transport);
    let failing = true;
    h.transport.send = async (target, message) => {
      if (failing && JSON.stringify(message).includes('flaky one')) {
        throw new Error('discord is down');
      }
      return original(target, message);
    };

    const first = await h.app.reminderNotifier.tick();
    // One failure never stops the rest of the batch.
    expect(first.delivered).toBe(1);
    expect(first.failed).toBe(1);
    expect(flat(h.transport.sent)).toContain('the other one');
    expect(flat(h.transport.sent)).not.toContain('flaky one');

    // Still pending, so a later tick retries this exact occurrence.
    failing = false;
    const second = await h.app.reminderNotifier.tick();
    expect(second.delivered).toBe(1);
    expect(flat(h.transport.sent)).toContain('flaky one');
    h.close();
  });

  it('abandons an occurrence that can never be delivered rather than retrying forever', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'undeliverable', at: 'in 1h' });
    clock.advance(HOUR + MINUTE);
    h.transport.send = async () => {
      throw new Error('permanently down');
    };

    for (let i = 0; i < REMINDER_MAX_DELIVERY_ATTEMPTS; i += 1) {
      await h.app.reminderNotifier.tick();
    }
    // Retired, and still visible in the ledger as a record of what happened.
    expect(h.store.reminders.pendingOccurrences(10)).toHaveLength(0);
    const reminderId = h.app.reminders.list(h.owner, 'all')[0]!.id;
    const [occurrence] = h.store.reminders.occurrencesFor(reminderId);
    expect(occurrence?.abandonedAt).not.toBeNull();
    expect(occurrence?.deliveredAt).toBeNull();
    expect(occurrence?.attempts).toBe(REMINDER_MAX_DELIVERY_ATTEMPTS);
    h.close();
  });

  it('never re-addresses a previous owner’s reminder to a new one', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'someone else’s private reminder', at: 'in 1h' });
    // The configured owner changed; the stored row belongs to the old one.
    h.store.db.prepare('UPDATE reminders SET discord_user_id = ?').run('999999999999999999');

    clock.advance(HOUR + MINUTE);
    const result = await h.app.reminderNotifier.tick();
    expect(result.delivered).toBe(0);
    expect(result.abandoned).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('never sends a cancelled reminder, even one already due', async () => {
    const { h, clock } = boot();
    const r = h.app.reminders.add(h.owner, { text: 'cancel me', at: 'in 1h', every: '1h', count: 5 });

    clock.advance(HOUR + MINUTE);
    h.app.reminderNotifier.materializeDue();
    h.app.reminders.cancel(h.owner, r.publicId);

    const result = await h.app.reminderNotifier.tick();
    expect(result.delivered).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
    h.close();
  });

  it('runs one pass at a time, so two overlapping ticks cannot both send', async () => {
    const { h, clock } = boot();
    h.app.reminders.add(h.owner, { text: 'exactly once', at: 'in 1h' });
    clock.advance(HOUR + MINUTE);

    const [a, b] = await Promise.all([
      h.app.reminderNotifier.tick(),
      h.app.reminderNotifier.tick(),
    ]);
    expect(a).toBe(b);
    expect(h.transport.sent).toHaveLength(1);
    h.close();
  });
});
