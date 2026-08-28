# 0013. Bounded reminder recurrence, and a collapsing catch-up after an outage

**Status:** Accepted

## Context

Milestone 2B adds reminders the assistant delivers on its own. Two questions
had to be answered before any of it could be written, and the roadmap marked
both as unresolved rather than guessing:

- **Recurrence grammar.** Fixed intervals only, or a cron-like expression?
- **Missed-reminder policy.** After the host has been offline for a day: fire
  everything, fire only the most recent, or summarise?

They are not independent. An unbounded schedule makes the catch-up question
much worse: a cron expression that fires every fifteen minutes and a two-day
outage is 192 pending messages with no natural ceiling.

Ducky runs on a development workstation that is switched off, suspended,
rebooted and moved between networks. An outage is not an incident here; it is
the normal case. Whatever policy was chosen had to be correct on a Monday
morning after the machine had been shut since Friday.

## Decision

### Recurrence is a fixed interval with an explicit occurrence count

A reminder is either `once`, or `interval` with **both** an interval in minutes
and a maximum number of occurrences. Both are bounded at input
(`REMINDER_MIN_INTERVAL_MINUTES` … `REMINDER_MAX_INTERVAL_MINUTES`, up to
`REMINDER_MAX_OCCURRENCES`), and both bounds are enforced *again* by CHECK
constraints on the `reminders` table, so no code path — including a future one
— can write a schedule that never ends.

Omitting the count does not mean "forever". It means
`REMINDER_DEFAULT_OCCURRENCES`.

There is deliberately **no cron column**, so there is nothing for a later
change to grow one in.

### Catch-up collapses; it never storms and never silently drops

The tick applies five rules, in this order:

1. **Nothing fires early.** An occurrence is materialized only once its
   scheduled instant has passed.
2. **At most one message per reminder per tick.** However long the outage, a
   repeating reminder produces exactly one occurrence, standing for the most
   recent slot that came due.
3. **Skipped occurrences are counted and named.** The collapsed slots are
   recorded as `missed_count` on that occurrence, and the message says so:
   "24 earlier occurrences came due while the assistant was not running."
4. **A late reminder is still delivered.** It is never dropped for being
   stale. The Discord relative timestamp says how late it is.
5. **The recurrence advances exactly once.** Recording the occurrence and
   moving the `next_fire_at` cursor happen in one transaction, guarded by a
   compare-and-set on the fired count.

### Delivery reuses 2A's architecture rather than adding a second one

`reminder_occurrences` is the same shape of durable outbox
`job_notification_deliveries` is: a row exists from the moment an occurrence is
due, a unique key makes recording delivery idempotent, one failure is isolated
and retried on the next tick, and everything goes out through the same
`transport.send` choke point so `sanitizeOutbound` applies unchanged.

It rides the **existing coordinator interval**. There is no second scheduler,
no cron daemon and no per-reminder timer.

## Alternatives considered

**A cron expression.** Rejected. It is a parsing surface, a support burden and
an unbounded schedule in one field, and the owner cannot read one back and be
sure what it will do. A fixed interval with a count is something
`/reminder list` can state plainly: "every 2h, 3 of 10 sent".

**Fire every missed occurrence.** Rejected. Correct in the sense that nothing
is lost, and unusable in practice: a weekend off produces a wall of
notifications that gets muted, which loses far more than collapsing would.

**Fire only the most recent and say nothing.** Rejected. This is the collapse
without rule 3, and it is quietly dishonest — the owner cannot tell a reminder
that fired on time from one standing in for eleven that did not.

**Drop anything older than a grace window.** Rejected. Staleness is not the
same as irrelevance; a reminder missed over a long weekend is often exactly the
one that mattered. The relative timestamp already communicates lateness without
losing the message.

**A per-reminder `setTimeout`.** Rejected. Timers do not survive a restart,
which is the case that matters, and they would put an unbounded number of
scheduled callbacks in memory. The durable ledger plus one interval has neither
problem.

## Consequences

- Worst-case reminder lateness is one reconcile interval
  (`DUCKY_RECONCILE_INTERVAL_MS`, 30 s by default). This is visible in
  configuration rather than hidden in a timer table.
- A repeating reminder cannot be used as a high-frequency scheduler. That is
  intended; jobs are for work, reminders are for people.
- A reminder's occurrence numbering is not dense across an outage: a series can
  jump from occurrence 1 to occurrence 25. `missed_count` is what reconciles
  the two, and both are in the ledger.
- After `REMINDER_MAX_DELIVERY_ATTEMPTS` failures an occurrence is marked
  `abandoned_at` and stops being retried. It is not deleted: the row stays as a
  record of what came due and was never delivered.
- A reminder whose owner no longer matches the configured owner is abandoned
  rather than re-addressed. Authorization already never reads the database;
  neither does delivery.

## Follow-up

Retention of delivered and abandoned occurrences is open, and belongs with the
rest of milestone 2E rather than here.
