import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_TEMP_PREFIX, sweepStaleTempDirs } from '../src/discord/attachments.js';

/**
 * The sweep removes leftovers a crashed run could not, and nothing else. A name
 * prefix alone is not ownership, so these pin what it will and will not touch.
 */
const old = (p: string): void => {
  const t = new Date(Date.now() - 7_200_000);
  utimesSync(p, t, t);
};

describe('stale temp sweep ownership', () => {
  const root = (): string => mkdtempSync(path.join(os.tmpdir(), 'ducky-sweep-root-'));

  it('removes a stale directory of its own prefix that this user owns', async () => {
    const dir = root();
    const mine = mkdtempSync(path.join(dir, CONVERSATION_TEMP_PREFIX));
    old(mine);
    expect(sweepStaleTempDirs(3_600_000, dir)).toEqual([mine]);
    await vi.waitFor(() => expect(existsSync(mine)).toBe(false), { timeout: 5_000 });
  });

  it('leaves a fresh directory alone', () => {
    const dir = root();
    const fresh = mkdtempSync(path.join(dir, CONVERSATION_TEMP_PREFIX));
    expect(sweepStaleTempDirs(3_600_000, dir)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('leaves names without a Ducky prefix alone, however old', () => {
    const dir = root();
    const other = path.join(dir, 'agent-flow-work');
    mkdirSync(other);
    old(other);
    expect(sweepStaleTempDirs(3_600_000, dir)).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });

  it('never follows or removes a symlink wearing the prefix, nor its target', () => {
    const dir = root();
    const target = path.join(dir, 'precious');
    mkdirSync(target);
    writeFileSync(path.join(target, 'keep.txt'), 'x');
    old(target);
    const link = path.join(dir, `${CONVERSATION_TEMP_PREFIX}link`);
    symlinkSync(target, link);

    expect(sweepStaleTempDirs(3_600_000, dir)).toEqual([]);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('leaves a plain file wearing the prefix alone', () => {
    const dir = root();
    const file = path.join(dir, `${CONVERSATION_TEMP_PREFIX}file`);
    writeFileSync(file, 'x');
    old(file);
    expect(sweepStaleTempDirs(3_600_000, dir)).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it('skips a directory owned by another account', () => {
    const dir = root();
    const theirs = mkdtempSync(path.join(dir, CONVERSATION_TEMP_PREFIX));
    old(theirs);
    const real = process.getuid!;
    // The owner check compares against the running uid, so presenting a
    // different uid is the same situation as another user's directory.
    process.getuid = () => real.call(process) + 1;
    try {
      expect(sweepStaleTempDirs(3_600_000, dir)).toEqual([]);
    } finally {
      process.getuid = real;
    }
    expect(existsSync(theirs)).toBe(true);
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(sweepStaleTempDirs(3_600_000, path.join(os.tmpdir(), 'ducky-absent-xyz'))).toEqual([]);
  });
});
