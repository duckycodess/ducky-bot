import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryCredentialStore, MockConversationProvider, MockGitHubReader, OpenMeteoWeather, type WeatherPlace,
} from '@ducky/adapters';
import { RUNTIME_LOCK_HEARTBEAT_MS, RUNTIME_LOCK_STALE_MS } from '@ducky/contracts';
import { acquireRuntimeLock, createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { createApp } from '../src/app.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import { startLockHeartbeat, takeCoordinatorLock } from '../src/runtime-lock.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { MANILA, importDoc, importEnv } from './assistant-import-fixture.js';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { OWNER, REPOS_JSON, TestClock, makeHarness, secret, type Harness } from './helpers.js';
import { takeLock } from './assistant-import-fixture.js';

/** Fixes from the independent review of 86b1189. Invented data only. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---- the coordinator takes the lock before it writes anything ------------------------------------------

describe('the coordinator is the sole writer from the first write', () => {
  const withExtra = JSON.stringify({
    version: 1,
    repos: [
      ...JSON.parse(REPOS_JSON).repos,
      { slug: 'extra', absolutePath: '/tmp/ducky-extra', defaultBranch: 'main', github: { owner: 'zed', repo: 'extra' },
        allowWorktree: true, allowBootstrap: false, bootstrapAllowedEntries: ['.git'], enabled: true },
    ],
  });

  const shared = () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    return createStore(db);
  };
  const mirrors = (store: ReturnType<typeof shared>) => ({
    repos: store.db.prepare('SELECT slug FROM repos ORDER BY slug').all(),
    selected: store.db.prepare('SELECT repo_key FROM github_feed_repos ORDER BY repo_key').all(),
    placements: Number((store.db.prepare('SELECT COUNT(*) n FROM repo_placements').get() as { n: number }).n),
  });

  it('refuses a second app BEFORE it mirrors configuration or reconciles the feed selection', () => {
    const store = shared();
    const first = makeHarness({ store, holdRuntimeLock: true, env: { DUCKY_GITHUB_FEED_ENABLED: 'true' } });
    const before = mirrors(store);
    expect(before.repos.length).toBeGreaterThan(0);

    expect(() =>
      makeHarness({
        store, holdRuntimeLock: true, allowlistJson: withExtra,
        env: { DUCKY_GITHUB_FEED_ENABLED: 'true', DUCKY_GITHUB_FEED_REPOS: 'zed/extra' },
      }),
    ).toThrow(/live coordinator is already writing/);

    // The refused app left no trace: no new repository, no new selection, no placement.
    expect(mirrors(store)).toEqual(before);
    expect(before.repos).not.toContainEqual({ slug: 'extra' });
    // The first is still the writer.
    expect(first.app.runtimeLock!.held()).toBe(true);
  });

  it('lets a new coordinator start once the first has released, and writes then', () => {
    const store = shared();
    const first = makeHarness({ store, holdRuntimeLock: true });
    first.app.runtimeLock!.release();
    const second = makeHarness({ store, holdRuntimeLock: true, allowlistJson: withExtra });
    expect(second.app.runtimeLock!.held()).toBe(true);
    expect(mirrors(store).repos).toContainEqual({ slug: 'extra' });
  });

  it('refuses to start while an import holds the database', () => {
    const store = shared();
    const imp = takeLock(store);
    expect(() => makeHarness({ store, holdRuntimeLock: true })).toThrow(/live importer is already writing/);
    imp.release();
    expect(() => makeHarness({ store, holdRuntimeLock: true })).not.toThrow();
  });

  it('does not take the lock unless asked, so a modelled restart still works', () => {
    const store = shared();
    makeHarness({ store });
    expect(() => makeHarness({ store })).not.toThrow();
  });

  it('releases the lock and closes the database on close, and cleans up a refused start on a file database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ducky-app-'));
    dirs.push(dir);
    const dbFile = path.join(dir, 'app.db');
    const env = {
      NODE_ENV: 'test', DUCKY_PROFILE: 'development', OWNER_DISCORD_USER_ID: OWNER,
      CHAT_WHITELIST_USER_IDS: '100000000000000002', DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
      DUCKY_DB_PATH: dbFile, DUCKY_REPOS_FILE: 'unused', DUCKY_OWNER_TIMEZONE: MANILA,
    } as NodeJS.ProcessEnv;
    const overrides = {
      allowlistJson: REPOS_JSON, transport: new MockDiscordTransport(), conversation: new MockConversationProvider(),
      github: new MockGitHubReader(), credentials: new MemoryCredentialStore(JSON.stringify({ version: 1, executors: [] })), holdRuntimeLock: true,
    };
    const first = createApp(env, overrides);
    // A second process opening the same FILE database is refused, and its own handle is closed.
    expect(() => createApp(env, overrides)).toThrow(/live coordinator is already writing/);
    // The first still holds, and a clean close frees the row for the next.
    expect(first.runtimeLock!.held()).toBe(true);
    first.close();
    const probe = openDatabase({ location: dbFile });
    expect((probe.prepare('SELECT COUNT(*) n FROM runtime_lock').get() as { n: number }).n).toBe(0);
    probe.close();
    const third = createApp(env, overrides);
    expect(third.runtimeLock!.held()).toBe(true);
    third.close();
  });
});

// ---- the heartbeat has its own bounded period ------------------------------------------------------------

describe('the lock heartbeat', () => {
  const store = () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    return createStore(db);
  };

  it('beats on a fixed short period that fits many times inside the stale window', () => {
    expect(RUNTIME_LOCK_HEARTBEAT_MS * 3).toBeLessThanOrEqual(RUNTIME_LOCK_STALE_MS);
    const s = store();
    const handle = takeCoordinatorLock(s.db);
    const periods: number[] = [];
    let tick: (() => void) | undefined;
    startLockHeartbeat(handle, () => undefined, {
      set: (fn, ms) => { periods.push(ms); tick = fn; return 1; },
      clear: () => undefined,
    });
    // Whatever DUCKY_RECONCILE_INTERVAL_MS is, the beat period is its own constant.
    expect(periods).toEqual([RUNTIME_LOCK_HEARTBEAT_MS]);
    const before = s.db.prepare('SELECT heartbeat_at h FROM runtime_lock').get() as { h: string };
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    tick!();
    vi.useRealTimers();
    const after = s.db.prepare('SELECT heartbeat_at h FROM runtime_lock').get() as { h: string };
    expect(after.h >= before.h).toBe(true);
  });

  it('reports a lost lock exactly once, stops its timer and stops beating', () => {
    const s = store();
    const handle = takeCoordinatorLock(s.db);
    let tick: (() => void) | undefined;
    let cleared = 0;
    let lost = 0;
    startLockHeartbeat(handle, () => { lost += 1; }, {
      set: (fn) => { tick = fn; return 1; },
      clear: () => { cleared += 1; },
    });
    // Someone else takes the lock after this holder went quiet.
    s.db.prepare(`UPDATE runtime_lock SET host = 'elsewhere', heartbeat_at = '2000-01-01T00:00:00.000Z'`).run();
    expect(acquireRuntimeLock(s.db, 'importer', { host: 'h2', pid: 9 }).ok).toBe(true);
    tick!();
    tick!();
    expect(lost).toBe(1);
    expect(cleared).toBe(1);
  });

  it('the stop function stops it', () => {
    const s = store();
    const handle = takeCoordinatorLock(s.db);
    let cleared = 0;
    let tick: (() => void) | undefined;
    const stop = startLockHeartbeat(handle, () => undefined, { set: (fn) => { tick = fn; return 1; }, clear: () => { cleared += 1; } });
    stop();
    expect(cleared).toBe(1);
    tick!();
    expect(handle.held()).toBe(true);
  });
});

// ---- the importer pins its source ------------------------------------------------------------------------

describe('the importer pins to the source it has already seen', () => {
  const boot = () => {
    const clock = new TestClock('2026-10-13T00:00:00.000Z', MANILA);
    const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA } });
    const svc = (over = {}) => new AssistantImportService({ store: h.store, env: importEnv(over), nowMs: () => clock.nowMs() });
    return { h, svc };
  };
  const apply = (h: Harness, svc: AssistantImportService, doc: unknown) => {
    const lock = takeLock(h.store);
    try {
      return svc.run(doc, { apply: true, lock });
    } finally {
      lock.release();
    }
  };
  const total = (h: Harness): number =>
    ['tasks', 'reminders', 'captures', 'schedule_rules', 'assistant_watch_targets'].reduce(
      (n, t) => n + Number((h.store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n), 0,
    );

  it('refuses a mistyped namespace instead of importing everything a second time', () => {
    const { h, svc } = boot();
    expect(apply(h, svc(), importDoc()).ok).toBe(true);
    const before = total(h);
    for (const typo of ['fixtur', 'fixture2', 'other']) {
      const doc = importDoc();
      doc['namespace'] = typo;
      const out = apply(h, svc(), doc);
      expect(out.ok, typo).toBe(false);
      expect(out.issues).toContainEqual({ category: 'document', rule: 'namespace_mismatch', count: 1 });
    }
    expect(total(h)).toBe(before);
    // Nothing duplicated: one live identity per source record.
    expect(h.store.assistantImport.namespaces()).toEqual(['fixture']);
  });

  it('accepts any namespace on the very first import, and then only that one', () => {
    const { h, svc } = boot();
    const first = importDoc();
    first['namespace'] = 'first-source';
    expect(apply(h, svc(), first).ok).toBe(true);
    expect(apply(h, svc(), importDoc()).issues.map((i) => i.rule)).toContain('namespace_mismatch');
  });

  it('does not let an empty ledger make a typo harmless either way', () => {
    const { h, svc } = boot();
    expect(svc().run(importDoc(), { apply: false }).ok).toBe(true);
    expect(h.store.assistantImport.namespaces()).toEqual([]);
  });
});

describe('private imported sections never ride a channel configuration', () => {
  const rules = (delivery: 'dm' | 'channel' | 'both', over: Record<string, unknown> = {}) => {
    const clock = new TestClock('2026-10-13T00:00:00.000Z', MANILA);
    const h = makeHarness({ clock });
    const svc = new AssistantImportService({
      store: h.store, nowMs: () => clock.nowMs(),
      env: importEnv({ briefing: { ...importEnv().briefing, delivery } }),
    });
    const doc = importDoc();
    Object.assign(doc['preferences'], over);
    const lock = takeLock(h.store);
    try {
      return svc.run(doc, { apply: false, lock }).issues.map((i) => `${i.category}:${i.rule}`);
    } finally {
      lock.release();
    }
  };

  it('refuses the capture inbox or the repository digest when briefings go to a channel', () => {
    expect(rules('dm')).toEqual([]);
    expect(rules('channel')).toContain('preferences:private_sections_need_dm_delivery');
    expect(rules('both')).toContain('preferences:private_sections_need_dm_delivery');
  });

  it('is fine to go to a channel when neither private section is wanted', () => {
    const none = { includeGithub: false, includeCaptures: false };
    expect(rules('channel', none)).not.toContain('preferences:private_sections_need_dm_delivery');
    expect(rules('both', none)).not.toContain('preferences:private_sections_need_dm_delivery');
  });
});

describe('a pending reminder is not imported for a task the owner has moved on from', () => {
  it('suppresses a new pending reminder for a task whose deadline the owner edited in Ducky', () => {
    const clock = new TestClock('2026-10-13T00:00:00.000Z', MANILA);
    const h = makeHarness({ clock });
    const svc = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() });
    const lock = takeLock(h.store);
    svc.run(importDoc(), { apply: true, lock });
    const open = h.store.assistantImport.identity('fixture', 'task', 't-open')!;
    const row = h.store.tasks.byId(OWNER, open.targetId!)!;
    h.app.tasks.setDeadline(h.owner, row.publicId, h.app.tasks.parseDeadline('2026-11-05 10:00'));
    const before = h.store.reminders.scheduledForTask(OWNER, row.id).map((r) => r.id).sort();

    const later = importDoc();
    later['reminders'].push({
      sourceId: 'r-new', taskSourceId: 't-open', kind: 'snooze', offsetMinutes: null,
      fireAt: '2026-10-21T00:00:00Z', state: 'pending', deliveredAt: null, createdAt: '2026-10-12T00:00:00Z',
    });
    const out = svc.run(later, { apply: true, lock });
    lock.release();
    expect(out.ok).toBe(true);
    expect(out.counts.reminders).toMatchObject({ created: 0, suppressed: 1 });
    expect(h.store.reminders.scheduledForTask(OWNER, row.id).map((r) => r.id).sort()).toEqual(before);
    expect(h.store.assistantImport.identity('fixture', 'reminder', 'r-new')).toMatchObject({ state: 'tombstone' });
  });
});

// ---- a damaged policy never starts reminding -----------------------------------------------------------------

describe('a corrupt reminder policy fails closed', () => {
  it('does not default-enable reminders on the next Edit', () => {
    const clock = new TestClock('2026-10-13T00:00:00.000Z', MANILA);
    const h = makeHarness({ clock });
    h.store.assistantImport.insertTask({
      id: 'p', publicId: 'tpxxxx', discordUserId: OWNER, title: 'Damaged', dueAt: '2026-10-20T10:00:00.000Z',
      dueAllDay: false, priority: 'normal', status: 'open', createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z', closedAt: null, reminderPolicy: { enabled: true, offsetsMinutes: [60] },
    });
    h.store.db.prepare(`UPDATE tasks SET reminder_policy = '{broken' WHERE id = 'p'`).run();
    const out = h.app.tasks.setDeadline(h.owner, 'tpxxxx', h.app.tasks.parseDeadline('2026-10-25 10:00'));
    expect(out.sync.scheduled).toBe(0);
    expect(h.store.reminders.scheduledForTask(OWNER, 'p')).toEqual([]);
    h.close();
  });
});

// ---- the forecast fetch is hardened ----------------------------------------------------------------------------

describe('the forecast request', () => {
  const place: WeatherPlace = { latitude: 14.6, longitude: 121, location: 'Somewhere', timeZone: MANILA };
  const good = { current: { temperature_2m: 30, weather_code: 1 }, daily: { weather_code: [1, 1], temperature_2m_max: [31, 31], temperature_2m_min: [25, 25], precipitation_probability_max: [10, 10] } };

  it('refuses redirects, so the coordinates cannot be sent to a host nobody named', async () => {
    let init: RequestInit | undefined;
    const w = new OpenMeteoWeather({ fetch: (async (_u: URL, i?: RequestInit) => { init = i; return new Response(JSON.stringify(good)); }) as unknown as typeof fetch });
    await w.forecast(place, 0);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
  });

  it('treats a redirect as a failure, not as something to follow', async () => {
    const w = new OpenMeteoWeather({ fetch: (async () => { throw new TypeError('redirect mode is set to error'); }) as unknown as typeof fetch });
    expect(await w.forecast(place, 0)).toBeNull();
  });

  const streamOf = (chunks: number, size: number, pulled: { n: number }): Response => {
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.n += 1;
        if (i >= chunks) return controller.close();
        i += 1;
        controller.enqueue(new Uint8Array(size).fill(65));
      },
    }));
  };

  it('stops reading a body the moment it passes the ceiling, whatever it claims about its length', async () => {
    const pulled = { n: 0 };
    const w = new OpenMeteoWeather({ fetch: (async () => streamOf(1000, 8 * 1024, pulled)) as unknown as typeof fetch });
    expect(await w.forecast(place, 0)).toBeNull();
    // 64 KiB is eight 8 KiB chunks; it must not have pulled anything like all 1000.
    expect(pulled.n).toBeLessThan(20);
  });

  it('refuses a declared oversize body without reading it at all', async () => {
    const pulled = { n: 0 };
    const w = new OpenMeteoWeather({
      fetch: (async () => {
        const r = streamOf(10, 1024, pulled);
        return new Response(r.body, { headers: { 'content-length': String(10 * 1024 * 1024) } });
      }) as unknown as typeof fetch,
    });
    expect(await w.forecast(place, 0)).toBeNull();
    expect(pulled.n).toBeLessThanOrEqual(1);
  });

  it('still reads a normal answer through the streaming path', async () => {
    const w = new OpenMeteoWeather({ fetch: (async () => new Response(JSON.stringify(good))) as unknown as typeof fetch });
    expect((await w.forecast(place, 0))?.label).toBe('Mostly clear');
  });
});

describe('the natural-language briefing carries the forecast too', () => {
  it('includes weather when the preference asks for it', async () => {
    const clock = new TestClock('2026-10-13T00:00:00.000Z', MANILA);
    const days: number[] = [];
    const h = makeHarness({
      clock,
      weather: { forecast: async (_p, day) => { days.push(day); return { location: 'Somewhere', label: 'Heavy rain', temperatureC: 29, highC: 31, lowC: 25, rainChance: 80 }; } },
      env: {
        DUCKY_IMPORTED_PREFERENCES: 'true', DUCKY_OWNER_TIMEZONE: MANILA,
        DUCKY_WEATHER_LATITUDE: '14.6', DUCKY_WEATHER_LONGITUDE: '121', DUCKY_WEATHER_LOCATION: 'Somewhere',
      },
    });
    h.store.ownerPreferences.insert({
      ownerId: OWNER, source: 'import', at: '2026-10-01T00:00:00.000Z',
      prefsJson: JSON.stringify({ ...importDoc()['preferences'], includeWeather: true, includeGithub: false, includeCaptures: false }),
    });
    const reply = await h.app.router.handle({ kind: 'message', userId: OWNER, text: 'brief me', threadKey: 'dm-1' });
    expect(JSON.stringify(reply)).toContain('Weather');
    expect(JSON.stringify(reply)).toContain('Heavy rain');
    expect(days).toEqual([0]);
    h.close();
  });

  it('still answers, without it, when no location is configured', async () => {
    const h = makeHarness({ clock: new TestClock('2026-10-13T00:00:00.000Z', MANILA), env: { DUCKY_OWNER_TIMEZONE: MANILA } });
    const reply = await h.app.router.handle({ kind: 'message', userId: OWNER, text: 'brief me', threadKey: 'dm-1' });
    expect(JSON.stringify(reply)).not.toContain('Weather');
    expect(reply).toBeDefined();
    h.close();
  });
});

// ---- late events at the cursor ---------------------------------------------------------------------------------

describe('an event that arrives late with the cursor’s own timestamp', () => {
  const NOW = '2026-10-13T00:00:00.000Z';
  const CURSOR = '2026-10-12T10:00:00.000Z';
  const boot = () => {
    const clock = new TestClock(NOW, 'UTC');
    const reader = new FakeWatchReader();
    reader.pageSize = 10;
    const h = makeHarness({ clock, assistantWatchReader: reader });
    h.store.assistantWatch.insertTarget({
      id: 't1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/widgets', display: 'acme/widgets',
      defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
    });
    return { h, clock, reader };
  };
  const commit = (sha: string, at: string) => ({ sha, committedAt: at, subject: `${sha} change` });
  const cp = (h: Harness) => h.store.assistantWatch.checkpoint('t1', 'commits')!;
  const shas = (h: Harness) => h.store.assistantWatch.eventsFor('t1').map((e) => e.identity).sort();
  const seed = (h: Harness, state: 'imported' | 'ready', boundaryKnown: boolean) => {
    h.store.assistantWatch.insertCheckpoint({ targetId: 't1', surface: 'commits', state, cursor: CURSOR, nextDueAt: NOW, updatedAt: NOW });
    if (boundaryKnown) h.store.db.prepare(`UPDATE assistant_watch_checkpoints SET boundary_known = 1`).run();
  };

  it('is announced once, and a known one at the same instant is not announced again', async () => {
    const { h, clock, reader } = boot();
    seed(h, 'ready', true);
    // 'a' was seen and recorded by an earlier Ducky pass; 'b' reached GitHub late with the same time.
    h.store.assistantWatch.insertImportedEvent({
      id: 'ea', targetId: 't1', kind: 'commit', identity: 'a', occurredAt: CURSOR, payloadJson: '{}',
      alertedAt: NOW, digestedAt: null, createdAt: NOW,
    });
    reader.commitsBy.set('acme/widgets', [commit('b', CURSOR), commit('a', CURSOR), commit('old', '2026-10-12T09:00:00Z')]);
    await h.app.assistantWatch.tick();
    expect(shas(h)).toEqual(['a', 'b']);
    expect(h.store.assistantWatch.undigested(OWNER, 10).map((e) => e.identity).sort()).toEqual(['a', 'b']);
    // And once more, nothing doubles.
    clock.advance(16 * 60_000);
    await h.app.assistantWatch.tick();
    expect(shas(h)).toEqual(['a', 'b']);
    h.close();
  });

  it('does NOT reproduce history while the boundary is unknown (a source cursor)', async () => {
    const { h, reader } = boot();
    seed(h, 'imported', false);
    // The source announced 'a' long ago and has since pruned that record: its identity is not here.
    reader.commitsBy.set('acme/widgets', [commit('a', CURSOR), commit('old', '2026-10-12T09:00:00Z')]);
    await h.app.assistantWatch.tick();
    expect(shas(h)).toEqual([]);
    expect(cp(h)).toMatchObject({ state: 'ready', boundaryKnown: false });
    // Still strict on the next pass: the same boundary item is still not news.
    h.close();
  });

  it('does NOT reproduce history after a baseline either', async () => {
    const { h, clock, reader } = boot();
    h.store.assistantWatch.insertCheckpoint({ targetId: 't1', surface: 'commits', state: 'unbaselined', cursor: null, nextDueAt: NOW, updatedAt: NOW });
    reader.commitsBy.set('acme/widgets', [commit('newest', CURSOR), commit('older', '2026-10-12T09:00:00Z')]);
    await h.app.assistantWatch.tick();
    expect(cp(h)).toMatchObject({ state: 'ready', cursor: CURSOR, boundaryKnown: false });
    clock.advance(16 * 60_000);
    await h.app.assistantWatch.tick();
    expect(shas(h)).toEqual([]);
    h.close();
  });

  it('becomes inclusive only after a pass has actually processed the newest item', async () => {
    const { h, clock, reader } = boot();
    seed(h, 'imported', false);
    reader.commitsBy.set('acme/widgets', [commit('n1', '2026-10-12T12:00:00Z'), commit('old', '2026-10-12T09:00:00Z')]);
    await h.app.assistantWatch.tick();
    expect(shas(h)).toEqual(['n1']);
    expect(cp(h)).toMatchObject({ cursor: '2026-10-12T12:00:00.000Z', boundaryKnown: true });
    // Now a late commit with the new cursor's own timestamp is reconciled by identity.
    reader.commitsBy.set('acme/widgets', [commit('late', '2026-10-12T12:00:00Z'), commit('n1', '2026-10-12T12:00:00Z'), commit('old', '2026-10-12T09:00:00Z')]);
    clock.advance(16 * 60_000);
    await h.app.assistantWatch.tick();
    expect(shas(h)).toEqual(['late', 'n1']);
    h.close();
  });
});
