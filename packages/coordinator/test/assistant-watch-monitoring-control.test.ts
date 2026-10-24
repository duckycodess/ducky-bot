import { describe, expect, it } from 'vitest';
import { WATCH_EVENT_KINDS, type WatchSurface } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { OWNER, REPOS_JSON, STRANGER, TestClock, makeHarness, replyText, type Harness } from './helpers.js';

/**
 * The owner's explicit on/off control over the global monitoring switch, through the
 * real service, store, router and transport with a scripted reader. Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;
const SHARED = '900000000000000001';
const GITHUB = '900000000000000014';
const GUILD = '800000000000000001';

const boot = (env: Record<string, string> = {}) => {
  const clock = new TestClock(NOW, 'UTC');
  const reader = new FakeWatchReader();
  reader.capabilities = { observableKinds: [...WATCH_EVENT_KINDS], discovery: false };
  const h = makeHarness({ clock, assistantWatchReader: reader, env });
  return { h, clock, reader };
};

let seq = 700;
const addTarget = (h: Harness, key: string, state: 'active' | 'cancelled' = 'active') => {
  seq += 1;
  const id = `m${seq}`;
  h.store.assistantWatch.insertTarget({
    id, publicId: `w${String(seq).padStart(5, '0')}`, discordUserId: OWNER, repoKey: key, display: key,
    defaultBranch: 'main', state, lastObservedAt: null, createdAt: NOW,
    cancelledAt: state === 'cancelled' ? NOW : null, pushedAt: null, relationship: null, archived: false, fork: false,
  });
  return id;
};
const checkpoint = (h: Harness, id: string, surface: WatchSurface) =>
  h.store.assistantWatch.insertCheckpoint({
    targetId: id, surface, state: 'imported', cursor: '2026-10-10T00:00:00.000Z', nextDueAt: NOW, updatedAt: NOW,
  });

/** Everything the switch must never touch: targets, checkpoints, events and the call budget. */
const observationState = (h: Harness): string =>
  JSON.stringify(
    ['assistant_watch_targets', 'assistant_watch_checkpoints', 'assistant_watch_events', 'assistant_watch_calls']
      .map((t) => h.store.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()),
  );
const setting = (h: Harness) =>
  h.store.db.prepare('SELECT * FROM assistant_watch_settings').all() as Record<string, unknown>[];
const audit = (h: Harness) => h.store.auditLog.recent(50).filter((r) => r.event === 'watch.monitoring_changed');
const turn = (h: Harness, enabled: boolean) => h.app.assistantWatch.setMonitoring(h.owner, enabled);

describe('setting the switch explicitly', () => {
  it('turns it off with a settings row, an injected-time audit row and nothing else', () => {
    const { h } = boot();
    expect(turn(h, false)).toEqual({ ok: true, changed: true, enabled: false });
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    expect(setting(h)).toMatchObject([{ discord_user_id: OWNER, monitoring_enabled: 0, updated_at: NOW }]);
    const rows = audit(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: NOW, actorKind: 'owner', actorRef: 'owner', subjectKind: 'config', subjectRef: 'watch.monitoring',
      outcome: 'ok', detail: 'on to off',
    });
    h.close();
  });

  it('is a no-op in the state it already has: no row, no timestamp, no audit row', () => {
    const { h, clock } = boot();
    // Never stored means on: saying on changes nothing and writes nothing.
    expect(turn(h, true)).toEqual({ ok: true, changed: false, enabled: true });
    expect(setting(h)).toEqual([]);
    expect(audit(h)).toHaveLength(0);

    turn(h, false);
    const stamped = setting(h);
    clock.advance(5 * MIN);
    expect(turn(h, false)).toEqual({ ok: true, changed: false, enabled: false });
    expect(setting(h)).toEqual(stamped); // the same timestamp, not refreshed
    expect(audit(h)).toHaveLength(1);

    clock.advance(5 * MIN);
    expect(turn(h, true)).toMatchObject({ ok: true, changed: true, enabled: true });
    const resumed = setting(h);
    clock.advance(5 * MIN);
    expect(turn(h, true)).toMatchObject({ ok: true, changed: false });
    expect(setting(h)).toEqual(resumed);
    expect(audit(h).map((r) => r.detail)).toEqual(['off to on', 'on to off']);
    h.close();
  });

  it('is owner-only', () => {
    const { h } = boot();
    expect(() => h.app.assistantWatch.setMonitoring(h.stranger, false)).toThrow();
    expect(setting(h)).toEqual([]);
    expect(audit(h)).toHaveLength(0);
    h.close();
  });

  it('is atomic with its audit row: a failed audit write leaves the switch where it was', () => {
    const { h } = boot();
    h.store.db.exec(
      "CREATE TRIGGER no_audit BEFORE INSERT ON audit_log WHEN NEW.event = 'watch.monitoring_changed' " +
      "BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => turn(h, false)).toThrow(/audit unavailable/);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    expect(setting(h)).toEqual([]);
    h.store.db.exec('DROP TRIGGER no_audit');
    expect(turn(h, false)).toMatchObject({ ok: true, changed: true });

    // And from OFF: resuming with a failing audit keeps it paused, timestamp untouched.
    const paused = setting(h);
    h.store.db.exec(
      "CREATE TRIGGER no_audit BEFORE INSERT ON audit_log WHEN NEW.event = 'watch.monitoring_changed' " +
      "BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => turn(h, true)).toThrow(/audit unavailable/);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    expect(setting(h)).toEqual(paused);
    h.close();
  });
});

describe('pausing and resuming change no observation state', () => {
  it('keeps every target, checkpoint, pending event and call count, and resumes where it stood', async () => {
    const { h, clock, reader } = boot();
    const id = addTarget(h, 'acme/widgets');
    checkpoint(h, id, 'issues');
    checkpoint(h, id, 'pulls');
    h.store.assistantWatch.insertImportedEvent({
      id: 'e1', targetId: id, kind: 'review_requested_changes', identity: '3:review:r9', occurredAt: '2026-10-12T12:00:00.000Z',
      payloadJson: JSON.stringify({ number: 3, title: 'Add a thing' }), alertedAt: NOW, digestedAt: null, createdAt: NOW,
    });
    const before = observationState(h);

    turn(h, false);
    expect(observationState(h)).toBe(before);
    clock.advance(MIN);
    const paused = await h.app.assistantWatch.tick();
    expect(paused.callsUsed).toBe(0);
    expect(reader.calls).toBe(0);
    expect(observationState(h)).toBe(before);

    turn(h, true);
    expect(observationState(h)).toBe(before);
    expect(h.store.assistantWatch.checkpoint(id, 'issues')).toMatchObject({ state: 'imported', cursor: '2026-10-10T00:00:00.000Z' });
    clock.advance(MIN);
    expect((await h.app.assistantWatch.tick()).callsUsed).toBeGreaterThan(0);
    h.close();
  });

  it('keeps a recorded failure and its backoff across a pause and a resume', async () => {
    const { h, clock, reader } = boot();
    const id = addTarget(h, 'acme/widgets');
    checkpoint(h, id, 'issues');
    reader.failNext.add('issues');
    await h.app.assistantWatch.tick();
    const failed = h.store.assistantWatch.checkpoint(id, 'issues')!;
    expect(failed.failures).toBeGreaterThan(0);
    const before = observationState(h);
    turn(h, false);
    clock.advance(MIN);
    turn(h, true);
    expect(observationState(h)).toBe(before);
    expect(h.store.assistantWatch.checkpoint(id, 'issues')).toMatchObject({
      failures: failed.failures, nextDueAt: failed.nextDueAt,
    });
    h.close();
  });

  it('applies a pause at the NEXT tick: the tick in flight finishes, the next reads nothing', async () => {
    const { h, clock, reader } = boot();
    const id = addTarget(h, 'acme/widgets');
    checkpoint(h, id, 'issues');
    clock.advance(MIN);
    const running = h.app.assistantWatch.tick(); // reads the switch synchronously, before its first await
    turn(h, false); // the owner pauses while it runs
    const inFlight = await running;
    expect(inFlight.callsUsed).toBeGreaterThan(0);
    const calls = reader.calls;
    clock.advance(10 * MIN);
    expect((await h.app.assistantWatch.tick()).callsUsed).toBe(0);
    expect(reader.calls).toBe(calls);
    h.close();
  });

  it('still delivers an alert that was already owed while it is off', async () => {
    const { h } = boot();
    const id = addTarget(h, 'acme/widgets');
    checkpoint(h, id, 'pulls');
    h.store.assistantWatch.insertImportedEvent({
      id: 'a1', targetId: id, kind: 'review_requested_changes', identity: '3:review:r9', occurredAt: '2026-10-12T12:00:00.000Z',
      payloadJson: JSON.stringify({ number: 3, title: 'Add a thing' }), alertedAt: null, digestedAt: null, createdAt: NOW,
    });
    turn(h, false);
    expect((await h.app.assistantWatch.tick()).alertsSent).toBe(1);
    h.close();
  });
});

describe('resuming no longer refuses because history exists (ADR 0034)', () => {
  const pauseWithTarget = (h: Harness, key = 'acme/demo') => {
    const id = addTarget(h, key);
    checkpoint(h, id, 'pulls');
    return id;
  };

  it.each([
    ['an ordinary watch active on the same repository', (h: Harness) => {
      h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    }],
    ['an ordinary watch cancelled long before', (h: Harness) => {
      const w = h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
      h.app.githubWatches.cancel(h.owner, w.publicId);
    }],
    ['a selected feed repository that a target also watches', (h: Harness) => {
      h.store.githubFeed.insertRepo({ repoKey: 'acme/demo', display: 'x', source: 'explicit', atIso: NOW });
    }],
    ['a cancelled feed repository on the same repository', (h: Harness) => {
      h.store.githubFeed.insertRepo({ repoKey: 'acme/demo', display: 'x', source: 'explicit', atIso: NOW });
      h.store.githubFeed.cancelRepo('acme/demo', NOW);
    }],
  ])('resumes with %s, changing no checkpoint', (_name, history) => {
    const { h, clock } = boot();
    const id = pauseWithTarget(h);
    turn(h, false);
    clock.advance(MIN);
    history(h);
    clock.advance(MIN);
    const cursor = h.store.assistantWatch.checkpoint(id, 'pulls')!.cursor;
    const state = observationState(h);
    expect(turn(h, true)).toEqual({ ok: true, changed: true, enabled: true });
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    expect(observationState(h)).toBe(state);
    expect(h.store.assistantWatch.checkpoint(id, 'pulls')).toMatchObject({ state: 'imported', cursor });
    h.close();
  });

  it('refuses only when the ledger boundary cannot be read, and then changes nothing', () => {
    const { h } = boot();
    pauseWithTarget(h);
    turn(h, false);
    const since = setting(h);
    h.store.db.exec('DELETE FROM native_ledger_boundary');
    expect(turn(h, true)).toEqual({ ok: false, reason: 'ledger_unreadable' });
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    expect(setting(h)).toEqual(since);
    expect(audit(h).map((r) => r.detail)).toEqual(['on to off']);
    h.close();
  });

  it('records who paused, when, and when it ended; a no-op records nothing', () => {
    const { h, clock } = boot();
    pauseWithTarget(h);
    expect(turn(h, true)).toMatchObject({ changed: false });
    expect(h.store.assistantWatch.pausePeriods(OWNER)).toEqual([]);
    turn(h, false);
    clock.advance(MIN);
    expect(turn(h, false)).toMatchObject({ changed: false });
    expect(h.store.assistantWatch.pausePeriods(OWNER)).toEqual([
      { startedAt: NOW, startedOrigin: 'owner', startBoundAt: NOW, endedAt: null },
    ]);
    clock.advance(MIN);
    turn(h, true);
    expect(h.store.assistantWatch.pausePeriods(OWNER)).toEqual([
      { startedAt: NOW, startedOrigin: 'owner', startBoundAt: NOW, endedAt: new Date(Date.parse(NOW) + 2 * MIN).toISOString() },
    ]);
    h.close();
  });

  it('gives an imported pause no real start, only the latest instant it is known to have begun', () => {
    const { h, clock } = boot();
    h.store.assistantWatch.setMonitoring(OWNER, false, NOW, 'import');
    expect(h.store.assistantWatch.pausePeriods(OWNER)).toEqual([
      { startedAt: null, startedOrigin: 'import', startBoundAt: NOW, endedAt: null },
    ]);
    clock.advance(MIN);
    expect(turn(h, true)).toMatchObject({ ok: true, changed: true });
    expect(h.store.assistantWatch.pausePeriods(OWNER)[0]).toMatchObject({ startedAt: null, endedAt: expect.any(String) });
    h.close();
  });

  it('names the pause and its provenance in /status without any repository', () => {
    const { h } = boot();
    pauseWithTarget(h);
    turn(h, false);
    expect(h.app.assistantWatch.statusLine()).toMatch(/PAUSED.*since 2026-10-13T00:00:00.000Z/);
    h.store.db.exec('DELETE FROM assistant_watch_pause_periods');
    expect(h.app.assistantWatch.statusLine()).toMatch(/PAUSED.*start unknown/);
    h.close();
  });

  it('never resets a checkpoint to get past history', async () => {
    const { h, clock } = boot();
    const id = pauseWithTarget(h);
    turn(h, false);
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(MIN);
    const cursor = h.store.assistantWatch.checkpoint(id, 'pulls')!.cursor;
    turn(h, true);
    expect(h.store.assistantWatch.checkpoint(id, 'pulls')).toMatchObject({ state: 'imported', cursor });
    h.close();
  });
});

describe('/watch monitoring through the command', () => {
  const dispatch = (h: Harness, userId: string, options: Record<string, string | number | boolean | undefined>, context?: object) =>
    h.transport.dispatch({
      kind: 'command', name: 'watch', subcommand: 'monitoring', userId, options, ...(context ? { context } : {}),
    } as never);

  it('turns it off and on, privately, saying only what changed', async () => {
    const { h } = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const off = await dispatch(h, OWNER, { state: 'off' });
    expect(off?.ephemeral).toBe(true);
    expect(replyText(off)).toMatch(/monitoring is off/i);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(false);
    const again = await dispatch(h, OWNER, { state: 'OFF' });
    expect(replyText(again)).toMatch(/already off/);
    const on = await dispatch(h, OWNER, { state: 'on' });
    expect(replyText(on)).toMatch(/monitoring is on.*nothing was reset/i);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    expect(audit(h)).toHaveLength(2);
    h.close();
  });

  it('refuses anything that is not exactly on or off, and is never a toggle', async () => {
    const { h } = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    for (const bad of [undefined, '', 'toggle', 'resume', 'pause', 'true', '1', 'on off']) {
      const out = await dispatch(h, OWNER, bad === undefined ? {} : { state: bad });
      expect(replyText(out), String(bad)).toMatch(/state:on.*state:off/);
    }
    expect(setting(h)).toEqual([]);
    expect(audit(h)).toHaveLength(0);
    h.close();
  });

  it('resumes through the command over retained history, saying nothing about a repository', async () => {
    const { h, clock } = boot();
    await h.transport.start((e) => h.app.router.handle(e));
    const id = addTarget(h, 'acme/demo');
    checkpoint(h, id, 'pulls');
    await dispatch(h, OWNER, { state: 'off' });
    clock.advance(MIN);
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    const out = await dispatch(h, OWNER, { state: 'on' });
    expect(out?.ephemeral).toBe(true);
    expect(replyText(out)).toMatch(/Monitoring is on.*nothing was reset.*not sent again.*withheld/is);
    expect(replyText(out)).not.toMatch(/acme|demo/i);
    expect(h.store.assistantWatch.monitoringEnabled(OWNER)).toBe(true);
    h.close();
  });

  it('refuses a non-owner everywhere, before the service, and answers the owner privately in channels', async () => {
    const { h } = boot({ DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED, DUCKY_DEV_GITHUB_CHANNEL_ID: GITHUB });
    await h.transport.start((e) => h.app.router.handle(e));
    const contexts = [undefined, { channelId: SHARED, guildId: GUILD }, { channelId: GITHUB, guildId: GUILD }];
    for (const context of contexts) {
      const out = await dispatch(h, STRANGER, { state: 'off' }, context);
      expect(replyText(out)).toMatch(/not authorized/i);
    }
    expect(setting(h)).toEqual([]);
    for (const context of contexts.slice(1)) {
      const out = await dispatch(h, OWNER, { state: 'on' }, context);
      expect(out?.ephemeral).toBe(true);
    }
    expect(audit(h)).toHaveLength(0); // already on: nothing changed
    h.close();
  });
});
