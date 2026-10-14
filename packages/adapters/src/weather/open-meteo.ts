import { describeWeatherCode, type WeatherPlace, type WeatherPort, type WeatherReport } from './weather.port.js';

/** The one host this adapter will ever contact. Not configurable, not derived from input. */
export const OPEN_METEO_ORIGIN = 'https://api.open-meteo.com';
const ENDPOINT = `${OPEN_METEO_ORIGIN}/v1/forecast`;
const TIMEOUT_MS = 10_000;
/** A forecast does not move fast enough to be worth fetching more often than this. */
const CACHE_TTL_MS = 30 * 60_000;
/** A forecast answer is a few hundred bytes; anything near this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export interface OpenMeteoOptions {
  /** Injected so a test never reaches a network. Production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly nowMs?: () => number;
}

const num = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
};
const at = (v: unknown, i: number): unknown => (Array.isArray(v) ? v[i] : undefined);

/**
 * A key-less forecast read over HTTPS to one fixed host.
 *
 * Bounded in every direction: a timeout, a body-size ceiling, a cache, a URL
 * built only from numbers and constants (no owner text is ever put in it), and
 * a result type that cannot carry an error message. Every failure resolves to
 * null so a missing forecast is a missing section, never a failed briefing.
 */
export class OpenMeteoWeather implements WeatherPort {
  private readonly doFetch: typeof fetch;
  private readonly nowMs: () => number;
  private cache: { at: number; key: string; payload: unknown } | null = null;

  constructor(opts: OpenMeteoOptions = {}) {
    this.doFetch = opts.fetch ?? fetch;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  async forecast(place: WeatherPlace, day: 0 | 1): Promise<WeatherReport | null> {
    try {
      const payload = await this.payload(place);
      return payload === null ? null : parse(payload, place.location, day);
    } catch {
      return null;
    }
  }

  private async payload(place: WeatherPlace): Promise<unknown> {
    const key = `${place.latitude.toFixed(4)},${place.longitude.toFixed(4)},${place.timeZone}`;
    if (this.cache && this.cache.key === key && this.nowMs() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.payload;
    }
    const url = new URL(ENDPOINT);
    url.searchParams.set('latitude', place.latitude.toFixed(4));
    url.searchParams.set('longitude', place.longitude.toFixed(4));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set(
      'daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    );
    url.searchParams.set('timezone', place.timeZone);
    // Two days: today for the morning briefing, tomorrow for the evening one.
    url.searchParams.set('forecast_days', '2');
    // A redirect would take the request, and the owner's coordinates in it, to a
    // host this adapter was never told about: it is an error, not something followed.
    const res = await this.doFetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) return this.cache?.key === key ? this.cache.payload : null;
    const body = await readCapped(res, MAX_BODY_BYTES);
    if (body === undefined) return null;
    const payload: unknown = JSON.parse(body);
    this.cache = { at: this.nowMs(), key, payload };
    return payload;
  }
}

/**
 * The body as text, or undefined once it has grown past the ceiling.
 *
 * It is counted AS IT STREAMS and the stream is cancelled the moment it passes
 * the limit, so a hostile or broken response cannot make this buffer more than
 * the ceiling before being refused, whatever it claims about its own length.
 */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!res.body) {
    const text = await res.text();
    return text.length > max ? undefined : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parse(payload: unknown, location: string, day: 0 | 1): WeatherReport | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { current?: Record<string, unknown>; daily?: Record<string, unknown> };
  // Only today has a current reading; tomorrow has the day's forecast alone.
  const current = day === 0 ? (p.current ?? {}) : {};
  const daily = p.daily ?? {};
  const code = num(current['weather_code']) ?? num(at(daily['weather_code'], day));
  const temperature = num(current['temperature_2m']);
  const high = num(at(daily['temperature_2m_max'], day));
  const low = num(at(daily['temperature_2m_min'], day));
  const rain = num(at(daily['precipitation_probability_max'], day));
  // A report with no number and no recognised code carries no information.
  if (code === null && temperature === null && high === null) return null;
  return {
    location,
    label: describeWeatherCode(code),
    temperatureC: temperature,
    highC: high,
    lowC: low,
    rainChance: rain === null ? null : Math.round(rain),
  };
}
