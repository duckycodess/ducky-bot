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
