import { describe, expect, it, vi } from 'vitest';
import { ExecutorLoop } from '../src/loop.js';
import { MockPiOrchestrator } from '@ducky/adapters';
import { checkMemoryHeadroom, defaultCgroupDir, type ReadText } from '../src/memory-headroom.js';
import { loadExecutorEnv } from '../src/config.js';

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

describe('provider reserve', () => {
  const MIB = 2 ** 20;
  const files = (current: number) => async (f: string) => {
    if (f.endsWith('memory.current')) return String(current);
    if (f.endsWith('memory.max')) return String(10 * 1024 * MIB);
    return 'max';
  };
  const base = { cgroupDir: '/x', engineeringReserveBytes: 2048 * MIB, notificationReserveBytes: 512 * MIB };

  it('is part of the required room when set, and absent (zero) when omitted', async () => {
    const used = 10 * 1024 * MIB - 2560 * MIB; // exactly engineering + notification free
    expect((await checkMemoryHeadroom(base, files(used))).ok).toBe(true);
    const verdict = await checkMemoryHeadroom({ ...base, providerReserveBytes: 512 * MIB }, files(used));
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toMatch(/3072 MiB needed/);
    expect((await checkMemoryHeadroom({ ...base, providerReserveBytes: 512 * MIB }, files(used - 512 * MIB))).ok).toBe(true);
  });
});

describe('executor memory configuration', () => {
  const BASE = {
    DUCKY_COORDINATOR_URL: 'http://127.0.0.1:8787',
    DUCKY_EXECUTOR_ID: 'exec-remote',
    DUCKY_EXECUTOR_KEY_ID: 'key-remote-1',
    DUCKY_EXECUTOR_TOKEN: 't'.repeat(20),
    DUCKY_EXECUTOR_HMAC_SECRET: 'h'.repeat(20),
  };

  it('defaults to the guard off with the documented operator-estimate reserves', () => {
    const env = loadExecutorEnv(BASE);
    expect(env.DUCKY_MEMORY_GUARD).toBe('off');
    expect(env.DUCKY_MEMORY_RESERVE_ENGINEERING_MIB).toBe(2048);
    expect(env.DUCKY_MEMORY_RESERVE_NOTIFICATIONS_MIB).toBe(512);
    expect(env.DUCKY_MEMORY_RESERVE_PROVIDER_MIB).toBe(512);
  });

  it('accepts an explicit provider reserve, including zero, and refuses a negative or fractional one', () => {
    expect(loadExecutorEnv({ ...BASE, DUCKY_MEMORY_RESERVE_PROVIDER_MIB: '0' }).DUCKY_MEMORY_RESERVE_PROVIDER_MIB).toBe(0);
    expect(loadExecutorEnv({ ...BASE, DUCKY_MEMORY_RESERVE_PROVIDER_MIB: '768' }).DUCKY_MEMORY_RESERVE_PROVIDER_MIB).toBe(768);
    expect(() => loadExecutorEnv({ ...BASE, DUCKY_MEMORY_RESERVE_PROVIDER_MIB: '-1' })).toThrow();
    expect(() => loadExecutorEnv({ ...BASE, DUCKY_MEMORY_RESERVE_PROVIDER_MIB: '1.5' })).toThrow();
  });
});

describe('the pre-claim parser never reads invalid as unlimited or unsafe as exact', () => {
  const MIB = 2 ** 20;
  const base = { cgroupDir: '/x', engineeringReserveBytes: 2048 * MIB, notificationReserveBytes: 512 * MIB };
  const slice = (v: { current?: string; max?: string; high?: string }) => async (f: string) => {
    if (f.endsWith('memory.current')) return v.current ?? '1048576';
    if (f.endsWith('memory.max')) return v.max ?? String(16 * 1024 * MIB);
    return v.high ?? 'max';
  };

  it('accepts the literal max (with its newline) beside a valid ceiling', async () => {
    expect((await checkMemoryHeadroom(base, slice({ max: 'max\n', high: String(16 * 1024 * MIB) }))).ok).toBe(true);
  });

  it('refuses a literal max beside a MALFORMED other ceiling instead of trusting the valid one', async () => {
    for (const bad of ['MAX', 'unlimited', '', '-1', '1e9', '0123', '1.5', '0x10', '12 34', 'maxx']) {
      const asHigh = await checkMemoryHeadroom(base, slice({ max: 'max', high: bad }));
      expect(asHigh.ok, `high=${JSON.stringify(bad)}`).toBe(false);
      const asMax = await checkMemoryHeadroom(base, slice({ max: bad, high: 'max' }));
      expect(asMax.ok, `max=${JSON.stringify(bad)}`).toBe(false);
      // Even beside a perfectly good ceiling, a malformed one is not skipped.
      const beside = await checkMemoryHeadroom(base, slice({ max: String(16 * 1024 * MIB), high: bad }));
      expect(beside.ok, `beside high=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('refuses an unsafe integer in either ceiling or in current, however many digits', async () => {
    for (const unsafe of ['9007199254740993', '123456789012345678', '99999999999999999999']) {
      expect((await checkMemoryHeadroom(base, slice({ max: unsafe }))).ok, `max=${unsafe}`).toBe(false);
      expect((await checkMemoryHeadroom(base, slice({ high: unsafe }))).ok, `high=${unsafe}`).toBe(false);
      expect((await checkMemoryHeadroom(base, slice({ current: unsafe }))).ok, `current=${unsafe}`).toBe(false);
    }
  });

  it('refuses a malformed memory.current', async () => {
    for (const bad of ['max', '-5', '', '1.0', 'NaN']) {
      expect((await checkMemoryHeadroom(base, slice({ current: bad }))).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses unsafe, negative, fractional or non-finite reserves and an unsafe sum', async () => {
    const read = slice({});
    const big = Number.MAX_SAFE_INTEGER;
    for (const reserves of [
      { engineeringReserveBytes: -1 },
      { engineeringReserveBytes: 1.5 },
      { notificationReserveBytes: Number.NaN },
      { notificationReserveBytes: Number.POSITIVE_INFINITY },
      { providerReserveBytes: -1 },
      { engineeringReserveBytes: big, notificationReserveBytes: 1 },
      { engineeringReserveBytes: big, notificationReserveBytes: big, providerReserveBytes: big },
    ]) {
      const v = await checkMemoryHeadroom({ ...base, ...reserves }, read);
      expect(v.ok, JSON.stringify(reserves)).toBe(false);
      expect(!v.ok && v.reason).toMatch(/reserves were not exact/);
    }
  });

  it('still answers a valid reading exactly at the boundary', async () => {
    const used = 16 * 1024 * MIB - 2560 * MIB;
    expect((await checkMemoryHeadroom(base, slice({ current: String(used) }))).ok).toBe(true);
    expect((await checkMemoryHeadroom(base, slice({ current: String(used + 1) }))).ok).toBe(false);
  });
});
