import { randomUUID } from 'node:crypto';
import {
  RELEASE_FATAL, RELEASE_SETTLED, canonicalAdmissionRepoKey,
  type AdmissionHolder, type AdmissionRefusal, type SharedAdmissionLedgerPort,
} from '@ducky/contracts';
import type { JobRow, Store } from '@ducky/persistence';

/**
 * Ducky's side of the shared engineering admission (ADR 0031).
 *
 * The ledger is the cross-program fence; the coordinator's own
 * `engineering_admission` row stays the local fact and now records the exact
 * shared fence it stands on. The ordering that keeps this safe is one rule:
 *
 *     the shared hold is taken BEFORE the local one and given back AFTER it,
 *     so at every instant the ledger holds at least what this database holds.
 *
 * A crash can therefore leak a hold; it can never create capacity. Acquire and
 * CONFIRM both happen before the local claim commits, and a claim is returned
 * (or replayed) only after that, so nothing launches before confirm. A release
 * is a local outbox row written in the transaction that deletes the local slot,
 * and is delivered to the ledger only after that commit, by exact fence.
 *
 * Everything that is not clearly fine STOPS engineering with a plain reason: a
 * missing, replaced or re-policied ledger, a pin that no longer matches, a local
 * slot whose fence the ledger does not confirm (a restored database, a lost
 * ledger), a release the ledger refused. Nothing here re-pins, re-adopts or
 * re-acquires over possibly live work.
 */
export type SharedGate =
  | { readonly ok: true; readonly instanceId: string }
  | { readonly ok: false; readonly reason: string };

export type SharedGrant =
  | { readonly ok: true; readonly ledgerId: string; readonly fence: number; readonly created: boolean }
  | { readonly ok: false; readonly reason: AdmissionRefusal | 'repo_identity' | 'confirm_failed' };

export interface SharedAdmissionDeps {
  readonly store: Store;
  readonly ledger: SharedAdmissionLedgerPort;
  readonly expectedLedgerId: string;
  readonly expectedPolicyDigest: string;
  readonly executors: ReadonlySet<string>;
  readonly reserveBytes: number;
  /** Called when the stop reason changes (audit); never carries content. */
  readonly onStatus?: (status: { ok: boolean; reason: string }) => void;
}

const OUTBOX_BATCH = 20;
/** Past this many failed deliveries a release is a stuck debt, and engineering stops. */
const OUTBOX_MAX_ATTEMPTS = 100;
/** A fence the local slot still stands on cannot also be owed: contradictory, so a stop. */
const OUTBOX_FATAL = [...RELEASE_FATAL, 'local_still_holds'] as const;

export class SharedAdmissionService {
  private lastReason: string | undefined;

  constructor(private readonly deps: SharedAdmissionDeps) {}

  /** Shared-mode claims go only to executors on the ledger's host. */
  executorAllowed(executorId: string): boolean {
    return this.deps.executors.has(executorId);
  }

  private stop(reason: string): SharedGate {
    this.note(false, reason);
    return { ok: false, reason };
  }

  private note(ok: boolean, reason: string): void {
    const key = ok ? 'ok' : reason;
    if (key === this.lastReason) return;
    this.lastReason = key;
    this.deps.onStatus?.({ ok, reason: key });
  }

  /** The last reason engineering was stopped, or undefined while it is not. */
  stoppedBecause(): string | undefined {
    return this.lastReason && this.lastReason !== 'ok' ? this.lastReason : undefined;
  }

  /**
   * Whether engineering may admit right now. Read fresh each time and never
   * cached: the ledger, its pins, this database's slot and any refused release
   * are all re-checked, because each can change between two claims.
   */
  gate(): SharedGate {
    const { store, ledger } = this.deps;
    const checked = ledger.check();
    if (!checked.ok) return this.stop(`ledger_${checked.reason}`);
    if (checked.ledgerId !== this.deps.expectedLedgerId) return this.stop('ledger_identity_differs_from_pin');
    if (checked.policyDigest !== this.deps.expectedPolicyDigest) return this.stop('ledger_policy_differs_from_pin');

    let binding = store.jobs.sharedBinding();
    if (!binding) {
      // First use under an explicit eligibility gate and an operator-supplied pin.
      // Never reached again: a changed ledger later is a stop, not a re-pin.
      try {
        store.jobs.bindShared(randomUUID(), checked.ledgerId, checked.policyDigest);
      } catch {
        return this.stop('binding_unwritable');
      }
      binding = store.jobs.sharedBinding();
      if (!binding) return this.stop('binding_unwritable');
    }
    if (binding.ledgerId !== checked.ledgerId || binding.policyDigest !== checked.policyDigest) {
      return this.stop('binding_differs_from_ledger');
    }

    if (store.jobs.outboxStuck(checked.ledgerId, OUTBOX_FATAL, OUTBOX_MAX_ATTEMPTS)) {
      return this.stop('release_refused_by_ledger');
    }

    const slot = store.jobs.admission();
    if (slot) {
      if (slot.sharedFence === undefined || slot.sharedLedgerId === undefined) {
        // A local hold that never stood on a ledger fence cannot be covered by
        // one. The owner's /job cleanup releases it; nothing adopts it.
        return this.stop('local_hold_without_shared_fence');
      }
      if (slot.sharedLedgerId !== checked.ledgerId) return this.stop('slot_on_a_different_ledger');
      const seen = ledger.verify(slot.sharedFence, this.holder(binding.instanceId, slot.jobId));
      if (seen !== 'confirmed') return this.stop(`slot_fence_${seen}`);
    }
    this.note(true, 'ok');
    return { ok: true, instanceId: binding.instanceId };
  }

  private holder(instanceId: string, jobId: string): AdmissionHolder {
    return { program: 'ducky', instanceId, jobRef: jobId };
  }

  /**
   * Takes AND confirms the shared hold for a job, or refuses. `resumeFence` is
   * the fence this database's own slot already stands on (a reclaim of the same
   * attempt); nothing else is ever adopted by name.
   *
   * Returns before the local claim commits, so the confirm precedes any launch.
   * `created` marks a fence this call minted, the only kind it may give back.
   */
  acquire(job: JobRow, githubRepo: string | undefined, instanceId: string, resumeFence?: number): SharedGrant {
    const repoKey = githubRepo === undefined ? undefined : canonicalAdmissionRepoKey(githubRepo);
    if (!repoKey) return { ok: false, reason: 'repo_identity' };
    const holder = this.holder(instanceId, job.id);
    const got = this.deps.ledger.acquire({
      holder, repoKey, reserveBytes: this.deps.reserveBytes,
      ...(resumeFence === undefined ? {} : { resumeFence }),
    });
    if (!got.ok) return { ok: false, reason: got.reason };
    if (got.state === 'pending') {
      const confirmed = this.deps.ledger.confirm(got.fence, holder);
      if (!confirmed.ok) {
        // Nothing has launched and this fence is new: give back exactly it.
        if (!got.adopted) this.deps.ledger.release(got.fence, holder);
        return { ok: false, reason: 'confirm_failed' };
      }
    }
    return { ok: true, ledgerId: this.deps.expectedLedgerId, fence: got.fence, created: !got.adopted };
  }

  /**
   * Gives back a fence this call minted, after a LOCAL failure, and only when
   * this database's slot does not stand on it. A fence that was already live
   * (adopted) is never touched, and any doubt leaves it held.
   */
  giveBackCreated(job: JobRow, instanceId: string, grant: Extract<SharedGrant, { ok: true }>): void {
    if (!grant.created) return;
    if (this.deps.store.db.isTransaction) return; // held is safe; a release inside one is not
    if (this.deps.store.jobs.localHoldsFence(grant.ledgerId, grant.fence)) return;
    this.deps.ledger.release(grant.fence, this.holder(instanceId, job.id));
  }

  /** A replayed claim is served only while its job still stands on a confirmed fence. */
  slotConfirmed(jobId: string): boolean {
    const slot = this.deps.store.jobs.admission();
    const binding = this.deps.store.jobs.sharedBinding();
    if (!slot || !binding || slot.jobId !== jobId || slot.sharedFence === undefined) return false;
    return this.deps.ledger.verify(slot.sharedFence, this.holder(binding.instanceId, jobId)) === 'confirmed';
  }

  /**
   * Delivers owed releases, oldest first, bounded. Each names the exact ledger,
   * fence and holder that were released locally. An outcome that finishes the
   * delivery (`released`, or `gone` for an exact replay) forgets the row; any
   * other keeps it, and a refusal stops engineering (see `gate`).
   */
  drain(): { delivered: number; kept: number } {
    const { store, ledger } = this.deps;
    // ENFORCED, not just documented: a release delivered from inside a local
    // transaction could be undone by a rollback that leaves the ledger freed
    // while this database still stands on the fence. Only after a commit.
    if (store.db.isTransaction) return { delivered: 0, kept: 0 };
    const binding = store.jobs.sharedBinding();
    if (!binding) return { delivered: 0, kept: 0 };
    let delivered = 0;
    let kept = 0;
    for (const row of store.jobs.outboxPending(OUTBOX_BATCH)) {
      if (row.ledgerId !== binding.ledgerId) {
        store.jobs.outboxAttempted(row.id, 'ledger_mismatch');
        kept += 1;
        continue;
      }
      // A fence this database's slot still stands on is never released from here.
      if (store.jobs.localHoldsFence(row.ledgerId, row.fence)) {
        store.jobs.outboxAttempted(row.id, 'local_still_holds');
        kept += 1;
        continue;
      }
      const out = ledger.release(row.fence, this.holder(binding.instanceId, row.jobId));
      if ((RELEASE_SETTLED as readonly string[]).includes(out)) {
        store.jobs.outboxSettle(row.id);
        delivered += 1;
      } else {
        store.jobs.outboxAttempted(row.id, out);
        kept += 1;
      }
    }
    return { delivered, kept };
  }
}
