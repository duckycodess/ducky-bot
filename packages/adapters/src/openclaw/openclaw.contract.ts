/**
 * The recorded OpenClaw contract, or the absence of one.
 *
 * This file is the single fact that decides whether the gateway provider may
 * serve production traffic. It is `null`, and the reason is now specific rather
 * than total: OpenClaw IS installed (pinned, into a dedicated local prefix) and
 * `pnpm probe:openclaw` has recorded HALF the contract into
 * `openclaw.fixtures/` --
 *
 *   * the CLI version and command surface;
 *   * the agent-turn REQUEST shape (`--message`, `--session-key`, `--json`, and
 *     `--deliver`, which Ducky must never pass);
 *   * the transport: a WebSocket gateway with `loopback|lan|tailnet|auto|custom`
 *     bind modes and `none|token|password|trusted-proxy` auth modes;
 *   * the auth model, observed by running a turn: `ProviderAuthError`, exit 1,
 *     empty stdout, diagnostics on stderr;
 *   * that an agent turn has NO attachment input at all.
 *
 * -- and cannot record the other half. A turn needs model provider credentials,
 * none are configured on this host, so no successful reply envelope has ever
 * been seen. Half a contract is not a contract: the probe exits 2, this stays
 * null, and `reply()` throws.
 *
 * Deliberately a source constant rather than an environment variable. An
 * operator can set a variable; an operator cannot conjure a recorded
 * request/response shape, an auth model, or a set of attachment limits. Making
 * `verified` settable from configuration would reintroduce exactly the failure
 * this replaced -- a production instance believing it had a real backend
 * because somebody typed a flag.
 *
 * To fill it in, in this order:
 *   1. configure a model provider for an OpenClaw agent (`openclaw agents add
 *      <id>`). This is the remaining blocker, and it is an OWNER action: it
 *      spends money on somebody's account, so nothing here does it;
 *   2. run `pnpm probe:openclaw` again. It records a reply envelope only if a
 *      turn actually succeeds, and exits 2 while one has not;
 *   3. pin zod schemas against the recorded envelope and implement `reply()`
 *      over the CLI contract (argv only, through `runArgv`, never a shell, and
 *      never `--deliver`);
 *   4. leave `capabilities.attachments` UNAVAILABLE regardless. The recorded
 *      agent turn takes text only, so claiming otherwise would be an over-claim
 *      on the gate that matters most;
 *   5. set this to the contract version the fixtures represent.
 */
export const RECORDED_CONTRACT_VERSION: string | null = null;
