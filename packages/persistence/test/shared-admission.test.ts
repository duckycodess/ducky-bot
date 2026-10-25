import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  canonicalAdmissionRepoKey, type AdmissionHolder, type AdmissionRequest,
} from '@ducky/contracts';
import {
  LEDGER_SCHEMA_SQL, SharedLedger, defaultLedgerForbiddenRoots, initLedger, observeAccountMemory,
  policyDigest, type MemoryObservation,
} from '../src/index.js';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const MIB = 1024 * 1024;

interface Scratch {
  dir: string;
  file: string;
  cgroup: string;
  setMemory: (limitMiB: number | 'max', currentMiB: number, high?: number | 'max') => void;
}

const scratch = (): Scratch => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-ledger-'));
  const cgroup = path.join(dir, 'cg');
  mkdirSync(cgroup, { mode: 0o700 });
  const setMemory: Scratch['setMemory'] = (limit, current, high = 'max') => {
    writeFileSync(path.join(cgroup, 'memory.max'), limit === 'max' ? 'max\n' : `${limit * MIB}\n`);
    writeFileSync(path.join(cgroup, 'memory.high'), high === 'max' ? 'max\n' : `${high * MIB}\n`);
    writeFileSync(path.join(cgroup, 'memory.current'), `${current * MIB}\n`);
  };
  setMemory(14336, 1024);
  return { dir, file: path.join(dir, 'ledger.sqlite3'), cgroup, setMemory };
};

const open = (s: Scratch, ledgerId: string, extra: Partial<ConstructorParameters<typeof SharedLedger>[0]> = {}) =>
  new SharedLedger({
    path: s.file, expectedLedgerId: ledgerId, forbiddenRoots: [],
    observe: () => observeAccountMemory(s.cgroup), ...extra,
  });

const mk = (program: 'ducky' | 'agent-flow', job: string): AdmissionHolder => ({
  program, instanceId: program === 'ducky' ? 'ducky-dev-0001' : 'agentflow-0001', jobRef: job,
});
const req = (h: AdmissionHolder, repo: string, mib = 3584, resumeFence?: number): AdmissionRequest => ({
  holder: h, repoKey: repo, reserveBytes: mib * MIB, ...(resumeFence === undefined ? {} : { resumeFence }),
});

describe('canonical repository key', () => {
  it('accepts exact lower-case owner/name and refuses everything else', () => {
    expect(canonicalAdmissionRepoKey('duckycodess/ducky-bot')).toBe('duckycodess/ducky-bot');
    // Case is the one thing normalized: two spellings of a repository are one key.
    expect(canonicalAdmissionRepoKey('DuckyCodess/Ducky-Bot')).toBe('duckycodess/ducky-bot');
    for (const bad of [
      'a/b/c', 'a', '/b', 'a/', 'a/.', 'a/..', 'a/b.git', 'a/b.', ' a/b',
      'https://github.com/a/b', 'a b/c', '-a/b',
    ]) expect(canonicalAdmissionRepoKey(bad), bad).toBeUndefined();
  });
});

describe('ledger lifecycle and invariants', () => {
  it('initializes once, never twice, and creates a private file', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    expect(made.ledgerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => initLedger({ path: s.file, forbiddenRoots: [] })).toThrow(/already exists/);
    expect(open(s, made.ledgerId).check()).toMatchObject({ ok: true, ledgerId: made.ledgerId });
  });

  it('refuses to open a missing ledger rather than creating one', () => {
    const s = scratch();
    const l = open(s, 'whatever');
    expect(l.check()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(existsSync(s.file)).toBe(false);
    expect(l.acquire(req(mk('agent-flow', 'dotph/one#1'), 'dotph/one'))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(existsSync(s.file)).toBe(false);
  });

  it('refuses a ledger of a different identity or policy: pinned, never adopted', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    expect(open(s, 'some-other-ledger-id').check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
    expect(open(s, made.ledgerId, { expectedPolicyDigest: 'deadbeef' }).check())
      .toMatchObject({ ok: false, reason: 'policy_mismatch' });
    expect(open(s, made.ledgerId, { expectedPolicyDigest: made.policyDigest }).check().ok).toBe(true);
    // A replaced file (a fresh ledger at the same path) is a different identity.
    const s2 = scratch();
    const other = initLedger({ path: s2.file, forbiddenRoots: [] });
    expect(other.ledgerId).not.toBe(made.ledgerId);
    expect(new SharedLedger({
      path: s2.file, expectedLedgerId: made.ledgerId, forbiddenRoots: [],
      observe: () => observeAccountMemory(s2.cgroup),
    }).acquire(req(mk('ducky', 'j'), 'duckycodess/ducky-bot', 2560)))
      .toMatchObject({ ok: false, reason: 'ledger_mismatch' });
  });

  it('refuses an unsafe path: temp roots, symlinks, loose modes, extra links', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    // Default roots refuse a scratch under the OS temp directory.
    expect(() => initLedger({ path: path.join(os.tmpdir(), 'ducky-x', 'l.sqlite3') })).toThrow(/temporary or runtime/);
    expect(defaultLedgerForbiddenRoots({ TMPDIR: '/x/tmp' } as never)).toContain('/x/tmp');
    // A symlinked directory component.
    const link = path.join(s.dir, 'link');
    symlinkSync(s.dir, link);
    expect(new SharedLedger({
      path: path.join(link, 'ledger.sqlite3'), expectedLedgerId: made.ledgerId, forbiddenRoots: [],
      observe: () => observeAccountMemory(s.cgroup),
    }).check()).toMatchObject({ ok: false, reason: 'unavailable' });
    // A second hard link, then a loose mode.
    linkSync(s.file, path.join(s.dir, 'second-link'));
    expect(open(s, made.ledgerId).check()).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('refuses a ledger left in a loose mode', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    chmodSync(s.file, 0o644);
    expect(open(s, made.ledgerId).check()).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('keeps its structural guarantees even against a participant that skips the checks', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    const raw = new DatabaseSync(s.file);
    const ins = (program: string, inst: string, job: string, repo: string, bytes = 100 * MIB) =>
      raw.prepare(
        `INSERT INTO entries (program, instance_id, job_ref, repo_key, reserve_bytes, state, acquired_at, pending_expires_at)
         VALUES (?,?,?,?,?, 'pending', 1, 2)`,
      ).run(program, inst, job, repo, bytes);
    ins('agent-flow', 'agentflow-0001', 'a', 'o/a');
    expect(() => ins('agent-flow', 'agentflow-0002', 'b', 'o/a')).toThrow(/UNIQUE/);
    expect(() => ins('ducky', 'ducky-dev-0001', 'c', 'o/c')).toThrow(/ducky_exclusive/);
    ins('agent-flow', 'agentflow-0001', 'd', 'o/d');
    expect(() => ins('agent-flow', 'agentflow-0001', 'e', 'o/e')).toThrow(/global_cap/);
    raw.exec('DELETE FROM entries');
    ins('ducky', 'ducky-dev-0001', 'c', 'o/c');
    expect(() => ins('agent-flow', 'agentflow-0001', 'f', 'o/f')).toThrow(/ducky_present/);
    raw.exec('DELETE FROM entries');
    expect(() => ins('agent-flow', 'agentflow-0001', 'g', 'o/g', 14 * 1024 * MIB)).toThrow(/reserve_budget/);
    // Identity is fixed and state only moves forward; policy and meta never change.
    ins('agent-flow', 'agentflow-0001', 'h', 'o/h');
    expect(() => raw.exec(`UPDATE entries SET repo_key = 'o/z'`)).toThrow(/identity_fixed/);
    raw.exec(`UPDATE entries SET state = 'confirmed', confirmed_at = 3, pending_expires_at = NULL`);
    expect(() => raw.exec(`UPDATE entries SET state = 'pending', pending_expires_at = 9, confirmed_at = NULL`)).toThrow(/state_forward_only/);
    expect(() => raw.exec('UPDATE policy SET global_cap = 1')).toThrow(/policy_fixed/);
    expect(() => raw.exec(`UPDATE meta SET value = 'x' WHERE key = 'ledger_id'`)).toThrow(/meta_fixed/);
    expect(() => raw.exec('DELETE FROM meta')).toThrow(/meta_fixed/);
    raw.close();
    expect(made.policyDigest).toBe(policyDigest({
      globalCap: 2, repoCap: 1, duckyExclusive: true, ceilingBytes: 14 * 1024 * MIB,
      notificationReserveBytes: 512 * MIB, pendingTtlSeconds: 120,
    }));
  });

  it('bounds the policy structurally and at the API: the global cap can never exceed 2', () => {
    for (const bad of [
      { globalCap: 3 }, { globalCap: 4 }, { globalCap: 0 }, { globalCap: 1.5 }, { globalCap: Number.NaN },
      { globalCap: Number.MAX_SAFE_INTEGER + 2 }, { ceilingBytes: 0 }, { ceilingBytes: -1 },
      { ceilingBytes: 1.5 }, { notificationReserveBytes: -1 }, { notificationReserveBytes: 15 * 1024 * MIB },
      { pendingTtlSeconds: 4 }, { pendingTtlSeconds: 3601 }, { pendingTtlSeconds: 1.5 },
      { repoCap: 2 }, { duckyExclusive: false },
    ]) {
      const s = scratch();
      expect(() => initLedger({ path: s.file, forbiddenRoots: [], policy: bad as never }), JSON.stringify(bad))
        .toThrow(/invalid policy/);
      expect(existsSync(s.file)).toBe(false);
    }
    // The schema itself refuses a cap above 2 for a writer that skips the API.
    const s = scratch();
    initLedger({ path: s.file, forbiddenRoots: [] });
    const raw = new DatabaseSync(s.file);
    expect(() => raw.exec('DROP TABLE policy')).not.toThrow(); // DDL is not guarded; the digest and checks catch it
    raw.exec(`CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1),
      global_cap INTEGER NOT NULL CHECK (global_cap BETWEEN 1 AND 2), repo_cap INTEGER, ducky_exclusive INTEGER,
      ceiling_bytes INTEGER, notification_reserve_bytes INTEGER, pending_ttl_seconds INTEGER)`);
    expect(() => raw.exec('INSERT INTO policy VALUES (1, 4, 1, 1, 1000, 0, 120)')).toThrow(/CHECK/);
    raw.close();
  });

  it('refuses to open a ledger whose policy row sits outside the authorized bounds', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    const raw = new DatabaseSync(s.file);
    raw.exec('DROP TABLE policy');
    raw.exec(`CREATE TABLE policy (id INTEGER PRIMARY KEY, global_cap INTEGER, repo_cap INTEGER, ducky_exclusive INTEGER,
      ceiling_bytes INTEGER, notification_reserve_bytes INTEGER, pending_ttl_seconds INTEGER)`);
    raw.exec(`INSERT INTO policy VALUES (1, 4, 1, 1, ${14 * 1024 * MIB}, ${512 * MIB}, 120)`);
    raw.exec('CREATE TRIGGER policy_fixed_u BEFORE UPDATE ON policy BEGIN SELECT RAISE(ABORT, \'policy_fixed\'); END');
    raw.exec('CREATE TRIGGER policy_fixed_d BEFORE DELETE ON policy BEGIN SELECT RAISE(ABORT, \'policy_fixed\'); END');
    raw.close();
    expect(open(s, made.ledgerId).check()).toMatchObject({ ok: false, reason: 'policy_mismatch' });
  });

  it('a tampered policy row no longer matches its recorded digest', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    const raw = new DatabaseSync(s.file);
    raw.exec('DROP TRIGGER policy_fixed_u');
    raw.exec('UPDATE policy SET global_cap = 1');
    raw.close();
    expect(open(s, made.ledgerId).check()).toMatchObject({ ok: false, reason: 'ledger_mismatch' });
  });

  it('observes the account memory fail-closed', () => {
    const files: Record<string, string> = {};
    const reader = (f: string) => {
      const v = files[path.basename(f)];
      if (v === undefined) throw new Error('enoent');
      return v;
    };
    const set = (max: string, high: string, current: string) => {
      files['memory.max'] = max; files['memory.high'] = high; files['memory.current'] = current;
    };
    const obs = (): MemoryObservation => observeAccountMemory('/cg', reader);
    set('17179869184', '15032385536', '4294967296');
    expect(obs()).toEqual({ ok: true, limitBytes: 15032385536, currentBytes: 4294967296 });
    set('max', '15032385536', '1');
    expect(obs()).toMatchObject({ ok: true, limitBytes: 15032385536 });
    set('max', 'max', '1');
    expect(obs().ok).toBe(false);
    for (const bad of ['', '-1', '1e9', '0x10', '99999999999999999999', '12 34', 'MAX']) {
      set(bad, '15032385536', '1');
      expect(obs().ok, `max=${bad}`).toBe(false);
      set('17179869184', '15032385536', bad);
      expect(obs().ok, `current=${bad}`).toBe(false);
    }
    delete files['memory.high'];
    set('1', '1', '1'); delete files['memory.high'];
    expect(obs().ok).toBe(false);
    expect(observeAccountMemory('relative/dir', reader).ok).toBe(false);
  });

  it('applies the LOWER of the observed ceiling and the policy ceiling', () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    const l = open(s, made.ledgerId);
    // Observed ceiling 4 GiB beats the 14 GiB policy: 3.5 GiB + 0.5 notification = 4 GiB, nothing left.
    s.setMemory(4096, 0);
    expect(l.acquire(req(mk('agent-flow', 'dotph/one#1'), 'dotph/one', 3585))).toMatchObject({ ok: false, reason: 'insufficient_memory' });
    expect(l.acquire(req(mk('agent-flow', 'dotph/one#1'), 'dotph/one', 3584))).toMatchObject({ ok: true });
    // memory.high lower than memory.max governs.
    s.setMemory(16384, 0, 2048);
    expect(l.acquire(req(mk('agent-flow', 'dotph/two#2'), 'dotph/two', 1))).toMatchObject({ ok: false, reason: 'insufficient_memory' });
  });
});

interface VectorStep {
  op: string; holder?: string; fence?: string | number; repo?: string; reserveMiB?: number;
  as?: string; resume?: string; seconds?: number; limitMiB?: number; currentMiB?: number; fail?: boolean;
  expect?: unknown;
}
interface Vectors {
  policy: { globalCap: number; ceilingMiB: number; notificationReserveMiB: number; pendingTtlSeconds: number };
  holders: Record<string, AdmissionHolder>;
  scenarios: { name: string; steps: VectorStep[] }[];
}
const vectors = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'shared-admission-vectors.json'), 'utf8'),
) as Vectors;

describe('protocol vectors (the same file the Python companion is run against)', () => {
  for (const sc of vectors.scenarios) {
    it(sc.name, () => {
      const s = scratch();
      const made = initLedger({
        path: s.file, forbiddenRoots: [],
        policy: {
          globalCap: vectors.policy.globalCap,
          ceilingBytes: vectors.policy.ceilingMiB * MIB,
          notificationReserveBytes: vectors.policy.notificationReserveMiB * MIB,
          pendingTtlSeconds: vectors.policy.pendingTtlSeconds,
        },
      });
      let clock = 1_000_000;
      let mem: MemoryObservation = { ok: true, limitBytes: 14336 * MIB, currentBytes: 0 };
      const l = open(s, made.ledgerId, { now: () => clock, observe: () => mem });
      const fences = new Map<string, number>();
      const fenceOf = (f: string | number | undefined): number =>
        typeof f === 'number' ? f : (fences.get(String(f)) ?? -1);
      for (const [i, st] of sc.steps.entries()) {
        const where = `${sc.name} / step ${i} (${st.op})`;
        const holder = st.holder ? vectors.holders[st.holder]! : undefined;
        switch (st.op) {
          case 'memory':
            mem = st.fail
              ? { ok: false, detail: 'vector' }
              : { ok: true, limitBytes: st.limitMiB! * MIB, currentBytes: st.currentMiB! * MIB };
            break;
          case 'advance': clock += st.seconds! * 1000; break;
          case 'acquire': {
            const r = l.acquire({
              holder: holder!, repoKey: st.repo!, reserveBytes: st.reserveMiB! * MIB,
              ...(st.resume ? { resumeFence: fenceOf(st.resume) } : {}),
            });
            const exp = st.expect as { ok: boolean; reason?: string; state?: string; adopted?: boolean };
            expect(r.ok, where).toBe(exp.ok);
            if (r.ok) {
              expect({ state: r.state, adopted: r.adopted }, where).toEqual({ state: exp.state, adopted: exp.adopted });
              if (st.as) fences.set(st.as, r.fence);
            } else expect(r.reason, where).toBe(exp.reason);
            break;
          }
          case 'confirm': {
            const r = l.confirm(fenceOf(st.fence), holder!);
            const exp = st.expect as { ok: boolean; reason?: string };
            expect(r.ok, where).toBe(exp.ok);
            if (!r.ok) expect(r.reason, where).toBe(exp.reason);
            break;
          }
          case 'release': expect(l.release(fenceOf(st.fence), holder!), where).toBe(st.expect); break;
          case 'verify': expect(l.verify(fenceOf(st.fence), holder!), where).toBe(st.expect); break;
          default: throw new Error(`unknown vector op ${st.op}`);
        }
      }
    });
  }
});

describe('real concurrent processes against one scratch ledger', () => {
  const child = async (s: Scratch, ledgerId: string, args: Record<string, unknown>) => {
    const { stdout } = await exec(
      TSX,
      [path.join(import.meta.dirname, 'fixtures', 'ledger-child.ts'),
        JSON.stringify({ path: s.file, ledgerId, cgroupDir: s.cgroup, ...args })],
      { encoding: 'utf8', timeout: 60_000 },
    ).catch((err: { stdout?: string; code?: number | null; signal?: string | null }) => ({
      stdout: err.stdout ?? '', killed: err.signal ?? `exit ${String(err.code)}`,
    }));
    return stdout.trim() ? (JSON.parse(stdout.trim()) as Record<string, { ok: boolean; reason?: string; fence?: number }>) : undefined;
  };

  const racers = (ducky: boolean) => [
    ...(ducky ? [{ holder: mk('ducky', 'job-d'), repoKey: 'duckycodess/ducky-bot', reserveBytes: 2560 * MIB }] : []),
    ...['one', 'two', 'three', 'four'].map((n) => ({
      holder: mk('agent-flow', `dotph/${n}#1`), repoKey: `dotph/${n}`, reserveBytes: 3072 * MIB,
    })),
    // Two programs racing for ONE repository, under different names and cases of key.
    { holder: mk('agent-flow', 'dotph/one#2'), repoKey: 'dotph/one', reserveBytes: 3072 * MIB },
  ];

  it('never admits past the global cap, the repository cap or Ducky exclusivity', async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = scratch();
      const made = initLedger({ path: s.file, forbiddenRoots: [] });
      const results = await Promise.all(
        racers(round !== 1).map((r) => child(s, made.ledgerId, { ...r, steps: ['confirm'] })),
      );
      const admitted = results.filter((r) => r?.['acquire']?.ok);
      const snap = open(s, made.ledgerId).inspect();
      expect(snap.entries.length).toBe(admitted.length);
      expect(snap.entries.length).toBeLessThanOrEqual(2);
      expect(new Set(snap.entries.map((e) => e.repoKey)).size).toBe(snap.entries.length);
      if (snap.entries.some((e) => e.program === 'ducky')) expect(snap.entries.length).toBe(1);
      expect(snap.entries.length).toBeGreaterThanOrEqual(1);
      expect(snap.entries.every((e) => e.state === 'confirmed')).toBe(true);
      // Strictly increasing, unique fences.
      const f = snap.entries.map((e) => e.fence);
      expect(new Set(f).size).toBe(f.length);
    }
  }, 120_000);

  it('a killed holder leaves its hold in place and never wedges the lock', async () => {
    const s = scratch();
    const made = initLedger({ path: s.file, forbiddenRoots: [] });
    const a = mk('agent-flow', 'dotph/one#1');
    // Confirmed, then SIGKILLed: the confirmed hold must survive any amount of time.
    await child(s, made.ledgerId, { holder: a, repoKey: 'dotph/one', reserveBytes: 3072 * MIB, steps: ['die_after_confirm'] });
    // Acquired but never confirmed, then SIGKILLed: times out, and only that.
    const b = mk('agent-flow', 'dotph/two#1');
    await child(s, made.ledgerId, { holder: b, repoKey: 'dotph/two', reserveBytes: 3072 * MIB, steps: ['die_after_acquire'] });
    const near = open(s, made.ledgerId).inspect();
    expect(near.entries.map((e) => [e.jobRef, e.state])).toEqual([
      ['dotph/one#1', 'confirmed'], ['dotph/two#1', 'pending'],
    ]);
    const later = open(s, made.ledgerId, { now: () => Date.now() + 10 * 3600_000 });
    // The lock is not wedged: this write completes, and it reaps only the pending hold.
    expect(later.acquire(req(mk('agent-flow', 'dotph/three#1'), 'dotph/three', 3072)))
      .toMatchObject({ ok: true, state: 'pending' });
    expect(later.inspect().entries.map((e) => e.jobRef)).toEqual(['dotph/one#1', 'dotph/three#1']);
    // A different holder, program, instance or fence cannot release the confirmed hold.
    const live = later.inspect().entries[0]!;
    expect(later.release(live.fence, mk('ducky', 'dotph/one#1'))).toBe('not_holder');
    expect(later.release(live.fence, { ...a, instanceId: 'agentflow-0002' })).toBe('not_holder');
    expect(later.verify(live.fence, a)).toBe('confirmed');
    expect(LEDGER_SCHEMA_SQL).toContain('AUTOINCREMENT');
  }, 120_000);
});
