# ADR 0034 — Exact, delivered-only reconciliation between native and imported notifications

**Status:** accepted
**Supersedes** the coarse "imported typed observation takes precedence" rule of
[ADR 0030](0030-private-assistant-migration-and-parity-capabilities.md) and the
resume guard of [ADR 0032](0032-remaining-private-assistant-parity-behaviors.md).
**Extends** [ADR 0031](0031-typed-notification-watch-reads.md) and
[ADR 0033](0033-private-rollback-delta-export.md).

## Context

The owner can be told the same fact by two independent paths: the native paths (the GitHub
feed and the ordinary `github_watches` snapshot DM) and an imported notification-only target
(its alert and its briefing digest). ADR 0030 and 0032 stopped them repeating each other with
**prospective, surface-level** suppression: a healthy imported surface retired a native card or
trimmed a snapshot line. That is a promise of future coverage, not a delivery, and it loses a
notification whenever the promise fails (a paused switch, a failing read, a window outside the
poll cycle, a digest nobody carries, an event the target later withholds). Resuming the global
switch was refused wherever any native history existed, because Ducky recorded neither when a
pause began, nor which repository an ordinary watch queried (its allowlist slug is remapped at every
boot), nor which items a native message actually named.

Blanket refusal was a missing implementation, not a policy. This ADR replaces both with one
exact protocol. It does not claim full parity and keeps every earlier blocker.

## Decision

### A transition is told by exactly one path, and only a delivery counts

One shared pure codec (`@ducky/contracts` `native-transition.ts`) says, for **every** imported
event kind, which native transition it can be. A transition is `(kind, item, stamp, hash, attempt)`:

| imported kind | native counterpart | exact identity |
|---|---|---|
| `pr_opened`, `issue_opened` | feed `pr_opened` / `issue_opened` card | number |
| `commit` | commit named in a feed digest | SHA |
| `pr_merged` | ordinary summary's named merge | number + the provider `mergedAt` instant |
| `pr_updated` | ordinary summary's named update | number + the provider `updatedAt` instant; a target update at or before a proven native update of the same item is covered (a per-item dominance rule, never across items or by time alone) |
| `review_requested_changes` | feed `changes_requested` card | pull request number + a hash of the review **node id** |
| `ci_failed` | feed `check_failed` card for a run | run id + rerun **attempt** |
| everything else | none | never matched, never withheld |

Counts, unnamed aggregates ("3 new issues", "and 7 more commits"), snapshots, `skipped`,
`baseline`, `abandoned`, failed and expired rows, a follow-up proposal and a bare timestamp are
**not** receipts. A summary names at most three updates and three merges, and a transition is
recorded only for an item whose line was actually written (the same slices produce the text and the
claims). An update is named only when `updatedAt` itself moved; a pull request new to a capped
snapshot is not an "opened" receipt. A commit digest records per commit whether its own line was
written (`told_as = named`) or it was only counted.

The review comparison is by **exact string equality** of the review node id: the approved
reviews response (`GET repos/{o}/{r}/pulls/{n}/reviews`) already carries `node_id`, now parsed as a
bounded optional field with no change to the endpoint, argv or policy, and the native feed card
carries the id GraphQL calls `id`. Nothing is decoded or normalised, only a hash is kept (a
domain-separated SHA-256, never the id), and an unusable value becomes "absent", never a failure.
Whether the two ids are equal on a live provider is **unproven** (the live reviews probe returned an
empty answer): if they differ, nothing matches and the effect is a withheld review (below), never a
silent suppression. That live equality check is a required evidence gate.

### One reservation per transition, decided in one synchronous step

`native_transition_claims` (migration 36) has one row per owner, repository and exact
transition; its primary key **is** the protocol.

- A **native** path reserves the transition with its outbox row (a feed event, a buffered commit,
  an ordinary summary), in the same transaction that creates the row. The reservation becomes a
  **receipt** in the same step that settles the row after a **successful** send. A card sent to the
  owner's DM and one sent to the configured public `github` channel are receipts alike (an
  unsuccessful send is neither).
- The **target** reserves only around **one actual send attempt** (an alert, or the briefing that
  carries a digest). Success makes it a receipt; failure releases it and the event stays pending.
- A native path **skips an item only for a transition the target actually delivered**. A target send
  in flight makes it wait: a feed card stays pending with no attempt charged; an ordinary
  observation does not commit (its snapshot and check time are untouched) and repeats next tick.
  A target event that is merely pending, held or withheld is not a reason to skip anything.
- An imported event is decided against the ledger **inside the same transaction as its cursor** (and
  again at held-event release, and at each send): a native receipt settles it silently
  (`settled_by = native_receipt`, never a delivery of its own); a native reservation makes it
  **wait** (nothing settled, no digest consumption, no abandonment charge, carried forward by the
  next briefing); otherwise it is delivered normally.
- An ordinary summary is **rebuilt around exactly the delivered item** when one was delivered by the
  target: the rest of a mixed summary (other updates, merges, counts, issues, runs, review lines) is
  kept. Nothing aggregate or unnamed is dropped on the theory that the target will tell it.
- Two sends of one transition never run at once. Another `reserved` row makes a send wait; the same
  event's other mode (an alert, then the briefing) may still follow a delivered one; another event
  of the same transition is already told.

Because these checks are made against the ledger, every coverage gap is handled alike: a paused
switch, a cycle exclusion and re-entry, a failed or blocked surface, a digest nobody can carry, an
import adopting an older source cursor. There is no `covers()` question left, and no native path
reads an imported surface, the monitoring switch or the digest's deliverability
(a source-scan test asserts it).

### Releasing, with no timer

Elapsed time cannot prove whether a send happened or whether its owner is alive, so nothing expires.
A native reservation is released only when its outbox row can never be sent, by a sweep that runs
at start-up, after each native tick and on selection changes: an abandoned or skipped feed event; a
retired, stale or deselected one; a buffered commit that was consumed, expired, counted only or whose
repository left the list; an ordinary summary that was abandoned or whose watch the owner cancelled
(an identity-stopped watch keeps its still-deliverable outbox and its reservation); and every feed
reservation once at start-up when frozen configuration disables the feed (rows are kept). A commit
carried to a later digest stays reserved.

A **target** reservation that outlived a crash is a send of unknown outcome. At start-up, under the
runtime lock (so no earlier holder is alive), it is released back to pending and **never** turned
into a receipt; the event may be sent again. That is the existing at-least-once transport caveat
(a crash between the Discord send and the SQLite write), not something this ADR removes.

### What predates the ledger cannot be placed, and is withheld

Migration 36 captures a cutoff (`native_ledger_boundary.cutoff_at`) **before any retention can
run**. On a database that is not **verifiably new** (all migrations applied by one run, represented
explicitly as `fresh`), every imported event with a native counterpart that occurred at or before the
cutoff plus a one-second skew margin, and has no exact receipt, is **withheld**: never delivered,
never settled, never a baseline marker, counted in `/status`, `import:assistant --verify` and the
rollback export. This is global on purpose: retention may already have pruned every native row, so
absence proves nothing, and the repository a legacy ordinary watch queried was never recorded.

Surviving delivered feed rows carry their own repository, key and time. The migration reads them
through the shared codec (never SQL decoding) and stages them, ownerless, in the same transaction;
the first caller that knows the owner (start-up, or the importer's own transaction) turns them into
receipts. Pending feed rows and unconsumed buffered commits become reservations. A skipped, baseline,
abandoned or pruned row, and a commit a digest already consumed (named or counted is unknown), prove
nothing.

An event that cannot be named exactly (a review without a node id, a run without an attempt) is
withheld whenever a native path could tell it (a native claim for the item, or a feed row for the
repository, which is a durable tombstone), because "no native claim yet" proves nothing about one
written later. When no native path could ever tell it, it is delivered. A timestamp is only ever used
to prove an event **later** than a native observation, so a genuinely new second review is delivered.

A withheld event and its advancing cursor commit atomically. It has **no clearing control** (a
release would need an owner command, which the manifests forbid) and stays a **required cutover
blocker** with counts, never a waiver. Required operator sequencing: migrate the stopped target
before the final source export, so imported cursors lie after the cutoff plus margin, and prove
`--verify` reports zero withheld events and zero cursors at or before the cutoff. That is not
permission to reset a live cursor.

### Pause provenance, and resuming

`assistant_watch_pause_periods` records when monitoring was paused and by whom: an owner pause has a
real start (the injected time); an imported one, or one that predates the table, has none, only the
latest instant it is known to have begun (`origin` `owner`, `import` or `unknown`). Resuming closes
the open period. The switch, the period and the strict audit row change in one transaction; the same
state again writes nothing. A period is **provenance only**: it never suppresses or authorizes a
delivery. Resuming no longer refuses because history exists; the only refusal is an unreadable ledger
boundary. A repeated import never overrides the owner's choice and records no new period.

### Ordinary watches record what they queried

An ordinary watch records the canonical `owner/repo` it actually queried: bound at creation, or at its
first observation after migration, fixed **before** the awaited reads and part of the observation's
compare-and-set, and stamped on every outbox row. Nothing is ever filled in from today's allowlist
mapping, which is rewritten at every boot, so a pre-migration watch's past stays unknown. A slug that
later names another repository stops the watch (`cancel_reason = identity_mismatch`): no cross-
repository diff, no silent re-baseline, no DM; its snapshot and every outbox row are kept, and
`/status` counts it. An identity record is non-authoritative and grants no job, access or owner right.

### Rollback export v3

The export (`ducky-rollback-delta/v3`) adds the pause periods, the ledger boundary and every receipt
and reservation (identifiers only), and on each event `withheldReason`, `settledBy`, `providerHash`
(a hash) and `attempt`. A v1 or v2 document carries none of it and is not inferred or rewritten. An
unreadable boundary makes the export incomplete. Retention may never touch the ledger, boundary,
staging or pause tables (they are on `RETENTION_FORBIDDEN_TABLES`); lifetime growth is a few
identifiers per delivered native transition and is accepted.

## Consequences

- **Precedence changed, deliberately.** The delivered transition wins, and on a repository both paths
  watch the native path is usually first, so the imported digest may be empty for items a card
  already told. There is no prospective imported precedence. A native card may now name something an
  imported target will later settle silently.
- **Duplicates that remain, honestly.** A count line or an unnamed aggregate never proves an item, so
  an aggregate ("3 new issues", "and 7 more commits") and the detailed imported event can both reach
  the owner. A requested-changes review is told twice while REST `node_id` and the native id are not
  proven equal on a live provider (unequal ids never match). A transition no codec can name has no
  counterpart and is told by both.
- **Loss that remains, honestly.** A withheld event is a notification that was never sent, by design,
  and is counted. On a not-new database with the cutoff after the source's own times, a large
  backlog of counterpart events is withheld until the sequencing above is followed.
- **Older code is incompatible.** Stop coordinators before migrating and never run an older build
  against a migrated database: it would not know the reservations, so it could not honour them.
- A repeated import, a restart and a retry can neither lose nor duplicate a deterministic transition,
  within the at-least-once caveat above.

## Not done here

No live probe, import, source access, deployment or notification. Unit and synthetic tests are not
live Discord, `gh` or provider evidence. The REST/native review id equality, the real reader's
completeness and timing, runtime eligibility (issue 8), the private reverse bridge and every
operational gate in the runbook remain required.
