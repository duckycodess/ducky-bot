# ADR 0026 — Deadlines that remind, and cards that say only what the owner asked for

**Status:** accepted
**Extends** [ADR 0013](0013-bounded-reminder-recurrence-and-catch-up.md) (bounded
recurrence and the collapsing catch-up) and **narrows**
[ADR 0014](0014-single-owner-timezone-as-a-projection.md) in one specific place,
stated plainly below.

## The problem

Three separate complaints, one shape:

1. **A deadline owed nothing.** `due_at` was a column nobody acted on. The
   owner had to remember to ask.
2. **A date-only task was overdue from midnight.** A date is stored as that
   day's local midnight, and "overdue" compared it to `now` — so a task due
   *today* was listed as late at 00:00:01 on the day it was due. The overdue
   section was wrong every morning, which is exactly when it was read.
3. **Reminders arrived as DMs, and the cards explained themselves.** A draft
   card carried a "Reminder: 1 hour before" line and a timezone suffix. Both
   were rejected: when Ducky speaks is Ducky's business, and the owner knows
   what timezone they live in.

## The decision

### A deadline schedules its own reminders, through a recorded link

A timed deadline earns reminders 24 hours and 1 hour before it. A date-only
deadline earns one at 08:00 on the day itself — a date carries no time, so
there is no offset to subtract, and midnight is a notification nobody reads.

**An offset already in the past is skipped, not fired.** Saving a task an hour
before it is due must not produce a "due in 24 hours" message, and a date-only
task saved at 10am must not announce an 08:00 that has gone. The save succeeds
with fewer reminders; the deadline is the real record.

The link is a **column** (`reminders.task_id`), never an inference from text.
Matching reminder text against task titles to decide what to cancel would make
two tasks called "Letters" cancel each other's notifications.

Closing a task withdraws its pending reminders and abandons any undelivered
occurrence. Moving its deadline cancels and re-derives them in the same
transaction as the move. Snooze adds one bounded one-shot and leaves `due_at`
exactly where it was — a snooze that quietly rescheduled a real deadline would
be the most damaging kind of convenience.

### Linked reminders are plumbing, and are not listed as reminders

`/reminder list` and the briefing's reminder sections show only what the owner
set **themselves**. A deadline earning two rows would otherwise bury the three
reminders they actually typed, and the briefing would name the same task twice
— once as due, once as a reminder about being due. The cap still counts every
row, because a linked reminder really does occupy the scheduler.

### Overdue has two meanings, and both are correct

A **timed** deadline is late once its instant has passed: a 09:00 task at 17:00
is overdue, and saying otherwise would be wrong. A **date-only** deadline is
late once the day it names has **ended**. The caller passes the start of the
current local day alongside `now`, because SQLite has no timezone and computing
the boundary in SQL would also be wrong across a DST change.

### The card: title, deadline, three buttons

Nothing else. No timezone label, no schedule line, no internal UUID, and no
action words pretending to be controls.

**This is the one deliberate departure from ADR 0014.** That ADR prefers
Discord timestamps (`<t:…:f>`) because they render in each reader's own zone
and a stored message stays correct as time passes. On a card it is the wrong
default twice over: the owner asked to see the deadline **they typed**, back in
the words they typed it in, and the tag renders differently for every reader of
a channel. So `formatDeadline` assembles the string by hand from numeric parts
and a hand-held month table — no ambient locale, no zone suffix, identical on
every host. ADR 0014's rule stands everywhere else, including the reminder DM
for a free-standing reminder.

### Where a task reminder is delivered

To a configured reminders channel with the owner's mention, when one exists;
otherwise to the DM every reminder has always used. **Only task-linked
reminders are ever routed there**: a free-standing reminder is personal data
with no shape worth posting where somebody else may read it.

The controls on a card in that channel are signed, owner-bound, re-checked
server-side, and additionally signed over the task's `updated_at` — so a card
whose deadline has since moved stops acting instead of acting on a state the
owner is no longer looking at. **Visibility is not authorization**, exactly as
in ADR 0012 and ADR 0023: a reader who presses a control is refused.

## Alternatives considered

- **Configurable offsets.** Rejected for now: two numbers nobody tuned beats a
  settings page, and the shape leaves room for one later.
- **A reminder at the deadline itself.** Rejected: the owner asked for notice,
  not for an announcement that the moment has arrived.
- **Inferring the link from text.** Rejected, see above.
- **Keeping the overdue comparison and showing date-only tasks differently.**
  Rejected: the data was wrong, not its rendering.
- **Posting every reminder in the channel.** Rejected: a free-standing reminder
  is private and has no safe projection.

## Consequences

- An outage still collapses to one message per reminder (ADR 0013), and a late
  one is still delivered rather than dropped. The ledger's send/acknowledge
  crash window is unchanged, and **nothing here claims exactly-once Discord
  delivery**.
- Deleting a task takes its reminders with it, counted rather than cascaded
  silently, through both `/forget task` and the retention sweep.
- Five new interaction kinds exist. They are on `OWNER_ONLY_INTERACTION_KINDS`,
  asserted never to be shared-readable, and no new slash command was added:
  `OWNER_ONLY_COMMANDS` is byte-for-byte what it was.
