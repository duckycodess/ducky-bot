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
   `DUCKY_RETENTION_TERMINAL_JOBS_DAYS=100000` — and read the `retention.pruned`
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

| Window | Configurable | Default |
|---|---|---|
| terminal jobs | `DUCKY_RETENTION_TERMINAL_JOBS_DAYS` | 180 d |
| closed assistant records | `DUCKY_RETENTION_CLOSED_ASSISTANT_DAYS` | 365 d |
| settled watch events | `DUCKY_RETENTION_WATCH_EVENTS_DAYS` | 90 d |
| idempotency keys | `DUCKY_RETENTION_IDEMPOTENCY_DAYS` | 7 d |
| batch size | `DUCKY_RETENTION_BATCH` | 200 |
| **cancelled watches** | **fixed** | 365 d |
| **retention's own run log** | **fixed** | 365 d |
| audit log | fixed (`AUDIT_RETENTION_MS`) | 90 d |

The last three are deliberately not configurable. None holds owner content
anybody would want to tune, and every extra knob is another way to misconfigure a
destructive feature. A test asserts they stay at the defaults whatever the
environment says.

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
/forget target:job id:<public job id>
/forget target:conversation
```

`/forget job` shows what will go and returns a confirm control; only pressing it
deletes. It refuses, and says which, when the job is still running, still holds
its repository, still has an open workspace, has a pending approval, or is
waiting on a dependency — each of those means something is still live, and one
of them (an open workspace) means uncommitted work is sitting on disk.

An unknown id and an id belonging to somebody else are answered identically.
**There is no bulk form.** The contract cannot express one.

`/forget conversation` reports that nothing is stored: replies are not
persisted, there is no transcript table, and no attachment byte has ever been
kept. It exists so the answer is a statement of fact rather than a missing
command, and so it is the obvious place to hook real deletion if a future
provider retains history.

## What cannot be deleted from here

Messages Ducky posted into a **shared channel** persist in Discord's history.
Ducky will not remove them: that needs a Manage Messages permission the bot
deliberately does not hold. If that history matters, lock the channel down or
delete the messages by hand.
