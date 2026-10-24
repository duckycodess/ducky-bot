import {
  isExecutorDone, isTerminalPauseDisposition, leaseDigest, type PauseDeliveryResponse,
} from '@ducky/contracts';
import { redact, type PiOrchestrator } from '@ducky/adapters';
import { PauseDeliveryError, type CoordinatorClient } from './client.js';
import { dispositionBody, reportBody, type PauseIntent, type PauseIntentStore } from './pause-intents.js';

/**
 * Settling a pause the executor owes: deliver it, learn what became of it, and
 * forget it only when the coordinator has answered for THAT report.
 *
 * What an executor may do with an intent, and when:
 * - forget it: only on a 2xx whose body validates against the disposition schema,
 *   echoes the intent's whole identity (profile's executor, job, original lease
 *   digest, workspace, agent, cause, report id) and carries a TERMINAL
 *   disposition -- `paused`, `overtaken_*` (a cancellation or the deadline won on
 *   the coordinator's clock) or `superseded` (the coordinator moved past that
 *   attempt and no hold is released by it);
 * - keep it, and hold every claim and prompt, on everything else: a transport
 *   failure, a 5xx, an unknown route (version skew), an unknown job, a mismatch,
 *   a refusal, a malformed 2xx, an identity that does not match, or `pending`
 *   with a proof that is not fresh and positive.
 *
 * Nothing here sends a prompt to an agent, starts work, or releases a hold.
 */
export interface SettleDeps {
  readonly client: CoordinatorClient;
  readonly intents: PauseIntentStore;
  readonly log: (line: string) => void;
  /** Drops the dispatch journal of a job the answer shows nothing will run again. */
  readonly forgetJournal?: (jobId: string) => void;
}

export type Settlement = 'resolved' | 'held';

/** True only when the coordinator's answer is about exactly this report. */
export function answersIntent(r: PauseDeliveryResponse, i: PauseIntent, executorId: string): boolean {
  return (
    r.reportId === i.reportId &&
    r.jobId === i.jobId &&
    r.executorId === executorId &&
    r.leaseDigest === leaseDigest(i.leaseId) &&
    r.workspaceId === i.workspaceId &&
    r.agentName === i.agentName &&
    r.cause === i.cause
  );
}

const why = (err: unknown): string =>
  err instanceof PauseDeliveryError
    ? `${err.kind}${err.status === undefined ? '' : ` ${err.status}`}`
    : redact((err as Error).message).slice(0, 120);

/** Applies an answer: forgets the intent on a matched terminal disposition, otherwise holds. */
export function applyAnswer(deps: SettleDeps, i: PauseIntent, r: PauseDeliveryResponse): Settlement {
  if (!answersIntent(r, i, deps.client.executorId)) {
    deps.log(`job ${i.publicId}: the coordinator's answer is not about this pause report; holding it`);
    return 'held';
  }
  if (!isTerminalPauseDisposition(r.disposition)) return 'held';
  try {
    deps.intents.remove(i);
  } catch {
    deps.log(`job ${i.publicId}: the pause was answered (${r.disposition}) but its record could not be removed; holding`);
    return 'held';
  }
  // Worded per answer. Only `paused` and the overtaken outcomes were decided on
  // THIS report; `superseded` says the coordinator had already moved past that
  // attempt (which may have been charged, resumed or ended) and this report
  // changed nothing.
  deps.log(
    r.disposition === 'superseded'
      ? `job ${i.publicId}: the coordinator had already moved past that attempt (job is ${r.state}); this report changed nothing`
      : r.disposition === 'paused'
        ? `job ${i.publicId}: paused for the owner on this report; no attempt was charged for it`
        : `job ${i.publicId}: ${r.disposition.replace(/_/g, ' ')} (job is ${r.state}); decided on this report`,
  );
  if (isExecutorDone(r.state)) deps.forgetJournal?.(i.jobId);
  return 'resolved';
}

/** Delivers an intent whose proof was just taken, in the run that produced it. */
export async function deliverFresh(deps: SettleDeps, i: PauseIntent): Promise<Settlement> {
  try {
    return applyAnswer(deps, i, await deps.client.pauseReport(i.jobId, reportBody(i)));
  } catch (err) {
    deps.log(`job ${i.publicId}: the pause report was not delivered (${why(err)}); it is kept and will be retried`);
    return 'held';
  }
}

/**
 * Reconciles an intent left from an earlier run or process.
 *
 * The coordinator is asked FIRST what became of the report, because a lost
 * response after a commit, an owner resume or a cancellation all leave a
 * terminal answer that needs no proof -- and demanding fresh proof first could
 * deadlock on an agent the owner has since resumed. Only a `pending` answer asks
 * for the report, and only with a FRESH, positive proof: historical quiet is not
 * quiet after a restart, so the exact agent is looked at again and the durable
 * dispatch journal must still say its last turn settled.
 */
export async function reconcileIntent(
  deps: SettleDeps & { readonly orchestrator: PiOrchestrator },
  i: PauseIntent,
): Promise<Settlement> {
  let answer: PauseDeliveryResponse;
  try {
    answer = await deps.client.pauseDisposition(i.jobId, dispositionBody(i));
  } catch (err) {
    deps.log(`job ${i.publicId}: could not learn what became of the pause (${why(err)}); holding`);
    return 'held';
  }
  if (!answersIntent(answer, i, deps.client.executorId)) {
    deps.log(`job ${i.publicId}: the coordinator's answer is not about this pause report; holding it`);
    return 'held';
  }
  if (isTerminalPauseDisposition(answer.disposition)) return applyAnswer(deps, i, answer);

  const proof = await deps.orchestrator.proveQuiet({
    jobId: i.jobId, workspaceId: i.workspaceId, agentName: i.agentName,
  });
  if (!proof.quiet) {
    deps.log(`job ${i.publicId}: the pause is still owed and the agent is not proven quiet now; holding (${redact(proof.detail).slice(0, 160)})`);
    return 'held';
  }
  try {
    return applyAnswer(
      deps,
      i,
      await deps.client.pauseReport(i.jobId, reportBody(i, proof.observed)),
    );
  } catch (err) {
    deps.log(`job ${i.publicId}: the pause report was not delivered (${why(err)}); holding`);
    return 'held';
  }
}
