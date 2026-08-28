# 0022 — Per-kind retention windows, and deleting one record

## Status

Accepted. Retention still ships **disabled**.

## Context

ADR 0020 gave retention two windows: 180 days for anything hanging off a
terminal job, 365 for everything the assistant had finished with. That was the
right shape to start from and the wrong resolution to stop at, for two reasons.

**One number for several kinds of record means choosing which to get wrong.** A
job's *shape* (it ran, in this repository, and failed) and a job's *detail* (the
summary, the review notes, the verification output, the changed files) do not
deserve the same lifetime: the detail is the most specific thing Ducky stores
about a repository, and it is the part a later question almost never needs. The
same is true across the assistant: a finished task, a fired reminder and a past
schedule entry were sharing 365 days because they happened to be in one bucket.

**The owner could delete a job and nothing else.** `/forget job` existed;
`/forget task`, `/forget capture` and `/forget schedule` did not, so the only way
to remove one task was to wait for a retention window that was off by default.

## Decision

### Every kind of record gets its own window

| Record | Window | Variable |
|---|---|---|
| Job metadata — the row, transitions, delivery ledger | 90 d | `DUCKY_RETENTION_JOB_METADATA_DAYS` |
| Job detail — result snapshot, events, owner answers | 30 d | `DUCKY_RETENTION_JOB_DETAIL_DAYS` |
| Done / archived captures | 365 d | `DUCKY_RETENTION_DONE_CAPTURE_DAYS` |
| Done / cancelled tasks | 90 d | `DUCKY_RETENTION_CLOSED_TASK_DAYS` |
| Finished / cancelled reminders and their occurrences | 90 d | `DUCKY_RETENTION_CLOSED_REMINDER_DAYS` |
| Past confirmed schedule entries | 180 d | `DUCKY_RETENTION_PAST_SCHEDULE_DAYS` |
| Audit log | 90 d | `DUCKY_RETENTION_AUDIT_DAYS` |
| Settled GitHub watch events | 90 d | `DUCKY_RETENTION_WATCH_EVENTS_DAYS` |
| Idempotency keys | 7 d | `DUCKY_RETENTION_IDEMPOTENCY_DAYS` |
| Conversation turns — owner / guest | 30 d / 7 d | `DUCKY_RETENTION_CONVERSATION_*_DAYS` |
| Cancelled watches, retention run log | 365 d | fixed, deliberately not configurable |

**Job detail is pruned before the job.** This is safe because every reader
already treats a missing result as normal — a queued job has none — so
`JobsService.detail` and the shared projection both handle its absence without a
presenter pretending otherwise. The count is reported separately
(`jobDetailRowsDeleted`) from the child rows of jobs that went entirely: adding
them together would hide the fact that a job survived while its detail did not.

**Delivery ledgers follow their parent.** A job's notification rows are part of
the job unit and go with it at 90 days; a reminder's occurrence outbox goes with
its reminder at 90. Neither has a window of its own to get out of step.

**The two Phase-2 variables are kept as deprecated aliases.**
`DUCKY_RETENTION_TERMINAL_JOBS_DAYS` maps onto the job-metadata window and
`DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS` onto the four assistant ones. An
operator who set one expressed an intent, and silently ignoring a variable still
sitting in their env file is worse than either honouring it or refusing it. An
explicit new value always wins.

### The owner can delete one record of any kind

`/forget` gains `capture`, `task`, `reminder` and `schedule` alongside `job` and
`conversation`. These are **choices on a command that was already owner-only** —
no command is added, no interaction kind is added, and the owner-only surface is
not widened, which `AGENTS.md` forbids.

- **Two steps.** The command shows what will go and returns a signed control
  bound to the owner; only pressing it deletes.
- **With no id it LISTS** the owner's records with the ids they can type, as a
  plain read with no controls — a row of delete buttons is how somebody removes
  the wrong thing. Discovery lives inside `/forget` so that captures and
  schedule entries, which have no short public handle, are reachable without
  adding a command.
- **Captures and schedule entries are named by an id PREFIX** — the first 8
  characters, which is exactly what `/inbox` already displays. An ambiguous
  prefix is refused rather than resolved: guessing which record the owner meant
  is the one behaviour a deletion path must never have.
- **Every statement is owner-scoped in its WHERE clause**, not checked
  beforehand. A lookup followed by a delete is two statements that can disagree,
  and the id arrived in a message.
- **Not guarded the way a job is, deliberately.** A job can be live in ways that
  make deletion destructive — a held repository, an open workspace holding
  uncommitted work — so it has six guards. A capture, a task, a reminder and a
  schedule entry cannot be live in any such way.
- **A reminder takes its occurrence outbox with it**, child-first, through the
  same code the scheduled pass uses.
- **Audited by count.** The subject reference is the kind and the id; never the
  title, the text or the content.

### What did not change

- Retention is still **off by default**, still batched, still idempotent, still
  skips any job that is live in any sense and counts the skip.
- `RETENTION_FORBIDDEN_TABLES` is unchanged: `repos`,
  `authorized_user_audit`, `executors`, `executor_credentials`,
  `repo_reservations` and `schema_migrations` have no delete path at any layer.
- **No bulk wipe, at any layer.** `FORGET_TARGETS` still cannot express one:
  every target names one record, except `conversation`, which means one person's
  own conversation.
- **Shared channel history is still not ours to delete.** Removing a projection
  message needs a Manage Messages write the bot deliberately does not hold.
  Recorded as a residual, not an open question.
- Raw and derived attachment data remains immediate and record-scoped: no byte
  is kept and none is derived, so there is nothing to age out.

## Consequences

- The audit log now has one owner: retention prunes it on its own configurable
  window, and the reconciler keeps its existing fixed prune so an instance with
  retention disabled still bounds it.
- A signed `forget_confirm` control now carries `kind.id` rather than a bare job
  id. The separator is `.` and not `:` because the custom id is itself
  colon-delimited and parsed as exactly five segments — a colon there silently
  invalidated the signature, and the egress sanitizer dropped the button before
  it could render. A control minted before this change still works: no separator
  means a job.
