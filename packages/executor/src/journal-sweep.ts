import { isExecutorDone } from '@ducky/contracts';
import { PauseDeliveryError, type CoordinatorClient } from './client.js';
import type { FileDispatchJournal } from './dispatch-journal-file.js';
import type { PauseIntentStore } from './pause-intents.js';

/**
 * Drops dispatch-journal entries whose job the COORDINATOR confirms nothing will
 * ever run again.
 *
 * The journal is what a later quiet proof rests on, so an entry is dropped only
 * when that cannot matter: the coordinator says the job is completed, failed,
 * cancelled or waiting for approval (which ends through the coordinator, never
 * through a turn), or does not know the job at all. Everything else is kept --
 * running, queued, waiting for an executor, paused for the owner or on a
 * dependency can all still be recovered, resumed or reconciled -- and so is any
 * entry whose job still has a pause owed, an entry the coordinator will not talk
 * about (another executor's, an old coordinator, an outage), and anything
 * unreadable. Nothing is aged out: a clock says nothing about whether a job is
 * live.
 */
export interface SweepDeps {
  readonly client: CoordinatorClient;
  readonly journal: FileDispatchJournal;
  readonly intents: PauseIntentStore;
  readonly log: (line: string) => void;
}

export interface SweepResult {
  /** Records the coordinator confirmed finished AND that were actually removed. */
  readonly pruned: number;
  /** Records the coordinator confirmed finished whose removal failed, so they are still there. */
  readonly removalFailed: number;
  readonly kept: number;
  readonly unanswered: number;
}

/**
 * Where the next sweep resumes. Ids are visited in sorted order starting just AFTER
 * the last one looked at, wrapping around, so a bounded sweep is fair: if the first
 * records are live and hundreds of later ones are finished, successive sweeps still
 * reach them instead of re-asking about the same first few forever.
 */
export interface SweepCursor {
  after: string | undefined;
}

export interface SweepOptions {
  /** The most coordinator queries one sweep may make. */
  readonly maxQueries?: number;
  /** Stop as soon as the journal has room for a new job (the capacity-time scan). */
  readonly stopWhenRoom?: boolean;
  readonly cursor?: SweepCursor;
}

export async function sweepJournal(deps: SweepDeps, opts: SweepOptions = {}): Promise<SweepResult> {
  const maxQueries = opts.maxQueries ?? 64;
  const cursor = opts.cursor ?? { after: undefined };
  const found = deps.journal.jobIds();
  if (found === undefined) return { pruned: 0, removalFailed: 0, kept: 0, unanswered: 0 };
  const sorted = [...found].sort();
  const start = cursor.after === undefined ? 0 : sorted.findIndex((id) => id > cursor.after!);
  const from = start === -1 ? 0 : start;
  const ids = [...sorted.slice(from), ...sorted.slice(0, from)];

  const owed = new Set(deps.intents.list().intents.map((i) => i.jobId));
  let pruned = 0;
  let removalFailed = 0;
  let kept = 0;
  let unanswered = 0;
  let queries = 0;
  for (const id of ids) {
    if (opts.stopWhenRoom === true && deps.journal.hasRoom()) break;
    if (owed.has(id)) {
      kept += 1;
      cursor.after = id;
      continue;
    }
    if (queries >= maxQueries) break;
    queries += 1;
    try {
      const answer = await deps.client.jobStatus(id);
      if (answer.kind === 'gone' || isExecutorDone(answer.status.state)) {
        if (deps.journal.forget(id)) pruned += 1;
        else removalFailed += 1;
      } else {
        kept += 1;
      }
      cursor.after = id;
    } catch (err) {
      unanswered += 1;
      cursor.after = id;
      // An outage or an old coordinator ends the sweep: every further query would fail too.
      if (err instanceof PauseDeliveryError && (err.kind === 'transport' || err.kind === 'version_skew' || err.kind === 'server')) break;
    }
  }
  if (pruned > 0) deps.log(`dispatch journal: dropped ${pruned} record(s) of jobs the coordinator confirms are finished`);
  if (removalFailed > 0) {
    deps.log(`dispatch journal: ${removalFailed} finished job record(s) could not be removed and were kept`);
  }
  return { pruned, removalFailed, kept, unanswered };
}
