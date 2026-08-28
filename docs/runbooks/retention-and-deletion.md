# Runbook: retention and deletion

Two separate things. **Retention** is a scheduled sweep of finished records and
ships **disabled**. **`/forget`** is the owner deleting one named thing on
purpose, and is always available.

## Before enabling retention

Retention deletes the owner's own records. On a populated database:

1. **Copy the SQLite file.** Stop the coordinator, then copy
   `data/ducky-<profile>.db` (and its `-wal`/`-shm` siblings) somewhere else.
   There is no soft-delete and no restore.
2. Check what the current windows would remove. Set `DUCKY_RETENTION_ENABLED=true`
   with a deliberately huge window first — e.g.
   `DUCKY_RETENTION_JOB_METADATA_DAYS=100000` — and read the `retention.pruned`
   audit row and the `retention_runs` count for a pass that should delete
   nothing. If it deletes something, the windows are not what you think.
3. Then set the real windows.

Profiles share no database, so this is a **per-profile** decision. Enabling it
for development does nothing for production and vice versa.

## What a pass does

Rides the existing reconcile interval; there is no second scheduler. Each pass:

- takes at most `DUCKY_RETENTION_BATCH` rows per table, so a tick stays short
  and a pass that hits the cap resumes on the next one;
- removes each terminal job as a **unit** — the job row plus its transitions,
  events, owner inputs, result snapshot, approvals, dependencies, notification
  deliveries and closed workspace record — child-first, in one transaction;
- **skips a job whole** if anything about it is still live, and counts the skip;
- records the pass in `retention_runs` and in the audit log, with counts only.

## Reading a pass

```bash
sqlite3 data/ducky-development.db \
  "SELECT started_at, outcome, counts_json FROM retention_runs ORDER BY id DESC LIMIT 5;"
```

`jobsSkipped` above zero is worth looking at. A terminal job old enough to prune
but still holding a repository reservation or an open workspace means something
did not finish cleaning up — usually a worktree job whose checkout still holds
uncommitted work. Clear it with `/job cleanup <id>`; retention will take it on a
later pass.

## Windows: which are configurable

One window per KIND of record (ADR 0022), because a job's shape, a job's
detailed result, a finished task and a past schedule entry are not the same
thing.

| Window | Configurable | Default |
|---|---|---|
| job metadata — row, transitions, delivery ledger | `DUCKY_RETENTION_JOB_METADATA_DAYS` | 90 d |
| job **detail** — result snapshot, events, your answers | `DUCKY_RETENTION_JOB_DETAIL_DAYS` | 30 d |
| done / archived captures | `DUCKY_RETENTION_DONE_CAPTURE_DAYS` | 365 d |
| closed tasks | `DUCKY_RETENTION_CLOSED_TASK_DAYS` | 90 d |
| finished reminders and their occurrences | `DUCKY_RETENTION_CLOSED_REMINDER_DAYS` | 90 d |
| past confirmed schedules | `DUCKY_RETENTION_PAST_SCHEDULE_DAYS` | 180 d |
| audit log | `DUCKY_RETENTION_AUDIT_DAYS` | 90 d |
| settled watch events | `DUCKY_RETENTION_WATCH_EVENTS_DAYS` | 90 d |
| idempotency keys | `DUCKY_RETENTION_IDEMPOTENCY_DAYS` | 7 d |
| conversation turns — yours | `DUCKY_RETENTION_CONVERSATION_OWNER_DAYS` | 30 d |
| conversation turns — a chat-whitelist guest's | `DUCKY_RETENTION_CONVERSATION_OTHER_DAYS` | 7 d |
| batch size | `DUCKY_RETENTION_BATCH` | 200 |
| **cancelled watches** | **fixed** | 365 d |
| **retention's own run log** | **fixed** | 365 d |

The last two are deliberately not configurable: neither holds owner content
anybody would want to tune, and every extra knob is another way to misconfigure a
destructive feature. A test asserts they stay at the defaults whatever the
environment says.

**A job outlives its own detail.** At 30 days the result snapshot, the job events
and your answers go; the job row, its transitions and its delivery ledger stay
until 90. `/job status` on such a job shows its state and timings with no result
section — the same thing it shows for a job that has not produced one yet.

`DUCKY_RETENTION_TERMINAL_JOBS_DAYS` and `DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS`
are **deprecated but still honoured**, mapping onto the job-metadata window and
the four assistant windows respectively. An explicit new value wins. They are
not silently ignored, because a variable still sitting in an env file is an
intent somebody expressed.

## Schedules are the one time-zone-sensitive case

`schedules.starts_at` is bare WALL-CLOCK text in the owner's zone — `2026-09-01
09:00`, no zone, no offset (ADR 0014). So retention needs **two** conditions
before deleting one:

1. it was `confirmed_at` (a real UTC instant) longer ago than the window, and
2. the event itself is genuinely past in `DUCKY_OWNER_TIMEZONE`.

The SQL only does (1). The zone-aware test in (2) happens in TypeScript, where
the zone is known. A row whose stored text cannot be parsed is **kept** — the
presenter already falls back to showing raw text for those, and deleting
something we cannot interpret is the one outcome with no upside.

Changing `DUCKY_OWNER_TIMEZONE` therefore changes which schedules are eligible.
That is the same projection rule the rest of the assistant follows; it does not
rewrite any stored row.

## What retention never touches

`repos`, `authorized_user_audit`, `executors`, `executor_credentials`,
`repo_reservations` and `schema_migrations` have no delete path at all. Nothing
non-terminal, nothing open, and no active credential is ever in scope, whatever
the windows say.

Credentials are removed only by `pnpm executor:revoke-credential` — see
[credential-rotation.md](credential-rotation.md).

## `/forget`

```
/forget target:job       id:<public job id>
/forget target:task      id:<task id>
/forget target:reminder  id:<reminder id>
/forget target:capture   id:<first 8 characters of the capture id>
/forget target:schedule  id:<first 8 characters of the schedule id>
/forget target:conversation
```

**Omit `id` to LIST your records** with the ids you can type. That listing is a
plain read with no buttons — a row of delete controls is how somebody removes the
wrong thing. Captures and schedule entries have no short handle, so they are
named by the first 8 characters of their id, which is exactly what `/inbox`
already shows; a prefix that could mean two records is refused rather than
resolved.

Every one of these is a CHOICE on `/forget`, which was already owner-only. No
command and no interaction kind was added, so the owner-only surface is
unchanged.

`/forget job` shows what will go and returns a confirm control; only pressing it
deletes. It refuses, and says which, when the job is still running, still holds
its repository, still has an open workspace, has a pending approval, or is
waiting on a dependency — each of those means something is still live, and one
of them (an open workspace) means uncommitted work is sitting on disk.

An unknown id and an id belonging to somebody else are answered identically.
**There is no bulk form.** The contract cannot express one.

`/forget task`, `/forget reminder`, `/forget capture` and `/forget schedule`
delete one record each, and report the count. They are not guarded the way a job
is, deliberately: a job can be live in ways that make deletion destructive — a
held repository, an open workspace holding uncommitted work — and a note cannot.
A reminder takes its occurrence outbox with it.

`/forget conversation` deletes every stored conversation turn of every thread of
YOURS, and reports the count. It works even when continuity is switched off,
because rows an earlier run stored are still yours to remove; when nothing is
stored it says so. No attachment byte is involved either way — none is ever kept
and none is ever derived.

## What cannot be deleted from here

Messages Ducky posted into a **shared channel** persist in Discord's history.
Ducky will not remove them: that needs a Manage Messages permission the bot
deliberately does not hold. If that history matters, lock the channel down or
delete the messages by hand.
