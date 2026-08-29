import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DeterministicScheduleExtractor } from '../src/schedule/extraction.deterministic.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/schedule/schedule.fixtures/binary-extraction.json',
);

/**
 * The capability claim, and the thing that keeps it honest.
 *
 * "No decoder is installed" was documented prose for several milestones and
 * nothing re-checked it. `pnpm probe:extraction` now records what is actually
 * on this host, and this asserts the one property that must hold whatever it
 * found: **a decoder appearing on the host does not open the path.**
 */
describe('binary schedule extraction', () => {
  it('is refused by the shipped extractor regardless of what is installed', () => {
    // Two independent switches, and this is the one that is in the code:
    // the provider itself reports it cannot read bytes. A `pdftotext` on PATH
    // does not change this line.
    expect(new DeterministicScheduleExtractor().supportsBinary).toBe(false);
  });

  it.runIf(existsSync(FIXTURE))('records presence and versions, and nothing else', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      deterministicTextExtractionAvailable: boolean;
      candidates: { bin: string; present: boolean; version: string | null; kind: string }[];
    };
    expect(f.candidates.length).toBeGreaterThan(0);
    for (const c of f.candidates) {
      // Absent means absent: no version string invented for something that is
      // not there.
      if (!c.present) expect(c.version).toBeNull();
    }
    // The recording holds no path from this host.
    const raw = readFileSync(FIXTURE, 'utf8');
    expect(raw).not.toMatch(/\/home\/|\/Users\//);
  });

  it.runIf(existsSync(FIXTURE))('keeps OCR separate from deterministic extraction', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      candidates: { bin: string; kind: string }[];
    };
    // The distinction is the whole argument: `pdftotext` reads a text layer
    // that is already there, OCR returns a guess about pixels. A fixture that
    // lumped them together would let "we have tesseract" read as "we can
    // extract schedules".
    const kinds = new Set(f.candidates.map((c) => c.kind));
    expect(kinds.has('deterministic')).toBe(true);
    expect(kinds.has('ocr')).toBe(true);
    expect(f.candidates.find((c) => c.bin === 'tesseract')?.kind).toBe('ocr');
    expect(f.candidates.find((c) => c.bin === 'pdftotext')?.kind).toBe('deterministic');
  });
});
