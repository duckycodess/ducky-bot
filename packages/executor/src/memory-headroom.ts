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
}

export type HeadroomVerdict =
  | { readonly ok: true; readonly freeBytes: number; readonly requiredBytes: number }
  | { readonly ok: false; readonly reason: string };

export type ReadText = (file: string) => Promise<string>;

const readUtf8: ReadText = (file) => readFile(file, 'utf8');

/** A plain non-negative integer, or undefined for `max`/anything else. */
const numeric = (raw: string): number | undefined => {
  const t = raw.trim();
  return /^\d{1,18}$/.test(t) ? Number(t) : undefined;
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

  const current = numeric(rawCurrent);
  if (current === undefined) {
    return { ok: false, reason: 'memory.current was not a number, so headroom is unproven' };
  }
  // `max` is the kernel's word for "no limit", so it is not a ceiling. MemoryHigh
  // is a throttle point below MemoryMax, and the lower of the two is the one a
  // job will actually meet first.
  const ceilings = [numeric(rawMax), numeric(rawHigh)].filter((n): n is number => n !== undefined);
  if (ceilings.length === 0) {
    return { ok: false, reason: 'the slice shows no numeric memory limit, so headroom is unproven' };
  }

  const ceiling = Math.min(...ceilings);
  const requiredBytes = config.engineeringReserveBytes + config.notificationReserveBytes;
  const freeBytes = ceiling - current;
  if (freeBytes < requiredBytes) {
    return {
      ok: false,
      reason:
        `${Math.floor(freeBytes / 2 ** 20)} MiB free of ${Math.floor(ceiling / 2 ** 20)} MiB, ` +
        `${Math.ceil(requiredBytes / 2 ** 20)} MiB needed (engineering plus notification reserve)`,
    };
  }
  return { ok: true, freeBytes, requiredBytes };
}
