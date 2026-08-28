# Current state

What is actually true today. Phase 1 plus milestones 2A, 2B, 2C, lifecycle
hardening, and explicit approved-action/watch paths; no deployment performed.

## Two Discord identities

`DUCKY_PROFILE` selects `development` or `production`. They share no token,
application id, guild, database, port or command scope, and neither falls back
to the other. Development may run token-less on the mock; production refuses to
start without its own credentials. The active profile is in the startup
diagnostics and in `/status`.

## Working end to end (against mock Discord and mock Pi)

- Owner-only Discord surface: `/capture`, `/inbox`, `/schedule`, `/job`
  (submit, status, cancel, answer, cleanup, execute), `/jobs`, `/repo status`,
  `/status`, `/task` (add, list, done, cancel), `/reminder` (add, list,
  cancel), `/briefing`, `/watch` (add, list, remove), `/forget` (job,
  conversation)
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
- **Conversation attachments (milestone 2C): the PIPELINE only, and closed on
  this host.** See
  [decisions/0015](decisions/0015-provider-agnostic-conversation-attachments.md)
  - One image or file may be attached to an ordinary conversation message.
    Several in one message are refused concisely, before anything is inspected
    further.
  - **Nothing is downloaded unless all three hold:** the operator has opted in
    (`CONVERSATION_ATTACHMENTS_ENABLED`, default off), the provider reports
    itself `verified`, and it declares attachment support. Both shipped
    providers advertise none and throw if one reaches them anyway, so on this
    host the refusal is on metadata alone and **no attachment byte is ever
    fetched**.
  - The port carries **metadata plus a bounded read** — never a path, never
    base64 — with an explicit lifetime the coordinator owns. The provider is
    handed a narrower type with no `dispose`, and the handle is poisoned after
    the reply, so a retained reference reads an error rather than the owner's
    file.
  - **Owner-only.** Plain conversation keeps its Phase 1 whitelist behaviour;
    an attachment does not, because it is personal data leaving the host and
    fetching one is an action taken on somebody else's say-so. Conversation is
    not a shared route, and a message event carries no channel context.
  - Accepted types: `image/png`, `image/jpeg`, `image/webp`, `text/plain`,
    `text/csv`, `text/markdown`, `application/json`. **PDF is deliberately
    excluded.** Accepting a type is not a claim that anything can read it — no
    vision or extraction capability is claimed anywhere.
  - Controls: exact HTTPS host from the existing `DISCORD_CDN_HOSTS`; declared
    type and size checked before any network request; the smaller of the
    configured cap and the provider's own; no redirects; no compressed
    transfer; the received stream capped again because a declared size is a
    claim; a `0700` directory and a `0600` file removed on success, failure
    and provider error alike; the startup sweep extended to the new prefix;
    per-owner hourly budget. No byte reaches SQLite, a log line, or a Discord
    reply.
- Job lifecycle: queue, claim, lease, heartbeat, result intake, cancellation
  (supervised mid-turn, acknowledged only once a stop is observed), owner-input
  rounds, per-repo reservations, durable workspace registration, crash
  recovery, reconciliation
- **Engineering work phases, now actually reported.** `preparing`, `planning`,
  `implementing`, `reviewing`, `fixing`, `verifying`, persisted beside the job
  state rather than replacing it. Set on claim, moved by an **allowlisted**
  `phase` on the executor's job heartbeat, validated against an exhaustive
  phase machine
  (a report cannot walk backwards from implementing to planning), idempotent
  for a repeated report, and cleared whenever the job stops being lease-bearing
  so a paused job never renders a stale phase. Shown privately as
  "Working — reviewing"; never in a shared channel.
  **`running` is still the only lease-bearing state**, so the partial unique
  index, the lease-expiry sweep, the supervised cancel branch and the claim
  predicate are unchanged. `approved` / `executing_approved_action` were
  deliberately NOT added: the performer is still unimplemented, so they would
  be dead states. See
  [decisions/0016](decisions/0016-work-phases-dependency-waits-and-audit.md)

  **Where each phase comes from, exactly.** Until this milestone no executor
  code path ever sent `progress.phase` at all, so a live job sat at `preparing`
  from claim to terminal state while this document claimed otherwise. Now:
  - `preparing` — set by the coordinator on claim.
  - `planning` — emitted by the orchestrator when the brief is handed over.
    That is a fact it observes.
  - `implementing`, `reviewing`, `fixing`, `verifying` — read from
    `.ducky/phase`, a one-word file **Pi writes about itself**, which the brief
    asks for. Herdr can only report `idle | working | blocked | done | unknown`,
    so nothing else could observe these; inferring them from a terminal scrape
    would be a guess dressed as an observation. If Pi does not write the file,
    the job honestly stays at `implementing` or earlier.
  A report is carried by a **coalesced immediate heartbeat** (2 s debounce, one
  in flight, the regular lease interval never reset), so a phase appears in
  seconds rather than after a full interval. A phase the machine would refuse
  is not sent, and one the coordinator refuses is not resent — a refused report
  fails the whole heartbeat, and losing a lease renewal to it would be a bad
  trade.
- **Explicit approved Git actions.** An owner can use `/job execute` after a
  per-action approval; the immutable proposal and a durable execution ledger
  are checked before the opt-in same-filesystem performer can commit, push or
  create a PR. The default flag remains off, and no action is executed merely
  because it was approved.
- **Durable waiting-on-dependency path.** A result may report
  `waiting_on_dependency` with a closed dependency shape (type, description,
  optional opaque external key, next check, and TWO ceilings: a check count
  and a wall-clock deadline). Persisted in the same transaction as the result
  and the transition. **The lease is released and the repository reservation is
  retained**, so nothing else starts in that repository while the job waits.
  Visible in the owner's private `/job status` only.
  - A bounded `DependencyResolver` runs on the existing coordinator interval —
    no second scheduler, no per-dependency timer, no unbounded polling. Batched
    per pass, compare-and-set on the check count, bounded exponential backoff,
    re-entrancy guarded. A checker that throws or hangs counts as `pending` and
    **still spends a check**.
  - Outcomes: `ready` → requeued keeping its reservation; `failed` → job fails
    and the repository is released; `pending` with budget → rescheduled;
    **budget spent → `needs_owner_input`**.
  - **The shipped checker never reports ready.** Nothing on this host can
    observe a CI run or a registry, so `UnavailableDependencyChecker` answers
    `pending` for everything and a wait ends at the owner's desk rather than
    being resumed on a check that did not happen. A `ready` from an unverified
    checker is downgraded, not believed.
  - Cancelling a waiting job closes its dependency in the same transaction, so
    the resolver cannot later requeue a job the owner stopped. The cursor is
    durable, so a restart resumes from it.
- **Central command policy.** Every `gh`, `git` and `herdr` operation is
  classified `read_only` / `local_mutation` / `external_mutation` /
  `high_risk`. Ordinary workspace inspection has a `local_mutation` ceiling;
  the explicit, owner-approved action performer may opt into the narrow
  external entries. Force, hook-bypass and high-risk verbs remain refused.
  `gh-cli`, the executor's `git` helper and **now `HerdrCli`** consult it before
  spawning: the frozen argv table decides what can be constructed, the policy
  decides whether it may run. No arbitrary shell anywhere.

  Until this milestone that sentence was two binaries out of three. Every herdr
  invocation went straight to a subprocess, and `agent get`, `workspace close`
  and `worktree remove` were not classified at all — so the claim above was
  false for the surface that starts agents. Both spawn points in `HerdrCli` now
  assert, `agent get` / `agent read` / `agent wait` are classified `read_only`,
  `workspace close` / `worktree remove` are `local_mutation`, and a test drives
  every method the orchestrator uses and asserts each argv it builds is
  classified. One consequence is deliberate: `--force` is a forbidden flag, so
  a forced worktree removal is refused **before** a subprocess exists rather
  than deleting a checkout that still holds uncommitted work.
- **Structured audit log.** Job creation, claim, every transition (written from
  the single point of state change, so coverage is structural), phase changes
  including refused ones, cancellation, failure, approval decisions, executor
  connect/offline and every dependency event. It is a record and **never an
  authority** — nothing reads it to decide anything, asserted by a test. No
  secret, no raw authentication material, no terminal output, no environment;
  the owner is recorded as the role `owner` rather than a Discord id. Details
  are redacted and clamped, recording never throws, and the reconciler prunes
  past the retention window.
- Per-action approvals, decided individually, with a separate View Details
  control. `/job execute` is an explicit owner-only second step; a durable
  per-approval ledger prevents replay. Same-filesystem development execution
  supports commit, push and PR when `DUCKY_DEV_APPROVED_ACTIONS_ENABLED` is
  deliberately enabled; the default remains disabled and issue/deploy/Azure
  actions remain recorded-only.
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
  persisted state. Work phases refine the private running label, and
  `waiting_on_dependency` is an explicit validated state.
- Authenticated, signed, replay-resistant, rate-limited executor API
- Executor: outbound polling, fail-closed workspace resolution, single-writer
  lock, Herdr/Pi orchestration behind a port
- Read-only GitHub inspection through a frozen `gh` argv table, plus bounded
  owner-configured repository watches with normalized-snapshot deduplication
  and owner-DM change summaries
- Redaction at the transport boundary; no secret in the database or logs

## What "verified" means here

Three different things, and they are not interchangeable:

- **Verified against this host** — exercised for real, with recorded evidence.
- **Unit-tested only** — the logic is covered, but the external system it talks
  to has never been contacted. The real Discord payload path is in this
  category.
- **Unavailable** — the dependency is not installed or not probed, and the code
  says so at runtime rather than pretending.

## Retention and deletion (milestone 2E, the substance of it)

- **Bounded retention, OFF by default.** `DUCKY_RETENTION_ENABLED=false` means
  no window is consulted and nothing is deleted. When enabled it rides the
  existing coordinator interval — no second scheduler — and every table is
  capped at `DUCKY_RETENTION_BATCH` per pass, so a tick is short and a pass that
  hits the cap resumes on the next one.
- **Table-by-table.** Terminal jobs (and every row referencing them) at 180
  days; closed tasks, closed reminders, done/archived captures and past
  confirmed schedules at 365; settled GitHub watch events at 90; idempotency
  keys at 7. `audit_log` (90 days) and `executor_nonces` keep their existing
  prunes, unchanged. Cancelled watches and the run log are fixed at 365 days and
  deliberately not configurable.
- **Schedules are time-zone correct.** `schedules.starts_at` is wall-clock text
  in the owner's zone, so a schedule goes only when it was confirmed longer ago
  than the window AND its event is genuinely past in `DUCKY_OWNER_TIMEZONE`. The
  SQL selects on `confirmed_at` (a real instant); the zone-aware test happens in
  TypeScript. An unparseable stored time is kept, never deleted.
- **Six guards per job, and a skip is counted.** A job is skipped whole — never
  partially deleted — if it is non-terminal, has no `finished_at`, holds a
  repository reservation, has an open workspace, has a pending approval, or has
  an open dependency. A terminal job still holding a reservation is an
  inconsistency somebody should see, so `jobsSkipped` is reported rather than
  swallowed.
- **Never reachable at all:** `repos`, `authorized_user_audit`, `executors`,
  `executor_credentials`, `repo_reservations`, `schema_migrations`. Tests assert
  the source of both the repository and the service names none of them in a
  `DELETE`.
- **Every pass is recorded twice** — in `retention_runs` and in the audit log —
  with counts only, including a pass that deleted nothing.
- **`/forget job <id>` and `/forget conversation`**, owner-only, on the
  owner-only manifest, never shared-readable. Two-step: the command shows what
  will go and returns a signed control bound to the owner; only pressing it
  deletes. An unknown id and somebody else's id are answered identically.
  `/forget conversation` says plainly that nothing is stored — there is no
  transcript table — and exists so the answer is a fact rather than a missing
  command.
- **No wipe-all path at any layer.** `FORGET_TARGETS` cannot express one.

Both `/forget` and the scheduled pass use the SAME deletion implementation, so
there is one child-first order and one set of guards rather than two that could
drift apart.

## Security audit events

The audit log recorded the lifecycle in detail and nothing about who was turned
away. It now also records `auth.failed`, `auth.replay_detected`,
`authz.refused` (the **role**, never a Discord id), `rate_limit.exceeded` — for
both the Discord buckets (the **bucket**) and the HTTP routes (the **route**) —
`credential.reloaded`, `retention.pruned`, `data.deleted`,
`approval.requested`, `approval.expired`, `provider.failed` and
`config.rejected`. None says why authentication failed, and none records the
material that failed.

Local commit/push/PR outcomes map onto the existing `approval.execution_*`
events, whose detail carries the action kind and, on failure, the redacted
reason. Startup configuration errors are logged rather than audited: they happen
before the database exists. Both distinctions are documented in
[SECURITY.md](SECURITY.md) and asserted by tests.

`AuditLogRepo.record` never throws by design, which means an enum value the
table's CHECK constraint does not allow is dropped **silently**. That happened;
migration 13 widens the constraint and a test now asserts every declared event,
actor kind and subject kind is actually persistable.

## Certified on the production code path

`pnpm probe:live-job` drives the **shipped** chain — router → `JobsService` →
real Fastify HTTP with bearer/HMAC/nonce auth → `CoordinatorClient` →
`ExecutorLoop` → `runClaimedJob` → `resolveWorkspace` (real git) →
`acquireWriterLock` → `HerdrPiOrchestrator` → `HerdrCli` → Herdr → Pi →
`.ducky/result.json` → `FileResultReader` → `ResultIntake`. Only the Discord
transport is mocked, and deliberately: a certification run must never open a
gateway.

A successful run against the disposable allowlisted repository recorded:

- `orchestrator=herdr-pi` (not the mock) from the executor's own selection;
- `queued → running → completed (result_implemented)`;
- the **full engineering loop**, `preparing → planning → implementing →
  reviewing → fixing → verifying`, including the review⇄fixing back-edge;
- audit rows for creation, claim, every transition and every phase change, with
  none of `AUDIT_FORBIDDEN_SUBSTRINGS` present;
- a `herdr_workspaces` row with `mode=worktree` and a checkout path under
  `~/.herdr/worktrees`;
- the exact Herdr argv sequence, including `worktree create --label ducky-mgd:…`
  and `worktree remove`;
- an accepted result: `verdict=implemented`, an independent passing review, four
  verification commands with real exit codes, `changedFiles=["README.md"]`;
- **271 seconds elapsed** — direct evidence that the 30-second subprocess cap
  which used to kill every real turn is gone.

Not certified by that run, and stated plainly: no Discord gateway interaction,
no OpenClaw, and `DUCKY_HERDR_VERIFIED` was not set.

**One successful production-path run has been OBSERVED. Repeatability is NOT
certified.** Of the runs attempted after the orchestration fixes landed, two
reached `completed` with an accepted `implemented` result (271 s and 240 s) — and
only the 271 s run was checked against the full evidence gate, because the gate
was added after the first. Three failed with `agent_prompt_stalled`, because
`agent start` reported `interactive_ready: true` while Pi was still painting
startup banners and the prompt was silently dropped.

Ducky reports that honestly — its own error code, bounded observation, never a
re-prompt, workspace and reservation retained, and the probe exits non-zero — but
the integration is intermittent. **`HerdrPiOrchestrator.verified` stays `false`,
`/status` still reports `experimental`, and `DUCKY_HERDR_VERIFIED` is unset.**
See [integrations/herdr.md](integrations/herdr.md).

## Verified against the live host

- SQLite behaviour (`node:sqlite`, WAL, partial unique indexes, triggers)
- Herdr `agent list`, `workspace list`, `workspace create`,
  `workspace report-metadata`, `pane split`, `worktree create` — recorded as
  fixtures by `pnpm probe:herdr` and parsed by the production schemas
- The `gh` read-only JSON surface
- Development Discord bot identity and configured guild REST access (HTTP 200)
- Development coordinator gateway startup on `127.0.0.1:8787`
- Slash-command registration, stated as two separate facts because they have
  drifted apart:
  - **DEFINED: 12 owner commands** — `/capture`, `/inbox`, `/schedule`, `/job`,
    `/jobs`, `/repo`, `/status`, `/watch`, `/forget`, `/task`, `/reminder`,
    `/briefing`. `OWNER_ONLY_COMMANDS` and the registration payload agree on all
    12, asserted by a test.
  - **REGISTERED LIVE: the seven that existed at the time of the one recorded
    registration.** The five added since (`/task`, `/reminder`, `/briefing`,
    `/watch`, `/forget`) have never been written to Discord. Registering is an
    external write, is never done at boot, and has not been done in any run
    since. Run `pnpm register-commands --apply --profile development`
    deliberately; the default remains a dry run.
- Development executor authentication, polling, and liveness heartbeat

The probe caught a real detail: Herdr checks a linked worktree out under its own
directory, not inside the source repository, so the result file must be read
from the reported checkout path.

**Now probed:** `herdr agent start`, `agent prompt` and `agent get` have been
exercised repeatedly against a real Pi agent, by `pnpm probe:herdr --with-agent`
(which records `agent-start.json`, `agent-prompt.json`, `agent-get.json` and a
result file a real agent wrote) and by `pnpm probe:live-job`. Their contracts are
recorded and parsed by the production schemas.

That is a recorded CONTRACT, not a certification of the integration: the
end-to-end path is intermittent (see above), so `HerdrPiOrchestrator.verified`
stays `false` and `/status` reports `experimental`.

## Mocked or unverified — stated plainly

| Area | Status |
|---|---|
| OpenClaw conversation | **Not installed on this host** (not on PATH, not in the global npm tree, no config directory). The HTTP provider throws rather than guessing an API. `DUCKY_CONVERSATION_PROVIDER` now chooses explicitly between `mock`, `disabled` and `openclaw`; **production must choose and fails at startup otherwise**, and `mock` is refused for production outright. All three providers advertise attachments as unavailable, so the 2C path stays closed. `pnpm probe:openclaw` exists, refuses to guess, and exits 2 with the blocker. |
| Conversation attachment delivery | **Unreachable, by design.** The pipeline is unit-tested against an injected `fetch` and a test-only provider that supplies the one thing this host lacks — a verified, attachment-capable endpoint. **No live attachment byte has been fetched on this host, and none is sent anywhere.** It becomes reachable only when 2D produces a verified provider that declares attachment support. |
| Image / PDF schedule extraction | **Unsupported.** Those uploads are refused before download. No decoder ships in Phase 1, and 2C did not add one: it forwards bytes, it does not read them. |
| `herdr agent start` / `agent prompt` | **Now exercised, repeatedly, against a real Pi agent** — by `pnpm probe:herdr --with-agent` (contract) and `pnpm probe:live-job` (production path). Five real defects were found and fixed as a result; see [integrations/herdr.md](integrations/herdr.md). The orchestrator nonetheless still reports `experimental`: `DUCKY_HERDR_VERIFIED=1` is a deliberate operator act and this run did not set it. |
| Cleanup after a completed worktree job | **Keeps the workspace, by design.** `herdr worktree remove` refuses a checkout holding uncommitted work, and a finished job's checkout holds the implementation plus `.ducky/result.json`. Ducky does not force — that would delete the work — so it reports the workspace as kept. The repository reservation IS released, so nothing is blocked; the owner clears the workspace with `/job cleanup`, and the reconciler sweeps a stale one after `HERDR_WORKSPACE_TTL_MS`. |
| Real Discord gateway | The development bot successfully connected during a local smoke test, and the bot/guild REST checks returned HTTP 200. A human DM/slash-command interaction has not yet been exercised; Message Content intent must be enabled in the portal for message bodies. Proactive job notifications use this same path, so their delivery is still not verified by an owner-initiated live DM. |
| Reminder DM delivery | **Unit-tested only.** Materialization, collapse, retry, abandonment and DM-only targeting are covered against the mock transport with an injected clock. No reminder has been delivered to a real Discord DM on this host; it uses the same unverified gateway path as job notifications. |
| Shared-channel delivery | **Unit-tested only.** `channelAwareSink` is covered against a structurally-typed stand-in client, and the sanitization boundary is asserted for a channel send. No message has been delivered to a real Discord channel on this host. |
| Shared-channel command routing | **Unit-tested only.** Channel/guild/DM context is populated from `discord.js` interaction fields (`channelId`, `guildId`) but has never been exercised by a real interaction, so the DM-versus-guild distinction the whole policy rests on is verified against constructed events, not live traffic. |
| Slash-command registration | Development commands were deliberately registered to the configured test guild. Production remains unregistered; the default command-registration mode remains a dry run. |
| Interrupting a live Pi turn | Herdr exposes no verified way to interrupt one without risking a half-written edit, so cancellation aborts our wait *immediately* and then observes the agent. A still-working agent is reported honestly, the writer lock is retained, and the repository stays reserved for the owner. |
| Approved action execution | **Unit-tested only.** An opt-in same-filesystem performer validates the immutable proposal, allowlisted workspace, branch and GitHub origin before commit/push/PR. The default flag is off; no live external write has been performed here. Production executor routing, issues, deployments, Azure and high-risk actions remain unsupported. |
| GitHub repository watches | **Unit-tested only.** The loop uses the verified read-only `gh` surface, stores normalized snapshots and deduplicates owner-DM summaries. Recent commits, review comments/requested changes, workflow history and a live watch have not been exercised here. |
| Dependency checking | **No real checker exists.** The port ships with `UnavailableDependencyChecker`, which only ever answers `pending`, so a dependency wait always ends at the owner's desk on this host. The resume-on-ready and fail-on-failed paths are unit-tested against a scripted fake; neither has ever run against a real external system. |
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
