import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether the account's memory cgroup has room for one more engineering job.
 *
 * The remote account has ONE ceiling (the user slice) shared by Ducky, Herdr,
 * the provider, the agents and everything else the owner runs there. Admitting
 * a job into a nearly full slice is how an out-of-memory kill takes down a
 * neighbour -- including the coordinator that has to send the owner a
 * notification. So a claim is attempted only when the slice has room for the
 * engineering reserve AND the notification reserve.
 *
 * FAIL CLOSED. If any number cannot be read or understood, or the slice shows no
 * numeric ceiling at all, there is no proof of headroom and the answer is no.
 * "Probably fine" is not a reading.
 *
 * What this is not: it does not bound the agents. Herdr's server owns the
 * agent processes, outside the executor's own unit, so a user-unit MemoryMax on
 * the executor would not limit them. This reads the slice that contains both.
 * The reserves are operator-set estimates, not measurements of Pi's footprint.
 */
export interface HeadroomConfig {
  /** The user slice directory, e.g. /sys/fs/cgroup/user.slice/user-1000.slice */
  readonly cgroupDir: string;
  readonly engineeringReserveBytes: number;
  readonly notificationReserveBytes: number;
  /** The provider's own footprint on the host. Omitted means none is reserved. */
  readonly providerReserveBytes?: number;
}

export type HeadroomVerdict =
  | { readonly ok: true; readonly freeBytes: number; readonly requiredBytes: number }
  | { readonly ok: false; readonly reason: string };

export type ReadText = (file: string) => Promise<string>;

const readUtf8: ReadText = (file) => readFile(file, 'utf8');

/**
 * A plain non-negative decimal integer that is EXACT in a JavaScript number, or
 * undefined. Sixteen digits at most and then a safe-integer check, so a value
 * that would silently round (and make a free-bytes subtraction wrong) is not a
 * reading at all.
 */
const safeInt = (raw: string): number | undefined => {
  const t = raw.trim();
  if (!/^(0|[1-9]\d{0,15})$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * `max` is the kernel's literal word for "no limit"; it is the ONLY non-numeric
 * thing that means it. Anything else that is not an exact integer is INVALID,
 * which is a refusal -- never read as "unlimited" just because the other
 * ceiling happens to be valid.
 */
const limitOf = (raw: string): number | 'max' | 'invalid' => {
  if (raw.trim() === 'max') return 'max';
  return safeInt(raw) ?? 'invalid';
};

export const defaultCgroupDir = (uid: number): string =>
  `/sys/fs/cgroup/user.slice/user-${uid}.slice`;

export async function checkMemoryHeadroom(
  config: HeadroomConfig,
  read: ReadText = readUtf8,
): Promise<HeadroomVerdict> {
  const file = (name: string): string => path.join(config.cgroupDir, name);
  let rawCurrent: string;
  let rawMax: string;
  let rawHigh: string;
  try {
    [rawCurrent, rawMax, rawHigh] = await Promise.all([
      read(file('memory.current')),
      read(file('memory.max')),
      read(file('memory.high')),
    ]);
  } catch {
    return { ok: false, reason: 'the memory cgroup could not be read, so headroom is unproven' };
  }

  const current = safeInt(rawCurrent);
  if (current === undefined) {
    return { ok: false, reason: 'memory.current was not an exact integer, so headroom is unproven' };
  }
  const limits = [limitOf(rawMax), limitOf(rawHigh)];
  if (limits.includes('invalid')) {
    return { ok: false, reason: 'a memory limit was neither `max` nor an exact integer, so headroom is unproven' };
  }
  // MemoryHigh is a throttle point below MemoryMax, and the lower of the two is
  // the one a job will actually meet first.
  const ceilings = limits.filter((l): l is number => typeof l === 'number');
  if (ceilings.length === 0) {
    return { ok: false, reason: 'the slice shows no numeric memory limit, so headroom is unproven' };
  }

  const ceiling = Math.min(...ceilings);
  const reserves = [
    config.engineeringReserveBytes, config.notificationReserveBytes, config.providerReserveBytes ?? 0,
  ];
  const requiredBytes = reserves.reduce((a, b) => a + b, 0);
  if (!reserves.every((r) => Number.isSafeInteger(r) && r >= 0) || !Number.isSafeInteger(requiredBytes)) {
    return { ok: false, reason: 'the configured reserves were not exact non-negative integers' };
  }
  const freeBytes = ceiling - current;
  if (freeBytes < requiredBytes) {
    return {
      ok: false,
      reason:
        `${Math.floor(freeBytes / 2 ** 20)} MiB free of ${Math.floor(ceiling / 2 ** 20)} MiB, ` +
        `${Math.ceil(requiredBytes / 2 ** 20)} MiB needed (engineering, provider and notification reserves)`,
    };
  }
  return { ok: true, freeBytes, requiredBytes };
}
