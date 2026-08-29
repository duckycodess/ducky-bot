import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GH_OPERATIONS } from '../src/github/gh-cli.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/github/github.fixtures',
);

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

/**
 * What `pnpm probe:gh-live` recorded against a real repository.
 *
 * `gh-fields.test.ts` asserts the argv table against the SELECTORS this `gh`
 * accepts, recorded locally with no network. This asserts the other half: that
 * a live response came back, that the production schema accepted it, and --
 * the part that needs guarding rather than merely stating -- that nothing in
 * the recording is repository content.
 */
describe('the recorded live GitHub surface', () => {
  const present = existsSync(path.join(FIXTURES, 'live-shape.json'));

  it.runIf(present)('records every surface the reader can reach', () => {
    const fixture = read('live-shape.json');
    const surfaces = fixture['surfaces'] as { surface: string }[];
    expect(new Set(surfaces.map((s) => s.surface))).toEqual(new Set(Object.keys(GH_OPERATIONS)));
  });

  it.runIf(present)('says which surfaces genuinely parsed and which never ran', () => {
    const surfaces = read('live-shape.json')['surfaces'] as {
      surface: string;
      parsed: boolean;
      unexercised?: string;
    }[];
    for (const s of surfaces) {
      // No third state: a surface either parsed a real response or says, in
      // words, why it could not be exercised. A silent skip would let an
      // unobserved surface read as an observed one.
      expect(s.parsed || typeof s.unexercised === 'string', s.surface).toBe(true);
    }
    // At least one surface must have really run, or the fixture is recording
    // nothing and the probe has stopped being evidence of anything.
    expect(surfaces.some((s) => s.parsed)).toBe(true);
  });

  it.runIf(present)('contains TYPES only -- never a value from the repository', () => {
    /**
     * The guard that matters. Every leaf of a recorded shape has to be one of
     * the type words the probe emits; anything else means a real string got
     * through, and a fixture holding somebody's branch name or PR title is
     * exactly what this recording was designed not to be.
     */
    const allowed = new Set([
      'string', 'number', 'boolean', 'null', 'undefined', 'object', 'empty',
    ]);
    const walk = (node: unknown, at: string): void => {
      if (typeof node === 'string') {
        // `length` is recorded as a stringified count, which is a fact about
        // the response and not content.
        if (/^\d+$/.test(node)) return;
        expect(allowed.has(node), `${at} = ${JSON.stringify(node)}`).toBe(true);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
      }
    };
    for (const s of read('live-shape.json')['surfaces'] as { surface: string; shape?: unknown }[]) {
      if (s.shape !== undefined) walk(s.shape, s.surface);
    }
  });

  it.runIf(existsSync(path.join(FIXTURES, 'live-watch.json')))(
    'records a live watch pass that deduplicated, and no real Discord message',
    () => {
      const w = read('live-watch.json');
      // The property a watch lives or dies by: observing an unchanged
      // repository a second time produces nothing to send.
      expect(w['deduplicated']).toBe(true);
      expect(w['snapshotStored']).toBe(true);
      expect(w['realDiscordMessagesSent']).toBe(0);
      const first = w['firstPass'] as { observed: number; failed: number };
      expect(first.observed).toBe(1);
      expect(first.failed).toBe(0);
    },
  );

  it.runIf(present)('holds nothing that looks like a credential or a path', () => {
    for (const name of ['live-shape.json', 'live-watch.json']) {
      const file = path.join(FIXTURES, name);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
      expect(raw).not.toMatch(/\/home\/|\/Users\//);
      expect(raw).not.toMatch(/https?:\/\//);
    }
  });
});
