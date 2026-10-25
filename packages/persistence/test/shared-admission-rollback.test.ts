import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdmissionHolder } from '@ducky/contracts';
import { SharedLedger, initLedger, observeAccountMemory } from '../src/index.js';

const MIB = 1024 * 1024;
const A: AdmissionHolder = { program: 'agent-flow', instanceId: 'agentflow-0001', jobRef: 'dotph/one#1' };
const D: AdmissionHolder = { program: 'ducky', instanceId: 'ducky-dev-0001', jobRef: 'job-d' };

const rig = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-rollback-'));
  const cg = path.join(dir, 'cg');
  mkdirSync(cg, { mode: 0o700 });
  writeFileSync(path.join(cg, 'memory.max'), `${14336 * MIB}\n`);
  writeFileSync(path.join(cg, 'memory.high'), 'max\n');
  writeFileSync(path.join(cg, 'memory.current'), `${1024 * MIB}\n`);
  const file = path.join(dir, 'ledger.sqlite3');
  const made = initLedger({ path: file, forbiddenRoots: [] });
  const open = () => new SharedLedger({
    path: file, expectedLedgerId: made.ledgerId, expectedPolicyDigest: made.policyDigest,
    forbiddenRoots: [], observe: () => observeAccountMemory(cg),
  });
  return { dir, file, open, made };
};

/**
 * The scenario the manager named: another program's CONFIRMED hold is lost to a
 * stale copy of the SAME ledger (same identity, same policy digest) while its
 * worker lives. The program that owned the hold has its own gate, but a DIFFERENT
 * participant that held nothing must not be admitted from the now-empty file.
 */
describe('a stale copy of the same ledger put back in place', () => {
  const lose = (how: 'in_place' | 'rename') => {
    const r = rig();
    const live = r.open();
    const stale = path.join(r.dir, 'stale-copy.sqlite3');
    copyFileSync(r.file, stale); // the empty ledger, same identity and digest
    const got = live.acquire({ holder: A, repoKey: 'dotph/one', reserveBytes: 3072 * MIB });
    if (!got.ok) throw new Error('setup');
    expect(live.confirm(got.fence, A).ok).toBe(true);
    // Restore the stale copy over the live file.
    if (how === 'in_place') writeFileSync(r.file, readFileSync(stale));
    else renameSync(stale, r.file);
    return { r, fence: got.fence };
  };

  for (const how of ['in_place', 'rename'] as const) {
    it(`never admits another participant from the rolled-back file (${how} restore)`, () => {
      const { r, fence } = lose(how);
      // A fresh participant process: it never saw the lost hold.
      const other = r.open();
      expect(other.acquire({ holder: D, repoKey: 'duckycodess/ducky-bot', reserveBytes: 2560 * MIB }))
        .toMatchObject({ ok: false, reason: 'ledger_mismatch' });
      const af2: AdmissionHolder = { ...A, jobRef: 'dotph/two#2' };
      expect(other.acquire({ holder: af2, repoKey: 'dotph/two', reserveBytes: 3072 * MIB }))
        .toMatchObject({ ok: false, reason: 'ledger_mismatch' });
      expect(other.check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
      // The owner of the lost hold cannot be told it is still held, either.
      expect(other.verify(fence, A)).toBe('ledger_mismatch');
    });
  }

  it('is also caught by a long-running participant that already saw the later state', () => {
    const r = rig();
    const live = r.open();
    const stale = path.join(r.dir, 'stale.sqlite3');
    copyFileSync(r.file, stale);
    const got = live.acquire({ holder: A, repoKey: 'dotph/one', reserveBytes: 3072 * MIB });
    if (!got.ok) throw new Error('setup');
    live.confirm(got.fence, A);
    writeFileSync(r.file, readFileSync(stale));
    expect(live.verify(got.fence, A)).toBe('ledger_mismatch');
  });
});

describe('the rollback fence itself', () => {
  it('advances a generation on every change, even for a writer that bypasses the client', async () => {
    const r = rig();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(r.file);
    const gen = () => Number((raw.prepare('SELECT gen FROM epoch').get() as { gen: number }).gen);
    expect(gen()).toBe(0);
    raw.prepare(
      `INSERT INTO entries (program, instance_id, job_ref, repo_key, reserve_bytes, state, acquired_at, pending_expires_at)
       VALUES ('agent-flow','agentflow-0001','j','o/a', 100, 'pending', 1, 2)`,
    ).run();
    expect(gen()).toBe(1);
    raw.exec(`UPDATE entries SET state='confirmed', confirmed_at=3, pending_expires_at=NULL`);
    expect(gen()).toBe(2);
    raw.exec('DELETE FROM entries');
    expect(gen()).toBe(3);
    expect(() => raw.exec('UPDATE epoch SET gen = gen + 5')).toThrow(/epoch_step/);
    expect(() => raw.exec('UPDATE epoch SET gen = 0')).toThrow(/epoch_step/);
    expect(() => raw.exec('DELETE FROM epoch')).toThrow(/epoch_keep/);
    raw.close();
  });

  it('does not raise a false alarm across many ordinary operations and reopenings', () => {
    const r = rig();
    for (let i = 0; i < 6; i += 1) {
      const l = r.open(); // a fresh participant each time
      const h: AdmissionHolder = { ...A, jobRef: `dotph/r${i}#1` };
      const got = l.acquire({ holder: h, repoKey: `dotph/r${i}`, reserveBytes: 3072 * MIB });
      if (!got.ok) throw new Error('setup');
      expect(l.confirm(got.fence, h).ok).toBe(true);
      expect(l.verify(got.fence, h)).toBe('confirmed');
      expect(l.release(got.fence, h)).toBe('released');
    }
    expect(r.open().check().ok).toBe(true);
  });

  it('refuses when the witness is missing, malformed, or another ledger\'s, and never recreates it', async () => {
    const { unlinkSync } = await import('node:fs');
    const r = rig();
    const wit = `${r.file}.witness`;
    const good = readFileSync(wit, 'utf8');
    unlinkSync(wit);
    expect(r.open().check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
    expect(() => readFileSync(wit)).toThrow(); // not recreated by a runtime
    writeFileSync(wit, 'not json', { mode: 0o600 });
    expect(r.open().check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
    writeFileSync(wit, good.replace(r.made.ledgerId, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), { mode: 0o600 });
    expect(r.open().check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
  });

  it('refuses a witness AHEAD of the file and tolerates one that lags', async () => {
    const r = rig();
    const wit = `${r.file}.witness`;
    const w = JSON.parse(readFileSync(wit, 'utf8')) as { gen: number };
    writeFileSync(wit, `${JSON.stringify({ ...w, gen: w.gen + 3 })}\n`, { mode: 0o600 });
    expect(r.open().check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
    // Lagging (a crash after the commit, before the witness advanced) is not a rollback.
    writeFileSync(wit, `${JSON.stringify({ ...w, gen: 0 })}\n`, { mode: 0o600 });
    const l = r.open();
    const got = l.acquire({ holder: A, repoKey: 'dotph/one', reserveBytes: 3072 * MIB });
    expect(got.ok).toBe(true);
    expect((JSON.parse(readFileSync(wit, 'utf8')) as { gen: number }).gen).toBeGreaterThan(0);
  });

  it('treats a replaced file as a different file even when its content is current', () => {
    const r = rig();
    const l = r.open();
    const got = l.acquire({ holder: A, repoKey: 'dotph/one', reserveBytes: 3072 * MIB });
    if (!got.ok) throw new Error('setup');
    const twin = path.join(r.dir, 'twin.sqlite3');
    copyFileSync(r.file, twin);
    renameSync(twin, r.file); // same bytes, new inode
    expect(r.open().check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
  });

  it('is accepted again only by the owner\'s explicit rewitness, which recovers nothing', async () => {
    const { rewitnessLedger } = await import('../src/index.js');
    const r = rig();
    const live = r.open();
    const stale = path.join(r.dir, 'stale.sqlite3');
    copyFileSync(r.file, stale);
    const got = live.acquire({ holder: A, repoKey: 'dotph/one', reserveBytes: 3072 * MIB });
    if (!got.ok) throw new Error('setup');
    writeFileSync(r.file, readFileSync(stale));
    expect(r.open().check().ok).toBe(false);
    expect(() => rewitnessLedger({ path: r.file, forbiddenRoots: [], expectedLedgerId: 'someone-else' })).toThrow(/identity/);
    rewitnessLedger({ path: r.file, forbiddenRoots: [], expectedLedgerId: r.made.ledgerId });
    // Accepted as truth now -- and the lost hold stays lost, which is exactly why this is an owner act.
    expect(r.open().check().ok).toBe(true);
    expect(r.open().inspect().entries).toHaveLength(0);
  });
});


describe('witness writes are serialized with the ledger write lock', () => {
  const TSX = path.join(path.resolve(import.meta.dirname, '..', '..', '..'), 'node_modules', '.bin', 'tsx');
  const CHILD = path.join(import.meta.dirname, 'fixtures', 'ledger-child.ts');
  const witnessGen = (file: string): number => (JSON.parse(readFileSync(`${file}.witness`, 'utf8')) as { gen: number }).gen;
  const dbGen = async (file: string): Promise<number> => {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(file);
    try { return Number((raw.prepare('SELECT gen FROM epoch').get() as { gen: number }).gen); } finally { raw.close(); }
  };
  const startChild = (r: ReturnType<typeof rig>, barrier: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const flags = path.join(r.dir, 'flags');
    mkdirSync(flags, { recursive: true });
    const payload = {
      path: r.file, ledgerId: r.made.ledgerId, cgroupDir: path.join(r.dir, 'cg'),
      holder: A, repoKey: 'dotph/one', reserveBytes: 3072 * MIB, steps: [],
      barrier: { dir: flags, ...barrier }, ...extra,
    };
    const child = spawn(TSX, [CHILD, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
    const wait = async (name: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (!existsSync(path.join(flags, name))) {
        if (Date.now() > deadline) throw new Error(`barrier ${name} never reached`);
        await new Promise((res) => setTimeout(res, 20));
      }
    };
    return { done, wait, release: (name: string) => writeFileSync(path.join(flags, name), 'x') };
  };

  it('a slow writer resumed after a faster one never moves the witness backwards', async () => {
    const r = rig();
    // A commits its acquire, then PAUSES before touching the witness.
    const a = startChild(r, { point: 'afterCommit', announce: 'a-committed', until: 'b-done' });
    await a.wait('a-committed');
    const seen: number[] = [witnessGen(r.file)];
    // While A is paused, B (a different participant) commits two more writes and advances the witness.
    const b = r.open();
    const bh: AdmissionHolder = { ...A, jobRef: 'dotph/two#2' };
    const got = b.acquire({ holder: bh, repoKey: 'dotph/two', reserveBytes: 3072 * MIB });
    if (!got.ok) throw new Error(`setup: ${JSON.stringify(got)}`);
    expect(b.confirm(got.fence, bh).ok).toBe(true);
    seen.push(witnessGen(r.file));
    const high = seen[seen.length - 1]!;
    expect(high).toBeGreaterThan(seen[0]!);
    // Now A resumes with a generation it captured BEFORE B's writes. It must not write it.
    a.release('b-done');
    // An observer polls the witness for the whole resume.
    let exited = false;
    void a.done.then(() => { exited = true; });
    while (!exited) { seen.push(witnessGen(r.file)); await new Promise((res) => setTimeout(res, 5)); }
    seen.push(witnessGen(r.file));
    expect(await a.done).toBe(0);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!, `observation ${i}: ${seen.join(',')}`).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(witnessGen(r.file)).toBe(await dbGen(r.file));
    expect(witnessGen(r.file)).toBeGreaterThanOrEqual(high);
  }, 90_000);

  it('holds the write lock between re-reading the generation and writing the witness', async () => {
    const r = rig();
    // A pauses AFTER re-reading the current generation, before writing the witness: it holds the lock.
    const a = startChild(r, { point: 'beforeWitnessWrite', announce: 'a-locked', until: 'b-tried' });
    await a.wait('a-locked');
    const before = witnessGen(r.file);
    const bh: AdmissionHolder = { ...A, jobRef: 'dotph/two#2' };
    // B cannot commit anything in that window: the lock is A's, so B times out as busy.
    const blocked = r.open().acquire({ holder: bh, repoKey: 'dotph/two', reserveBytes: 3072 * MIB });
    expect(blocked).toMatchObject({ ok: false, reason: 'busy' });
    expect(witnessGen(r.file)).toBe(before);
    a.release('b-tried');
    expect(await a.done).toBe(0);
    // Afterwards the ledger is whole: A's hold exists, the witness equals the database, B can proceed.
    expect(witnessGen(r.file)).toBe(await dbGen(r.file));
    expect(r.open().acquire({ holder: bh, repoKey: 'dotph/two', reserveBytes: 3072 * MIB })).toMatchObject({ ok: true });
  }, 90_000);

  it('a reader in another process never sees the witness ahead of its own snapshot', async () => {
    const r = rig();
    const writer = r.open();
    const h: AdmissionHolder = { ...A, jobRef: 'dotph/w#1' };
    const payload = {
      path: r.file, ledgerId: r.made.ledgerId, cgroupDir: path.join(r.dir, 'cg'),
      holder: A, repoKey: 'dotph/x', reserveBytes: MIB, steps: [], loopMs: 3000,
    };
    const reader = spawn(TSX, [CHILD, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    reader.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const finished = new Promise<number>((resolve) => reader.on('close', (c) => resolve(c ?? -1)));
    // Let the reader start, then write continuously while it checks as fast as it can.
    await new Promise((res) => setTimeout(res, 700));
    const until = Date.now() + 2000;
    let writes = 0;
    while (Date.now() < until) {
      const got = writer.acquire({ holder: h, repoKey: 'dotph/w', reserveBytes: 3072 * MIB });
      if (got.ok) { writer.confirm(got.fence, h); writer.release(got.fence, h); writes += 1; }
    }
    expect(await finished).toBe(0);
    const report = JSON.parse(out.trim()) as { checks: number; reasons: Record<string, number> };
    expect(writes).toBeGreaterThan(20);
    expect(report.checks).toBeGreaterThan(50);
    // Only a busy refusal is acceptable while a writer holds the lock; never a rollback.
    expect(Object.keys(report.reasons).filter((k) => !k.startsWith('busy'))).toEqual([]);
  }, 60_000);
});

describe('the witness test hooks are never set by a runtime', () => {
  it('no production source passes afterCommit or beforeWitnessWrite', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === 'node_modules' || name === 'dist' || name === 'test' || name === '.git') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mjs|js)$/.test(name) && /afterCommit|beforeWitnessWrite/.test(readFileSync(p, 'utf8'))) {
          offenders.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, 'packages'));
    walk(path.join(root, 'scripts'));
    expect(offenders).toEqual(['packages/persistence/src/shared-admission/ledger.ts']);
  });
});
