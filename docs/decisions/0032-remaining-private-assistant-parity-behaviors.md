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

When an imported target will REALLY tell the owner about the same repository's pulls or
issues surface, the ordinary snapshot DM (and the feed's duplicate card) omits the parts
that surface reports, so one event is told once. A healthy checkpoint on an active target
is not delivery. Watching must be on (the global switch), the target must be inside the
poll cycle's coverage where one applies, and what it tells must have somewhere to go: a
requested change is an imported ALERT, sent as soon as it is found, and needs nothing
more; every other kind waits for a briefing digest, so it needs briefings on, imported
preferences in force with the GitHub section and at least one briefing slot enabled, and a DM
copy. Paused, outside the cycle, preferences off, no GitHub section, both slots off, briefings off or channel-only, or a discovered target
with no preferences all keep the native DM and card. A part the imported side cannot see is kept: a
check changing on a pull request head (it touches none of a pull request's state, title or
update time), and a workflow run on any branch (the imported runs surface follows the
default branch only). The follow-up job proposal for a requested change is not a
notification and is kept. A snapshot whose every change was covered sends nothing, and the
snapshot still advances.

### Schedule rollback is an owner control with a stale-safe confirmation

Rollback flips the active batch to replaced and restores the most recently replaced
batch (`schedule_rules.replaced_at`, carried by the import). Nothing is deleted and no
exception is touched. The owner reaches it through the existing `/schedule` command, as
an optional `rollback` string that is never mixed with `text` or a file (no subcommand:
the text and file flow keeps its shape, and no signed button kind was added or
repurposed). `rollback:preview` shows counts and a 16-hex code; `rollback:<code>`
confirms.

The code digests every rule by identity, batch, active flag and replacement time, and the
selected target. It is recomputed, compared, applied and audited in ONE transaction, so a
confirmation for a state that has since moved (an import, a deleted or replaced rule, a
second active batch, a rollback already made) is refused as stale, a used code cannot be
replayed, and nothing flips on a mismatch. A fresh, deliberate second rollback needs its
own preview and flips again, as the service always did; whether the source's repeated
rollback is the same is a private-audit question and **stays a required parity gate**.

Ambiguity is refused, never guessed: ANY replaced batch with no known or an unreadable
replacement time (even beside batches of known order), two batches at the same instant, a
batch split between active and replaced rules or across replacement times, or a stamp not
strictly newer than every stored one (it would create the very tie refused above).
Replies carry counts and the code, never a batch, label or course.

A successful rollback is audited with the typed event `schedule.batch_rolled_back` (counts
only, fixed owner reference, subject kind `config`), written by a strict, injected-time
method inside the same transaction, so an audit failure undoes the flip. **Correction:**
this ADR previously said the audit event set was closed and that widening it needs a table
rebuild. That was wrong. `audit_log.event` is unconstrained text; only `subject_kind` is
constrained, and an existing kind serves. Adding a typed event needs no migration.

### The monitoring switch is an explicit owner choice, and resuming is guarded

`/watch monitoring state:on|off` sets the global switch. It is a choice, never a toggle,
and the same state is a no-op: no settings row, no timestamp, no audit row and no export
delta. A change writes the switch and the audit event `watch.monitoring_changed` (state
only) in one transaction at the injected time. Neither direction touches a target, a
checkpoint, a pending event, a failure count or the call budget. Pausing applies at the
next tick (the tick in flight read the switch once, at its start and finishes); resuming
makes every cursor due again exactly where it stood.

Resuming (off to on) is **refused** wherever a native path could have told the owner the
same things. While monitoring is off an ordinary snapshot DM or feed card is not trimmed for
what a target covers, so it may already have told the owner what the target's untouched
checkpoint would tell a second time. Nothing stored proves when a pause really began (an
imported pause carries only the import time, so a native watch cancelled before the import
can have spoken after the source's pause began), what a native path delivered, or whether a
pending native notification was settled; exact cross-path reconciliation has no evidence,
and resetting a checkpoint would silently baseline away events nobody was told. So, inside
the transaction, the guard counts every repository on which an ordinary watch or a feed
selection still has a row, active or cancelled, whenever it ran, that an active target also
watches, plus any it cannot resolve, and refuses if there is one. Cancelled targets are not
counted (they are not read), and unrelated repositories do not block.

The cost is deliberate and owned: a target whose repository ever had a native row cannot be
resumed until reconciliation exists. Removing the native row is **not** a way round it (that
would delete the history the guard honours), so the reply gives a count and no remedy, and
an operator import cannot override it either (an import never overwrites a stored switch).
Pause provenance (whether the pause was the owner's, with a known start, or imported) and
fuller native dedup history are not recorded; recording them, and reconciling, is a required
full-parity blocker, not an accepted omission and not a completed acceptance criterion.

A repeated import of an unchanged document states the switch only when nothing has ever
been stored, so it can neither undo a native choice nor re-pause what the owner resumed;
`verify` reports the difference as drift. Schedule rules were already left alone by a
repeat (an existing identity is not rewritten); `verify` likewise reports a native
rollback as drift. Both changes appear in the rollback-delta export.

## What this ADR deliberately does not do

- **"Areas mentioned" in a requested-changes alert.** The approved review body is now
  read, but the private audit does not define how an area is extracted or which file
  paths count as sensitive. Inventing a rule would be unsupported behavior, so this stays
  a named blocker on the rule.
- **AI wording of briefings.** Not implemented, and the blocker is specific. The only
  approved provider path is the OpenClaw conversation provider, and every call through it is
  a session-keyed agent turn whose transcript OpenClaw keeps in its own store; no
  session-deletion contract has been recorded for it (ADR 0024: there are two stores, and
  only one is Ducky's). A briefing sentence generated that way would leave the owner's day
  in a transcript `/forget` cannot delete. Doing it safely needs a stateless call that
  leaves no transcript (an owner decision and a recorded contract), frozen configuration
  that opts in, counts-only input that never carries a capture or digest, validation that
  item identities, counts and states are unchanged, and live evidence on an eligible
  runtime. None exists, so the importer still refuses an active wording preference and
  every briefing stays deterministic, which is already the complete, non-authoritative
  fallback the source has. No billed fallback was or will be created.
- **Meals.** Not implemented, and not asserted by mechanical support. The source's meal
  behavior rests on a built-in catalog this repository has no licence to copy, so the
  preferences, history and repeat-cooldown mechanics alone would be a shell that looks like
  parity and is not. It needs an owner-supplied catalog and a contract for it; until then
  the importer refuses an active meal preference.
- **Cross-path reconciliation and pause provenance on resume.** Resuming is an owner control now
  (above), but only where no native path has ever had a row on the target's repository;
  reconciling what the ordinary watch and the feed told the owner against a target's checkpoint,
  and recording where a pause began, have no evidence in the stored data and are not built.
  Refusal is the safe form, and it stays a required parity blocker.
- **The private source's repeated-rollback semantics.** The audit available to this repository
  does not say what the source does on a second rollback; none was invented.
