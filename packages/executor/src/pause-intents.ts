import { z } from 'zod';
import {
  ExecutorIdSchema, JOB_PAUSE_CAUSES, JOB_PAUSE_QUIET_STATUSES, PAUSE_DELIVERY_PROTOCOL,
  PAUSE_REPORT_ID_RE, PUBLIC_JOB_ID_RE, leaseDigest, type PauseDispositionRequest,
  type PauseReportRequest,
} from '@ducky/contracts';
import { StateStoreError, type StateDir } from './state-store.js';

/**
 * A pause the executor OWES the coordinator: it proved its agent quiet and
 * result-less, and has not yet seen a terminal answer to the report.
 *
 * Written (fsynced) BEFORE the host writer lock is released and BEFORE anything
 * is sent, so a crash at any later point leaves the obligation on disk. It holds
 * ids and enums only. The lease id is the lease the pause was proved under; the
 * coordinator keeps only its digest.
 */
export const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const PauseIntentSchema = z.strictObject({
  v: z.literal(1),
  reportId: z.string().regex(PAUSE_REPORT_ID_RE),
  executorId: ExecutorIdSchema,
  jobId: z.string().regex(JOB_ID_RE),
  publicId: z.string().regex(PUBLIC_JOB_ID_RE),
  leaseId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(64),
  cause: z.enum(JOB_PAUSE_CAUSES),
  agentStatus: z.enum(JOB_PAUSE_QUIET_STATUSES),
});
export type PauseIntent = z.infer<typeof PauseIntentSchema>;

export interface PauseIntentListing {
  readonly intents: PauseIntent[];
  /** Reasons a record could not be trusted. Any entry here holds every claim. */
  readonly blocked: string[];
}

/** What the executor needs from its durable outbox. */
export interface PauseIntentStore {
  /** Durable when it returns. Throws when it could not be made so. Idempotent for the same report id. */
  write(intent: PauseIntent): void;
  list(): PauseIntentListing;
  /** Removes exactly this report; a record with a different report id is left alone. */
  remove(intent: PauseIntent): void;
}

export const reportBody = (i: PauseIntent, agentStatus: PauseIntent['agentStatus'] = i.agentStatus): PauseReportRequest => ({
  protocol: PAUSE_DELIVERY_PROTOCOL,
  reportId: i.reportId,
  leaseId: i.leaseId,
  cause: i.cause,
  workspaceId: i.workspaceId,
  agentName: i.agentName,
  agentStatus,
  quiescent: true,
});

export const dispositionBody = (i: PauseIntent): PauseDispositionRequest => ({
  protocol: PAUSE_DELIVERY_PROTOCOL,
  reportId: i.reportId,
  leaseDigest: leaseDigest(i.leaseId),
  cause: i.cause,
  workspaceId: i.workspaceId,
  agentName: i.agentName,
});

export class FilePauseIntentStore implements PauseIntentStore {
  constructor(private readonly dir: StateDir) {}

  write(intent: PauseIntent): void {
    const name = `${intent.jobId}.json`;
    const existing = this.dir.read(name, PauseIntentSchema);
    if (existing.kind === 'untrusted') throw new StateStoreError('An unreadable intent already exists for this job.');
    if (existing.kind === 'ok') {
      if (existing.value.reportId === intent.reportId) return;
      throw new StateStoreError('A different pause intent is already pending for this job.');
    }
    this.dir.write(name, PauseIntentSchema.parse(intent));
  }

  list(): PauseIntentListing {
    const l = this.dir.list(PauseIntentSchema);
    const intents: PauseIntent[] = [];
    const blocked = [...l.untrusted];
    for (const r of l.records) {
      // A record must live under its own job id; anything else is not ours to trust.
      if (r.name === `${r.value.jobId}.json`) intents.push(r.value);
      else blocked.push(`${r.name}: name does not match its job`);
    }
    return { intents, blocked };
  }

  remove(intent: PauseIntent): void {
    const name = `${intent.jobId}.json`;
    const existing = this.dir.read(name, PauseIntentSchema);
    if (existing.kind === 'absent') return;
    if (existing.kind !== 'ok' || existing.value.reportId !== intent.reportId) {
      throw new StateStoreError('The pending intent is not the one that was acknowledged.');
    }
    this.dir.remove(name);
  }
}

/** In memory, for tests that do not need a disk. */
export class MemoryPauseIntentStore implements PauseIntentStore {
  readonly byJob = new Map<string, PauseIntent>();
  blocked: string[] = [];
  failWrites = false;

  write(intent: PauseIntent): void {
    if (this.failWrites) throw new StateStoreError('write failed');
    const existing = this.byJob.get(intent.jobId);
    if (existing && existing.reportId !== intent.reportId) throw new StateStoreError('different intent pending');
    this.byJob.set(intent.jobId, intent);
  }

  list(): PauseIntentListing {
    return { intents: [...this.byJob.values()], blocked: [...this.blocked] };
  }

  remove(intent: PauseIntent): void {
    if (this.byJob.get(intent.jobId)?.reportId === intent.reportId) this.byJob.delete(intent.jobId);
  }
}
