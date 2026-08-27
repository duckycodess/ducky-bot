import { ScheduleDraftSchema, SCHEDULE_MAX_ENTRIES, type ScheduleDraft, type ScheduleEntry } from '@ducky/contracts';
import type { ScheduleExtractionProvider, ScheduleSource } from './extraction.port.js';

const HEADER_ALIASES: Record<string, keyof ScheduleEntry> = {
  title: 'title', name: 'title', event: 'title', subject: 'title',
  start: 'startsAt', starts: 'startsAt', startsat: 'startsAt', start_time: 'startsAt',
  starttime: 'startsAt', when: 'startsAt', date: 'startsAt',
  end: 'endsAt', ends: 'endsAt', endsat: 'endsAt', end_time: 'endsAt', endtime: 'endsAt',
  location: 'location', place: 'location', room: 'location', where: 'location',
  notes: 'notes', note: 'notes', description: 'notes', details: 'notes',
};

const normalizeHeader = (h: string): keyof ScheduleEntry | undefined =>
  HEADER_ALIASES[h.trim().toLowerCase().replace(/[\s-]+/g, '_')] ??
  HEADER_ALIASES[h.trim().toLowerCase().replace(/[\s_-]+/g, '')];

/** `2026-09-01 09:00` / `2026-09-01T09:00` / `2026-09-01` */
const DATETIME =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2})(?::\d{2})?)?$/;

const isDateish = (s: string): boolean => DATETIME.test(s.trim());

const blank = (): ScheduleEntry => ({
  title: '', startsAt: '', endsAt: null, location: null, notes: null,
});

/** Minimal RFC4180-ish splitter: handles quoted fields containing commas. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(lines: string[]): ScheduleDraft | undefined {
  const header = splitCsvLine(lines[0]!).map(normalizeHeader);
  if (!header.includes('title') || !header.includes('startsAt')) return undefined;

  const entries: ScheduleEntry[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line);
    const e = blank();
    header.forEach((key, i) => {
      if (!key) return;
      const v = (cells[i] ?? '').trim();
      if (v === '') return;
      if (key === 'title' || key === 'startsAt') e[key] = v;
      else e[key] = v;
    });
    if (e.title && e.startsAt) entries.push(e);
    if (entries.length >= SCHEDULE_MAX_ENTRIES) break;
  }
  return entries.length ? entries : undefined;
}

function parseDelimited(lines: string[]): ScheduleDraft | undefined {
  const entries: ScheduleEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split('|').map((p) => p.trim());
    if (parts.length >= 2 && isDateish(parts[0]!)) {
      const e = blank();
      e.startsAt = parts[0]!;
      e.title = parts[1]!;
      if (parts[2]) e.location = parts[2];
      if (parts[3]) e.notes = parts[3];
      if (e.title) entries.push(e);
    } else {
      // `2026-09-01 09:00 Standup @ Room 3`
      const m = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2})?)\s+(.+)$/.exec(line);
      if (!m) continue;
      const e = blank();
      e.startsAt = m[1]!.trim();
      const rest = m[2]!;
      const at = rest.split(' @ ');
      e.title = at[0]!.trim();
      if (at[1]) e.location = at.slice(1).join(' @ ').trim();
      if (e.title) entries.push(e);
    }
    if (entries.length >= SCHEDULE_MAX_ENTRIES) break;
  }
  return entries.length ? entries : undefined;
}

/**
 * Fully deterministic, text-only extraction. It never guesses: a line that does
 * not match a supported shape is skipped, and if nothing matches the result is
 * an empty draft, which the caller surfaces as "no entries found" rather than
 * a fabricated preview.
 */
export class DeterministicScheduleExtractor implements ScheduleExtractionProvider {
  readonly name = 'deterministic-text';
  readonly supportsBinary = false;

  async extract(source: ScheduleSource): Promise<ScheduleDraft> {
    const lines = source.text.split(/\r?\n/);
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    if (nonEmpty.length === 0) return [];

    const csv = nonEmpty[0]!.includes(',') ? parseCsv(nonEmpty) : undefined;
    const draft = csv ?? parseDelimited(nonEmpty) ?? [];
    return ScheduleDraftSchema.parse(draft);
  }
}
