# 0020. Conservative retention, per-entity deletion, and no wipe-all

**Status:** Accepted

## Context

Only two things were ever pruned: `audit_log` at 90 days and `executor_nonces`
at expiry. The other 23 domain tables grew for the life of the instance, holding
the owner's task text, their answers to questions, whole result snapshots,
captures, schedules and reminder history. `captures.delete` was the single
deletion path in the codebase.

So the owner had no way to remove anything, and the database had no bound. Both
needed answering at once, because they are the same question from two ends.

## Decision

**Retention is off unless configured.** This deletes the owner's own records.
`DUCKY_RETENTION_ENABLED=false` means no window is consulted and nothing is
removed, so an operator has to choose retention rather than inherit it.

**Only finished things are ever in scope.** Every policy selects on a column
that exists *because* a record is closed — `finished_at`, `closed_at`,
`delivered_at`, `cancelled_at`, `confirmed_at`. For jobs that is not enough on
its own, so six independent guards refuse a job that is non-terminal, lacks a
`finished_at`, holds a repository reservation, has an open workspace, has a
pending approval, or has an open dependency.

**A refused job is counted, not swallowed.** A terminal job still holding a
reservation is an inconsistency somebody should look at. Retention reports
`jobsSkipped` and moves on; it does not tidy the symptom away.

**Six tables have no delete path at all**: `repos`, `authorized_user_audit`,
`executors`, `executor_credentials`, `repo_reservations`, `schema_migrations`.
Named in `RETENTION_FORBIDDEN_TABLES`, and tests assert the source of both the
repository and the service mentions none of them in a `DELETE`.

**Deletion order is explicit, not delegated.** Every foreign key into `jobs` is
`NO ACTION` on purpose, so a mis-scoped delete fails at the constraint instead
of silently taking half the database. The order matters in one non-obvious
place: a notification delivery row and its transition are removed **together**,
because pruning a transition while its delivery row survived would resurface it
as undelivered and DM the owner about a job that no longer exists.

**`/forget` is per-entity and two-step.** Owner-only, on the owner-only
manifest, never shared-readable. The command shows what will go and returns a
signed control bound to the owner; only pressing it deletes. An unknown id and
somebody else's id are answered identically, so it cannot be used to discover
that a job exists.

**There is no wipe-all path at any layer.** `FORGET_TARGETS` is
`['job', 'conversation']` — the contract cannot express "everything", so nothing
above it can offer one. `/forget job` requires an explicit id; there is no
plural form, no filter, no wildcard.

**Both paths share one implementation.** `RetentionRepo.deleteJobUnitGuarded` is
used by the scheduled pass and by `/forget`, so there is one deletion order and
one set of guards rather than two that drift.

**Every removal is audited by COUNT.** A deletion record that quoted what it
deleted would defeat the deletion.

## Alternatives considered

- **`ON DELETE CASCADE` on the job foreign keys.** Far less code. It also turns
  every mistake into a silent, large deletion, and removes the constraint that
  currently catches a wrong order.
- **Retention on by default with generous windows.** Would bound the database
  without an operator doing anything — and would delete the owner's history on
  an instance whose owner never asked for that.
- **A `/forget all` for convenience.** Rejected at the contract level rather
  than by not writing the handler, because "we just won't add the command" is
  not a guarantee.
- **Soft-delete with a restore window.** Genuinely safer for the owner, and it
  contradicts the point: a deletion request that leaves the data in place is not
  a deletion. The confirm step is the mitigation instead.
- **Deleting shared-channel projection messages.** Needs a Manage Messages
  write the bot deliberately does not hold. Recorded as a residual.

## Consequences

A default instance still grows without bound, because retention ships disabled.
That is the intended trade: an unbounded database is recoverable, deleted
history is not. The runbook says to copy the SQLite file before enabling it.

`/forget job` cannot be undone. The confirm step, the per-entity scope, and the
identical answer for unknown and foreign ids are the mitigations.

One further thing surfaced while wiring the audit events, and is recorded here
because it is a general hazard rather than a one-off bug: **`AuditLogRepo.record`
never throws**, so a value the TypeScript enum allows and the table's CHECK
constraint does not is dropped without a sound. Three new subject kinds hit
exactly that. Migration 13 widens the constraint, and a test now asserts every
declared event, actor kind and subject kind is genuinely persistable — because
the reason `record` cannot throw is also the reason nothing else would have
noticed.
