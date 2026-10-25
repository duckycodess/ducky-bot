/**
 * A tiny participant for the cross-process ledger tests. Takes one JSON argument,
 * performs one ledger step and prints one JSON line. It is a local fixture: it
 * touches only the scratch ledger and cgroup directory it is handed and never
 * starts anything else.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SharedLedger, observeAccountMemory } from '../../src/index.js';

const a = JSON.parse(process.argv[2] ?? '{}') as {
  path: string; ledgerId: string; cgroupDir: string; clockOffsetMs?: number;
  steps: ('acquire' | 'confirm' | 'die_after_acquire' | 'die_after_confirm')[];
  holder: { program: 'ducky' | 'agent-flow'; instanceId: string; jobRef: string };
  repoKey: string; reserveBytes: number;
  /** A concurrent READER mode: check as fast as possible for this many ms. */
  loopMs?: number;
  /** Deterministic barrier: pause at `point`, announce `announce`, resume once `until` exists. */
  barrier?: { dir: string; point: 'afterCommit' | 'beforeWitnessWrite'; announce: string; until: string };
};
const pauseAt = (point: 'afterCommit' | 'beforeWitnessWrite'): (() => void) | undefined => {
  const b = a.barrier;
  if (!b || b.point !== point) return undefined;
  return () => {
    writeFileSync(path.join(b.dir, b.announce), 'x');
    const deadline = Date.now() + 30_000;
    while (!existsSync(path.join(b.dir, b.until)) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  };
};
const ledger = new SharedLedger({
  path: a.path,
  expectedLedgerId: a.ledgerId,
  forbiddenRoots: [],
  observe: () => observeAccountMemory(a.cgroupDir),
  now: () => Date.now() + (a.clockOffsetMs ?? 0),
  hooks: {
    ...(pauseAt('afterCommit') ? { afterCommit: pauseAt('afterCommit')! } : {}),
    ...(pauseAt('beforeWitnessWrite') ? { beforeWitnessWrite: pauseAt('beforeWitnessWrite')! } : {}),
  },
});
const out: Record<string, unknown> = {};
if (a.loopMs) {
  // A concurrent READER: check the ledger as fast as it can for a while, and report every refusal.
  const reasons: Record<string, number> = {};
  const until = Date.now() + a.loopMs;
  let n = 0;
  while (Date.now() < until) {
    const c = ledger.check();
    n += 1;
    if (!c.ok) { const k = `${c.reason}: ${(c as { detail?: string }).detail ?? ""}`; reasons[k] = (reasons[k] ?? 0) + 1; }
  }
  process.stdout.write(`${JSON.stringify({ checks: n, reasons })}\n`);
  process.exit(0);
}
const got = ledger.acquire({ holder: a.holder, repoKey: a.repoKey, reserveBytes: a.reserveBytes });
out['acquire'] = got;
if (got.ok && a.steps.includes('die_after_acquire')) process.kill(process.pid, 'SIGKILL');
if (got.ok && (a.steps.includes('confirm') || a.steps.includes('die_after_confirm'))) {
  out['confirm'] = ledger.confirm(got.fence, a.holder);
  if (a.steps.includes('die_after_confirm')) process.kill(process.pid, 'SIGKILL');
}
process.stdout.write(`${JSON.stringify(out)}\n`);
