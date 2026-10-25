#!/usr/bin/env tsx
/**
 * Operator tool for the host-local shared admission ledger (ADR 0031).
 *
 *   init     creates a NEW ledger (refuses if anything exists at the path) and
 *            prints its identity and policy digest, which every participant pins.
 *   inspect  read-only: the identity, the policy digest and every hold.
 *   release  frees ONE hold by exact ledger, fence and holder. It is the owner's
 *            explicit recovery for a hold that nothing else will ever clear, and
 *            it refuses unless the caller attests the worker is gone.
 *
 * Nothing here contacts a service, starts a process or reads a secret. A runtime
 * never calls `init`: a missing ledger stops engineering, it does not create one.
 */
import path from 'node:path';
import {
  SHARED_ADMISSION_DEFAULT_POLICY, ADMISSION_PROGRAMS, type AdmissionProgram,
} from '../packages/contracts/src/index.js';
import {
  SharedLedger, defaultAccountCgroupDir, initLedger, observeAccountMemory,
} from '../packages/persistence/src/index.js';

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i]!;
  if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) flags.set(a.slice(2), 'true');
  else { flags.set(a.slice(2), next); i += 1; }
}
const need = (name: string): string => {
  const v = flags.get(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};
const int = (name: string, fallback: number): number => {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  return Number(raw);
};

try {
  const file = path.resolve(need('path'));
  if (command === 'init') {
    const made = initLedger({
      path: file,
      policy: {
        globalCap: int('global-cap', SHARED_ADMISSION_DEFAULT_POLICY.globalCap),
        ceilingBytes: int('ceiling-mib', SHARED_ADMISSION_DEFAULT_POLICY.ceilingBytes / 1048576) * 1048576,
        notificationReserveBytes:
          int('notification-reserve-mib', SHARED_ADMISSION_DEFAULT_POLICY.notificationReserveBytes / 1048576) * 1048576,
        pendingTtlSeconds: int('pending-ttl-seconds', SHARED_ADMISSION_DEFAULT_POLICY.pendingTtlSeconds),
      },
    });
    process.stdout.write(`ledger created at ${file}\nledger_id=${made.ledgerId}\npolicy_digest=${made.policyDigest}\n`);
    process.stdout.write('Pin both in every participant. This creates no authority by itself: engineering stays off until the explicit eligibility gate is set.\n');
  } else if (command === 'inspect' || command === 'release') {
    const ledger = new SharedLedger({
      path: file,
      expectedLedgerId: need('ledger-id'),
      observe: () => observeAccountMemory(defaultAccountCgroupDir(process.getuid?.() ?? 0)),
    });
    if (command === 'inspect') {
      const snap = ledger.inspect();
      process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    } else {
      const program = need('program') as AdmissionProgram;
      if (!(ADMISSION_PROGRAMS as readonly string[]).includes(program)) throw new Error('--program must be ducky or agent-flow');
      if (flags.get('i-verified-no-worker-is-running') !== 'true') {
        throw new Error('refusing: pass --i-verified-no-worker-is-running once you have confirmed that no agent holds this reservation');
      }
      const fence = int('fence', 0);
      const out = ledger.release(fence, { program, instanceId: need('instance'), jobRef: need('job') });
      process.stdout.write(`release ${String(fence)}: ${out}\n`);
      if (out !== 'released' && out !== 'gone') process.exitCode = 3;
    }
  } else {
    throw new Error('usage: shared-admission <init|inspect|release> --path <file> [...]');
  }
} catch (err) {
  process.stderr.write(`shared-admission: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = process.exitCode || 1;
}
