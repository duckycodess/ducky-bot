# ADR 0033 — A private, read-only rollback-delta export

**Status:** accepted (schema now `ducky-rollback-delta/v3`, see [ADR 0034](0034-exact-native-reconciliation.md))
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
- **One read snapshot.** All reads run inside a single read transaction (a concurrent
  writer cannot make reminders and their occurrences disagree), a snapshot that breaks a
  foreign key is incomplete, and a backup whose runtime-lock row names a still-live holder
  is refused: it is not a finished state, and a delta read from it would miss whatever that
  writer does next. **Passing that check proves the writer is not alive; it does not prove the
  backup is the final or latest one.** An older backup from a stopped coordinator passes. That
  the export was taken from the FINAL state (both notifiers stopped, the last backup) remains
  required operational evidence, not something the tool can establish.
- **Private by construction.** The source and the output must be outside the repository
  (through symlinks), the source 0600 and both directories 0700; the output is created
  0600, is published by a hard link from a private temporary file so it is complete or
  absent and never replaces anything, and an I/O failure prints a fixed sentence, never a
  path. The terminal gets counts and rule names only: never a title, an id, a repository,
  a preference value (the monitoring switch is a presence count) or a path.
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

The cause row is only what the triggers read. Nesting is tracked in memory, so a row a
crashed process left behind is overwritten by the next outermost deletion path and cleared
at coordinator start-up (under the lock); and an export that finds a cause row present
reports `deletion_context_stale` and is incomplete, because a tombstone made since could
carry a cause that was never meant for it.

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
**Baseline markers and the schema version.** Every exported watch event carries a
`baselineMarker` boolean decided by the one shared classifier (ADR 0031): a first-observation
suppression marker in the reserved `baseline-marker:v1:` namespace. It means "this start is
known", never that anything was delivered, so a reverse bridge announces nothing and settles
nothing from it. Because a v1 document cannot tell an exporter that lacked the flag from a real
`false`, the schema is bumped to `ducky-rollback-delta/v2`. **A v1 document has no such flag, so
its marker status is UNKNOWN**: it must not be inferred from a payload, a timestamp or an
identity, and an unflagged v1 row must not be read as "not a marker". No consumer of v1 exists in
this repository, no v1 file is rewritten, no stored row is migrated or contracted, and the
private source reverse bridge remains unproven.

**v3 (ADR 0034).** The schema is bumped again because the meaning of a watch event changed. v3 adds
`state.pausePeriods` (a null `startedAt` means the real start is unknown), `state.nativeLedger` (the
boundary and every native receipt and reservation, identifiers only) and, on each event,
`withheldReason`, `settledBy`, `providerHash` (a hash, never a review id) and `attempt`. A v1 or v2
document carries none of them: whether an event was withheld, settled by a native receipt, or
paused-over is UNKNOWN there and must not be inferred, no older file is rewritten, and an unreadable
boundary makes the export incomplete. A withheld event is neither delivered nor baseline, and a reverse
bridge must not announce it from here.

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
