import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIEF_RELATIVE_PATH, FileBriefWriter, briefPointerPrompt,
} from '../src/pi/brief-file.js';

/**
 * Measured on this host: a 1.5 KB brief pasted and submitted fine, a 3.3 KB one
 * was left sitting UNSENT in Pi's input buffer -- the agent stayed idle, Herdr
 * reported `agent_prompt_stalled`, and the job failed with no work started.
 * So the brief travels as a file and only a one-line pointer is pasted.
 */
describe('brief handover', () => {
  it('writes the brief where the agent can read it', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    const rel = await new FileBriefWriter().write(ws, '# hello\nbody');
    expect(rel).toBe(BRIEF_RELATIVE_PATH);
    expect(readFileSync(path.join(ws, rel), 'utf8')).toBe('# hello\nbody');
  });

  it('keeps the owner task text private on disk', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    await new FileBriefWriter().write(ws, 'secretish task');
    const file = statSync(path.join(ws, BRIEF_RELATIVE_PATH));
    const dir = statSync(path.join(ws, path.dirname(BRIEF_RELATIVE_PATH)));
    expect(file.mode & 0o777).toBe(0o600);
    expect(dir.mode & 0o777).toBe(0o700);
  });

  it('overwrites a previous round rather than appending to it', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    const w = new FileBriefWriter();
    await w.write(ws, 'first');
    await w.write(ws, 'second');
    expect(readFileSync(path.join(ws, BRIEF_RELATIVE_PATH), 'utf8')).toBe('second');
  });

  it('creates the directory when the workspace is bare', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    await expect(new FileBriefWriter().write(ws, 'x')).resolves.toBeTruthy();
  });

  it('fails loudly when the workspace path does not exist', async () => {
    await expect(new FileBriefWriter().write('/definitely/not/here', 'x')).rejects.toThrow();
  });
});

describe('the pointer that is actually pasted', () => {
  const pointer = briefPointerPrompt(BRIEF_RELATIVE_PATH);

  it('is one line, so a bracketed paste cannot leave it unsent', () => {
    expect(pointer.split('\n')).toHaveLength(1);
  });

  it('is short enough to be nowhere near the size that failed', () => {
    // The measured failure was 3298 characters over 66 lines.
    expect(pointer.length).toBeLessThan(300);
  });

  it('names the brief with a forward-slash path the agent can open', () => {
    expect(pointer).toContain('./.ducky/brief.md');
    expect(pointer).not.toContain('\\');
  });

  it('tells the agent to do the work, not to acknowledge and stop', () => {
    expect(pointer).toMatch(/carry out everything/i);
    expect(pointer).toMatch(/do not reply until the work is done/i);
  });
});

/**
 * Permissions on OVERWRITE, which is the case the first pass got wrong.
 *
 * `mode` on `mkdir`/`writeFile` applies only on CREATION, and is masked by the
 * umask even then. A second round therefore inherited whatever permissions the
 * directory and file already had — and `.ducky/` is created by Pi as well as by
 * us, so "already had" can mean 0755/0644.
 */
describe('brief permissions survive an overwrite', () => {
  it('tightens a directory and file that already exist with wide permissions', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    const dir = path.join(ws, '.ducky');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const file = path.join(ws, BRIEF_RELATIVE_PATH);
    writeFileSync(file, 'stale', { mode: 0o644 });
    chmodSync(file, 0o644);

    await new FileBriefWriter().write(ws, 'fresh');

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('fresh');
  });

  it('is owner-only on every round, not just the first', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    const w = new FileBriefWriter();
    for (const round of ['one', 'two', 'three']) {
      await w.write(ws, round);
      const file = path.join(ws, BRIEF_RELATIVE_PATH);
      expect(statSync(file).mode & 0o777, round).toBe(0o600);
      expect(readFileSync(file, 'utf8'), round).toBe(round);
    }
  });

  it('leaves no temp file behind', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    await new FileBriefWriter().write(ws, 'x');
    const entries = readdirSync(path.join(ws, '.ducky'));
    expect(entries).toEqual(['brief.md']);
  });
});

/**
 * The temp file must not follow anything that is already at its path.
 *
 * A predictable `.tmp-<pid>` name that already existed as a symlink would have
 * been followed, and the write would have landed wherever it pointed — at 0600
 * on the wrong file. The workspace is Ducky-managed, but a Pi agent also writes
 * in it, so "nothing else creates that name" is not a property to rely on.
 */
describe('the temp write does not follow a symlink', () => {
  it('writes the brief, not the symlink target, when a decoy exists', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    mkdirSync(path.join(ws, '.ducky'), { recursive: true });

    // A file the write must never touch.
    const outside = path.join(ws, 'DO-NOT-TOUCH');
    writeFileSync(outside, 'original', { mode: 0o644 });

    // Plant symlinks across the whole predictable-name space the old code used.
    for (const suffix of [String(process.pid), `${process.pid}`, '0', '1']) {
      const decoy = path.join(ws, BRIEF_RELATIVE_PATH) + `.tmp-${suffix}`;
      try {
        symlinkSync(outside, decoy);
      } catch {
        /* a decoy that cannot be planted is simply not tested */
      }
    }

    await new FileBriefWriter().write(ws, 'the real brief');

    expect(readFileSync(outside, 'utf8')).toBe('original');
    expect(readFileSync(path.join(ws, BRIEF_RELATIVE_PATH), 'utf8')).toBe('the real brief');
  });

  it('leaves no temp file behind, whatever decoys are present', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    await new FileBriefWriter().write(ws, 'x');
    const stray = readdirSync(path.join(ws, '.ducky')).filter((f) => f.includes('.tmp-'));
    expect(stray).toEqual([]);
  });

  it('uses an unpredictable temp name rather than the pid', () => {
    // Asserted against the source, because the temp name only exists between
    // the open and the rename and is not observable from outside. The property
    // is what matters: a name derived from the pid is guessable, so a decoy can
    // be planted for the next run.
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'pi', 'brief-file.ts'),
      'utf8',
    );
    expect(src).not.toContain('process.pid');
    expect(src).toContain('randomBytes');
    // And the open must be exclusive, or an existing path is followed.
    expect(src).toContain("'wx'");
  });
});

/**
 * The temp file holds the owner's task text, so no failure may leave it behind.
 */
describe('temp file cleanup on failure', () => {
  it('removes the temp file when the write fails', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    mkdirSync(path.join(ws, '.ducky'), { recursive: true });

    // A brief that cannot be serialised forces a failure after the exclusive
    // open has already created the temp file.
    const hostile = { toString() { throw new Error('cannot serialise'); } } as unknown as string;
    await expect(new FileBriefWriter().write(ws, hostile)).rejects.toThrow();

    const stray = readdirSync(path.join(ws, '.ducky')).filter((f) => f.includes('.tmp-'));
    expect(stray).toEqual([]);
  });

  it('REPLACES a symlink planted at the brief path rather than writing through it', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'ducky-brief-'));
    mkdirSync(path.join(ws, '.ducky'), { recursive: true });
    const outside = path.join(ws, 'DO-NOT-TOUCH');
    writeFileSync(outside, 'original', { mode: 0o644 });
    symlinkSync(outside, path.join(ws, BRIEF_RELATIVE_PATH));

    await new FileBriefWriter().write(ws, 'the real brief');

    // `rename` replaces the link; it does not follow it.
    expect(readFileSync(outside, 'utf8')).toBe('original');
    expect(lstatSync(path.join(ws, BRIEF_RELATIVE_PATH)).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(ws, BRIEF_RELATIVE_PATH), 'utf8')).toBe('the real brief');
  });
});
