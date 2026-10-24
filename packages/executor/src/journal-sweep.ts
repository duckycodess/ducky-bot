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
  readonly pruned: number;
  readonly kept: number;
  readonly unanswered: number;
}

export async function sweepJournal(deps: SweepDeps, maxQueries = 64): Promise<SweepResult> {
  const ids = deps.journal.jobIds();
  if (ids === undefined) return { pruned: 0, kept: 0, unanswered: 0 };
  const owed = new Set(deps.intents.list().intents.map((i) => i.jobId));
  let pruned = 0;
  let kept = 0;
  let unanswered = 0;
  let queries = 0;
  for (const id of ids) {
    if (owed.has(id)) {
      kept += 1;
      continue;
    }
    if (queries >= maxQueries) break;
    queries += 1;
    try {
      const answer = await deps.client.jobStatus(id);
      if (answer.kind === 'gone' || isExecutorDone(answer.status.state)) {
        deps.journal.forget(id);
        pruned += 1;
      } else {
        kept += 1;
      }
    } catch (err) {
      unanswered += 1;
      // An outage or an old coordinator ends the sweep: every further query would fail too.
      if (err instanceof PauseDeliveryError && (err.kind === 'transport' || err.kind === 'version_skew' || err.kind === 'server')) break;
    }
  }
  if (pruned > 0) deps.log(`dispatch journal: dropped ${pruned} record(s) of jobs the coordinator confirms are finished`);
  return { pruned, kept, unanswered };
}
