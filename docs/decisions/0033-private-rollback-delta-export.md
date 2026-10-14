# ADR 0033 — A private, read-only rollback-delta export

**Status:** accepted
**Extends** [ADR 0030](0030-private-assistant-migration-and-parity-capabilities.md)
and [ADR 0020](0020-conservative-retention-and-per-entity-deletion.md); supersedes
nothing.

## Context

After a cutover, Ducky holds records the source never had (a new task, a snooze, an
edit, a completion, a cancelled reminder, a discovered repository), records it changed,
records it deleted, and delivery and watch progress. Rolling back by restoring the
source's backup would silently drop all of that, and restoring it over Ducky's newer
state would resurrect what the owner deleted. The runbook therefore requires a
**reverse-delta rollback** to be proven before cutover. That needs, first, an export
that says exactly what changed. It does not, by itself, need or provide the bridge that
applies it to the source: that stays a separate, privately rehearsed gate.

## Decision

### One private, offline, read-only CLI

`pnpm export:rollback-delta --db <db> --out <file>` (or `--from-backup <file>`) reads one
consistent state and writes one file. It is a CLI beside `import:assistant` and
`backup`: no Discord command, no phone route, no new owner-only command, no network.

- **Consistency is mechanical.** `--db` takes the shared runtime lock, which it cannot
  while a live coordinator holds the database. `--from-backup` opens a backup file
  READ-ONLY after SQLite's integrity check and a fully-migrated-schema check. Exactly one
  of the two is required.
- **Private by construction.** The source and the output must be outside the repository
  (through symlinks), the source 0600 and both directories 0700; the output is created
  0600 and never overwrites anything. The terminal gets counts and rule names only: never
  a title, an id, a repository, a preference or a path.
- **Exit codes.** 0 complete; 2 refused before reading data; 3 backup refused; 4 a live
  process holds the database; **5 incomplete**. An incomplete export writes nothing
  unless `--allow-incomplete`, and even then exits 5 and the file says `complete: false`.

### Baseline identity and version

An imported record's identity is `(namespace, category, source id)`, already in the
correlation ledger. Its **baseline version** is new: `stored_hash`, a hash of the fields
Ducky wrote, taken inside the import transaction (and a hash, never content). The
fields exclude everything the system rewrites on its own (a task's `updated_at`, a watch
target's default branch). An export compares each record's current hash with its
baseline: equal is only counted as unchanged; different is **changed** and carries the
record's full current state. A record with no ledger identity is **added**. A live
identity with no stored hash (imported before this existed) is exported in full, flagged
`baseline: unknown`, and makes the export incomplete.

### Why a record is gone, in one word

A tombstone said only "gone", which cannot tell a record a bridge must never resurrect
(the owner asked for it to be deleted) from one that simply aged out. It now also carries
`tombstone_cause`: `forget`, `owner_delete`, `retention`, `import_suppressed` (the import
chose not to write it: deleted at the source, or superseded by what the owner did since)
or `unknown`. The cause is set by the deletion path that ran (`deletion_context`, a
single row read by the tombstone triggers, written by Forget, the retention pass and the
owner's own capture deletion). A deletion that reaches the trigger with no path around it
is `unknown`, never mislabelled.

**This does not defeat Forget.** Nothing about the deleted record's content is kept or
exported, and the cause is one word from a closed list; a deletion record that quoted what
it deleted would defeat the deletion. A deletion whose cause is `unknown` makes the export
**incomplete**: history already lost is not reconstructible and is never pretended to be.

### What is a delta and what is state

Tasks, reminders (with their occurrences, so delivered and cancelled state travel with
them, and each snooze links to its task), captures, weekly rules and exceptions (including
a flipped batch), preferences and watch targets (a cancel, a discovered repository) are
classified `unchanged` / `changed` / `added` / `deleted`. One-off schedule rows are native
only. **State** is one latest value per key, applied idempotently: watch checkpoints, the
events Ducky observed or settled since the import, briefing slots, the monitoring switch
and discovery tombstones. A table past a 20,000-row read cap is reported incomplete rather
than cut.

### Replay semantics

The file carries its own rules (`replay`): apply only when `complete`; `added` is created
unless that handle exists; `changed` sets the identified record to the given state and
never reopens what the delta says is closed; `deleted` with `forget` or `owner_delete` must
never be resurrected; with `retention` it is a finished record to remove or leave;
`import_suppressed` needs nothing; `unknown` is a stop; `state` is idempotent.

## What this ADR deliberately does not claim

- **A synthetic replay is not a bridge.** The tests apply a delta to a MODEL of the source
  built from the import document and show the model ends up equal to Ducky's state, twice
  over, and that two exports are byte-identical. That proves the export complete and
  idempotent for the categories listed. It does not prove a reverse bridge exists, and it
  authorizes no restore of stale data. The bridge remains a required, privately rehearsed
  gate.
- **Not every kind of change is a delta.** Notification and briefing settlement are
  state; the export does not claim to reproduce Discord-side effects.
- **A record changed twice and changed back is `unchanged`.** The baseline is a hash of the
  fields, not a history.
- **No audit event.** The audit event set is closed and widening it needs a table rebuild;
  the export is a read, and is counted on the terminal.

## Consequences

- Migration 34 adds `stored_hash`, `tombstone_cause`, `deletion_context` and replaces the
  seven tombstone triggers. Additive; existing tombstones read as `unknown`.
- A new deletion path that touches imported records must run under
  `store.withDeletionCause`, or its tombstones are `unknown` and exports are incomplete:
  the failure is loud, not silent.
