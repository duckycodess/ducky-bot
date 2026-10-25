import { DuckyError } from '@ducky/contracts';

/**
 * What was durably recorded about the prompts handed to a job's agent.
 *
 * Whether an agent that reads `idle` is QUIET or merely has not picked its work
 * up yet is a fact about the past: a prompt was submitted and a turn was or was
 * not observed to settle. Remembering that in memory is not enough. After an
 * executor restart, a recovery claim, or any turn that replaces the in-memory
 * record, an idle reading with nothing recorded looks exactly like a finished
 * agent, and releasing a repository, a slot or a lock on it would put a second
 * writer beside a live one.
 *
 * So the rule is a journal, written BEFORE the fact it protects:
 *
 * - `dispatching` is recorded before every prompt attempt. If it cannot be
 *   recorded, the prompt is not sent.
 * - `settled` is recorded only after a settle was actually observed (or, for a
 *   freshly started agent, before any prompt could exist). If that write is
 *   lost the entry stays `dispatching`, which is the safe direction.
 *
 * Anything but a readable, matching, `settled` entry is NOT quiet proof:
 * absent, unreadable, mismatched, and `dispatching` all keep the holds. The
 * journal records ids and an enum, never terminal text, and says nothing about
 * why an agent stopped.
 */
export type DispatchState = 'dispatching' | 'settled';

export interface DispatchEntry {
  readonly jobId: string;
  /** The lease under which this entry was written. */
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly agentName: string;
  readonly state: DispatchState;
}

export type JournalRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'untrusted'; readonly reason: string }
  | { readonly kind: 'entry'; readonly entry: DispatchEntry };

export interface DispatchJournal {
  read(jobId: string): Promise<JournalRead>;
  /** Durable when it resolves. Throws `DispatchJournalError` when it could not be made so. */
  record(entry: DispatchEntry): Promise<void>;
}

/** The journal could not record, so the thing it guards was not done. */
export class DispatchJournalError extends DuckyError {
  constructor(message = 'The record of what was submitted to the agent could not be written.') {
    super('dispatch_journal_unavailable', message);
  }
}

/**
 * In-memory journal for tests and for a run with no durable store. It has the
 * journal's semantics (a read reflects the last write) but survives nothing, so
 * the production executor never uses it.
 */
export class MemoryDispatchJournal implements DispatchJournal {
  readonly entries = new Map<string, DispatchEntry>();
  readonly writes: DispatchEntry[] = [];
  /** Makes the next `record` calls fail, to exercise the fail-closed paths. */
  failRecords: ((entry: DispatchEntry) => boolean) | boolean = false;
  untrusted: string | undefined;

  seedSettled(entry: Omit<DispatchEntry, 'state' | 'leaseId'> & { leaseId?: string }): this {
    this.entries.set(entry.jobId, { leaseId: 'seed', ...entry, state: 'settled' });
    return this;
  }

  async read(jobId: string): Promise<JournalRead> {
    if (this.untrusted !== undefined) return { kind: 'untrusted', reason: this.untrusted };
    const entry = this.entries.get(jobId);
    return entry ? { kind: 'entry', entry } : { kind: 'absent' };
  }

  async record(entry: DispatchEntry): Promise<void> {
    const fail = typeof this.failRecords === 'function' ? this.failRecords(entry) : this.failRecords;
    if (fail) throw new DispatchJournalError();
    this.writes.push(entry);
    this.entries.set(entry.jobId, entry);
  }
}
