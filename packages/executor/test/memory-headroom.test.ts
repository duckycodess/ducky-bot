import { describe, expect, it, vi } from 'vitest';
import { ExecutorLoop } from '../src/loop.js';
import { MockPiOrchestrator } from '@ducky/adapters';
import { checkMemoryHeadroom, defaultCgroupDir, type ReadText } from '../src/memory-headroom.js';

const MIB = 2 ** 20;
const GIB = 2 ** 30;

const config = {
  cgroupDir: '/cg/user-1000.slice',
  engineeringReserveBytes: 2 * GIB,
  notificationReserveBytes: 512 * MIB,
};

/** A fake cgroup directory: file name to contents, anything else is unreadable. */
const cgroup = (files: Record<string, string>): ReadText => async (file) => {
  const name = file.split('/').at(-1)!;
  const text = files[name];
  if (text === undefined) throw new Error('ENOENT');
  return `${text}\n`;
};

describe('memory headroom', () => {
  it('admits when the slice has room for both reserves', async () => {
    // The recorded host: MemoryMax 8 GiB, MemoryHigh 7 GiB. The lower one counts.
    const verdict = await checkMemoryHeadroom(
      config,
      cgroup({
        'memory.max': String(8589934592),
        'memory.high': String(7516192768),
        'memory.current': String(3 * GIB),
      }),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.freeBytes).toBe(7516192768 - 3 * GIB);
  });

  it('refuses when usage leaves less than the two reserves, measured from MemoryHigh', async () => {
    // 5 GiB used leaves 2 GiB below MemoryHigh, short of 2.5 GiB, although
    // 3 GiB remain below MemoryMax: the throttle point is what binds first.
    const verdict = await checkMemoryHeadroom(
      config,
      cgroup({
        'memory.max': String(8589934592),
        'memory.high': String(7516192768),
        'memory.current': String(5 * GIB),
      }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/needed/);
  });

  it('uses the one numeric limit when the other is "max"', async () => {
    const verdict = await checkMemoryHeadroom(
      config,
      cgroup({ 'memory.max': String(8 * GIB), 'memory.high': 'max', 'memory.current': String(1 * GIB) }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('fails closed when there is no numeric ceiling at all', async () => {
    const verdict = await checkMemoryHeadroom(
      config,
      cgroup({ 'memory.max': 'max', 'memory.high': 'max', 'memory.current': '1024' }),
    );
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/no numeric memory limit/) });
  });

  it('fails closed when the cgroup cannot be read', async () => {
    const verdict = await checkMemoryHeadroom(config, cgroup({}));
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read/) });
  });

  it('fails closed on a value it does not understand, and on one file missing', async () => {
    expect(
      await checkMemoryHeadroom(
        config,
        cgroup({ 'memory.max': String(8 * GIB), 'memory.high': 'max', 'memory.current': 'lots' }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await checkMemoryHeadroom(
        config,
        cgroup({ 'memory.max': String(8 * GIB), 'memory.current': String(1 * GIB) }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('points at the user slice for a uid', () => {
    expect(defaultCgroupDir(1000)).toBe('/sys/fs/cgroup/user.slice/user-1000.slice');
  });
});

describe('the executor loop and headroom', () => {
  const loopWith = (headroom: () => Promise<never>, claim = vi.fn(async () => undefined)) => {
    const log = vi.fn();
    const loop = new ExecutorLoop({
      client: { claim } as never,
      orchestrator: new MockPiOrchestrator(),
      pollWaitMs: 0,
      version: '0.1.0',
      headroom,
      log,
    });
    return { loop, claim, log };
  };

  it('attempts no claim, and says why once, while headroom is refused', async () => {
    const refuse = vi.fn(async () => ({ ok: false as const, reason: '1 MiB free' })) as never;
    const { loop, claim, log } = loopWith(refuse);

    expect(await loop.runOnce()).toBe('held');
    expect(await loop.runOnce()).toBe('held');

    expect(claim).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([l]) => /withheld/.test(String(l)))).toHaveLength(1);
  });

  it('claims again once headroom is back', async () => {
    let ok = false;
    const headroom = vi.fn(async () =>
      ok ? { ok: true as const, freeBytes: GIB, requiredBytes: MIB } : { ok: false as const, reason: 'full' },
    ) as never;
    const { loop, claim } = loopWith(headroom);

    expect(await loop.runOnce()).toBe('held');
    ok = true;
    expect(await loop.runOnce()).toBe('idle');
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
