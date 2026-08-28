# 0016. Work phases beside the state machine, bounded dependency waits, and a structured audit log

**Status:** Accepted

## Context

Phase 1's job lifecycle is correct but coarse. `running` covers everything from
"resolving the workspace" to "re-running verification after a review finding",
so the owner sees one undifferentiated state for what can be an hour of very
different work. And it has no answer at all for the commonest real-world
interruption: the work cannot continue *yet*, because something outside this
system has to happen first — a CI run, a package publish, someone merging
another pull request.

Today an executor in that position has three bad options: fail (losing the
work and the reservation), ask the owner a question that is not really a
question, or sit in `running` holding a lease it cannot renew meaningfully.

Two smaller gaps came with it. The safety of every subprocess surface was a
property you established by *reading* the frozen argv tables, not one you could
assert. And there was no structured record of what happened — `job_events` and
`job_transitions` are per-job, and `authorized_user_audit` is a single narrow
trail.

## Decision

### Work phases are a second dimension, not six new job states

The engineering loop — `preparing`, `planning`, `implementing`, `reviewing`,
`fixing`, `verifying` — is persisted as `jobs.work_phase`, orthogonal to
`jobs.state`.

**`running` remains the only lease-bearing state.** That is deliberate, and it
is the main judgement call in this batch. Every single-writer guarantee is
keyed on that one value:

- `ux_jobs_one_running_per_repo`, the partial unique index that is the
  secondary invariant behind the reservation;
- `expiredLeases()`, the sweep that recovers a dead executor;
- the `running` branch of `requestCancel`, which is what makes a cancellation
  of live work supervised rather than optimistic;
- `nextClaimable()`.

Promoting six phases to job states would have meant rewriting all four, plus a
migration that drops and recreates the crown-jewel index. That is a Phase 1
rewrite, and this batch is explicitly not one. Splitting the dimension gets the
same product outcome — the owner sees "Working — reviewing", progress reports
genuinely move the job — with none of that risk.

These are not dead labels:

- a claim sets `preparing`, so a running job always has a phase;
- an executor moves it through `JobHeartbeatRequest.progress.phase`, an
  **allowlisted enum** rejected at the HTTP schema;
- the edge is validated against an exhaustive phase machine, so a report cannot
  walk backwards from `implementing` to `planning`;
- reporting the same phase is an idempotent no-op, because a retried heartbeat
  is ordinary traffic;
- the phase is CLEARED whenever the job stops being lease-bearing, so a paused
  or finished job can never render a stale `verifying`;
- `ownerDetailedLabel` shows it privately, and the shared projection has no
  field that could carry it.

### `approved` and `executing_approved_action` are deliberately NOT added

They would be dead. The action performer is deliberately unimplemented
([ADR 0006](0006-approval-gate-deferred-performer.md)), so
`executing_approved_action` has nothing that could enter it, and `approved`
would be a state every job passes through in the same transaction that leaves
it. Adding a state whose only purpose is to appear in a diagram is precisely
the "dead label" this batch was asked to avoid. They belong with the batch that
implements the performer, where they will have behaviour.

### `waiting_on_dependency` IS a real job state

It has behaviour that no existing state has: **the lease is released, the
repository reservation is retained.**

That combination is the whole point. Nothing is being written, so holding a
lease would only make the job look stalled to the expiry sweep. But the job has
already done work in that repository and expects to resume, so another job must
not be allowed in behind it — exactly the reasoning `needs_owner_input` already
follows.

It is reachable only from `running`, and leaves in exactly four ways: `queued`
(resumed), `needs_owner_input` (we gave up checking), `failed`, `cancelled`.

### A dependency is a bounded schedule, written transactionally

`job_dependencies` holds a closed shape: type from a six-value enum, a
description, an optional opaque `external_key`, a `next_check_at` cursor, and
**two independent ceilings** — `max_checks` and `deadline_at`. There is no way
to express "check forever", and the schema enforces that a waiting row has a
cursor and a resolved one does not.

The executor **proposes**; the coordinator **decides**. Values outside the
ceilings are refused by the contract outright rather than silently clamped, and
absent ones get conservative defaults rather than "forever".

The dependency row, the result snapshot and the state transition are one
transaction. A job in `waiting_on_dependency` with no dependency row would hold
a reservation with no cursor and never resume; the two cannot exist apart.

### The resolver cannot poll forever, and never guesses

`DependencyResolver` runs on the **existing coordinator interval** — no second
scheduler, no per-dependency timer — with a bounded batch per pass, a
compare-and-set on the check count, and a re-entrancy guard.

Four outcomes:

| checker says | job goes to | reservation |
|---|---|---|
| `ready` | `queued`, and it re-claims its own repository | retained, fresh TTL |
| `failed` | `failed` | released (unless orphaned) |
| `pending`, budget left | stays put, rescheduled with bounded exponential backoff | retained |
| `pending`, budget spent | `needs_owner_input` | retained until the owner acts |

A checker that throws or hangs is treated as `pending` **and still spends a
check**, so a broken checker cannot buy unlimited retries by failing.

**The default production behaviour never claims readiness.**
`UnavailableDependencyChecker` ships as the only checker and answers `pending`
for everything, because nothing on this host can observe a CI run or a package
registry. A dependency wait therefore runs out its budget and lands at the
owner's desk — "I held your repository, I could not confirm this, over to you"
— which is a real, useful outcome and is not the same as pretending to have
looked. A `ready` from an **unverified** checker is downgraded to `pending`
rather than believed.

### A central command policy, classifying every subprocess surface

`COMMAND_POLICY` classifies every `gh`, `git` and `herdr` operation as
`read_only`, `local_mutation`, `external_mutation` or `high_risk`, with
`MAX_ALLOWED_COMMAND_CLASS = local_mutation` in this phase. `gh-cli` and the
executor's `git` helper both consult `checkCommandAllowed` before spawning.

Two independent gates: the frozen argv table decides what can be
*constructed*, the policy decides whether what was constructed may *run*. An
unclassified command is a refusal, not a default-allow, so a new surface has to
be classified deliberately. `FORBIDDEN_COMMAND_VERBS` (`push`, `reset`,
`clean`, `rm`, `exec`, `auth`, …) is checked first and independently.

Writing it caught a real thing: it made the `git` surface enumerate itself, and
every entry turned out to be genuinely read-only.

### The audit log is a record, never an authority

`audit_log` is written from the single point of state change (`JobsRepo.transition`,
so coverage is structural) plus job creation, claim, phase change, cancellation,
failure, approval decisions, executor connect/offline, and every dependency
event.

The rules that make it safe to write liberally:

- **Nothing reads it to decide anything**, asserted by a test. Authorization is
  frozen environment configuration ([ADR 0009](0009-env-config-sole-authorization-authority.md))
  and the lifecycle is the `jobs` table.
- **No secret, no raw authentication material, no terminal output, no
  environment.** Details are constructed from fixed strings and
  already-redacted values, then clamped.
- **The owner is `owner`, not a Discord id.** There is exactly one owner, so
  the id adds nothing an auditor could use and would be unnecessary personal
  data in a long-lived table. Executor ids are kept: not secret, genuinely
  identifying.
- **Recording never throws.** A job rolled back because bookkeeping failed
  would be worse than a job that ran correctly and was not written down.
- **Bounded retention**, pruned by the reconciler in batches. It is the one
  table that would otherwise grow for as long as the system runs.

One subtlety found while testing: a REFUSED phase change is audited *outside*
the transaction, because recording it inside would roll the row back along with
the rejected write — losing exactly the record worth keeping.

## Consequences

- The single-writer guarantees are byte-for-byte unchanged. A test asserts
  `LEASE_BEARING_STATES` is still exactly `['running']`, and that the partial
  unique index still refuses a second running job while ignoring a dependency
  wait.
- A job can now hold a repository for up to `DEPENDENCY_MAX_WAIT_MS` (24h)
  without an executor. The reservation TTL is deliberately longer than that, so
  the sweep cannot fail a job that is still on schedule — and if it ever does
  fire, that is a bug and the job fails loudly rather than having its
  reservation quietly renewed.
- `waiting_on_dependency` appears in the shared projection as
  "Paused — waiting on something else", with the shared next-step copy stating
  the detail is private.
- Nothing external is called or written. The performer is still deferred; the
  dependency checker is a port with no real implementation.

## Follow-up

A real `DependencyChecker` — the obvious first one reads GitHub check runs
through the existing read-only `gh` surface — is its own batch, and must be
verified against the live host before it may report `ready`. Executing approved
actions, and the `approved` / `executing_approved_action` states that go with
it, is a separate batch again.
