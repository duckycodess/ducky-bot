/**
 * The recorded OpenClaw contract.
 *
 * This file is the single fact that decides whether the gateway provider may
 * serve production traffic, and it is now SET -- because both halves have been
 * observed against the pinned install, not because anybody decided it was time.
 *
 * Recorded by `pnpm probe:openclaw` into `openclaw.fixtures/`:
 *
 *   * the CLI version and command surface;
 *   * the agent-turn REQUEST, as the argv that was actually exercised:
 *     `--dev --no-color agent --local --json --session-key <key>
 *      --message-file <path>`;
 *   * the transport: a WebSocket gateway with `loopback|lan|tailnet|auto|custom`
 *     bind modes and `none|token|password|trusted-proxy` auth modes;
 *   * the REPLY envelope, from a real successful turn:
 *     `{ payloads: [{ text, mediaUrl }], meta: {...} }`, recorded as a
 *     type-only shape so a model's answer never reaches a committed file;
 *   * that the turn carried no `deliveryStatus`, because `--deliver` was never
 *     passed;
 *   * that an agent turn has NO attachment input at all.
 *
 * The half that was missing for two milestones -- a successful reply -- was
 * blocked on model provider credentials. The owner signed in with a
 * ChatGPT/Codex subscription (`models auth login --provider openai
 * --device-code`, under `--dev`), the turn succeeded, and the probe exits 0.
 *
 * **No API key is involved and none is configured.** `models status` reports
 * `oauth=1, token=0, api_key=0`, and the runtime route is
 * `openai via codex ... status=usable`. Nothing in this repository reads
 * `OPENAI_API_KEY`.
 *
 * Deliberately a source constant rather than an environment variable. An
 * operator can set a variable; an operator cannot conjure a recorded
 * request/response shape. `GatewayOpenClawProvider.verified` is DERIVED from
 * this, so the two cannot drift.
 *
 * **What this does not license.** `capabilities.attachments` stays unavailable,
 * and being verified is precisely why that matters: `attachmentsUsable`
 * requires `verified` AND a declared capability, so this constant is now the
 * only thing standing between an over-claimed capability and the owner's
 * personal files leaving the host. The recorded turn takes text only.
 */
export const RECORDED_CONTRACT_VERSION: string | null = '2026.7.1-2';

/**
 * The recorded SESSION-DELETION contract, and why it is null.
 *
 * Same shape and same discipline as `RECORDED_CONTRACT_VERSION` above: a
 * source constant that an operator cannot set, derived from what a probe
 * actually observed. `GatewayOpenClawProvider.capabilities.sessionDeletion` is
 * DERIVED from it, so the capability and the evidence cannot drift.
 *
 * It is null because no such evidence exists. `pnpm probe:openclaw` now records
 * the deletion-capable command surface -- the flag and subcommand NAMES under
 * `sessions`, `transcripts` and `memory`, never a session value -- and that
 * recording is the first half. The second half is a verified narrow deletion
 * plus an INDEPENDENT readback proving the session is gone, and that has not
 * been performed: the pinned binary is not installed on the host this was
 * implemented from, so the probe could not run.
 *
 * Until both halves exist, `/forget` reports provider deletion as unsupported
 * and rotates the session epoch instead. Rotation orphans the old session; it
 * does not erase it. Saying otherwise would be the one thing a deletion path
 * must never do.
 *
 * Note that this is not merely a missing probe run. `ALWAYS_FORBIDDEN_COMMAND_VERBS`
 * refuses `rm`, `destroy`, `purge` and `drop` in any argv this system builds,
 * and that list is not going to be relaxed to make a deletion possible. If the
 * supported surface turns out to need one of those verbs, the honest answer
 * stays "unsupported".
 */
export const RECORDED_SESSION_DELETION: string | null = null;
