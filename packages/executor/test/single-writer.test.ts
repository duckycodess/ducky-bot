import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireWriterLock } from '../src/single-writer.js';

let previous: string | undefined;

beforeEach(() => {
  previous = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = mkdtempSync(path.join(os.tmpdir(), 'ducky-state-'));
});

afterEach(() => {
  if (previous === undefined) delete process.env['XDG_STATE_HOME'];
  else process.env['XDG_STATE_HOME'] = previous;
});

describe('writer lock', () => {
  it('permits exactly one holder at a time', () => {
    const first = acquireWriterLock('demo');
    expect(() => acquireWriterLock('demo')).toThrow(/already holds/);
    first.release();
    expect(() => acquireWriterLock('demo').release()).not.toThrow();
  });

  it('does not block a different repository', () => {
    const a = acquireWriterLock('demo');
    const b = acquireWriterLock('other');
    a.release();
    b.release();
  });

  it('releases idempotently', () => {
    const lock = acquireWriterLock('demo');
    lock.release();
    lock.release();
    expect(() => acquireWriterLock('demo').release()).not.toThrow();
  });

  it('reclaims a stale lock left by a dead process', () => {
    const lock = acquireWriterLock('demo', () => Date.now() - 3_600_000);
    // stale by age: a new acquisition takes it over rather than deadlocking
    const next = acquireWriterLock('demo');
    next.release();
    lock.release();
  });
});
