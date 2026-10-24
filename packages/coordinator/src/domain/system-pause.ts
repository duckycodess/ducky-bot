import { parseSystemPauseReason, type JobPauseCause } from '@ducky/contracts';
import type { JobRow, Store } from '@ducky/persistence';

/**
 * The system pause a job is CURRENTLY in, or undefined.
 *
 * Derived from the transition that put the job into `needs_owner_input`, and
 * only while it is still there, so a later move out (a resume, a cancellation)
 * can never leave a stale answer behind. Everything that would otherwise show a
 * previous round's question or result consults this first.
 */
export function activeSystemPause(
  store: Store,
  job: Pick<JobRow, 'id' | 'state'>,
): { cause: JobPauseCause; leaseDigest: string } | undefined {
  if (job.state !== 'needs_owner_input') return undefined;
  const reason = store.jobs.latestTransitionReasonInto(job.id, 'needs_owner_input');
  return reason === undefined ? undefined : parseSystemPauseReason(reason);
}
