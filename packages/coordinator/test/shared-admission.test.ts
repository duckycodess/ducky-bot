import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AdmissionHolder, type AdmissionReleaseOutcome, type AdmissionRequest, type SharedAdmissionLedgerPort,
} from '@ducky/contracts';
import { SharedLedger, initLedger, type MemoryObservation } from '@ducky/persistence';
import { Reconciler } from '../src/domain/reconciler.js';
import { EnvSchema, resolveEngineering, resolveSharedAdmission } from '../src/config.js';
import { implementedResult, makeHarness, REPOS_JSON } from './helpers.js';

const MIB = 1024 * 1024;
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * Ducky's side of the shared engineering admission over a REAL ledger file: the
 * claim, every release path, the crash windows and the stop conditions. Agent
 * Flow's holds are written to the same ledger through the protocol, exactly as
 * the dispatcher companion does. Nothing here starts an agent or a service.
 */

const REPOS = JSON.stringify({
  version: 1,
  repos: ['demo', 'other', 'third'].map((slug) => ({
    slug,
    absolutePath: `/tmp/ducky-${slug}`,
    defaultBranch: 'main',
    github: { owner: 'Acme', repo: slug },
    allowWorktree: true,
    allowBootstrap: true,
    bootstrapAllowedEntries: ['.git'],
    enabled: true,
  })),
});

const AF: AdmissionHolder = { program: 'agent-flow', instanceId: 'agentflow-0001', jobRef: 'acme/zzz#1' };
const af = (repoKey: string, jobRef = 'acme/zzz#1', mib = 3584): AdmissionRequest => ({
  holder: { ...AF, jobRef }, repoKey, reserveBytes: mib * MIB,
});

/** Delegates to the real ledger and lets a test make one operation misbehave. */
class Wrapped implements SharedAdmissionLedgerPort {
  failRelease: AdmissionReleaseOutcome | undefined;
  failAll = false;
  constructor(readonly inner: SharedLedger) {}
  check() { return this.failAll ? { ok: false as const, reason: 'unavailable' as const } : this.inner.check(); }
  acquire(r: AdmissionRequest) { return this.inner.acquire(r); }
  confirm(f: number, h: AdmissionHolder) { return this.inner.confirm(f, h); }
  release(f: number, h: AdmissionHolder) { return this.failRelease ?? this.inner.release(f, h); }
  verify(f: number, h: AdmissionHolder) { return this.inner.verify(f, h); }
}

interface Rig {
  dir: string; file: string; ledgerId: string; policyDigest: string;
  mem: { value: MemoryObservation };
  ledger: SharedLedger;
  wrapped: Wrapped;
}
const rig = (): Rig => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-shared-'));
  const file = path.join(dir, 'ledger.sqlite3');
  const made = initLedger({ path: file, forbiddenRoots: [] });
  const mem = { value: { ok: true, limitBytes: 14336 * MIB, currentBytes: 1024 * MIB } as MemoryObservation };
  const ledger = new SharedLedger({
    path: file, expectedLedgerId: made.ledgerId, expectedPolicyDigest: made.policyDigest,
    forbiddenRoots: [], observe: () => mem.value,
  });
  return { dir, file, ledgerId: made.ledgerId, policyDigest: made.policyDigest, mem, ledger, wrapped: new Wrapped(ledger) };
};

const shared = (r: Rig) => makeHarness({
  allowlistJson: REPOS,
  shared: { ledger: r.wrapped, ledgerId: r.ledgerId, policyDigest: r.policyDigest },
});
type H = ReturnType<typeof shared>;

const submit = (h: H, repoSlug: string) =>
  h.app.jobs.submit(h.owner, { repoSlug, task: `work on ${repoSlug}`, bootstrap: false });
const at = (h: H, when: Date) =>
  new Reconciler({ store: h.store, approvals: h.app.approvals, pending: { sweep: () => 0 } as never, now: () => when });
const future = (ms: number) => new Date(Date.now() + ms);
const REGISTRATION = {
  workspaceId: 'wX', label: 'ducky-mgd:demo', mode: 'direct' as const,
  agentName: 'ducky-pi-demo', workspacePath: '/tmp/ducky-demo',
};
const ducky = (r: Rig) => r.ledger.inspect().entries.filter((e) => e.program === 'ducky');

describe('a claim takes and confirms the shared hold before it is returned', () => {
  it('records the exact fence in the local slot and a confirmed ledger entry', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1');
    expect(c?.jobId).toBe(job.id);

    const entries = r.ledger.inspect().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      program: 'ducky', jobRef: job.id, repoKey: 'acme/demo', state: 'confirmed',
      reserveBytes: (2048 + 512) * MIB,
    });
    const slot = h.store.jobs.admission()!;
    expect(slot).toMatchObject({ jobId: job.id, sharedLedgerId: r.ledgerId, sharedFence: entries[0]!.fence });
    expect(h.store.jobs.sharedBinding()).toMatchObject({ ledgerId: r.ledgerId, policyDigest: r.policyDigest });
    h.close();
  });

  it('keys the hold on the canonical GitHub identity, not the local slug', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'other');
    h.app.jobs.claim(h.executorId, 'k1');
    expect(ducky(r)[0]?.repoKey).toBe('acme/other');
    h.close();
  });

  it('does not claim for a repository with no GitHub identity (fail closed)', () => {
    const r = rig();
    const h = makeHarness({
      shared: { ledger: r.wrapped, ledgerId: r.ledgerId, policyDigest: r.policyDigest },
    }); // the default allowlist has `other` with github: null
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 'x', bootstrap: false });
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    expect(h.store.jobs.byId(job.id)).toMatchObject({ state: 'queued', attempts: 0 });
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });
});

describe('contention leaves the job queued with its accounting unchanged', () => {
  const unchanged = (h: H, id: string) => {
    expect(h.store.jobs.byId(id)).toMatchObject({ state: 'queued', attempts: 0, attemptDeadlineAt: null });
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
  };

  it('is exclusive with ANY Agent Flow hold, on any repository', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    expect(r.ledger.acquire(af('dotph/elsewhere'))).toMatchObject({ ok: true });
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    unchanged(h, job.id);
    h.close();
  });

  it('refuses when Agent Flow holds the SAME repository under another spelling', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    r.ledger.acquire(af('acme/demo'));
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    unchanged(h, job.id);
    h.close();
  });

  it('then admits it once Agent Flow has released', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    const got = r.ledger.acquire(af('dotph/elsewhere'));
    if (!got.ok) throw new Error('setup');
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    expect(r.ledger.release(got.fence, AF)).toBe('released');
    expect(h.app.jobs.claim(h.executorId, 'k2')?.jobId).toBe(job.id);
    h.close();
  });

  it('keeps Agent Flow and a second Ducky profile out while it holds', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeDefined();
    expect(r.ledger.acquire(af('dotph/elsewhere'))).toMatchObject({ ok: false, reason: 'ducky_present' });
    expect(r.ledger.acquire({
      holder: { program: 'ducky', instanceId: 'ducky-prod-0002', jobRef: 'job-prod' },
      repoKey: 'acme/third', reserveBytes: 2560 * MIB,
    })).toMatchObject({ ok: false, reason: 'ducky_exclusive' });
    h.close();
  });

  it('refuses when the account does not have the memory, and changes nothing', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    r.mem.value = { ok: true, limitBytes: 14336 * MIB, currentBytes: 12000 * MIB };
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    unchanged(h, job.id);
    r.mem.value = { ok: false, detail: 'unreadable' };
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    unchanged(h, job.id);
    r.mem.value = { ok: true, limitBytes: 14336 * MIB, currentBytes: 1024 * MIB };
    expect(h.app.jobs.claim(h.executorId, 'k3')?.jobId).toBe(job.id);
    h.close();
  });

  it('leaves a deferred lease expiry uncharged while the ledger is stopped', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    const first = h.app.jobs.claim(h.executorId, 'k1', ['pause-delivery-v1'])!;
    h.app.jobs.registerWorkspace(h.executorId, first.jobId, first.leaseId, REGISTRATION);
    at(h, future(10 * 60_000)).expireLeases();
    const before = h.store.jobs.byId(job.id)!;
    expect(h.store.jobs.pendingExpiry(job.id)).toBeDefined();

    // The ledger cannot answer: the reclaim is refused BEFORE the charge.
    r.wrapped.failAll = true;
    expect(h.app.jobs.claim(h.executorId, 'k2', ['pause-delivery-v1'])).toBeUndefined();
    r.wrapped.failAll = false;
    expect(h.store.jobs.byId(job.id)!.attempts).toBe(before.attempts);
    expect(h.store.jobs.pendingExpiry(job.id)).toBeDefined();
    // Once it answers again the same attempt is reclaimed on the SAME fence.
    const fence = h.store.jobs.admission()!.sharedFence;
    expect(h.app.jobs.claim(h.executorId, 'k3', ['pause-delivery-v1'])?.jobId).toBe(job.id);
    expect(h.store.jobs.admission()!.sharedFence).toBe(fence);
    h.close();
  });
});

describe('shared mode is explicit and never falls back to the local slot', () => {
  it('holds engineering off when it is enabled but not shared-eligible', () => {
    const h = makeHarness({ allowlistJson: REPOS }); // local-only fixture: enabled
    h.close();
    // Without the test-only fixture flag, enabled alone does NOT run engineering.
    const env = EnvSchema.parse({ OWNER_DISCORD_USER_ID: '1', DUCKY_ENGINEERING_ENABLED: '1' });
    expect(resolveEngineering(env).enabled).toBe(true);
    expect(resolveSharedAdmission(env)).toBeUndefined();
  });

  it('refuses a configured-eligible runtime that is missing a pin, loudly', () => {
    const base = { OWNER_DISCORD_USER_ID: '1', DUCKY_SHARED_ADMISSION_ELIGIBLE: '1' };
    const ok = {
      ...base,
      DUCKY_SHARED_ADMISSION_PATH: '/home/u/.local/state/shared/ledger.sqlite3',
      DUCKY_SHARED_ADMISSION_LEDGER_ID: '5390fab6-a8e1-4f97-9694-3b4e50cfc532',
      DUCKY_SHARED_ADMISSION_POLICY_DIGEST: 'a'.repeat(64),
      DUCKY_SHARED_ADMISSION_EXECUTORS: 'exec-a, exec-b',
    };
    const cfg = resolveSharedAdmission(EnvSchema.parse(ok))!;
    expect([...cfg.executors]).toEqual(['exec-a', 'exec-b']);
    expect(cfg.reserveBytes).toBe((2048 + 512) * MIB);
    for (const drop of [
      'DUCKY_SHARED_ADMISSION_PATH', 'DUCKY_SHARED_ADMISSION_LEDGER_ID',
      'DUCKY_SHARED_ADMISSION_POLICY_DIGEST', 'DUCKY_SHARED_ADMISSION_EXECUTORS',
    ]) {
      const { [drop]: _gone, ...rest } = ok as Record<string, string>;
      expect(() => resolveSharedAdmission(EnvSchema.parse(rest)), drop).toThrow(drop);
    }
    expect(() => resolveSharedAdmission(EnvSchema.parse({ ...ok, DUCKY_SHARED_ADMISSION_PATH: 'relative.sqlite3' }))).toThrow(/absolute/);
    expect(() => resolveSharedAdmission(EnvSchema.parse({ ...ok, DUCKY_SHARED_ADMISSION_POLICY_DIGEST: 'xyz' }))).toThrow(/digest/);
    expect(() => resolveSharedAdmission(EnvSchema.parse({ ...ok, DUCKY_SHARED_ADMISSION_EXECUTORS: 'a b' }))).toThrow(/executor/);
  });

  it('the test-only local-admission switch is referenced by no production source', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mjs|js)$/.test(name) && !p.includes(`${path.sep}test${path.sep}`)) {
          if (readFileSync(p, 'utf8').includes('localOnlyAdmissionForTests')) offenders.push(path.relative(ROOT, p));
        }
      }
    };
    for (const pkg of ['packages', 'scripts']) walk(path.join(ROOT, pkg));
    // The composition root DECLARES and reads it; nothing else may set it.
    expect(offenders.sort()).toEqual(['packages/coordinator/src/app.ts']);
    const main = readFileSync(path.join(ROOT, 'packages/coordinator/src/main.ts'), 'utf8');
    expect(main).not.toMatch(/localOnlyAdmissionForTests/);
    expect(main).not.toMatch(/sharedAdmissionLedger/);
  });

  it('answers no claim for an executor that is not listed as co-located', () => {
    const r = rig();
    const h = makeHarness({
      allowlistJson: REPOS,
      shared: { ledger: r.wrapped, ledgerId: r.ledgerId, policyDigest: r.policyDigest, executors: 'some-other-exec' },
    });
    const job = submit(h, 'demo');
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    expect(h.store.jobs.byId(job.id)?.state).toBe('queued');
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });
});

describe('a missing, replaced or drifted ledger stops engineering', () => {
  it('never initializes a ledger itself and never claims without one', () => {
    const r = rig();
    const lost = new SharedLedger({
      path: path.join(r.dir, 'does-not-exist.sqlite3'), expectedLedgerId: r.ledgerId,
      expectedPolicyDigest: r.policyDigest, forbiddenRoots: [], observe: () => r.mem.value,
    });
    const h = makeHarness({
      allowlistJson: REPOS,
      shared: { ledger: lost, ledgerId: r.ledgerId, policyDigest: r.policyDigest },
    });
    const job = submit(h, 'demo');
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    expect(h.store.jobs.byId(job.id)?.state).toBe('queued');
    expect(h.app.sharedAdmission?.stoppedBecause()).toBe('ledger_unavailable');
    expect(h.store.jobs.sharedBinding()).toBeUndefined();
    expect(readdirSync(r.dir)).not.toContain('does-not-exist.sqlite3');
    h.close();
  });

  it('refuses a ledger of another identity: pinned, never adopted', () => {
    const r = rig();
    const other = rig();
    const wrongLedger = new SharedLedger({
      path: other.file, expectedLedgerId: r.ledgerId, expectedPolicyDigest: r.policyDigest,
      forbiddenRoots: [], observe: () => other.mem.value,
    });
    const h = makeHarness({
      allowlistJson: REPOS,
      shared: { ledger: wrongLedger, ledgerId: r.ledgerId, policyDigest: r.policyDigest },
    });
    submit(h, 'demo');
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    expect(h.app.sharedAdmission?.stoppedBecause()).toBe('ledger_ledger_mismatch');
    h.close();
  });

  it('stops when the database pin no longer matches the ledger (a restored or re-pinned database)', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeDefined();
    // A database whose pin is some other ledger, over the same configured pins.
    const stale = makeHarness({
      allowlistJson: REPOS,
      shared: { ledger: r.wrapped, ledgerId: r.ledgerId, policyDigest: r.policyDigest },
    });
    stale.store.db.exec('DROP TRIGGER shared_admission_binding_fixed_u');
    stale.store.db.exec(`INSERT INTO shared_admission_binding VALUES (1, 'instance-aaaa', 'old-ledger', 'old-digest', 'x')`);
    submit(stale, 'demo');
    expect(stale.app.jobs.claim(stale.executorId, 'k1')).toBeUndefined();
    expect(stale.app.sharedAdmission?.stoppedBecause()).toBe('binding_differs_from_ledger');
    stale.close();
    h.close();
  });

  it('stops when the ledger no longer confirms the fence this database stands on', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, REGISTRATION);
    const fence = h.store.jobs.admission()!.sharedFence!;
    // The hold vanishes from the ledger behind Ducky's back (a restored or
    // rewritten ledger, or an outside release).
    expect(r.ledger.release(fence, { program: 'ducky', instanceId: h.store.jobs.sharedBinding()!.instanceId, jobRef: first.id })).toBe('released');

    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(h.app.sharedAdmission?.stoppedBecause()).toBe('slot_fence_gone');
    // Not even the same job reclaims: nothing here manufactures a new authority.
    at(h, future(10 * 60_000)).expireLeases();
    expect(h.app.jobs.claim(h.executorId, 'k3')).toBeUndefined();
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });

  it('after a restore that lost the local slot, the surviving shared hold is a stop, not permission', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'k1');
    const fence = r.ledger.inspect().entries[0]!.fence;
    // The database as it was BEFORE the claim: the local slot is gone, the job is queued again.
    h.store.db.exec('DELETE FROM engineering_admission');
    h.store.db.exec(`DELETE FROM repo_reservations`);
    h.store.db.prepare(`UPDATE jobs SET state = 'queued', lease_id = NULL, lease_expires_at = NULL WHERE id = ?`).run(job.id);

    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(h.store.jobs.byId(job.id)?.state).toBe('queued');
    // The old hold is untouched and nothing acquired over it.
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([fence]);
    h.close();
  });

  it('stops when the ledger refuses a release it was handed', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    expect(h.store.jobs.byId(first.id)?.state).toBe('completed');
    expect(h.store.jobs.outboxOwes(first.id)).toBe(true);

    r.wrapped.failRelease = 'not_holder';
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined(); // drain tried, ledger refused
    expect(h.app.sharedAdmission?.stoppedBecause()).toBe('release_refused_by_ledger');
    // The refused row is KEPT, not forgotten.
    expect(h.store.jobs.outboxOwes(first.id)).toBe(true);
    h.close();
  });
});

describe('every release path goes through the committed outbox, by exact fence', () => {
  it('a terminal result releases locally at once and to the ledger after the commit', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    const second = submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    const fence = h.store.jobs.admission()!.sharedFence!;
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);

    expect(h.store.jobs.admission()).toBeUndefined();
    const owed = h.store.jobs.outboxPending(10);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ fence, jobId: first.id, ledgerId: r.ledgerId });
    // Not delivered yet: the ledger still holds it. A crash HERE leaks, never frees.
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([fence]);
    expect(r.ledger.acquire(af('dotph/elsewhere'))).toMatchObject({ ok: false, reason: 'ducky_present' });

    // The next claim (or tick) delivers it first, then admits the queued job.
    expect(h.app.jobs.claim(h.executorId, 'k2')?.jobId).toBe(second.id);
    expect(h.store.jobs.outboxPending(10)).toHaveLength(0);
    const now = r.ledger.inspect().entries;
    expect(now).toHaveLength(1);
    expect(now[0]!.fence).toBeGreaterThan(fence);
    h.close();
  });

  it('a restart between the local release and the delivery delivers it afterwards', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    expect(r.ledger.inspect().entries).toHaveLength(1);

    const restarted = makeHarness({
      store: h.store, allowlistJson: REPOS,
      shared: { ledger: r.wrapped, ledgerId: r.ledgerId, policyDigest: r.policyDigest },
    });
    expect(restarted.app.sharedAdmission?.drain()).toEqual({ delivered: 1, kept: 0 });
    expect(r.ledger.inspect().entries).toHaveLength(0);
    // Idempotent: a second drain has nothing, and nothing is released twice.
    expect(restarted.app.sharedAdmission?.drain()).toEqual({ delivered: 0, kept: 0 });
  });

  it('a pause releases the slot (and, after the commit, the hold) but keeps the repository', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which one?', proposedActions: [] }), 200,
    );
    expect(h.store.jobs.admission()).toBeUndefined();
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(first.id);
    expect(h.store.jobs.outboxOwes(first.id)).toBe(true);
    expect(h.app.sharedAdmission?.drain().delivered).toBe(1);
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });

  it('a delayed release of the old generation cannot free the job once it is resumed', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    const oldFence = h.store.jobs.admission()!.sharedFence!;
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which one?', proposedActions: [] }), 200,
    );
    // The pause's release is still undelivered when the owner answers.
    expect(h.store.jobs.outboxOwes(first.id)).toBe(true);
    h.app.jobs.submitOwnerInput(h.owner, first.publicId, 'that one');

    // A transient ledger fault on delivery: the resume is REFUSED, not adopted.
    r.wrapped.failRelease = 'unavailable';
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(h.store.jobs.byId(first.id)?.state).toBe('queued');
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([oldFence]);

    // Delivery works: old generation released, then a NEW fence is acquired.
    r.wrapped.failRelease = undefined;
    const again = h.app.jobs.claim(h.executorId, 'k3');
    expect(again?.jobId).toBe(first.id);
    const live = r.ledger.inspect().entries;
    expect(live).toHaveLength(1);
    expect(live[0]!.fence).toBeGreaterThan(oldFence);
    expect(h.store.jobs.admission()!.sharedFence).toBe(live[0]!.fence);

    // A replay of the old release changes nothing.
    expect(r.ledger.release(oldFence, { program: 'ducky', instanceId: h.store.jobs.sharedBinding()!.instanceId, jobRef: first.id })).toBe('gone');
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([live[0]!.fence]);
    h.close();
  });

  it('keeps the hold through lease expiry, and a reclaim stands on the same fence', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'k1');
    const fence = h.store.jobs.admission()!.sharedFence!;
    at(h, future(10 * 60_000)).expireLeases();

    expect(h.store.jobs.admission()).toMatchObject({ jobId: first.id, reason: 'unconfirmed_stop', sharedFence: fence });
    expect(h.store.jobs.outboxPending(10)).toHaveLength(0);
    expect(r.ledger.inspect().entries.map((e) => [e.fence, e.state])).toEqual([[fence, 'confirmed']]);
    expect(h.app.jobs.claim(h.executorId, 'k2')?.jobId).toBe(first.id);
    expect(h.store.jobs.admission()!.sharedFence).toBe(fence);
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([fence]);
    h.close();
  });

  it('keeps the hold for an orphan until the owner cleans up, then releases exactly it', () => {
    const r = rig();
    const h = shared(r);
    const first = submit(h, 'demo');
    const other = submit(h, 'other');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.reportFailure(h.executorId, c.jobId, c.leaseId, 'orphan_agent_still_working', {
      workspaceId: 'wX', agentName: 'ducky-pi-demo',
    });
    expect(h.store.jobs.outboxPending(10)).toHaveLength(0);
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeUndefined();
    expect(r.ledger.inspect().entries).toHaveLength(1);

    expect(h.app.jobs.cleanup(h.owner, first.publicId, false, 'absent').released).toBe(true);
    expect(h.store.jobs.outboxOwes(first.id)).toBe(true);
    expect(h.app.jobs.claim(h.executorId, 'k3')?.jobId).toBe(other.id);
    h.close();
  });

  it('cancelling a queued second job on a held repository releases nothing', () => {
    const r = rig();
    const h = shared(r);
    const running = submit(h, 'demo');
    const queued = submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'k1');
    const fence = h.store.jobs.admission()!.sharedFence!;
    h.app.jobs.requestCancel(h.owner, queued.publicId);
    expect(h.store.jobs.admission()).toMatchObject({ jobId: running.id, sharedFence: fence });
    expect(h.store.jobs.outboxPending(10)).toHaveLength(0);
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([fence]);
    h.close();
  });

  it('a duplicate terminal result releases nothing twice', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    try { h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500); } catch { /* answered or refused */ }
    expect(h.store.jobs.outboxPending(10)).toHaveLength(1);
    expect(h.app.sharedAdmission?.drain().delivered).toBe(1);
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });
});

describe('a local failure gives back only what this call minted', () => {
  it('releases a fence minted by a claim whose local half failed', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    const real = h.store.jobs.acquireAdmission.bind(h.store.jobs);
    h.store.jobs.acquireAdmission = () => false; // the race the local transaction can lose
    expect(() => h.app.jobs.claim(h.executorId, 'k1')).toThrow(/Another engineering job holds the slot/);
    expect(r.ledger.inspect().entries).toHaveLength(0);
    expect(h.store.jobs.admission()).toBeUndefined();
    h.store.jobs.acquireAdmission = real;
    expect(h.app.jobs.claim(h.executorId, 'k2')).toBeDefined();
    h.close();
  });

  it('never releases a fence the slot already stands on', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'k1');
    const fence = h.store.jobs.admission()!.sharedFence!;
    at(h, future(10 * 60_000)).expireLeases();
    h.store.jobs.acquireAdmission = () => false;
    expect(() => h.app.jobs.claim(h.executorId, 'k2')).toThrow();
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([fence]);
    h.close();
  });
});

describe('a replayed claim does not bypass the gate', () => {
  it('is served while the slot is confirmed and refused once the ledger stops', () => {
    const r = rig();
    const h = shared(r);
    submit(h, 'demo');
    const first = h.app.jobs.claim(h.executorId, 'same-key')!;
    expect(h.app.jobs.claim(h.executorId, 'same-key')).toEqual(first);
    r.wrapped.failAll = true;
    expect(h.app.jobs.claim(h.executorId, 'same-key')).toBeUndefined();
    r.wrapped.failAll = false;
    expect(h.app.jobs.claim(h.executorId, 'same-key')).toEqual(first);
    h.close();
  });
});

describe('the release delivery is enforced to follow a commit', () => {
  it('never frees the ledger from inside a local transaction, even if it is rolled back', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    h.app.jobs.claim(h.executorId, 'k1');
    const slotBefore = h.store.jobs.admission()!;

    h.store.db.exec('BEGIN IMMEDIATE');
    h.store.jobs.releaseAdmission(job.id);
    expect(h.store.jobs.outboxOwes(job.id)).toBe(true);
    // Refused while a transaction is open: nothing is delivered.
    expect(h.app.sharedAdmission?.drain()).toEqual({ delivered: 0, kept: 0 });
    expect(r.ledger.inspect().entries).toHaveLength(1);
    h.store.db.exec('ROLLBACK');

    // The rollback restored the local slot and discarded the debt; the ledger was never touched.
    expect(h.store.jobs.admission()).toMatchObject({ sharedFence: slotBefore.sharedFence });
    expect(h.store.jobs.outboxOwes(job.id)).toBe(false);
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([slotBefore.sharedFence]);
    h.close();
  });

  it('does not give back a minted fence from inside a transaction either', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    const instance = h.app.sharedAdmission!.gate();
    if (!instance.ok) throw new Error('setup');
    const grant = h.app.sharedAdmission!.acquire(h.store.jobs.byId(job.id)!, 'acme/demo', instance.instanceId);
    if (!grant.ok) throw new Error('setup');
    h.store.db.exec('BEGIN IMMEDIATE');
    h.app.sharedAdmission!.giveBackCreated(h.store.jobs.byId(job.id)!, instance.instanceId, grant);
    h.store.db.exec('ROLLBACK');
    expect(r.ledger.inspect().entries.map((e) => e.fence)).toEqual([grant.fence]);
    // Outside a transaction, with no local slot on it, the minted fence IS given back.
    h.app.sharedAdmission!.giveBackCreated(h.store.jobs.byId(job.id)!, instance.instanceId, grant);
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });
});

describe('a cached claim is only the current claim', () => {
  for (const mode of ['shared', 'local'] as const) {
    it(`is not replayed after a pause and resume gave the job a new lease (${mode})`, () => {
      const r = rig();
      const h = mode === 'shared' ? shared(r) : makeHarness({ allowlistJson: REPOS });
      const job = submit(h, 'demo');
      const first = h.app.jobs.claim(h.executorId, 'old-key')!;
      expect(h.app.jobs.claim(h.executorId, 'old-key')).toEqual(first);

      h.app.jobs.submitResult(
        h.executorId, first.jobId, first.leaseId,
        implementedResult({ verdict: 'needs_owner_input', question: 'which one?', proposedActions: [] }), 200,
      );
      // Paused: the job is not running, so the old claim must not launch anything.
      expect(h.app.jobs.claim(h.executorId, 'old-key')).toBeUndefined();

      h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'that one');
      const second = h.app.jobs.claim(h.executorId, 'new-key')!;
      expect(second.leaseId).not.toBe(first.leaseId);
      // Resumed under a NEW lease: the obsolete cache is still refused, the new one served.
      expect(h.app.jobs.claim(h.executorId, 'old-key')).toBeUndefined();
      expect(h.app.jobs.claim(h.executorId, 'new-key')).toEqual(second);
      // And another executor never gets this executor's cached claim.
      expect(h.app.jobs.claim('someone-else', 'new-key')).toBeUndefined();
      h.close();
    });
  }
});

describe('no release debt is hidden past a page', () => {
  const owe = (h: H, n: number, ledgerId: string, last: { outcome?: string; attempts?: number } = {}) => {
    const ins = h.store.db.prepare(
      `INSERT INTO shared_release_outbox (ledger_id, fence, job_id, created_at, attempts, last_outcome)
       VALUES (?, ?, ?, 'x', ?, ?)`,
    );
    for (let i = 1; i <= n; i += 1) {
      const last_ = i === n;
      ins.run(ledgerId, 1000 + i, `job-${i}`, last_ ? (last.attempts ?? 0) : 0, last_ ? (last.outcome ?? null) : null);
    }
  };

  it('stops on a refusal sitting behind 150 ordinary rows', () => {
    const r = rig();
    const h = shared(r);
    h.app.sharedAdmission!.gate(); // binds
    owe(h, 150, r.ledgerId, { outcome: 'not_holder' });
    expect(h.app.sharedAdmission!.gate()).toEqual({ ok: false, reason: 'release_refused_by_ledger' });
    h.close();
  });

  it('stops on a release retried past the attempt bound, and on a row of another ledger', () => {
    const r = rig();
    const h = shared(r);
    h.app.sharedAdmission!.gate();
    owe(h, 130, r.ledgerId, { attempts: 100 });
    expect(h.app.sharedAdmission!.gate()).toEqual({ ok: false, reason: 'release_refused_by_ledger' });
    h.close();
    const h2 = shared(rig());
    h2.app.sharedAdmission!.gate();
    owe(h2, 3, 'some-other-ledger');
    expect(h2.app.sharedAdmission!.gate().ok).toBe(false);
    h2.close();
  });

  it('keeps delivering the oldest rows, a bounded batch at a time, without losing any', () => {
    const r = rig();
    const h = shared(r);
    h.app.sharedAdmission!.gate();
    owe(h, 45, r.ledgerId);
    // Rows name fences the ledger never issued: 'unknown_fence' is refused and KEPT, never dropped.
    expect(h.app.sharedAdmission!.drain()).toEqual({ delivered: 0, kept: 20 });
    expect(h.store.jobs.outboxPending(100)).toHaveLength(45);
    h.close();
  });
});

describe('a missing prior fence is a stop at the Ducky layer too', () => {
  it('refuses a resume of a fence nothing stands on, rather than allocating anew', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    const gate = h.app.sharedAdmission!.gate();
    if (!gate.ok) throw new Error('setup');
    const row = h.store.jobs.byId(job.id)!;
    expect(h.app.sharedAdmission!.acquire(row, 'acme/demo', gate.instanceId, 999))
      .toEqual({ ok: false, reason: 'resume_fence_missing' });
    expect(r.ledger.inspect().entries).toHaveLength(0);
    h.close();
  });
});

describe('a stale copy of the same ledger does not admit Ducky past a live Agent Flow hold', () => {
  it('stops engineering when the ledger file went backwards, and admits nothing', () => {
    const r = rig();
    const h = shared(r);
    const job = submit(h, 'demo');
    const stale = path.join(r.dir, 'stale.sqlite3');
    copyFileSync(r.file, stale); // the empty ledger: same identity, same policy digest
    // Agent Flow takes and confirms a hold; its worker is alive.
    expect(r.ledger.acquire(af('dotph/elsewhere'))).toMatchObject({ ok: true });
    const live = r.ledger.inspect().entries[0]!;
    r.ledger.confirm(live.fence, AF);
    expect(r.ledger.verify(live.fence, AF)).toBe('confirmed');
    // The stale copy is put back over the live file.
    writeFileSync(r.file, readFileSync(stale));

    expect(h.app.jobs.claim(h.executorId, 'k1')).toBeUndefined();
    expect(h.app.sharedAdmission?.stoppedBecause()).toBe('ledger_ledger_mismatch');
    expect(h.store.jobs.byId(job.id)?.state).toBe('queued');
    expect(h.store.jobs.admission()).toBeUndefined();
    h.close();
  });
});
