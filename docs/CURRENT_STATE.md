# Current state

What is actually true today. Phase 1, no deployment performed.

## Working end to end (against mock Discord and mock Pi)

- Owner-only Discord surface: `/capture`, `/inbox`, `/schedule`, `/job`
  (submit, status, cancel, answer, cleanup), `/jobs`, `/repo status`, `/status`
- Captures and inbox with per-row management
- Text and CSV schedule extraction → editable preview → explicit confirm
- Job lifecycle: queue, claim, lease, heartbeat, result intake, cancellation,
  owner-input rounds, per-repo reservations, crash recovery, reconciliation
- Per-action approvals, decided individually, recorded and **not executed**
- Authenticated, signed, replay-resistant, rate-limited executor API
- Executor: outbound polling, fail-closed workspace resolution, single-writer
  lock, Herdr/Pi orchestration behind a port
- Read-only GitHub inspection through a frozen `gh` argv table
- Redaction at the transport boundary; no secret in the database or logs

## Verified against the live host

- SQLite behaviour (`node:sqlite`, WAL, partial unique indexes, triggers)
- Herdr `agent list`, `workspace list`, `workspace create`,
  `workspace report-metadata`, `pane split`, `worktree create` — recorded as
  fixtures by `pnpm probe:herdr` and parsed by the production schemas
- The `gh` read-only JSON surface

The probe caught a real detail: Herdr checks a linked worktree out under its own
directory, not inside the source repository, so the result file must be read
from the reported checkout path.

## Mocked or unverified — stated plainly

| Area | Status |
|---|---|
| OpenClaw conversation | **Not installed on this host.** The HTTP provider throws rather than guessing an API; the mock provider answers and every reply is prefixed `[mock]`. |
| Image / PDF schedule extraction | **Unsupported.** Those uploads are refused before download. No decoder ships in Phase 1. |
| `herdr agent start` / `agent prompt` | **Not exercised.** Doing so starts a real Pi agent. The orchestrator is therefore `experimental`, not `verified`. |
| Real Discord gateway | Implemented but not run — no token here. The privileged MessageContent intent must be enabled in the portal first. |
| Approved action execution | Deliberately absent. |
| Azure deployment | Documented only; nothing provisioned. |

## Deferred

Multi-user permissions; public bot; autonomous deployment; automatic GitHub or
Azure writes; arbitrary shell; browser automation; container sandboxing;
concurrent implementation writers; Tailscale provisioning.

## Verification

`pnpm typecheck`, `pnpm test`, `pnpm build` all pass. See
[TESTING.md](TESTING.md).
