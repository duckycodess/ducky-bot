# Current state

What is actually true today. Phase 1 plus milestones 2A and 2B, no deployment
performed.

## Two Discord identities

`DUCKY_PROFILE` selects `development` or `production`. They share no token,
application id, guild, database, port or command scope, and neither falls back
to the other. Development may run token-less on the mock; production refuses to
start without its own credentials. The active profile is in the startup
diagnostics and in `/status`.

## Working end to end (against mock Discord and mock Pi)

- Owner-only Discord surface: `/capture`, `/inbox`, `/schedule`, `/job`
  (submit, status, cancel, answer, cleanup), `/jobs`, `/repo status`,
  `/status`, `/task` (add, list, done, cancel), `/reminder` (add, list,
  cancel), `/briefing`
- Opt-in shared job visibility (milestone 2A), **off by default**. With
  `DUCKY_SHARED_CHANNEL_IDS` empty the feature is unreachable. When a channel
  is listed, anyone who can read it gets a safe projection from `/jobs` and
  `/job status` — public job id, allowlisted repo slug, coarse state, safe
  timestamps, sanitized summary and verdict, next-step copy — and nothing
  else. **Scoped to that channel:** only jobs submitted in it are listed or
  reachable by id. A job from a DM or another shared channel is refused
  identically to one that never existed. Task, context, owner id, questions, answers, events, workspace
  ids/paths, action details and signed controls never appear there. Writes,
  captures, schedules, approvals and every control stay owner-only and
  ephemeral. See [decisions/0012](decisions/0012-opt-in-shared-job-visibility.md)
- Captures and inbox with per-row management
- **Daily owner assistant (milestone 2B), owner-only in full.** See
  [decisions/0013](decisions/0013-bounded-reminder-recurrence-and-catch-up.md)
  and [decisions/0014](decisions/0014-single-owner-timezone-as-a-projection.md)
  - **Tasks** — title, optional due instant, priority (low/normal/high), state
    (open/done/cancelled). A separate record from a capture: a capture is an
    unsorted thought, a task is a commitment. `today` and `overdue` filters are
    computed against the owner's own civil day. A bare due date stays an
    all-day date rather than being given a time nobody typed.
  - **Reminders** — one-shot, or a FIXED interval with an explicit occurrence
    count. There is no cron grammar and no unbounded schedule: both bounds are
    validated at input and enforced again by table CHECK constraints.
  - **Reminder delivery** — to the **owner's DM only**, over a durable
    `reminder_occurrences` outbox with the same guarantees the job notification
    ledger has: an occurrence row exists from the moment it is due, a unique
    key makes recording delivery idempotent, one failure is isolated and
    retried on the next tick, and everything passes through the same
    `sanitizeOutbound` boundary. After a bounded number of failures an
    occurrence is marked abandoned and kept as a record rather than retried
    forever or deleted.
  - **Missed reminders** — collapse, count, and still deliver. However long the
    host was off, a repeating reminder produces at most one message per tick;
    the occurrences it stands for are recorded as `missed_count` and named in
    the message; nothing is dropped for being stale; the recurrence advances
    exactly once. Nothing ever fires early.
  - **Briefings** — `/briefing` with `morning`, `evening` or `today`, defaulting
    from the hour in the owner's zone. Assembled from stored tasks, reminders
    and schedule rows by counting them. `BriefingService` holds no provider, so
    no sentence in a briefing can be generated; every briefing says so.
  - **Timezone** — one configured `DUCKY_OWNER_TIMEZONE` (default `UTC`),
    validated at startup against the runtime's own ICU data and reported in
    `/status` and the boot diagnostics. Used ONLY as a projection: instants are
    still stored as UTC, Phase 1's `schedules.starts_at` rows keep the
    wall-clock text the owner typed, and nothing is migrated. Times render as
    Discord timestamps (`<t:…:f>` beside `<t:…:R>`) so each is shown in the
    reader's own zone.
  - **One scheduler** — the assistant tick runs on the existing coordinator
    interval alongside the reconciler and the job notifier, each isolated from
    the others. There is no second scheduler and no per-reminder timer, so a
    reminder is late by at most one `DUCKY_RECONCILE_INTERVAL_MS`.
- Text and CSV schedule extraction → preview → correction modal → explicit
  confirm
- Job lifecycle: queue, claim, lease, heartbeat, result intake, cancellation
  (supervised mid-turn, acknowledged only once a stop is observed), owner-input
  rounds, per-repo reservations, durable workspace registration, crash
  recovery, reconciliation
- Per-action approvals, decided individually, recorded and **not executed**
- Proactive job notifications on lifecycle transitions (running,
  needs_owner_input, needs_approval, completed, failed, cancelled), delivered
  to up to two independent targets:
  - the **owner DM**, with the same signed Answer/Approve/Reject components
    `/job status` offers;
  - the **originating shared channel**, when the job was submitted from one
    and that channel is still configured — the safe projection only, never a
    control.

  Both are swept off the durable `job_transitions` ledger on the existing
  reconcile interval, **not pushed instantly**: delivery lags by up to one
  interval. The ledger is keyed per `(transition, target)`, so the two
  succeed, fail and retry independently and neither can be double-sent. An
  upgrade backfills prior history as already delivered rather than replaying
  it. An owner-caused transition is skipped for the DM (already answered
  synchronously) but is posted to the channel, where nobody saw that reply.
- Plain-language job state labels and explicit "what happens next" copy on
  both the private and shared surfaces, derived exhaustively from the
  persisted state. The state machine is unchanged.
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
- Seven development slash commands registered to the configured test guild.
  **The three added by 2B (`/task`, `/reminder`, `/briefing`) are defined but
  NOT yet registered** — registering is an external write and is never done at
  boot. Run `pnpm register-commands --apply --profile development`
  deliberately.
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
| Reminder DM delivery | **Unit-tested only.** Materialization, collapse, retry, abandonment and DM-only targeting are covered against the mock transport with an injected clock. No reminder has been delivered to a real Discord DM on this host; it uses the same unverified gateway path as job notifications. |
| Shared-channel delivery | **Unit-tested only.** `channelAwareSink` is covered against a structurally-typed stand-in client, and the sanitization boundary is asserted for a channel send. No message has been delivered to a real Discord channel on this host. |
| Shared-channel command routing | **Unit-tested only.** Channel/guild/DM context is populated from `discord.js` interaction fields (`channelId`, `guildId`) but has never been exercised by a real interaction, so the DM-versus-guild distinction the whole policy rests on is verified against constructed events, not live traffic. |
| Slash-command registration | Development commands were deliberately registered to the configured test guild. Production remains unregistered; the default command-registration mode remains a dry run. |
| Interrupting a live Pi turn | Herdr exposes no verified way to interrupt one without risking a half-written edit, so cancellation aborts our wait *immediately* and then observes the agent. A still-working agent is reported honestly, the writer lock is retained, and the repository stays reserved for the owner. |
| Approved action execution | Deliberately absent. |
| Azure deployment | Documented only; nothing provisioned. |

## Deferred

Natural-language capture and proactive (pushed) briefings, both deferred out of
2B — the first depends on a verified conversation provider (2D), the second on
a delivery-time preference that does not exist yet.
Collaborator job submission (visibility shipped; writes stay owner-only);
multi-user permissions beyond shared visibility; public bot; autonomous deployment; automatic GitHub or
Azure writes; arbitrary shell; browser automation; container sandboxing;
concurrent implementation writers; Tailscale provisioning.

## Verification

`pnpm typecheck`, `pnpm test`, `pnpm build` all pass. See
[TESTING.md](TESTING.md).

## Next

[ROADMAP.md](ROADMAP.md) — the serial Phase 2 milestones, with every
unresolved product or API decision marked rather than guessed.
