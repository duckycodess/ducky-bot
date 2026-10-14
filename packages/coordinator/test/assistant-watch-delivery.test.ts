import { describe, expect, it } from 'vitest';
import {
  OpenMeteoWeather, describeWeatherCode, weatherAdvice, type WeatherPlace, type WeatherPort,
  type WeatherReport,
} from '@ducky/adapters';
import { WATCH_EVENT_KINDS, type ImportedPreferences, type WatchEventKind } from '@ducky/contracts';
import type { WatchEventWithTarget } from '@ducky/persistence';
import { IMPORT_COVERS_NATIVE, buildWatchDigest } from '../src/domain/assistant-watch.service.js';
import { briefingMessage } from '../src/discord/assistant-presenters.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { FeedReader, issue, pr, review, run, sentTo, commit } from './github-feed-helpers.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';

/** The digest, the briefing that carries it, the forecast, and overlap with the native feed. */
const MANILA = 'Asia/Manila';
const T0 = '2026-10-01T00:00:00.000Z';
/** Tuesday 2026-10-13 08:00 Manila. */
const MORNING = '2026-10-13T00:00:00.000Z';

const PREFS: ImportedPreferences = {
  timeZone: MANILA, morningEnabled: true, morningTime: '07:00', eveningEnabled: true,
  eveningTime: '21:00', weekendBriefings: true, lookaheadDays: 3, includeWeather: false,
  includeGithub: true, includeCaptures: false, includeMeal: false, assistantWording: false,
  defaultReminderOffsetsMinutes: [1440, 60],
};

const ev = (
  kind: WatchEventKind, n: number, over: Partial<WatchEventWithTarget> & { payload?: Record<string, unknown> } = {},
): WatchEventWithTarget => ({
  id: over.id ?? `e-${kind}-${n}`, targetId: 'w1', kind,
  surface: 'pulls', held: false, identity: `${n}:${kind}`, occurredAt: T0,
  payloadJson: JSON.stringify(over.payload ?? { number: n, title: `Title ${n}` }), origin: 'observed',
  alertedAt: null, alertAttempts: 0, alertAbandonedAt: null, digestedAt: null, createdAt: T0,
  display: over.display ?? 'acme/widgets', discordUserId: OWNER,
});

describe('the digest', () => {
  it('uses a bare repository name and fixed phrases around scrubbed titles', () => {
    const d = buildWatchDigest([
      ev('pr_opened', 12, { payload: { number: 12, title: 'Add a thing' } }),
      ev('issue_closed', 3),
      ev('commit', 1), ev('commit', 2),
    ]);
    expect(d.repos).toHaveLength(1);
    expect(d.repos[0]!.name).toBe('widgets');
    expect(d.repos[0]!.lines).toEqual(['2 new commits', 'PR #12 opened: Add a thing', 'Issue #3 closed: Title 3']);
    expect(JSON.stringify(d)).not.toContain('acme');
    expect(d.empty).toBe(false);
  });

  it('is empty, and says so, when nothing is unread', () => {
    expect(buildWatchDigest([])).toMatchObject({ empty: true, repos: [], eventIds: [] });
  });

  it('raises attention for failing CI and for requested changes', () => {
    const d = buildWatchDigest([
      ev('ci_failed', 1, { payload: { workflow: 'build' } }),
      ev('review_requested_changes', 9),
    ]);
    expect(d.attention).toContain('widgets has failing CI.');
    expect(d.attention).toContain('widgets: PR #9 has requested changes.');
  });

  it('does not call a recovered pipeline failing', () => {
    const d = buildWatchDigest([ev('ci_failed', 1, { payload: { workflow: 'b' } }), ev('ci_recovered', 2, { payload: { workflow: 'b' } })]);
    expect(d.attention).toEqual([]);
  });

  it('bounds lines per repository and repositories per digest, counts what it cut and still returns every id', () => {
    const many = Array.from({ length: 9 }, (_v, i) => ev('pr_opened', i + 1));
    const repos = Array.from({ length: 15 }, (_v, i) => ev('pr_opened', 100 + i, { display: `acme/r${String(i).padStart(2, '0')}` }));
    const d = buildWatchDigest([...many, ...repos]);
    expect(d.repos.length).toBe(12);
    expect(d.truncatedRepos).toBe(4);
    const widgets = d.repos.find((r) => r.name === 'widgets')!;
    expect(widgets.lines).toHaveLength(5); // four lines and "and N more"
    expect(widgets.lines.at(-1)).toBe('and 5 more');
    expect(d.eventIds).toHaveLength(24);
  });

  it('never prints a link or a mention that reached a title', () => {
    const d = buildWatchDigest([ev('pr_opened', 1, { payload: { number: 1, title: 'See https://x.test @bob a@b.co' } })]);
    expect(JSON.stringify(d)).not.toMatch(/https?:|@bob|a@b/);
  });

  it('knows every event kind it can be asked about, or deliberately ignores it', () => {
    // A kind added to the vocabulary without a phrase would silently vanish from
    // the digest; this pins the ones that are intentionally absent.
    const silent = WATCH_EVENT_KINDS.filter(
      (k) => buildWatchDigest([ev(k, 1, { payload: { number: 1, title: 't', workflow: 'w', tag: 'v1', branch: 'b' } })]).empty,
    );
    expect(silent).toEqual(['review_pending']);
  });
});

describe('a briefing carries the digest, and settles it only once sent', () => {
  const boot = (env: Record<string, string> = {}, clockIso = MORNING) => {
    const clock = new TestClock(clockIso, MANILA);
    const h = makeHarness({
      clock,
      env: {
        DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true', DUCKY_OWNER_TIMEZONE: MANILA, ...env,
      },
    });
    h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify(PREFS), source: 'import', at: T0 });
    h.store.assistantWatch.insertTarget({
      id: 'w1', publicId: 'wabcde', discordUserId: OWNER, repoKey: 'acme/widgets', display: 'acme/widgets',
      defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
    });
    const add = (id: string, kind: WatchEventKind, identity: string, digested: string | null = null) =>
      h.store.assistantWatch.insertImportedEvent({
        id, targetId: 'w1', kind, identity, occurredAt: T0, payloadJson: JSON.stringify({ number: 5, title: 'Add a thing' }),
        alertedAt: null, digestedAt: digested, createdAt: T0,
      });
    return { h, clock, add };
  };

  it('puts unread events in the briefing and not events already digested', () => {
    const { h, add } = boot();
    add('a', 'pr_opened', '5:opened');
    add('b', 'issue_opened', '6:issue_opened:x', T0);
    const b = h.app.briefing.build(h.owner, 'morning');
    expect(b.github!.repos[0]!.lines).toEqual(['PR #5 opened: Add a thing']);
    expect(JSON.stringify(briefingMessage(b))).toContain('GitHub');
    h.close();
  });

  it('is absent unless the preference includes GitHub', () => {
    const { h, add } = boot();
    h.store.db.prepare('DELETE FROM owner_preferences').run();
    h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify({ ...PREFS, includeGithub: false }), source: 'import', at: T0 });
    add('a', 'pr_opened', '5:opened');
    expect(h.app.briefing.build(h.owner, 'morning').github).toBeUndefined();
    h.close();
  });

  it('does NOT settle events when the briefing is only pulled', async () => {
    const { h, add } = boot();
    add('a', 'pr_opened', '5:opened');
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({ kind: 'command', name: 'briefing', userId: OWNER, options: { when: 'morning' } });
    expect(JSON.stringify(reply)).toContain('PR #5 opened');
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.close();
  });

  it('settles them only after the pushed briefing was sent', async () => {
    const { h, add } = boot();
    add('a', 'pr_opened', '5:opened');
    const out = await h.app.briefingNotifier.tick();
    expect(out.delivered).toBe(1);
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toEqual([]);
    // And never shown twice.
    expect(JSON.stringify(h.transport.sent)).toContain('PR #5 opened');
    h.close();
  });

  it('leaves them unread when the send fails, so a retry can still say them', async () => {
    const { h, add } = boot();
    add('a', 'pr_opened', '5:opened');
    h.transport.failSends = true;
    expect((await h.app.briefingNotifier.tick()).failed).toBe(1);
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.transport.failSends = false;
    await h.app.briefingNotifier.tick();
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toEqual([]);
    h.close();
  });

  it('puts the digest in the DM copy only, and settles it when the DM copy is sent', async () => {
    const { h, add } = boot({ DUCKY_BRIEFING_DELIVERY: 'both', DUCKY_DEV_BRIEFING_CHANNEL_ID: '900000000000000031' });
    add('a', 'pr_opened', '5:opened');
    const out = await h.app.briefingNotifier.tick();
    expect(out.delivered).toBe(2);
    const dm = h.transport.sent.find((s) => s.target.kind === 'user')!;
    const channel = h.transport.sent.find((s) => s.target.kind === 'channel')!;
    expect(JSON.stringify(dm.message)).toContain('PR #5 opened');
    // The channel's readers are not something Ducky can check: the owner's private
    // imported data never goes there.
    expect(JSON.stringify(channel.message)).not.toContain('PR #5 opened');
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toEqual([]);
    h.close();
  });

  it('never sends the digest or the capture inbox to a channel-only briefing, and does not settle', async () => {
    const { h, add } = boot({ DUCKY_BRIEFING_DELIVERY: 'channel', DUCKY_DEV_BRIEFING_CHANNEL_ID: '900000000000000031' });
    h.store.db.prepare('DELETE FROM owner_preferences').run();
    h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify({ ...PREFS, includeCaptures: true }), source: 'import', at: T0 });
    h.store.assistantImport.insertCapture({ id: 'c1', discordUserId: OWNER, content: 'PRIVATE-CAPTURE-TEXT', status: 'open', createdAt: T0, updatedAt: T0 });
    add('a', 'pr_opened', '5:opened');
    expect((await h.app.briefingNotifier.tick()).delivered).toBe(1);
    const body = JSON.stringify(h.transport.sent[0]!.message);
    expect(body).not.toContain('PR #5 opened');
    expect(body).not.toContain('PRIVATE-CAPTURE-TEXT');
    expect(body).not.toContain('Quick-capture');
    // Nothing carried the digest, so nothing is settled.
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.close();
  });

  it('keeps the owner’s own ephemeral reply complete', async () => {
    const { h, add } = boot({ DUCKY_BRIEFING_DELIVERY: 'channel', DUCKY_DEV_BRIEFING_CHANNEL_ID: '900000000000000031' });
    add('a', 'pr_opened', '5:opened');
    const b = await h.app.briefing.assemble(h.owner, 'morning');
    expect(b.github!.repos[0]!.lines).toEqual(['PR #5 opened: Add a thing']);
    h.close();
  });

  it('skips settling for a stale briefing that was never sent', async () => {
    // 22:30 Manila: the evening time (21:00) has been reached, so the source records the
    // 07:00 morning briefing skipped instead of sending it late. Only the morning slot is on.
    const { h, add } = boot({}, '2026-10-13T14:30:00.000Z');
    h.store.db.prepare('DELETE FROM owner_preferences').run();
    h.store.ownerPreferences.insert({
      ownerId: OWNER, prefsJson: JSON.stringify({ ...PREFS, eveningEnabled: false }), source: 'import', at: T0,
    });
    add('a', 'pr_opened', '5:opened');
    const out = await h.app.briefingNotifier.tick();
    expect(out.skippedStale).toBe(1);
    expect(out.delivered).toBe(0);
    // Nothing was sent, so nothing is settled.
    expect(h.store.assistantWatch.undigested(OWNER, 10)).toHaveLength(1);
    h.close();
  });
});

describe('the forecast', () => {
  const place: WeatherPlace = { latitude: 14.676, longitude: 121.0437, location: 'Somewhere', timeZone: MANILA };
  const payload = {
    current: { temperature_2m: 31.2, weather_code: 2 },
    daily: {
      weather_code: [3, 65], temperature_2m_max: [33.4, 29.9], temperature_2m_min: [25.1, 24],
      precipitation_probability_max: [20, 80],
    },
  };
  const respond = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);

  it('asks one fixed HTTPS host for numbers only, never for owner text', async () => {
    const seen: URL[] = [];
    const w = new OpenMeteoWeather({ fetch: (async (u: URL) => { seen.push(u); return respond(payload); }) as unknown as typeof fetch });
    await w.forecast(place, 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.origin).toBe('https://api.open-meteo.com');
    expect(seen[0]!.searchParams.get('latitude')).toBe('14.6760');
    expect(seen[0]!.searchParams.get('forecast_days')).toBe('2');
    expect(seen[0]!.toString()).not.toContain('Somewhere');
  });

  it('reads today with a current temperature and tomorrow from the daily forecast alone', async () => {
    const w = new OpenMeteoWeather({ fetch: (async () => respond(payload)) as unknown as typeof fetch });
    expect(await w.forecast(place, 0)).toEqual({
      location: 'Somewhere', label: 'Partly cloudy', temperatureC: 31.2, highC: 33.4, lowC: 25.1, rainChance: 20,
    });
    expect(await w.forecast(place, 1)).toEqual({
      location: 'Somewhere', label: 'Heavy rain', temperatureC: null, highC: 29.9, lowC: 24, rainChance: 80,
    });
  });

  it('caches for thirty minutes and then asks again', async () => {
    let now = 0;
    let calls = 0;
    const w = new OpenMeteoWeather({ nowMs: () => now, fetch: (async () => { calls += 1; return respond(payload); }) as unknown as typeof fetch });
    await w.forecast(place, 0);
    now += 29 * 60_000;
    await w.forecast(place, 1);
    expect(calls).toBe(1);
    now += 2 * 60_000;
    await w.forecast(place, 0);
    expect(calls).toBe(2);
  });

  it('resolves to null on every kind of failure instead of throwing', async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => respond('nope', { status: 500 }),
      async () => respond('not json'),
      async () => respond({ daily: {} }),
      async () => respond('x'.repeat(70 * 1024)),
      async () => { throw new Error('offline'); },
    ];
    for (const c of cases) {
      const w = new OpenMeteoWeather({ fetch: c as unknown as typeof fetch });
      expect(await w.forecast(place, 0)).toBeNull();
    }
  });

  it('describes codes in plain words and gives fixed advice', () => {
    expect([0, 2, 45, 63, 65, 71, 95, 99, 123, null].map(describeWeatherCode)).toEqual([
      'Clear', 'Partly cloudy', 'Foggy', 'Rain', 'Heavy rain', 'Snow', 'Thunderstorm',
      'Thunderstorm with hail', 'Unsettled', 'Unknown',
    ]);
    const base: WeatherReport = { location: 'x', label: 'x', temperatureC: null, highC: null, lowC: null, rainChance: null };
    expect(weatherAdvice({ ...base, rainChance: 60 })).toBe('Bring an umbrella.');
    expect(weatherAdvice({ ...base, rainChance: 59, highC: 34 })).toBe('Hot day. Carry water.');
    expect(weatherAdvice({ ...base, rainChance: 59, highC: 33 })).toBeUndefined();
  });

  describe('in a briefing', () => {
    class Port implements WeatherPort {
      days: number[] = [];
      fail = false;
      async forecast(_p: WeatherPlace, day: 0 | 1): Promise<WeatherReport | null> {
        this.days.push(day);
        if (this.fail) return null;
        return { location: 'Somewhere', label: day === 0 ? 'Clear' : 'Rain', temperatureC: 30, highC: 34, lowC: 25, rainChance: 70 };
      }
    }
    const boot = (prefs: Partial<ImportedPreferences>, env: Record<string, string> = {}, port = new Port()) => {
      const clock = new TestClock(MORNING, MANILA);
      const h = makeHarness({
        clock, weather: port,
        env: {
          DUCKY_IMPORTED_PREFERENCES: 'true', DUCKY_OWNER_TIMEZONE: MANILA,
          DUCKY_WEATHER_LATITUDE: '14.6', DUCKY_WEATHER_LONGITUDE: '121.0', DUCKY_WEATHER_LOCATION: 'Somewhere', ...env,
        },
      });
      h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify({ ...PREFS, includeWeather: true, ...prefs }), source: 'import', at: T0 });
      return { h, port };
    };

    it('shows today in the morning and tomorrow in the evening, with fixed advice', async () => {
      const { h, port } = boot({});
      const morning = await h.app.briefing.assemble(h.owner, 'morning');
      expect(morning.weather!.label).toBe('Clear');
      const text = JSON.stringify(briefingMessage(morning));
      expect(text).toContain('Weather');
      expect(text).toContain('Bring an umbrella.');
      const evening = await h.app.briefing.assemble(h.owner, 'evening');
      expect(evening.weather!.label).toBe('Rain');
      expect(JSON.stringify(briefingMessage(evening))).toContain("Tomorrow's weather");
      expect(port.days).toEqual([0, 1]);
      h.close();
    });

    it('is a missing section, not a failed briefing, when the forecast fails', async () => {
      const port = new Port();
      port.fail = true;
      const { h } = boot({}, {}, port);
      const b = await h.app.briefing.assemble(h.owner, 'morning');
      expect(b.weather).toBeUndefined();
      expect(JSON.stringify(briefingMessage(b))).not.toContain('Weather');
      h.close();
    });

    it('is never asked for when the preference excludes it or no location is configured', async () => {
      const off = boot({ includeWeather: false });
      await off.h.app.briefing.assemble(off.h.owner, 'morning');
      expect(off.port.days).toEqual([]);
      off.h.close();
      const unplaced = boot({}, { DUCKY_WEATHER_LATITUDE: '', DUCKY_WEATHER_LONGITUDE: '', DUCKY_WEATHER_LOCATION: '' });
      await unplaced.h.app.briefing.assemble(unplaced.h.owner, 'morning');
      expect(unplaced.port.days).toEqual([]);
      unplaced.h.close();
    });

    it('refuses a location that is only partly configured, at startup', () => {
      expect(() => makeHarness({ env: { DUCKY_WEATHER_LATITUDE: '14.6' } })).toThrow(/set all three or none/);
    });
  });
});

describe('overlap with the native feed', () => {
  const DEMO = 'acme/demo';
  const CHANNEL = '900000000000000021';

  const boot = () => {
    const clock = new TestClock('2026-10-01T00:00:00.000Z', 'UTC');
    const reader = new FeedReader();
    reader.setView(DEMO);
    const h = makeHarness({
      clock, github: reader, assistantWatchReader: new FakeWatchReader(),
      env: { DUCKY_GITHUB_FEED_ENABLED: 'true', DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL },
    });
    const tick = async (min = 16) => {
      clock.advance(min * 60_000);
      return h.app.githubFeed.tick();
    };
    return { h, reader, tick };
  };
  const observeDemo = (h: Harness, states: Partial<Record<'pulls' | 'issues' | 'runs', 'ready' | 'unbaselined' | 'blocked'>>) => {
    h.store.assistantWatch.insertTarget({
      id: 'w1', publicId: 'wabcde', discordUserId: OWNER, repoKey: DEMO, display: DEMO, defaultBranch: 'main',
      state: 'active', lastObservedAt: null, createdAt: T0, cancelledAt: null,
    });
    for (const [surface, st] of Object.entries(states) as ['pulls' | 'issues' | 'runs', string][]) {
      h.store.assistantWatch.insertCheckpoint({
        targetId: 'w1', surface, state: st === 'unbaselined' ? 'unbaselined' : 'ready',
        cursor: st === 'unbaselined' ? null : T0, nextDueAt: '2099-01-01T00:00:00.000Z', updatedAt: T0,
      });
      if (st === 'blocked') h.store.assistantWatch.block('w1', surface, 'unobservable', T0);
    }
  };
  const baseline = async (reader: FeedReader, tick: () => Promise<unknown>) => {
    reader.prs.set(DEMO, [pr(1)]);
    reader.issues.set(DEMO, [issue(1)]);
    reader.runs.set(DEMO, [run(10, { conclusion: 'failure' })]);
    reader.commitList.set(DEMO, [commit(1, '2026-09-29T00:00:00Z')]);
    await tick();
  };
  const news = (reader: FeedReader) => {
    reader.prs.set(DEMO, [
      pr(3, { createdAt: '2026-10-01T00:10:00Z', title: 'Add the feed' }), pr(1),
      pr(2, { latestReviews: [review('R9', 'CHANGES_REQUESTED', '2026-10-01T00:11:00Z', 'dave')] }),
    ]);
    reader.issues.set(DEMO, [issue(2, { createdAt: '2026-10-01T00:12:00Z' }), issue(1)]);
    reader.runs.set(DEMO, [run(11, { conclusion: 'failure', updatedAt: '2026-10-01T00:13:00Z' }), run(10, { conclusion: 'failure' })]);
  };

  it('retires the native card for an event an imported target observes, and sends the rest', async () => {
    const { h, reader, tick } = boot();
    await baseline(reader, () => tick(0));
    observeDemo(h, { pulls: 'ready', issues: 'unbaselined', runs: 'blocked' });
    news(reader);
    await tick();
    const texts = sentTo(h.transport.sent).map((s) => s.text).join('\n');
    // Pull requests are observed by the imported target: those two are retired.
    expect(texts).not.toContain('Pull request opened');
    expect(texts).not.toContain('Changes requested');
    // Issues are unbaselined and runs are blocked there: nothing observes them, so they go.
    expect(texts).toContain('Issue opened');
    expect(texts).toContain('Checks failed');
    const skipped = h.store.githubFeed.listEvents('skipped').map((e) => e.kind).sort();
    // Both new pull requests (3 and 2) and the review on 2 are observed by the import.
    expect(skipped).toEqual(['changes_requested', 'pr_opened', 'pr_opened']);
    h.close();
  });

  it('suppresses nothing when no imported target observes the repository, or it is cancelled', async () => {
    const { h, reader, tick } = boot();
    await baseline(reader, () => tick(0));
    observeDemo(h, { pulls: 'ready' });
    h.store.assistantWatch.cancel(OWNER, 'w1', T0);
    news(reader);
    await tick();
    expect(sentTo(h.transport.sent).map((s) => s.text).join('\n')).toContain('Pull request opened');
    h.close();
  });

  it('suppresses only kinds an imported surface sees in full', () => {
    expect(Object.keys(IMPORT_COVERS_NATIVE).sort()).toEqual(['changes_requested', 'issue_opened', 'pr_opened']);
    // A review request is a cross-repository search; a failing check on a pull
    // request head is invisible to the default-branch runs surface.
    expect(IMPORT_COVERS_NATIVE['review_requested']).toBeUndefined();
    expect(IMPORT_COVERS_NATIVE['check_failed']).toBeUndefined();
  });

  it('still delivers a failing check even when an imported runs surface is healthy', async () => {
    const { h, reader, tick } = boot();
    await baseline(reader, () => tick(0));
    observeDemo(h, { pulls: 'ready', issues: 'ready', runs: 'ready' });
    news(reader);
    await tick();
    const texts = sentTo(h.transport.sent).map((s) => s.text).join('\n');
    expect(texts).toContain('Checks failed');
    expect(h.store.githubFeed.listEvents('skipped').map((e) => e.kind)).not.toContain('check_failed');
    h.close();
  });

  it('stops suppressing while the imported surface is failing, so a failure never silences a card', async () => {
    const { h, reader, tick } = boot();
    await baseline(reader, () => tick(0));
    observeDemo(h, { pulls: 'ready' });
    h.store.db.prepare(`UPDATE assistant_watch_checkpoints SET failures = 2 WHERE surface = 'pulls'`).run();
    news(reader);
    await tick();
    expect(sentTo(h.transport.sent).map((s) => s.text).join('\n')).toContain('Pull request opened');
    h.close();
  });

  it('is scoped to the owner who has the target', () => {
    const { h } = boot();
    observeDemo(h, { pulls: 'ready' });
    expect(h.store.assistantWatch.observes(OWNER, DEMO, 'pulls')).toBe(true);
    expect(h.store.assistantWatch.observes('100000000000000099', DEMO, 'pulls')).toBe(false);
    h.close();
  });

  it('changes no authorization or job read: the native selection and allowlist are untouched', async () => {
    const { h, reader, tick } = boot();
    await baseline(reader, () => tick(0));
    const repos = h.store.db.prepare('SELECT COUNT(*) n FROM repos').get();
    const selected = h.store.githubFeed.listRepos('active').length;
    observeDemo(h, { pulls: 'ready', issues: 'ready', runs: 'ready' });
    news(reader);
    await tick();
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM repos').get()).toEqual(repos);
    expect(h.store.githubFeed.listRepos('active')).toHaveLength(selected);
    h.close();
  });
});
