import { z } from 'zod';
import {
  DispatchJournalError, type DispatchEntry, type DispatchJournal, type JournalRead,
} from '@ducky/adapters';
import { JOB_ID_RE } from './pause-intents.js';
import type { StateDir } from './state-store.js';

const EntrySchema = z.strictObject({
  v: z.literal(1),
  jobId: z.string().regex(JOB_ID_RE),
  leaseId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  agentName: z.string().min(1).max(64),
  state: z.enum(['dispatching', 'settled']),
});

/**
 * The durable dispatch journal (see `DispatchJournal`): one atomic record per
 * job in the executor's profile state directory. A write that cannot be made
 * durable throws, so the caller does not send the prompt it protects; a record
 * that cannot be trusted reads as untrusted, which is never quiet proof.
 */
export class FileDispatchJournal implements DispatchJournal {
  constructor(private readonly dir: StateDir) {}

  async read(jobId: string): Promise<JournalRead> {
    if (!JOB_ID_RE.test(jobId)) return { kind: 'untrusted', reason: 'invalid job id' };
    const r = this.dir.read(`${jobId}.json`, EntrySchema);
    if (r.kind === 'absent') return { kind: 'absent' };
    if (r.kind === 'untrusted') return { kind: 'untrusted', reason: r.reason };
    const { v: _v, ...entry } = r.value;
    if (entry.jobId !== jobId) return { kind: 'untrusted', reason: 'wrong job' };
    return { kind: 'entry', entry };
  }

  async record(entry: DispatchEntry): Promise<void> {
    if (!JOB_ID_RE.test(entry.jobId)) throw new DispatchJournalError();
    try {
      this.dir.write(`${entry.jobId}.json`, { v: 1, ...entry });
    } catch {
      throw new DispatchJournalError();
    }
  }

  get capacity(): number {
    return this.dir.capacity;
  }

  /** The job ids that have a record, or `undefined` when the directory cannot be listed. */
  jobIds(): string[] | undefined {
    try {
      return this.dir.names().map((n) => n.slice(0, -'.json'.length));
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a prompt for a job with NO record yet could still be journaled. An
   * unlistable directory counts as full: a prompt that cannot be recorded must not
   * be sent, and finding that out after an agent started is the failure to avoid.
   */
  hasRoom(): boolean {
    const ids = this.jobIds();
    return ids !== undefined && ids.length < this.capacity;
  }

  /** Room for THIS job's record: it already has one (an overwrite needs none), or there is a free slot. */
  hasRoomFor(jobId: string): boolean {
    const ids = this.jobIds();
    return ids !== undefined && (ids.includes(jobId) || ids.length < this.capacity);
  }

  /** Only for a job nothing will ever run again; its journal answers nothing more. */
  forget(jobId: string): boolean {
    if (!JOB_ID_RE.test(jobId)) return false;
    try {
      this.dir.remove(`${jobId}.json`);
      return true;
    } catch {
      // A kept record is harmless (it is bounded and is never trusted for another
      // job), but the caller must not count it as removed.
      return false;
    }
  }
}
