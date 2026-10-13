import { ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS, ENGINEERING_ATTEMPT_BUDGET_MAX_MS } from '@ducky/contracts';

/**
 * The instant, in epoch milliseconds, at which a claimed attempt must stop.
 *
 * The coordinator is authoritative: when the claim carries a deadline it is
 * used, capped by a local ceiling so a corrupt or far-future value cannot
 * produce an unbounded run. When it carries none -- a coordinator from before
 * the field existed, during a rolling restart -- the executor applies the
 * default budget from NOW rather than running unbounded. An unparseable value
 * is treated as absent for the same reason.
 *
 * Both executor and coordinator run on the same host in the remote
 * arrangement, so the two clocks are one clock; across hosts, clock skew moves
 * the stop by the skew and the coordinator's own overdue sweep still bounds it.
 */
export function attemptDeadlineMs(claimDeadline: string | undefined, nowMs: number): number {
  const ceiling = nowMs + ENGINEERING_ATTEMPT_BUDGET_MAX_MS;
  const parsed = claimDeadline === undefined ? Number.NaN : Date.parse(claimDeadline);
  if (Number.isNaN(parsed)) return nowMs + ENGINEERING_ATTEMPT_BUDGET_DEFAULT_MS;
  return Math.min(parsed, ceiling);
}
