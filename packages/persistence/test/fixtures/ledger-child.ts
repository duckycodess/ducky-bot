/**
 * A tiny participant for the cross-process ledger tests. Takes one JSON argument,
 * performs one ledger step and prints one JSON line. It is a local fixture: it
 * touches only the scratch ledger and cgroup directory it is handed and never
 * starts anything else.
 */
import { SharedLedger, observeAccountMemory } from '../../src/index.js';

const a = JSON.parse(process.argv[2] ?? '{}') as {
  path: string; ledgerId: string; cgroupDir: string; clockOffsetMs?: number;
  steps: ('acquire' | 'confirm' | 'die_after_acquire' | 'die_after_confirm')[];
  holder: { program: 'ducky' | 'agent-flow'; instanceId: string; jobRef: string };
  repoKey: string; reserveBytes: number;
};
const ledger = new SharedLedger({
  path: a.path,
  expectedLedgerId: a.ledgerId,
  forbiddenRoots: [],
  observe: () => observeAccountMemory(a.cgroupDir),
  now: () => Date.now() + (a.clockOffsetMs ?? 0),
});
const out: Record<string, unknown> = {};
const got = ledger.acquire({ holder: a.holder, repoKey: a.repoKey, reserveBytes: a.reserveBytes });
out['acquire'] = got;
if (got.ok && a.steps.includes('die_after_acquire')) process.kill(process.pid, 'SIGKILL');
if (got.ok && (a.steps.includes('confirm') || a.steps.includes('die_after_confirm'))) {
  out['confirm'] = ledger.confirm(got.fence, a.holder);
  if (a.steps.includes('die_after_confirm')) process.kill(process.pid, 'SIGKILL');
}
process.stdout.write(`${JSON.stringify(out)}\n`);
