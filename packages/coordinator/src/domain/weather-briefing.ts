import type { BriefingKind } from '@ducky/contracts';
import type { WeatherPlace, WeatherPort, WeatherReport } from '@ducky/adapters';

/**
 * The briefing's weather: one configured place, one port.
 *
 * The place comes from explicit configuration, never from stored data, and a
 * morning briefing asks about today while an evening one asks about tomorrow,
 * because the evening briefing exists to prepare for the next day. A failure of
 * any kind is `null`: a missing section, not a failed briefing.
 */
export class WeatherBriefing {
  constructor(
    private readonly port: WeatherPort,
    private readonly place: WeatherPlace,
  ) {}

  async forecastFor(kind: BriefingKind): Promise<WeatherReport | null> {
    try {
      return await this.port.forecast(this.place, kind === 'evening' ? 1 : 0);
    } catch {
      return null;
    }
  }
}
