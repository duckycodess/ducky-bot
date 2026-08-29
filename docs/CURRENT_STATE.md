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
  conversation). **The manifest is closed:** no command was added by the final
  milestone, and `AGENTS.md` forbids widening the owner-only surface.
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
  - **Proactive briefings, OFF by default** — the piece 2B deferred, because
    pushing one needs a delivery time. `DUCKY_BRIEFING_ENABLED` plus two LOCAL
    times (`07:30` / `20:30` by default), validated at startup so a typo fails at
    boot rather than at 07:00. Delivered to the **owner's DM only** over a
    durable `briefing_deliveries` outbox with the same guarantees the reminder
    ledger has: a row from the moment a slot comes due, a unique
    `(user, kind, day_key)` index that makes delivery idempotent, isolated
    retries, and abandonment as a RECORD after a bounded number of failures.
    Rides the same coordinator interval — still one scheduler.
    **One rule reminders do not have:** a briefing more than
    `BRIEFING_STALE_AFTER_MS` (6 h) late is marked `skipped` rather than sent. A
    reminder names a commitment and is worth having late; a briefing is a summary
    OF A DAY, and this morning's summary arriving tonight describes a day that has
    already happened. There is no backfill for a day the host was off, either.
    The body is assembled at DELIVERY time and nothing rendered is stored.
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
- **Deterministic-first natural language, owner-only, no new command.** A fixed
  rule table over the owner's own messages on the EXISTING conversation route.
  No provider is consulted, so none of it waits on 2D, and none of it can
  generate a sentence.
  - **Reads** are answered immediately: a briefing (the same assembly `/briefing`
    uses, same provenance line), a **Filipino meal suggestion** from a short
    fixed list in Ducky's own source, and a **study plan** that arranges the
    owner's own topic into a fixed schedule. Both helpers state their own limits
    in the reply — the meal list says it is neither generated nor complete, the
    study plan says Ducky knows nothing about the subject, has read nothing and
    kept nothing.
  - **Writes are PROPOSED, never applied on inference.** "i need to renew the
    domain" produces a proposal; the owner replies `yes` (or `no`) in their own
    words, and only then does `TasksService` — the same service `/task add` uses
    — write anything. One proposal per (user, thread), expiring after ten
    minutes, so a later `yes` cannot mean something the owner had stopped
    thinking about.
  - **Ambiguity produces nothing.** Two rules matching, a reminder with no time,
    an over-long message: all mean nothing rather than a guess.
  - **A non-owner reaches none of it.** A whitelist user's message is ordinary
    conversation, exactly as before.
  - **No command and no interaction kind was added**, and `OWNER_ONLY_COMMANDS`
    is unchanged. `/meal`, `/study` and a one-press confirm button would each
    widen the owner-only surface, which `AGENTS.md` forbids; conversation is an
    existing permitted route and the owner gate on it is the one conversation
    attachments already use.
- **Bounded conversation continuity, OFF by default.** See
  [decisions/0021](decisions/0021-bounded-conversation-continuity.md)
  - `DUCKY_CONVERSATION_MEMORY_ENABLED` defaults to false, and with it off
    nothing is read and nothing is written: the previous guarantee ("no
    transcript exists") holds exactly.
  - When enabled, turns are stored **scoped to one (user, thread)**. Every
    repository method takes the user id and puts it in the WHERE clause; there is
    no `byId`, no `listAll` and no thread-only read, so there is no method that
    could return another account's words. Two people in the same channel have two
    histories.
  - **A configured shared channel is excluded from both reading and writing.** A
    message event carries no channel context, but its thread key IS the channel
    id, so the two can be compared — and a channel other people can read never
    becomes a store of the owner's words nor a source of replayed context.
  - Bounded three ways: a replay window (`DUCKY_CONVERSATION_MEMORY_TURNS`,
    default 10), a hard row cap per thread enforced in the same transaction as
    the insert, and a per-turn length cap. An over-long turn is stored **visibly
    truncated** rather than silently halved.
  - Retention has two windows because the owner and a guest are not the same
    thing: **30 days** for the owner's own history, **7** for anyone else on the
    chat whitelist. Both configurable, both only consulted when retention is
    enabled.
  - The `role` column allows `user` and `assistant` only. There is deliberately
    no `system` role: a stored preamble would be configuration masquerading as
    history.
  - **Close to inert on this host**, and honestly so: no conversation provider is
    verified, so the only thing that can consume history is the marked mock. The
    storage, isolation and deletion rules are built now because they are the part
    that must not be retrofitted around a provider later.
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
  - **The DEFAULT checker never reports ready.** `UnavailableDependencyChecker`
    answers `pending` for everything, so a wait ends at the owner's desk rather
    than being resumed on a check that did not happen. A `ready` from an
    unverified checker is downgraded, not believed.
  - **A real one now exists, opt-in and still unverified.**
    `DUCKY_DEPENDENCY_CHECKER=github` selects `GitHubCiDependencyChecker`, which
    reads CI status for `<repo slug>#<pr number>` through the same read-only `gh`
    surface everything else uses. It answers `ci_run` only; anything else stays
    `pending` rather than a confident guess. It reports itself **unverified** —
    no GitHub repository is configured here, so no live check has run — which
    means on this host it can **fail** a job whose CI definitely failed and
    **cannot resume** one. That asymmetry is the correct one: failing on a
    definite failure is safe, resuming on an unexercised integration is not. A
    malformed key, an unknown repository or a `gh` error is `pending`, never
    `failed`: a lookup problem is not evidence about the work.
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
  and owner-DM change summaries. **The final milestone widened what a watch can
  see** — merges (via `pr list --state all`, so a merge is observable as a merge
  rather than as a pull request that vanished), approvals, requested changes,
  review comments, the commits under review, workflow **failures and the recovery
  after one**, and issue activity. Every `--json` selector is recorded from `gh`
  itself by `pnpm probe:gh` — locally, with no repository named and no network
  request — and a test asserts the argv table against that record. Response
  VALUES are still unrecorded, because no GitHub repository is configured in this
  host's allowlist, so every added schema field is optional: a missing field
  degrades the summary and never fails the observation.
- **Requested changes propose a job; nothing submits one.** A pull request whose
  review asked for changes produces one owner-DM proposal naming the exact
  `/job submit` command. No job is created, no approval is bypassed, and every
  existing gate is untouched because nothing reaches them. The proposal is tied
  to the repository, the PR number, the head commit AND the review timestamp, and
  deduplicated by the database (`UNIQUE (watch_id, fingerprint)`, inserted `OR
  IGNORE`) — so it appears once per genuinely new review or new code, never once
  per pass, and stops entirely once the PR is merged. A one-press signed control
  would have been friendlier and would have needed a new entry on the owner-only
  interaction manifest, which `AGENTS.md` forbids widening; the owner types the
  command instead.
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
- **Per kind of record, each with its own window** (ADR 0022). Job metadata —
  the row, its transitions and its delivery ledger — at **90** days; the job's
  **DETAIL** (result snapshot, events, the owner's answers) at **30**, so the
  most specific thing Ducky stores about a repository goes first while the shape
  of what happened survives; done/archived captures at 365; closed tasks at 90;
  finished reminders and their occurrences at 90; past confirmed schedules at
  180; the audit log at 90; settled watch events at 90; idempotency keys at 7;
  conversation turns at 30 (owner) and 7 (a chat-whitelist guest). Cancelled
  watches and the retention run log stay fixed at 365 and are deliberately not
  configurable. `executor_nonces` keeps its existing prune.

  Pruning the detail of a job it keeps is safe because every reader already
  treats a missing result as normal — a queued job has none — and the count is
  reported separately from the child rows of jobs that went entirely, so a job
  surviving without its detail is visible rather than hidden in one total.

  The two earlier variables (`TERMINAL_JOBS_DAYS`, `CLOSED_ASSISTANT_DAYS`) are
  kept as **deprecated aliases** rather than silently ignored: an operator who
  set one expressed an intent, and an explicit new value always wins.
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
  owner-only manifest, never shared-readable. `/forget job` is two-step: the
  command shows what will go and returns a signed control bound to the owner;
  only pressing it deletes. An unknown id and somebody else's id are answered
  identically. **`/forget` also names one `capture`, `task`, `reminder` or
  `schedule` entry** — choices on a command that was already owner-only, so no
  command and no interaction kind was added and the owner-only surface is
  unchanged. With no id it LISTS the owner's records with the ids they can type,
  as a plain read with no controls; captures and schedule entries are named by
  the 8-character id prefix `/inbox` already shows, and an ambiguous prefix is
  refused rather than resolved. Every statement is owner-scoped in its WHERE
  clause, a reminder takes its occurrence outbox with it child-first, and every
  deletion is audited by count. **`/forget conversation` now deletes for real** — every stored
  turn of every thread for that owner, one step (there is no id to confirm and
  no live-work reason it could be refused), reporting and auditing the COUNT. It
  works even when continuity has since been switched off, because rows an
  earlier run stored are still the owner's to remove; and when nothing is stored
  it says so plainly.
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
migration 13 widens the constraint, migration 15 widens it again for the
approval, provider and configuration subject kinds, and a test now asserts every
declared event, actor kind and subject kind is actually persistable.

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

**Repeatability is now CERTIFIED: three consecutive clean runs.** Before the
readiness fix this said the opposite, and honestly so — of the runs attempted
then, two reached `completed` (271 s and 240 s) and three failed with
`agent_prompt_stalled`, because `agent start` reported `interactive_ready: true`
while Pi was still painting startup banners and the prompt was silently dropped.

Since the fix, `pnpm probe:live-job` has been re-run **three times in a row,
each against its own throwaway database**, and each exited 0 through the full
evidence gate:

| Run | Elapsed | Phases observed | Result |
|---|---|---|---|
| 1 | 162 s | preparing → planning → implementing → reviewing → verifying | `implemented`, independent review passed |
| 2 | 193 s | same | `implemented`, independent review passed |
| 3 | 192 s | same | `implemented`, independent review passed, two verification commands |

Every run recorded the full transition and audit history, the exact Herdr argv
sequence including `worktree create --label ducky-mgd:…`, a `herdr_workspaces`
row with `mode=worktree`, `changedFiles=["README.md"]`, and no leak at teardown.
Not one run stalled.

**The stall's absence is evidence, not luck.** The readiness observation is in
each run's argv: `agent read --source detection` appears two or three times
between `agent start` and `agent prompt`, which is the orchestrator waiting for
Pi's input frame on two consecutive reads rather than trusting
`interactive_ready`.

Ducky reported that honestly — its own error code, bounded observation, never a
re-prompt, workspace and reservation retained, and a non-zero probe exit.

**That cause is now fixed by observation rather than trust.** Before the first
prompt the orchestrator reads the agent's own pane (`herdr agent read --source
detection`, which answers plain text and needed its own call path) and waits for
Pi's interactive input frame on two consecutive reads. Recorded by
`pnpm probe:herdr --with-agent` across two independent agent starts: Herdr claims
`interactive_ready: true` from ~6 s while the pane shows no frame, and the frame
appears at 8.16 s / 8.24 s. The probe FAILS if the marker never matches a real
pane — and it did fail once, which is what corrected the marker: a freshly
started Pi never paints the status footer the first version also required.

There is no timing heuristic: stability is two consecutive observations, and if
the marker never appears the orchestrator falls back to exactly the previous
behaviour rather than refusing the job.

**Repeatability is measured now** — see the three runs above.
**`HerdrPiOrchestrator.verified` nonetheless stays `false`, `/status` still
reports `experimental`, and `DUCKY_HERDR_VERIFIED` is unset.** That is not an
oversight and it is not modesty: promoting the integration is a deliberate
operator act, and a probe that promoted itself on its own evidence would be
grading its own work. The evidence is on the table; the decision is the
owner's.
See [integrations/herdr.md](integrations/herdr.md) and
[runbooks/live-job-certification.md](runbooks/live-job-certification.md).

## Verified against the live host

- SQLite behaviour (`node:sqlite`, WAL, partial unique indexes, triggers)
- Herdr `agent list`, `workspace list`, `workspace create`,
  `workspace report-metadata`, `pane split`, `worktree create` — recorded as
  fixtures by `pnpm probe:herdr` and parsed by the production schemas
- Herdr `agent read`, recorded by the agent probe: **plain text, not a JSON
  envelope**, exit 0, four snapshot sources. The readiness observation and the
  banner-versus-frame timings are recorded with it — shape, digest and timings
  only, never pane content
- The `gh` read-only JSON surface
- Development Discord bot identity and configured guild REST access (HTTP 200)
- Development coordinator gateway startup on `127.0.0.1:8787`
- Slash-command registration, stated as two separate facts because they have
  drifted apart:
  - **DEFINED: 12 owner commands** — `/capture`, `/inbox`, `/schedule`, `/job`,
    `/jobs`, `/repo`, `/status`, `/watch`, `/forget`, `/task`, `/reminder`,
    `/briefing`. `OWNER_ONLY_COMMANDS` and the registration payload agree on all
    12, asserted by a test.
  - **REGISTERED LIVE: eleven of the twelve, measured rather than recalled.**
    This document previously said seven, and named five commands as never
    registered. That was wrong: `pnpm register-commands --diff --profile
    development` performs a GET against the configured guild and compares it
    with what this build defines, and the guild has `/briefing`, `/capture`,
    `/inbox`, `/job`, `/jobs`, `/reminder`, `/repo`, `/schedule`, `/status`,
    `/task` and `/watch`. Nothing stale is registered either.

    **`/forget` is the one missing command**, and it is the one that deletes
    the owner's own data. Registering it is an external write: it replaces the
    whole guild command set, so it is never done at boot and never inferred.
    Run `pnpm register-commands --apply --profile development` deliberately;
    the default remains a dry run.

    The lesson is the reason `--diff` now exists. "What is registered?" had
    been answered from memory of a past run for several milestones, and memory
    was wrong in the direction that makes a system look less finished than it
    is -- which is the safer direction, but still wrong.
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
| OpenClaw conversation | **Installed (pinned, local prefix, not on PATH) and PROBED; contract recorded in HALF.** Recorded: a WebSocket gateway — not the HTTP endpoint first assumed — with `loopback\|lan\|tailnet\|auto\|custom` bind modes and `none\|token\|password\|trusted-proxy` auth; the agent-turn REQUEST shape (`--message`, `--session-key`, `--json`, and `--deliver`, which Ducky must never pass); and that **an agent turn takes text only**, so the 2C gate stays closed for this provider even once text works. NOT recorded: any successful reply — a turn needs model provider credentials and none are configured, so the probe observed `ProviderAuthError`, exit 1, empty stdout. `RECORDED_CONTRACT_VERSION` stays null, `reply()` throws, production selecting `openclaw` fails at startup, and `pnpm probe:openclaw` exits 2. `disabled` remains the honest production mode. |
| Conversation attachment delivery | **Unreachable, by design.** The pipeline is unit-tested against an injected `fetch` and a test-only provider that supplies the one thing this host lacks — a verified, attachment-capable endpoint. **No live attachment byte has been fetched on this host, and none is sent anywhere.** It becomes reachable only when 2D produces a verified provider that declares attachment support. |
| Image / PDF schedule extraction | **Unsupported.** Those uploads are refused before download. No decoder ships in Phase 1, and 2C did not add one: it forwards bytes, it does not read them. |
| `herdr agent start` / `agent prompt` | **Now exercised, repeatedly, against a real Pi agent** — by `pnpm probe:herdr --with-agent` (contract) and `pnpm probe:live-job` (production path). Five real defects were found and fixed as a result; see [integrations/herdr.md](integrations/herdr.md). The orchestrator nonetheless still reports `experimental`: `DUCKY_HERDR_VERIFIED=1` is a deliberate operator act and this run did not set it. |
| Cleanup after a completed worktree job | **Keeps the workspace, by design.** `herdr worktree remove` refuses a checkout holding uncommitted work, and a finished job's checkout holds the implementation plus `.ducky/result.json`. Ducky does not force — that would delete the work — so it reports the workspace as kept. The repository reservation IS released, so nothing is blocked; the owner clears the workspace with `/job cleanup`, and the reconciler sweeps a stale one after `HERDR_WORKSPACE_TTL_MS`. |
| Real Discord gateway | The development bot successfully connected during a local smoke test, and the bot/guild REST checks returned HTTP 200. A human DM/slash-command interaction has not yet been exercised; Message Content intent must be enabled in the portal for message bodies. Proactive job notifications use this same path, so their delivery is still not verified by an owner-initiated live DM. |
| Reminder DM delivery | **Unit-tested only.** Materialization, collapse, retry, abandonment and DM-only targeting are covered against the mock transport with an injected clock. No reminder has been delivered to a real Discord DM on this host; it uses the same unverified gateway path as job notifications. |
| Shared-channel delivery | **Unit-tested only.** `channelAwareSink` is covered against a structurally-typed stand-in client, and the sanitization boundary is asserted for a channel send. No message has been delivered to a real Discord channel on this host. |
| Shared-channel command routing | **Unit-tested only.** Channel/guild/DM context is populated from `discord.js` interaction fields (`channelId`, `guildId`) but has never been exercised by a real interaction, so the DM-versus-guild distinction the whole policy rests on is verified against constructed events, not live traffic. |
| Slash-command registration | **Eleven of the twelve** development commands are registered to the configured test guild. **Measured**, not recalled: `pnpm register-commands --diff --profile development` performs a GET and compares. Only `/forget` is absent. Production remains unregistered; the default command-registration mode remains a dry run. |
| Interrupting a live Pi turn | Herdr exposes no verified way to interrupt one without risking a half-written edit, so cancellation aborts our wait *immediately* and then observes the agent. A still-working agent is reported honestly, the writer lock is retained, and the repository stays reserved for the owner. |
| Approved action execution | **Unit-tested only.** An opt-in same-filesystem performer validates the immutable proposal, allowlisted workspace, branch and GitHub origin before commit/push/PR. The default flag is off; no live external write has been performed here. Production executor routing, issues, deployments, Azure and high-risk actions remain unsupported. |
| GitHub repository watches | **Unit-tested only, and now wider.** The loop reads merges, approvals, requested changes, review comments, commits under review, workflow runs (failure and recovery) and issue activity — all through the frozen read-only argv table, with every `--json` selector recorded from `gh` itself by `pnpm probe:gh`. What is NOT recorded is any response VALUE: **no GitHub repository is configured in this host's allowlist** (`github: null`), so no live watch has run and picking a repository to point at would mean reaching for one nobody selected. Schemas are tolerant for that reason. Recent commits on the DEFAULT BRANCH remain unobservable: that needs `gh api`, and `api` is on the forbidden-verb list. |
| Dependency checking | **A real checker exists and is opt-in; it is not verified.** `DUCKY_DEPENDENCY_CHECKER=github` reads CI status through the read-only `gh` surface. It is unit-tested against a mock reader and has never run against a real repository — none is configured here — so it reports `verified: false` and the resolver downgrades its `ready`. Net effect on this host: it can fail a job on a definite CI failure and cannot resume one. The default remains `none`, which only ever answers `pending`. |
| Azure deployment | Documented only; nothing provisioned. |

## Blocked, and by what exactly

Every one of these is blocked by a specific fact, not by effort. Each names what
would unblock it.

| Blocked | The exact blocker | What unblocks it |
|---|---|---|
| Real conversational replies | No successful OpenClaw agent turn has been observed: an agent needs model provider credentials, and none are configured on this host (`ProviderAuthError`, recorded). Verified again by `openclaw models auth list`, which reports `Profiles: (none)` in **both** the default and the `--dev` profile store. | The owner signs in with a **ChatGPT/Codex subscription**: `openclaw --dev models auth login --provider openai --device-code`. It must carry `--dev`, because that is the profile store the probe reads. Then `pnpm probe:openclaw` records a reply envelope and exits 0. This row used to name `openclaw agents add <id>`, which is the interactive per-agent helper that also offers API-key paste; the subscription OAuth entry point is `models auth login`. |
| Conversation ATTACHMENT delivery | Two independent blockers. The provider is unverified, AND the recorded OpenClaw agent turn takes **text only** — it has no attachment input at all. | A verified provider that genuinely declares attachment support. Not OpenClaw's agent turn as recorded. |
| Image / PDF schedule extraction | No decoder ships, none is installed (`pdftotext`, `tesseract`, `gs` are all absent), and no provider can read those bytes. Uploads are refused **before download**. | A verified binary-capable extractor or provider, plus `SCHEDULE_BINARY_EXTRACTION_ENABLED=true`. Installing a decoder is a host mutation of its own. |
| Herdr/Pi **certification** | The readiness fix removes the known cause of `agent_prompt_stalled`, but `pnpm probe:live-job` has not been re-run since it landed, so repeatability is unmeasured. Running it against the live development database would race the executor already polling it. | Several consecutive clean `probe:live-job` runs, isolated from the running executor. `DUCKY_HERDR_VERIFIED=1` stays an operator act. |
| A live GitHub watch | No repository in the allowlist has a GitHub mapping (`github: null`), so there is nothing to observe and nothing to point at. | The owner adds a GitHub mapping to a repository they want watched. |
| Recent commits on a repository's default branch | Reachable only through `gh api`, and `api` is on the forbidden-verb list. | A different read-only surface, or a deliberate decision about `gh api` with its own classification. |
| Verified dependency checking | The GitHub CI checker exists but has never run against a real repository (same reason as above), so it reports `verified: false` and the resolver refuses its `ready`. | One recorded live check. It can already **fail** a job on a definite CI failure. |
| Live Discord delivery | Reminder DMs, briefing DMs, watch summaries and shared-channel posts all use the gateway path, which no human has exercised. Eleven of the twelve commands ARE registered (measured by `--diff`); only `/forget` is missing. | `pnpm register-commands --apply --profile development`, the Message Content intent, and one real DM. |
| `/meal` and `/study` as slash commands | `AGENTS.md` forbids widening the owner-only surface. | Nothing here. Both features shipped on the conversation route instead, owner-gated, with no manifest entry. |
| Azure and Tailscale | Templates only. Nothing has been provisioned and nothing installs Tailscale. | A deliberate owner-run deployment, in the order `deploy/azure/README.md` gives. |

## Deferred

Collaborator job submission (visibility shipped; writes stay owner-only);
multi-user permissions beyond shared visibility; public bot; autonomous
deployment; automatic GitHub or Azure writes; arbitrary shell; browser
automation; container sandboxing; concurrent implementation writers; executor-
routed production actions; issue/deploy/Azure performers.

## Verification

`pnpm typecheck`, `pnpm test` (**81 files, 1045 tests**) and `pnpm build` all
pass on this host. See [TESTING.md](TESTING.md) for what each suite guarantees
and [SMOKE_CHECKLIST.md](SMOKE_CHECKLIST.md) for what to run, in what order, and
what each step does **not** prove.

Probes run in this milestone, with their real outcomes:

| Probe | Outcome |
|---|---|
| `pnpm probe:herdr --with-agent` | Run twice. The FIRST exited 3 — the readiness marker never matched a real pane — which is what corrected the marker. The second exited 0, with the input frame observed 8.16 s after `agent start`. |
| `pnpm probe:openclaw` | Exits **2**: half the contract recorded, the reply half blocked on model provider credentials. |
| `pnpm probe:gh` | Exits 0. Field lists recorded for six read-only surfaces, locally and repo-less. |
| `pnpm probe:live-job` | **Run three times, all exit 0**, each against its own throwaway database in a directory outside the repository. 162 s / 193 s / 192 s, full evidence gate each time. The development coordinator and executor were left running throughout and were never touched. |
| `pnpm probe:gh-live` | Exits **2**. Five read surfaces returned live responses that the production schemas accepted, and the watch loop observed and then deduplicated against a real repository. `prView` / `prChecks` / `prReviews` are unexercised: the target has no pull request, and opening one is a GitHub write. |

## Next

[ROADMAP.md](ROADMAP.md) — the serial Phase 2 milestones, with every
unresolved product or API decision marked rather than guessed.
