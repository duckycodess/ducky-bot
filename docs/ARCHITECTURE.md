# Architecture

## Components

```mermaid
flowchart LR
  subgraph U["Untrusted"]
    D[Discord user]
    PH[owner's phone<br/>tailnet only]
    ATT[attachment bytes]
    REPO[repository content]
  end
  subgraph AZ["Coordinator host"]
    TR[Discord transport<br/>sanitizeOutbound]
    AUTH[authz - frozen env config]
    API[Fastify executor API<br/>bearer + HMAC + nonce]
    PHN[phone capture page /app<br/>passcode + session + CSRF]
    CRED[credential store<br/>runtime only]
    DOM[domain services]
    RSV[(repo_reservations)]
    GH[gh reader<br/>frozen argv table]
    DB[(SQLite)]
    REC[reconciler]
    OC[OpenClaw adapter] --> OCG[[gateway: loopback / tailnet]]
  end
  subgraph W["WSL executor — no listener"]
    EX[long-poll client]
    WSR[workspace resolver]
    HRD[Herdr discovery/reuse]
    H[[Herdr]] --> PI[[Pi]] --> CC[[Claude writer]]
  end
  D --> TR --> AUTH --> DOM --> DB
  PH --> PHN --> DOM
  ATT --> TR
  DOM --> RSV
  DOM --> GH
  DOM --> OC
  REC --> DB
  EX -->|outbound HTTPS| API
  CRED --> API
  EX --> WSR --> HRD --> H
  REPO --> CC
```

## Trust boundaries

1. **Discord → coordinator.** Everything is untrusted: text, attachment bytes,
   component ids. Validated at the edge; `repo` is a slug, never a path; no
   Discord string reaches a shell.
2. **Executor → coordinator.** Bearer token (verifier in the database) plus an
   HMAC signature over the raw body, a timestamp, and a single-use nonce.
   Identity is trusted; content is not — everything is redacted and bounded
   before it is stored or shown.
3. **Owner's phone → coordinator.** A separate, HUMAN credential on the same
   listener: a scrypt-verified passcode, a signed bounded session cookie and a
   CSRF token. It authenticates a PERSON and grants exactly what the
   configured owner already has; it is not the executor's machine credential
   and neither opens the other's door. The routes exist only when the page is
   enabled AND the listener is bound to a private address
   ([ADR 0025](decisions/0025-owner-authenticated-phone-capture-on-the-tailnet.md)).
4. **Coordinator → OpenClaw.** Loopback or tailnet only, enforced in code at
   construction and again at startup.
5. **Executor → Herdr/Pi.** Same-user local trust; Pi documents that it has no
   sandbox. Containment is the allowlist, the fail-closed bootstrap policy,
   argv-only subprocesses, bounded timeouts and layered writer guards — not
   isolation.
6. **Repository content → Claude.** Prompt injection is assumed possible. The
   approval gate is the control.
7. **WSL has no inbound surface.** Asserted by a test.

## Job lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> waiting_for_executor: no executor online
  waiting_for_executor --> running: claimed
  queued --> running: claimed
  running --> needs_approval: actions proposed
  running --> needs_owner_input: question asked
  running --> completed
  running --> failed
  running --> waiting_for_executor: lease expired (reservation kept)
  needs_owner_input --> queued: owner answered
  needs_owner_input --> failed: rounds exhausted / expired
  needs_owner_input --> cancelled
  needs_approval --> completed: every action decided
  needs_approval --> cancelled: owner cancelled
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
```

Every transition writes a `job_transitions` row with a reason and an actor
(`owner:<id>`, `executor:<id>`, `system:<component>`).

## Single-writer guarantees and their lifetimes

Four guards, each with a deliberately different span, plus one engineering slot
above them (decision 0030):

| Guard | Scope | Held from | Released on |
|---|---|---|---|
| `repo_reservations` row (primary key on `repo_slug`) | per repo, coordinator | successful claim | terminal transition, in the same transaction; or reconciler expiry |
| Lease (`lease_id`, `lease_expires_at`) | per job | claim | result, cancel-ack, requeue, or expiry |
| Filesystem lock (`O_EXCL`) | per repo, executor host | just before a Pi turn | when that turn ends, **including before reporting `needs_owner_input`** |
| Herdr agent-name uniqueness | per host | `agent start` | agent exit |
| `engineering_admission` row (key pinned to 1) | **one per coordinator database**, across repos and executors; the row records the exact shared-ledger fence it stands on (migration 30) | successful claim, after the shared hold is taken AND confirmed | confirmed quiescence: a pause, a terminal release, an owner `/job cleanup`. Kept as `unconfirmed_stop` on lease expiry or an orphan. The shared release is a committed outbox row delivered after the commit |
| shared admission ledger (a separate host-local SQLite file, ADR 0031) | **across both Ducky profiles and Agent Flow on one host**; Ducky exclusive with every other hold, Agent Flow global 2 / per-repo 1 without it. **Source only: not installed, not proved** | `acquire` then `confirm`, BEFORE any launch | the exact ledger, fence and holder, after the local release commits. A confirmed hold never expires by time, PID or an absent local record |

The **reservation** — not `state = 'running'` — is the claim predicate, so it
spans `running`, `needs_owner_input` and `needs_approval`. A paused job keeps
holding its repository, which is what stops a second job from starting a writer
beside a workspace that still has uncommitted changes. The primary key makes a
double reservation structurally impossible rather than predicate-dependent.

Because the filesystem lock is released *before* `needs_owner_input` is
reported, that state is genuinely quiescent: no live writer, so cancelling it is
immediate and safe.

## Reservation TTLs and expiry outcomes

`expires_at` is recomputed on every transition:

| State | TTL |
|---|---|
| `running`, `waiting_for_executor`, `queued` | 24 h, refreshed by every job heartbeat |
| `needs_owner_input` | 24 h |
| `needs_approval` | approval TTL + 1 h, so the normal approval path always runs first |
| `reason = 'orphan_agent'` | never expires; owner-cleared only |

| State at expiry | Outcome |
|---|---|
| `needs_owner_input` | → `failed` / `owner_input_expired`, workspace retained, a later answer refused |
| `needs_approval` | → `completed` / `approvals_expired_reservation`, actions expired, result preserved |
| `orphan_agent` | never expires — `/job cleanup` only |

## Cancelling a running job

A claimed job is supervised: the executor heartbeats its lease and watches for
a cancellation the owner requested after the claim.

```mermaid
sequenceDiagram
  participant O as Owner
  participant C as Coordinator
  participant E as Executor
  participant P as Pi agent
  O->>C: /job cancel
  C->>C: cancel_requested = 1 (state unchanged)
  E->>C: job heartbeat
  C-->>E: cancelRequested: true
  E->>E: abort the turn's wait
  E->>P: observe status (never keystrokes)
  alt agent idle / absent
    E->>C: cancel-ack terminated=true
    C->>C: cancelled, reservation released
  else agent still working
    E->>C: cancel-ack terminated=false
    E->>C: failure orphan_agent_still_working
    C->>C: reservation converted to orphan_agent
  end
```

The orchestration is **raced** against the signal rather than awaited first: a
real turn is a blocking `herdr agent prompt --wait`, so waiting it out would
mean a cancellation only landed after the wall-clock timeout.

Herdr offers no verified way to interrupt a Pi turn without risking a
half-written edit, so nothing is ever typed into a live pane. Termination is
only ever *reported* when it is *observed* — a false positive here would
release the repository while a writer was still running. The executor's writer
lock is likewise held until a stop is confirmed, so a retry on that host cannot
start a second writer beside a live agent.

## Workspace cleanup

A workspace is closed only after a **terminal success**. A job awaiting an
owner answer or an approval keeps its workspace, so the work stays inspectable
and the next round can reuse the same Pi session; a failed or orphaned job
keeps it for the owner to look at.

Cleanup proves ownership again at the point of closing — the workspace must be
the one recorded for that job and carry the Ducky label, and a still-working
agent blocks the close — so a user's workspace can never be closed even if a
wrong id reached it.

## Durable workspace ownership

The executor registers a workspace with the coordinator as soon as it exists
and **before** any agent is started in it. Without that record, an executor
crash between creation and the first prompt would leave a live Ducky agent that
the next claim could not recognise — it would report `foreign_agent_conflict`
and release the reservation underneath it.

Registration is idempotent, lease-checked, and refuses to re-point a workspace
at a different job. A conflict reported while we hold a registered workspace
converts the reservation to `orphan_agent` rather than releasing it.

## Crash recovery

A lease can expire while a Ducky-owned Pi agent is still working. Handing the
repository to another job would create a second writer, so instead:

- the reconciler moves the job to `waiting_for_executor`, **keeps** the
  reservation, and sets `recovery_required`;
- on the next claim the executor inspects the recorded agent read-only and
  branches:

| Observed | Action |
|---|---|
| absent | normal path: discover, else create |
| `idle` / `done` | read the existing `result.json` first — a finished turn whose report was lost is submitted, not re-run |
| `working` | **reattach and poll**, never restart; on timeout fail closed as `orphan_agent_still_working` |
| `blocked` | never answered automatically; `orphan_agent_blocked` |
| ownership unprovable | touch nothing; `foreign_agent_conflict` |

Ownership requires **all three**: the `ducky-pi-` agent-name prefix, the
`ducky-mgd:` workspace label, and a row in `herdr_workspaces` — the last being
authoritative. This host already has a user workspace labelled exactly `ducky`,
so a label alone proves nothing.

## Data model

```mermaid
erDiagram
  repos ||--o{ jobs : "slug"
  repos ||--o| repo_reservations : "one per repo"
  jobs ||--o{ job_transitions : ""
  jobs ||--o{ job_events : ""
  jobs ||--o{ job_owner_inputs : "one per round"
  jobs ||--o{ job_results : "one per executor turn"
  jobs ||--o{ approvals : "one per proposed action"
  jobs ||--o{ job_dependencies : "at most one open"
  executors ||--o{ executor_credentials : "one per key id"
  captures }o--|| owner : ""
  schedules }o--|| owner : "only after confirmation"
  tasks }o--|| owner : ""
  tasks ||--o{ reminders : "deadline offsets, ON DELETE CASCADE"
  task_previews }o--|| owner : "pasted list, until it is kept or dropped"
  reminders }o--|| owner : ""
  reminders ||--o{ reminder_occurrences : "one per due occurrence"
  github_watches }o--|| owner : ""
  github_watches ||--o{ github_watch_events : "meaningful changes"
  github_feed_repos ||--o{ github_feed_cursors : "one per kind; baseline, backoff"
  github_feed_repos ||--o{ github_feed_events : "UNIQUE event_key = the dedup"
  github_feed_repos ||--o{ github_feed_commits : "(repo, sha); consumed by a digest"
  github_feed_digests }o--|| owner : "one slot per owner, local day, target"
```

`github_feed_*` references nothing, `repos` included: a selected repository is an
`owner/repo` identity, not an allowlist entry. `github_feed_events` holds every
event once, as `baseline` (history seen at first watch, never delivered),
`pending`, or a settled state; its UNIQUE `event_key` is the whole
deduplication. A cursor row exists per (scope, kind) and carries its own
baseline, watermark, backoff and failure count, so one kind failing delays only
itself. Retention never removes the selected list or a cursor (both are on
`RETENTION_FORBIDDEN_TABLES`).

`job_results` holds one immutable row per executor turn, keyed by
`(job_id, lease_id)`, with the sanitized snapshot and the proposed actions. An
`AFTER UPDATE` trigger aborts any attempt to mutate it. Approvals are derived
rows; the snapshot is the record of truth.

`schedules` is the only table that ever holds schedule content, and only after
explicit confirmation — pending previews live in memory alone. Its `starts_at`
holds the wall-clock text the owner typed rather than a UTC instant, and is
read back as a wall clock in the configured owner timezone; it is never
rewritten (see [decisions/0014](decisions/0014-single-owner-timezone-as-a-projection.md)).

`tasks` and `reminders` are the daily assistant's records, owner-only in full
with no shared projection. `reminder_occurrences` is the durable delivery
outbox: one row per occurrence that has come due, unique on
`(reminder_id, occurrence_no)`, carrying `delivered_at`, an attempt count and
an `abandoned_at`. It is the same shape as `job_notification_deliveries` and
for the same reason — recording a delivery must be idempotent, and a failure
must be retryable without being re-sendable.

`reminders.next_fire_at` is the single scheduling cursor. Materializing an
occurrence and advancing that cursor happen in one transaction guarded by a
compare-and-set on `fired_count`, which is what makes a repeated or overlapping
tick advance a recurrence exactly once. Recurrence is bounded by construction:
`interval_minutes` with `max_occurrences`, enforced by CHECK constraints, and
there is no cron column
(see [decisions/0013](decisions/0013-bounded-reminder-recurrence-and-catch-up.md)).

`reminders.task_id` is the recorded link between a deadline and the
notifications it owes. It is a column rather than an inference from text:
matching reminder text against task titles would make two tasks with the same
name cancel each other's notifications. `ON DELETE CASCADE` means a deleted
task cannot leave a reminder pointing at nothing — though both `/forget task`
and the retention sweep delete the children explicitly and COUNT them, because
a deletion that reports "1 row" while removing five is a count that lies.

`task_previews` is the only durable staging area in the system, and it exists
because the phone parses on one request and saves on the next: an in-memory
draft would not survive the gap. It holds the owner's parsed items **only while
pending**, clears them the moment it settles, and keeps the public ids a save
produced so a retry replays instead of writing a second set. The reconciler
sweeps expired and settled rows on every pass, so the table is bounded whether
or not retention is configured
(see [decisions/0025](decisions/0025-owner-authenticated-phone-capture-on-the-tailnet.md)).

`github_watches` stores the owner's explicit interval and the latest
normalized, redacted snapshot; `github_watch_events` is a durable owner-DM
outbox keyed by its snapshot fingerprint. Raw GitHub payloads, usernames and
API responses are not stored.

## Work phases and dependency waits

`jobs.state` says who owns a job and what may touch it. `jobs.work_phase` --
`preparing`, `planning`, `implementing`, `reviewing`, `fixing`, `verifying` --
says what the agent is doing. They are **orthogonal on purpose**: every
single-writer guarantee (the partial unique index, the lease-expiry sweep, the
supervised cancel branch, the claim predicate) is keyed on
`state = 'running'`, and `running` is still the ONLY lease-bearing state.
Splitting it into six would have meant rewriting all of them
(see [decisions/0016](decisions/0016-work-phases-dependency-waits-and-audit.md)).

A phase is set on claim, moved by an allowlisted `phase` on the executor's job
heartbeat, validated against an exhaustive phase machine, idempotent for a
repeated report, and **cleared** whenever the job stops being lease-bearing --
so a paused job can never render a stale phase.

`waiting_on_dependency` IS a real state, because it has behaviour nothing else
has: **the lease is released and the repository reservation is retained.**
Nothing is being written, so a lease would only look stalled to the sweep; but
the job has already worked in that repository and expects to resume, so nothing
else may start there.

```mermaid
stateDiagram-v2
  running --> waiting_on_dependency: result waiting_on_dependency
  waiting_on_dependency --> queued: checker says ready
  waiting_on_dependency --> failed: checker says it will not happen
  waiting_on_dependency --> needs_owner_input: bounded check budget spent
  waiting_on_dependency --> cancelled: owner cancels
```

`job_dependencies` is the schedule: a closed type enum, a `next_check_at`
cursor, and TWO independent ceilings (`max_checks` and `deadline_at`). The
schema requires a waiting row to have a cursor and a resolved one not to, so
"is anything still being polled?" is a fact of the row. The dependency, the
result snapshot and the transition are one transaction.

`DependencyResolver` rides the **existing coordinator interval** -- no second
scheduler and no per-dependency timer -- with a bounded batch, a
compare-and-set on the check count, bounded exponential backoff and a
re-entrancy guard. A checker that throws still spends a check, so a broken one
cannot buy unlimited retries.

**The shipped checker never reports ready.** `UnavailableDependencyChecker`
answers `pending` for everything, because nothing on this host can observe a CI
run or a registry. A wait therefore expires to `needs_owner_input` rather than
being resumed on a check that did not happen, and a `ready` from an unverified
checker is downgraded rather than believed.

## Command policy

`COMMAND_POLICY` classifies every `gh`, `git` and `herdr` operation as
`read_only`, `local_mutation`, `external_mutation` or `high_risk`. Ordinary
workspace inspection has a `local_mutation` ceiling; only the explicit,
owner-approved action performer may opt into the narrow external entries.
Force, hook-bypass and high-risk commands remain refused.

Two independent gates: the frozen argv table decides what can be
*constructed*, `checkCommandAllowed` decides whether what was constructed may
*run*. An unclassified command is refused rather than allowed by default, and
`FORBIDDEN_COMMAND_VERBS` (`push`, `reset`, `clean`, `rm`, `exec`, `auth`, …)
is checked first and independently of the table.

## The audit log

`audit_log` is a structured RECORD and never an authority. It is written from
`JobsRepo.transition` -- the single point of state change, so coverage is
structural -- plus creation, claim, phase change, cancellation, failure,
approval decisions, executor connect/offline and every dependency event.

Nothing reads it to decide anything, asserted by a test. It holds no secret, no
raw authentication material, no terminal output and no environment; the owner
is recorded as the role `owner` rather than a Discord id, because there is
exactly one and the id would be unnecessary personal data in a long-lived
table. Details are redacted and clamped, recording never throws, and the
reconciler prunes past the retention window so the table stays bounded.

## The assistant tick

The daily assistant has **no scheduler of its own**. `ReminderNotifier.tick()`
and `GitHubWatchService.tick()` run on the coordinator's existing interval,
beside `Reconciler.run()` and `JobNotifier.deliverPending()`, and each is
isolated: a failure in one never blocks the others. A tick materializes what
has come due, then delivers what is outstanding, and is re-entrancy guarded so
two overlapping passes cannot both read an occurrence as undelivered.

A task's deadline schedules its own reminders through the same tick: 24 hours
and 1 hour before a timed deadline, 08:00 on the day of a date-only one, with
any offset already in the past skipped rather than fired. Closing a task
withdraws its pending occurrences; moving its deadline re-derives them in the
same transaction as the move
(see [decisions/0026](decisions/0026-deadline-linked-reminders-and-plain-cards.md)).

`GitHubFeedService.tick()` rides the same interval. It reads GitHub through the
read-only `GitHubReader` port (one unit per repository and kind, each with its
own cursor, baseline and backoff), records what it saw before anything is
delivered, and delivers from the record: alerts as they are observed, one
commit digest per local day. It holds no model provider, so a paused
subscription quota does not stop it. See
[decisions/0029](decisions/0029-github-feed-and-the-delivery-only-github-channel.md).

The consequence is a worst-case reminder/watch lateness of one
`DUCKY_RECONCILE_INTERVAL_MS`, visible in configuration rather than hidden in a
timer table, and nothing scheduled in memory to be lost on restart. GitHub
snapshots are normalized and unchanged snapshots do not generate a DM.

## Decisions

See [decisions/README.md](decisions/README.md).
