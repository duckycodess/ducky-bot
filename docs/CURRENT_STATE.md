# Current state

What is actually true today. Phase 1, no deployment performed.

## Two Discord identities

`DUCKY_PROFILE` selects `development` or `production`. They share no token,
application id, guild, database, port or command scope, and neither falls back
to the other. Development may run token-less on the mock; production refuses to
start without its own credentials. The active profile is in the startup
diagnostics and in `/status`.

## Working end to end (against mock Discord and mock Pi)

- Owner-only Discord surface: `/capture`, `/inbox`, `/schedule`, `/job`
  (submit, status, cancel, answer, cleanup), `/jobs`, `/repo status`, `/status`
- Captures and inbox with per-row management
- Text and CSV schedule extraction → preview → correction modal → explicit
  confirm
- Job lifecycle: queue, claim, lease, heartbeat, result intake, cancellation
  (supervised mid-turn, acknowledged only once a stop is observed), owner-input
  rounds, per-repo reservations, durable workspace registration, crash
  recovery, reconciliation
- Per-action approvals, decided individually, recorded and **not executed**
- Proactive owner notifications on job lifecycle transitions (running,
  needs_owner_input, needs_approval, completed, failed, cancelled), with the
  same signed Answer/Approve/Reject components `/job status` offers — swept
  off the durable `job_transitions` ledger on the existing reconcile
  interval, **not pushed instantly**: delivery lags by up to one interval,
  and an upgrade backfills prior history as already delivered rather than
  replaying it
- Authenticated, signed, replay-resistant, rate-limited executor API
- Executor: outbound polling, fail-closed workspace resolution, single-writer
  lock, Herdr/Pi orchestration behind a port
- Read-only GitHub inspection through a frozen `gh` argv table
- Redaction at the transport boundary; no secret in the database or logs

## What "verified" means here

Three different things, and they are not interchangeable:

- **Verified against this host** — exercised for real, with recorded evidence.
- **Unit-tested only** — the logic is covered, but the external system it talks
  to has never been contacted. The real Discord payload path is in this
  category.
- **Unavailable** — the dependency is not installed or not probed, and the code
  says so at runtime rather than pretending.

## Verified against the live host

- SQLite behaviour (`node:sqlite`, WAL, partial unique indexes, triggers)
- Herdr `agent list`, `workspace list`, `workspace create`,
  `workspace report-metadata`, `pane split`, `worktree create` — recorded as
  fixtures by `pnpm probe:herdr` and parsed by the production schemas
- The `gh` read-only JSON surface
- Development Discord bot identity and configured guild REST access (HTTP 200)
- Development coordinator gateway startup on `127.0.0.1:8787`
- Seven development slash commands registered to the configured test guild
- Development executor authentication, polling, and liveness heartbeat

The probe caught a real detail: Herdr checks a linked worktree out under its own
directory, not inside the source repository, so the result file must be read
from the reported checkout path.

**Not probed:** `herdr agent start` and `agent prompt`, because exercising them
launches a real Pi agent. `HerdrPiOrchestrator.verified` is therefore `false`
and `/status` reports `experimental`.

## Mocked or unverified — stated plainly

| Area | Status |
|---|---|
| OpenClaw conversation | **Not installed on this host.** The HTTP provider throws rather than guessing an API; the mock provider answers and every reply is prefixed `[mock]`. |
| Image / PDF schedule extraction | **Unsupported.** Those uploads are refused before download. No decoder ships in Phase 1. |
| `herdr agent start` / `agent prompt` | **Not exercised.** Doing so starts a real Pi agent. The orchestrator is therefore `experimental`, not `verified`. |
| Real Discord gateway | The development bot successfully connected during a local smoke test, and the bot/guild REST checks returned HTTP 200. A human DM/slash-command interaction has not yet been exercised; Message Content intent must be enabled in the portal for message bodies. Proactive job notifications use this same path, so their delivery is still not verified by an owner-initiated live DM. |
| Slash-command registration | Development commands were deliberately registered to the configured test guild. Production remains unregistered; the default command-registration mode remains a dry run. |
| Interrupting a live Pi turn | Herdr exposes no verified way to interrupt one without risking a half-written edit, so cancellation aborts our wait *immediately* and then observes the agent. A still-working agent is reported honestly, the writer lock is retained, and the repository stays reserved for the owner. |
| Approved action execution | Deliberately absent. |
| Azure deployment | Documented only; nothing provisioned. |

## Deferred

Multi-user permissions; public bot; autonomous deployment; automatic GitHub or
Azure writes; arbitrary shell; browser automation; container sandboxing;
concurrent implementation writers; Tailscale provisioning.

## Verification

`pnpm typecheck`, `pnpm test`, `pnpm build` all pass. See
[TESTING.md](TESTING.md).
