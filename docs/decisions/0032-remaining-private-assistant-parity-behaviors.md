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

### The ordinary watch's snapshot DM no longer leaves anything out on a promise

**Superseded by [ADR 0034](0034-exact-native-reconciliation.md).** This ADR first made the ordinary
snapshot DM (and the feed's duplicate card) omit whatever an imported surface was healthy enough to
"really tell". That is a promise, not a delivery, and it lost a notification whenever the promise
failed. The ordinary summary and the feed now tell everything they tell, and skip an item only for an
exact transition the imported target has actually delivered; an imported event a native path already
delivered is settled silently. The summary is rebuilt around exactly that item and keeps every other
part: counts, aggregates, other updates, merges, issues, runs, review lines and the follow-up job
proposal (which is advice, not a receipt). A snapshot whose every change was an item the target
delivered sends nothing, and the snapshot still advances.

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
strictly newer than every stored one, which is its own refusal (`clock_not_newer`, shown with its own message, and checked by the preview as well as the confirmation, with the injected time, so neither depends on a code). A stored stamp in the future, or the clock going back to one, is that refusal too.
Replies carry counts and the code, never a batch, label or course.

A successful rollback is audited with the typed event `schedule.batch_rolled_back` (counts
only, fixed owner reference, subject kind `config`), written by a strict, injected-time
method inside the same transaction, so an audit failure undoes the flip. **Correction:**
this ADR previously said the audit event set was closed and that widening it needs a table
rebuild. That was wrong. `audit_log.event` is unconstrained text; only `subject_kind` is
constrained, and an existing kind serves. Adding a typed event needs no migration.

### The monitoring switch is an explicit owner choice

`/watch monitoring state:on|off` sets the global switch. It is a choice, never a toggle,
and the same state is a no-op: no settings row, no timestamp, no audit row, no pause period and no
export delta. A change writes the switch, its pause provenance (ADR 0034) and the audit event
`watch.monitoring_changed` (state only) in one transaction at the injected time. Neither direction
touches a target, a checkpoint, a pending event, a failure count or the call budget. Pausing applies at
the next tick (the tick in flight read the switch once, at its start and finishes); resuming
makes every cursor due again exactly where it stood.

**The switch is GLOBAL.** Resuming turns on every target at once (up to the 1,000-target cap).

**Correction.** This ADR first **refused** to resume wherever any native history existed (a selected
feed repository, active or cancelled, or any retained ordinary watch), because pause provenance, the
repository an ordinary watch queried and what a native path delivered were not recorded. That blanket
refusal was a missing implementation, not a policy, and is **removed**: ADR 0034 records all three and
reconciles per exact transition as the targets observe, withholding and counting only what predates the
ledger and cannot be placed. Resuming now refuses only when the ledger boundary cannot be read. It
never resets a checkpoint, and a repeated import still never overrides the owner's choice.

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
- **Cross-path reconciliation and pause provenance.** Built by ADR 0034, with limits that stay
  required blockers: what predates the ledger is withheld and counted, a count or an unnamed
  aggregate is never a receipt (aggregate/detail overlap remains), a requested-changes review is told
  twice until REST `node_id` equality with the native id is proven live, and nothing here is live
  evidence.
- **The private source's repeated-rollback semantics.** The audit available to this repository
  does not say what the source does on a second rollback; none was invented.
