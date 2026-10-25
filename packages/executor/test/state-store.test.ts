import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FileDispatchJournal } from '../src/dispatch-journal-file.js';
import { openExecutorState } from '../src/executor-state.js';
import { FilePauseIntentStore, PauseIntentSchema, type PauseIntent } from '../src/pause-intents.js';
import { MAX_RECORD_BYTES, StateDir, StateStoreError, defaultForbiddenRoots, type StateFsOps } from '../src/state-store.js';

/**
 * The executor's durable local store. Scratch directories live under /tmp, which
 * the REAL configuration forbids, so these tests pass `forbiddenRoots: []` -- and
 * a separate test pins that the default refuses exactly that.
 */
const uid = process.getuid!();
const Schema = z.strictObject({ n: z.number() });
let root: string;
const base = { uid, forbiddenRoots: [] as string[] };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ducky-state-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const open = (sub = 'd', over: Partial<Parameters<typeof StateDir.open>[1]> = {}): StateDir =>
  StateDir.open(path.join(root, sub), { ...base, maxRecords: 8, ...over });

describe('where the store may live', () => {
  it('refuses a temp or runtime location by default, without creating anything', () => {
    const target = path.join(os.tmpdir(), 'ducky-forbidden-state');
    expect(() => StateDir.open(target, { uid, maxRecords: 1 })).toThrow(/temporary or runtime/);
    expect(existsSync(target)).toBe(false);
    for (const dir of ['/tmp/x', '/var/tmp/x', '/dev/shm/x', '/run/user/1000/x']) {
      expect(() => StateDir.open(dir, { uid, maxRecords: 1 })).toThrow(/temporary or runtime/);
    }
    expect(defaultForbiddenRoots({ TMPDIR: '/scratch/t', XDG_RUNTIME_DIR: '/run/user/9' })).toEqual(
      expect.arrayContaining(['/tmp', '/scratch/t', '/run/user/9']),
    );
    expect(() =>
      StateDir.open('/scratch/t/state', { uid, maxRecords: 1, forbiddenRoots: defaultForbiddenRoots({ TMPDIR: '/scratch/t' }) }),
    ).toThrow(/temporary or runtime/);
  });

  it('refuses a relative or unnormalised path', () => {
    expect(() => StateDir.open('relative/dir', { ...base, maxRecords: 1 })).toThrow(/absolute/);
    expect(() => StateDir.open(`${root}/a/../b`, { ...base, maxRecords: 1 })).toThrow(/absolute/);
  });

  it('creates a private directory, and refuses a loose mode, a foreign owner and a symlink anywhere in the path', () => {
    const d = open('ok');
    expect(d.dir).toBe(path.join(root, 'ok'));
    expect((nodeFs.statSync(d.dir).mode & 0o777).toString(8)).toBe('700');

    const loose = path.join(root, 'loose');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    expect(() => StateDir.open(loose, { ...base, maxRecords: 1 })).toThrow(/0700/);

    expect(() => StateDir.open(path.join(root, 'ok'), { ...base, uid: uid + 1, maxRecords: 1 })).toThrow(/not owned/);

    const real = path.join(root, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, path.join(root, 'link'));
    expect(() => StateDir.open(path.join(root, 'link'), { ...base, maxRecords: 1 })).toThrow(/symbolic link/);
    expect(() => StateDir.open(path.join(root, 'link', 'child'), { ...base, maxRecords: 1 })).toThrow(/symbolic link/);
  });
});

describe('atomic writes', () => {
  it('writes a 0600 record and reads it back, replacing a previous one whole', () => {
    const d = open();
    d.write('a.json', { n: 1 });
    expect((nodeFs.statSync(path.join(d.dir, 'a.json')).mode & 0o777).toString(8)).toBe('600');
    expect(d.read('a.json', Schema)).toEqual({ kind: 'ok', value: { n: 1 } });
    d.write('a.json', { n: 2 });
    expect(d.read('a.json', Schema)).toEqual({ kind: 'ok', value: { n: 2 } });
    expect(readdirSync(d.dir)).toEqual(['a.json']);
  });

  const failing = (op: keyof StateFsOps, when: (n: number) => boolean = () => true): StateFsOps => {
    let n = 0;
    const real = nodeFs[op] as (...a: unknown[]) => unknown;
    return {
      ...nodeFs,
      [op]: (...a: unknown[]) => {
        n += 1;
        if (when(n)) throw new Error(`injected ${String(op)} failure`);
        return real(...a);
      },
    } as StateFsOps;
  };

  for (const op of ['renameSync', 'writeSync', 'openSync'] as const) {
    it(`a ${op} failure keeps the previous record intact and leaves no temp file`, () => {
      const good = open('f');
      good.write('a.json', { n: 1 });
      // Re-open over the same directory with a faulty fs. `openSync` is called for the
      // directory fsync too, so fail only the temp-file open (the first call after open).
      const faulty = StateDir.open(good.dir, { ...base, maxRecords: 8, fsOps: failing(op) });
      expect(() => faulty.write('a.json', { n: 2 })).toThrow(StateStoreError);
      expect(good.read('a.json', Schema)).toEqual({ kind: 'ok', value: { n: 1 } });
      expect(readdirSync(good.dir)).toEqual(['a.json']);
    });
  }

  it('an fsync failure of the file is a failed write, never a published record', () => {
    const good = open('g');
    const faulty = StateDir.open(good.dir, { ...base, maxRecords: 8, fsOps: failing('fsyncSync') });
    expect(() => faulty.write('a.json', { n: 1 })).toThrow(StateStoreError);
    expect(good.read('a.json', Schema)).toEqual({ kind: 'absent' });
    expect(readdirSync(good.dir)).toEqual([]);
  });

  it('a failed directory fsync (after the rename) is reported as failure, so nothing is released on it', () => {
    const good = open('h');
    // fsyncSync call 1 is the file, call 2 the directory.
    const faulty = StateDir.open(good.dir, { ...base, maxRecords: 8, fsOps: failing('fsyncSync', (n) => n === 2) });
    expect(() => faulty.write('a.json', { n: 1 })).toThrow(StateStoreError);
  });

  it('a partial write that never reached its rename is not a record, and its temp file is cleaned up on the next listing', () => {
    const d = open('p');
    writeFileSync(path.join(d.dir, '.a.json.0123456789abcdef.tmp'), '{"n":', { mode: 0o600 });
    expect(d.read('a.json', Schema)).toEqual({ kind: 'absent' });
    expect(d.list(Schema)).toEqual({ records: [], untrusted: [] });
    expect(readdirSync(d.dir)).toEqual([]);
  });

  it('refuses an oversized record and a bad name, and bounds the record count', () => {
    const d = open('b', { maxRecords: 2 });
    expect(() => d.write('a.json', { n: 'x'.repeat(MAX_RECORD_BYTES) })).toThrow(/too large/);
    expect(() => d.write('../a.json', { n: 1 })).toThrow(/Invalid record name/);
    d.write('a.json', { n: 1 });
    d.write('b.json', { n: 2 });
    expect(() => d.write('c.json', { n: 3 })).toThrow(/too many/);
    // Replacing an existing record is not a new record.
    d.write('a.json', { n: 9 });
  });
});

describe('untrusted records fail closed and are never deleted', () => {
  it('reports corrupt, wrong-shape, permissive, oversized, symlinked and unexpected entries, and keeps every one', () => {
    const d = open('u');
    const file = (name: string, body: string, mode = 0o600) => {
      writeFileSync(path.join(d.dir, name), body, { mode });
      chmodSync(path.join(d.dir, name), mode);
    };
    file('corrupt.json', '{not json');
    file('shape.json', '{"n":"text"}');
    file('loose.json', '{"n":1}', 0o644);
    file('big.json', ' '.repeat(MAX_RECORD_BYTES + 1));
    symlinkSync(path.join(d.dir, 'loose.json'), path.join(d.dir, 'link.json'));
    file('notes.txt', 'hello');
    file('good.json', '{"n":1}');

    const l = d.list(Schema);
    expect(l.records.map((r) => r.name)).toEqual(['good.json']);
    expect(l.untrusted.sort()).toEqual([
      'big.json: oversized',
      'corrupt.json: malformed',
      'link.json: not a regular file',
      'loose.json: permissive mode',
      'shape.json: wrong shape',
      'unexpected entry',
    ]);
    expect(readdirSync(d.dir).sort()).toEqual(
      ['big.json', 'corrupt.json', 'good.json', 'link.json', 'loose.json', 'notes.txt', 'shape.json'],
    );
    expect(readFileSync(path.join(d.dir, 'corrupt.json'), 'utf8')).toBe('{not json');
  });

  it('removal is idempotent', () => {
    const d = open('r');
    d.write('a.json', { n: 1 });
    d.remove('a.json');
    d.remove('a.json');
    expect(d.read('a.json', Schema)).toEqual({ kind: 'absent' });
  });
});

const intent = (over: Partial<PauseIntent> = {}): PauseIntent => ({
  v: 1, reportId: '11111111-1111-4111-8111-111111111111', executorId: 'exec-a', jobId: 'job-1',
  publicId: 'jabcde', leaseId: 'lease-1', workspaceId: 'wX', agentName: 'ducky-pi-demo',
  cause: 'agent_idle_no_result', agentStatus: 'idle', ...over,
});

describe('the pause intent outbox', () => {
  const store = (): FilePauseIntentStore => new FilePauseIntentStore(open('o'));

  it('is idempotent for one report id and refuses a second, different intent for the job', () => {
    const s = store();
    s.write(intent());
    s.write(intent());
    expect(s.list().intents).toEqual([intent()]);
    expect(() => s.write(intent({ reportId: '22222222-2222-4222-8222-222222222222' }))).toThrow(/already pending/);
  });

  it('survives reopening the directory, as a restarted process would see it', () => {
    store().write(intent());
    expect(store().list()).toEqual({ intents: [intent()], blocked: [] });
  });

  it('removes only the acknowledged report', () => {
    const s = store();
    s.write(intent());
    expect(() => s.remove(intent({ reportId: '22222222-2222-4222-8222-222222222222' }))).toThrow(/not the one/);
    expect(s.list().intents).toHaveLength(1);
    s.remove(intent());
    expect(s.list()).toEqual({ intents: [], blocked: [] });
  });

  it('blocks on a corrupt record, and on one filed under another job', () => {
    const d = open('o2');
    const s = new FilePauseIntentStore(d);
    writeFileSync(path.join(d.dir, 'job-1.json'), '{broken', { mode: 0o600 });
    expect(s.list().blocked).toEqual(['job-1.json: malformed']);
    expect(() => s.write(intent())).toThrow(/unreadable/);

    const e = open('o3');
    e.write('job-2.json', PauseIntentSchema.parse(intent()));
    expect(new FilePauseIntentStore(e).list().blocked).toEqual(['job-2.json: name does not match its job']);
  });

  it('holds only ids and enums: no terminal text, no secret, no local clock', () => {
    const s = store();
    s.write(intent());
    const raw = readFileSync(path.join(root, 'o', 'job-1.json'), 'utf8');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'agentName', 'agentStatus', 'cause', 'executorId', 'jobId', 'leaseId', 'publicId', 'reportId',
      'v', 'workspaceId',
    ]);
  });
});

describe('the dispatch journal file', () => {
  it('round-trips an entry, reads untrusted for a corrupt one, and refuses a bad job id', async () => {
    const d = open('j');
    const j = new FileDispatchJournal(d);
    expect(await j.read('job-1')).toEqual({ kind: 'absent' });
    const entry = { jobId: 'job-1', leaseId: 'lease-1', workspaceId: 'wX', agentName: 'ducky-pi-demo', state: 'dispatching' as const };
    await j.record(entry);
    expect(await j.read('job-1')).toEqual({ kind: 'entry', entry });
    await j.record({ ...entry, state: 'settled' });
    expect(await j.read('job-1')).toMatchObject({ kind: 'entry', entry: { state: 'settled' } });

    writeFileSync(path.join(d.dir, 'job-2.json'), 'garbage', { mode: 0o600 });
    expect(await j.read('job-2')).toMatchObject({ kind: 'untrusted' });
    expect(await j.read('../x')).toMatchObject({ kind: 'untrusted' });
    await expect(j.record({ ...entry, jobId: '../x' })).rejects.toThrow(/could not be written/);
  });

  it('refuses to record when the directory is full, so the prompt it protects is not sent', async () => {
    const j = new FileDispatchJournal(open('jf', { maxRecords: 1 }));
    const e = { jobId: 'job-1', leaseId: 'l', workspaceId: 'w', agentName: 'a', state: 'settled' as const };
    await j.record(e);
    await expect(j.record({ ...e, jobId: 'job-2' })).rejects.toThrow(/could not be written/);
  });

  it('forgets a finished job, and tolerates forgetting twice', async () => {
    const j = new FileDispatchJournal(open('jg'));
    const e = { jobId: 'job-1', leaseId: 'l', workspaceId: 'w', agentName: 'a', state: 'settled' as const };
    await j.record(e);
    j.forget('job-1');
    j.forget('job-1');
    expect(await j.read('job-1')).toEqual({ kind: 'absent' });
  });
});

describe('the whole executor state', () => {
  it('opens the two stores under an explicit directory and survives a reopen', async () => {
    const dir = path.join(root, 'state');
    const a = openExecutorState(dir, base);
    a.intents.write(intent());
    await a.journal.record({ jobId: 'job-1', leaseId: 'l', workspaceId: 'w', agentName: 'a', state: 'settled' });
    const b = openExecutorState(dir, base);
    expect(b.intents.list().intents).toHaveLength(1);
    expect(await b.journal.read('job-1')).toMatchObject({ kind: 'entry' });
    expect(readdirSync(dir).sort()).toEqual(['dispatch-journal', 'pause-intents']);
  });

  it('refuses to open under a forbidden root', () => {
    expect(() => openExecutorState(path.join(os.tmpdir(), 'x-state'), { uid })).toThrow(/temporary or runtime/);
  });
});
