import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ONE reading of the account's memory ceiling and use, taken while the shared
 * admission lock is held.
 *
 * It is the same fail-closed reading the executor's pre-claim guard makes (a
 * literal `max` is the only non-numeric value that means unlimited; anything
 * else that is not an exact integer is invalid and refuses), repeated here
 * because admission runs in the coordinator's process, under the ledger lock,
 * and has to see the number at that instant. The Agent Flow companion makes the
 * identical reading in Python against the same files.
 *
 * It is a reading at one instant. It is not a kernel reservation and not
 * continuous enforcement, and it says nothing about tasks or PIDs.
 */
export type MemoryObservation =
  | { readonly ok: true; readonly limitBytes: number; readonly currentBytes: number }
  | { readonly ok: false; readonly detail: string };

export type MemoryObserver = () => MemoryObservation;

export type ReadTextSync = (file: string) => string;

const safeInt = (raw: string): number | undefined => {
  const t = raw.trim();
  if (!/^(0|[1-9]\d{0,15})$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
};

export const defaultAccountCgroupDir = (uid: number): string =>
  `/sys/fs/cgroup/user.slice/user-${uid}.slice`;

export function observeAccountMemory(
  cgroupDir: string,
  read: ReadTextSync = (f) => readFileSync(f, 'utf8'),
): MemoryObservation {
  if (!path.isAbsolute(cgroupDir)) return { ok: false, detail: 'cgroup directory is not absolute' };
  let rawCurrent: string;
  let rawMax: string;
  let rawHigh: string;
  try {
    rawCurrent = read(path.join(cgroupDir, 'memory.current'));
    rawMax = read(path.join(cgroupDir, 'memory.max'));
    rawHigh = read(path.join(cgroupDir, 'memory.high'));
  } catch {
    return { ok: false, detail: 'a memory file could not be read' };
  }
  const currentBytes = safeInt(rawCurrent);
  if (currentBytes === undefined) return { ok: false, detail: 'memory.current is not an exact integer' };
  const limits: number[] = [];
  for (const [name, raw] of [['memory.max', rawMax], ['memory.high', rawHigh]] as const) {
    if (raw.trim() === 'max') continue;
    const n = safeInt(raw);
    if (n === undefined) return { ok: false, detail: `${name} is neither max nor an exact integer` };
    limits.push(n);
  }
  if (limits.length === 0) return { ok: false, detail: 'the slice shows no numeric ceiling' };
  return { ok: true, limitBytes: Math.min(...limits), currentBytes };
}
