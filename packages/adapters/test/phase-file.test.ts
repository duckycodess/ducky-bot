import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilePhaseReader, parsePhase, shouldReportPhase } from '../src/pi/phase-file.js';

/**
 * Pi's own phase report.
 *
 * Herdr can only say `idle | working | blocked | done | unknown`; it cannot say
 * whether a working agent is implementing, reviewing or verifying. That comes
 * from Pi, in a file, so this reader is the boundary where an untrusted word
 * becomes a typed phase -- and everything about it fails closed.
 */
const workspace = (contents?: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-phase-'));
  if (contents !== undefined) {
    mkdirSync(path.join(dir, '.ducky'), { recursive: true });
    writeFileSync(path.join(dir, '.ducky', 'phase'), contents);
  }
  return dir;
};

const reader = new FilePhaseReader();

describe('parsePhase', () => {
  it('accepts every real phase word', async () => {
    for (const w of ['preparing', 'planning', 'implementing', 'reviewing', 'fixing', 'verifying']) {
      expect(parsePhase(w)).toBe(w);
    }
  });

  it('tolerates surrounding whitespace and casing, which a file will have', () => {
    expect(parsePhase('  Verifying\n')).toBe('verifying');
    expect(parsePhase('REVIEWING')).toBe('reviewing');
  });

  it('refuses anything that is not exactly a phase', () => {
    for (const w of ['', '   ', 'done', 'implement', 'reviewing please', 'DROP TABLE jobs', '{"phase":"x"}']) {
      expect(parsePhase(w)).toBeUndefined();
    }
  });
});

describe('FilePhaseReader', () => {
  it('reads the phase Pi wrote', async () => {
    await expect(reader.read(workspace('verifying\n'))).resolves.toBe('verifying');
  });

  it('is undefined when there is no file at all', async () => {
    await expect(reader.read(workspace())).resolves.toBeUndefined();
  });

  it('is undefined for a nonexistent workspace', async () => {
    await expect(reader.read('/definitely/not/here')).resolves.toBeUndefined();
  });

  it('refuses an oversized file rather than reading it', async () => {
    await expect(reader.read(workspace('verifying'.repeat(64)))).resolves.toBeUndefined();
  });

  it('refuses a directory where the phase file should be', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-phase-'));
    mkdirSync(path.join(dir, '.ducky', 'phase'), { recursive: true });
    await expect(reader.read(dir)).resolves.toBeUndefined();
  });

  it('refuses an unrecognised word instead of inventing a phase', async () => {
    await expect(reader.read(workspace('shipping'))).resolves.toBeUndefined();
  });
});

/**
 * The executor does not own the phase machine -- the coordinator does, and it
 * REFUSES an illegal edge by failing the whole heartbeat. Asking the shared
 * predicate first means a doomed report never costs a lease renewal.
 */
describe('shouldReportPhase', () => {
  it('reports a legal forward edge', () => {
    expect(shouldReportPhase('implementing', 'reviewing')).toBe(true);
    expect(shouldReportPhase(null, 'verifying')).toBe(true);
  });

  it('stays quiet about the same phase repeated', () => {
    expect(shouldReportPhase('reviewing', 'reviewing')).toBe(false);
  });

  it('stays quiet about an edge the machine would refuse', () => {
    // Probe A showed a real Pi agent writing `verifying` straight after the
    // brief, which the machine refuses from `planning`.
    expect(shouldReportPhase('planning', 'verifying')).toBe(false);
    expect(shouldReportPhase('implementing', 'planning')).toBe(false);
  });

  it('stays quiet when there is nothing to report', () => {
    expect(shouldReportPhase('implementing', undefined)).toBe(false);
  });
});

/**
 * A stale phase must not be reported as current.
 *
 * A resumed job — an answered question, a retry, a recovered workspace — reuses
 * its workspace, so the phase the LAST turn finished on is sitting in the file.
 * Reading it would make a job that has only just started planning claim to be
 * verifying.
 */
describe('clearing a previous turn s phase', () => {
  it('removes a phase left behind', async () => {
    const ws = workspace('verifying');
    await expect(reader.read(ws)).resolves.toBe('verifying');

    await reader.clear(ws);
    await expect(reader.read(ws)).resolves.toBeUndefined();
  });

  it('is silent when there is nothing to clear', async () => {
    await expect(reader.clear(workspace())).resolves.toBeUndefined();
    await expect(reader.clear('/definitely/not/here')).resolves.toBeUndefined();
  });

  it('leaves the rest of the workspace alone', async () => {
    const ws = workspace('reviewing');
    writeFileSync(path.join(ws, '.ducky', 'result.json'), '{"keep":true}');
    await reader.clear(ws);

    expect(existsSync(path.join(ws, '.ducky', 'result.json'))).toBe(true);
    expect(existsSync(path.join(ws, '.ducky', 'phase'))).toBe(false);
  });
});
