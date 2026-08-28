/**
 * The recorded OpenClaw contract, or the absence of one.
 *
 * This file is the single fact that decides whether the HTTP provider may serve
 * production traffic. It is `null` because nothing has been recorded: OpenClaw
 * is not installed on this host, `pnpm probe:openclaw` exits 2 rather than
 * guessing, and `openclaw.fixtures/` does not exist.
 *
 * Deliberately a source constant rather than an environment variable. An
 * operator can set a variable; an operator cannot conjure a recorded
 * request/response shape, an auth model, or a set of attachment limits. Making
 * `verified` settable from configuration would reintroduce exactly the failure
 * this replaced -- a production instance believing it had a real backend
 * because somebody typed a flag.
 *
 * To fill it in, in this order:
 *   1. install OpenClaw deliberately (a host-wide mutation, needs approval);
 *   2. run `pnpm probe:openclaw` and record real fixtures;
 *   3. pin zod schemas against those fixtures and implement `reply()`;
 *   4. record the ATTACHMENT contract too -- flipping `verified` also opens the
 *      2C attachment gate, so an over-claim there is the one that matters;
 *   5. set this to the contract version the fixtures represent.
 */
export const RECORDED_CONTRACT_VERSION: string | null = null;
