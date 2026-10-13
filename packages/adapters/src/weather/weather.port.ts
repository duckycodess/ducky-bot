/**
 * A day's forecast for one configured place.
 *
 * The forecast is a FACT the briefing reports: nothing here is generated, and a
 * model is never asked to word or invent one. Any failure means "no forecast",
 * never a broken briefing.
 */
export interface WeatherReport {
  readonly location: string;
  /** A short phrase: "Clear", "Heavy rain". */
  readonly label: string;
  readonly temperatureC: number | null;
  readonly highC: number | null;
  readonly lowC: number | null;
  /** 0 to 100. */
  readonly rainChance: number | null;
}

export interface WeatherPlace {
  readonly latitude: number;
  readonly longitude: number;
  readonly location: string;
  /** The owner's IANA zone, so "today" and "tomorrow" mean the owner's days. */
  readonly timeZone: string;
}

export interface WeatherPort {
  /** `day` 0 is today and 1 is tomorrow. Resolves to null on ANY failure; it never throws. */
  forecast(place: WeatherPlace, day: 0 | 1): Promise<WeatherReport | null>;
}

/** The WMO weather interpretation codes, grouped into the phrases an owner wants. */
export function describeWeatherCode(code: number | null): string {
  if (code === null) return 'Unknown';
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Foggy';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code === 61 || code === 63 || code === 80 || code === 81) return 'Rain';
  if (code === 65 || code === 82) return 'Heavy rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return 'Unsettled';
}

/**
 * One practical note, or nothing. Deterministic: two fixed thresholds, so the
 * advice can be read back and checked, never composed.
 */
export function weatherAdvice(report: WeatherReport): string | undefined {
  if (report.rainChance !== null && report.rainChance >= 60) return 'Bring an umbrella.';
  if (report.highC !== null && report.highC >= 34) return 'Hot day. Carry water.';
  return undefined;
}
