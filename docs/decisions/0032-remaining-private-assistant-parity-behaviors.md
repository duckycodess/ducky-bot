# ADR 0032 — Remaining private-assistant parity behaviors

**Status:** accepted
**Extends** [ADR 0030](0030-private-assistant-migration-and-parity-capabilities.md)
and [ADR 0031](0031-typed-notification-watch-reads.md); supersedes nothing.

## Context

Full parity is settled (2026-10-13). After the typed watch reader, the remaining
accepted behaviors from the private semantic audit are small and each has a design
decision of its own. Every one is derived from the audit's language-independent
contract, never from private source, and every one respects the existing owner-only,
privacy, profile and transport boundaries.

## Decisions

### `urgent` and task categories are columns beside the old ones

The source's priorities are low, normal, high and urgent; its categories are school
and personal. `tasks.priority` has a CHECK that cannot be widened without rebuilding
`tasks`, and a rebuild is unsafe here: `reminders` references it with `ON DELETE
CASCADE`, and the project already recorded (migration 20) that a parent with foreign-key
children cannot be dropped inside a migration. So an urgent task is stored as priority
`high` with `urgent = 1`, and the category is a nullable column with its own CHECK.
Lists order urgent above high, the lookahead treats high-or-urgent as its first tier, and
a task line shows urgent and the category. No native command sets either, and the task
command definitions are unchanged: only an import carries them.

### The source's briefing staleness rule, only for imported preferences

Natively a pending briefing is stale after six hours. The source's rule is different: a
morning briefing is due until the evening time and is then recorded skipped (never sent
late as a morning greeting); an evening briefing is due until the end of its day; nothing
survives into a later day. It applies when the profile selects imported preferences
(`DUCKY_IMPORTED_PREFERENCES`), because those are the preferences that carry the source's
slot times. Without them the native six-hour rule is unchanged.

### The ordinary watch's snapshot DM leaves out what an imported target already tells

When an imported target is observing the same repository's pulls or issues surface
(active, not blocked, last read healthy), the ordinary snapshot DM omits the parts that
surface reports, so one event is told once. A part the imported side cannot see is kept: a
check changing on a pull request head (it touches none of a pull request's state, title or
update time), and a workflow run on any branch (the imported runs surface follows the
default branch only). The follow-up job proposal for a requested change is not a
notification and is kept. A snapshot whose every change was covered sends nothing, and the
snapshot still advances.

### Schedule rollback is a service, state only

Rollback flips the active batch to replaced and restores the most recently replaced batch
whose replacement time is KNOWN (`schedule_rules.replaced_at`, carried by the import).
A batch of unknown order, or two stamped at the same instant, is refused rather than
guessed. Nothing is deleted and no exception is touched. The owner-only command manifest
is not expanded, so no Discord command reaches the service: the missing control is a named
blocker, not something worked around. It is not on the audit log (the event set is closed
and widening it needs a table rebuild).

## What this ADR deliberately does not do

- **"Areas mentioned" in a requested-changes alert.** The approved review body is now
  read, but the private audit does not define how an area is extracted or which file
  paths count as sensitive. Inventing a rule would be unsupported behavior, so this stays
  a named blocker on the rule.
- **AI wording of briefings, and meals.** Not implemented; the importer still refuses an
  active preference for either, and nothing is copied from the source's catalog.
- **A way for the owner to resume a paused global watch switch.** Carried over and
  honoured (ADR 0031), but changing it needs an owner control that was not authorized.
