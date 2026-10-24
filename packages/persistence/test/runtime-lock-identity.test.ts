import { describe, expect, it } from 'vitest';
import { RUNTIME_LOCK_STALE_MS } from '@ducky/contracts';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { acquireRuntimeLock, readBootId, readProcessStart } from '../src/runtime-lock.js';

/**
 * A pid is not an identity. The lock records the boot and the process start, so
 * a reused pid, a reboot and a second handle in the same process are all judged
 * on what they are, not on whether "that number exists".
 */
const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return db;
};
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

/** A world where these processes exist and began at these moments. */
const world = (starts: Record<number, string>, alive: number[] = Object.keys(starts).map(Number)) => ({
  isPidAlive: (pid: number) => alive.includes(pid),
  startOf: (pid: number) => starts[pid],
});

describe('what makes a holder live on the same host', () => {
  it('recovers a lock whose pid has been REUSED by a different process', () => {
    const db = fresh();
    expect(acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) }).ok).toBe(true);
    // The coordinator died. Pid 100 now belongs to an unrelated process that began later.
    const next = acquireRuntimeLock(db, 'importer', { host: 'h', pid: 200, bootId: 'B1', ...world({ 100: 'start-Z', 200: 'start-B' }) });
    expect(next.ok).toBe(true);
  });

  it('refuses when the same pid really is the same process', () => {
    const db = fresh();
    acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) });
    expect(
      acquireRuntimeLock(db, 'importer', { host: 'h', pid: 200, bootId: 'B1', ...world({ 100: 'start-A', 200: 'start-B' }) }),
    ).toEqual({ ok: false, heldBy: 'coordinator' });
  });

  it('recovers a lock left by an EARLIER BOOT, even though its pid exists now', () => {
    const db = fresh();
    acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) });
    // After a reboot pid 100 is some other process entirely, and even if it had
    // the very same start token the boot differs.
    const next = acquireRuntimeLock(db, 'importer', { host: 'h', pid: 300, bootId: 'B2', ...world({ 100: 'start-A', 300: 'x' }) });
    expect(next.ok).toBe(true);
  });

  it('recovers a stale row that carries THIS process’s own pid from an earlier boot or start', () => {
    const db = fresh();
    acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) });
    // This process is pid 100 again, after a reboot.
    expect(acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B2', ...world({ 100: 'start-A' }) }).ok).toBe(true);
    // Or it is pid 100 in the same boot but a later incarnation.
    const db2 = fresh();
    acquireRuntimeLock(db2, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) });
    expect(acquireRuntimeLock(db2, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-B' }) }).ok).toBe(true);
  });

  it('refuses a second handle in the SAME live process, including the identical one', () => {
    const db = fresh();
    const opts = { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) };
    const first = acquireRuntimeLock(db, 'coordinator', opts);
    expect(first.ok).toBe(true);
    expect(acquireRuntimeLock(db, 'coordinator', opts)).toEqual({ ok: false, heldBy: 'coordinator' });
    expect(acquireRuntimeLock(db, 'importer', opts)).toEqual({ ok: false, heldBy: 'coordinator' });
    if (first.ok) expect(first.handle.held()).toBe(true);
  });

  it('recovers a holder whose process is gone', () => {
    const db = fresh();
    acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'a' }) });
    expect(acquireRuntimeLock(db, 'importer', { host: 'h', pid: 200, bootId: 'B1', ...world({ 200: 'b' }, [200]) }).ok).toBe(true);
  });

  it('stays conservative when identity is unknown: a live pid is a live holder', () => {
    const db = fresh();
    acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: undefined, isPidAlive: () => true, startOf: () => undefined });
    expect(
      acquireRuntimeLock(db, 'importer', { host: 'h', pid: 200, bootId: undefined, isPidAlive: () => true, startOf: () => undefined }),
    ).toEqual({ ok: false, heldBy: 'coordinator' });
  });
});

describe('another host', () => {
  it('refuses an EQUAL pid on a different host while the heartbeat is fresh, whatever the boot says', () => {
    const db = fresh();
    let now = T0;
    const clock = () => now;
    acquireRuntimeLock(db, 'coordinator', { host: 'h1', pid: 100, bootId: 'B1', nowMs: clock, ...world({ 100: 's' }) });
    now += 60_000;
    // Same pid, same START TOKEN, and a different boot: none of it means anything across hosts.
    expect(
      acquireRuntimeLock(db, 'importer', { host: 'h2', pid: 100, bootId: 'B2', nowMs: clock, ...world({ 100: 's' }) }),
    ).toEqual({ ok: false, heldBy: 'coordinator' });
  });

  it('recovers only once the heartbeat has gone stale', () => {
    const db = fresh();
    let now = T0;
    const clock = () => now;
    acquireRuntimeLock(db, 'coordinator', { host: 'h1', pid: 100, bootId: 'B1', nowMs: clock });
    now += RUNTIME_LOCK_STALE_MS - 1;
    expect(acquireRuntimeLock(db, 'importer', { host: 'h2', pid: 5, bootId: 'B2', nowMs: clock }).ok).toBe(false);
    now += 2;
    expect(acquireRuntimeLock(db, 'importer', { host: 'h2', pid: 5, bootId: 'B2', nowMs: clock }).ok).toBe(true);
  });
});

describe('the identity the lock records', () => {
  it('stores the boot and the process start it was taken under', () => {
    const db = fresh();
    acquireRuntimeLock(db, 'coordinator', { host: 'h', pid: 100, bootId: 'B1', ...world({ 100: 'start-A' }) });
    expect(db.prepare('SELECT boot_id, proc_start FROM runtime_lock').get()).toEqual({ boot_id: 'B1', proc_start: 'start-A' });
  });

  it.runIf(process.platform === 'linux')('reads this machine’s boot id and this process’s start from /proc', () => {
    expect(readBootId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(readProcessStart(process.pid)).toMatch(/^\d+$/);
    // Stable across two reads in one process, and unknown for a pid that does not exist.
    expect(readProcessStart(process.pid)).toBe(readProcessStart(process.pid));
    expect(readProcessStart(2 ** 22 + 12345)).toBeUndefined();
  });

  it.runIf(process.platform === 'linux')('refuses a second REAL handle from this very process', () => {
    const db = fresh();
    expect(acquireRuntimeLock(db, 'coordinator').ok).toBe(true);
    expect(acquireRuntimeLock(db, 'coordinator')).toEqual({ ok: false, heldBy: 'coordinator' });
  });
});
