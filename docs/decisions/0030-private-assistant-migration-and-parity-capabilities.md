# ADR 0030 — Migrating the private assistant: durable identity, indefinite schedules, notification-only targets

**Status:** accepted. The real-reader blocker below is lifted in part by
[ADR 0031](0031-typed-notification-watch-reads.md) (owner-approved 2026-10-14).
**Extends** [ADR 0013](0013-bounded-reminder-recurrence-and-catch-up.md),
[ADR 0014](0014-single-owner-timezone-as-a-projection.md),
[ADR 0020](0020-conservative-retention-and-per-entity-deletion.md),
[ADR 0026](0026-deadline-linked-reminders-and-plain-cards.md) and
[ADR 0029](0029-github-feed-and-the-delivery-only-github-channel.md); supersedes nothing.

## Context

Issue #9 retires the owner's private assistant module only after its records
and accepted behavior work in Ducky. On 2026-10-13 the owner chose **full
parity**: preserve all existing owner-scoped behavior, with no finite-horizon
substitute for recurring schedules, no unapproved subset of notification
watches and no silent checkpoint reset. That settles the policy questions; what
remains are facts and capabilities. Facts that are unavailable offline are
evidence blockers, not licence to omit or normalize a behavior.

Three things Ducky could not represent were identified by a private,
read-only behavioral audit (kept outside this repository, never published):

1. dated one-off schedule rows only, no recurrence and no exceptions;
2. an engineering-allowlist-bound watch (`github_watches.repo_slug` references
   `repos`, capped at 20 active and 64 configured), where the owner needs a much
   larger notification-only selection;
3. snapshot-hash watches, where the source keeps typed per-surface cursors and
   typed event identities with separate alert and digest settlement.

Importing through ordinary `add` services would also reopen closed records,
regenerate reminders and send a "Started watching" burst.

## Decision

### An offline, atomic, versioned import, not a route

`ducky-assistant-import/v1` is a strict, whole-document-validated contract in
`@ducky/contracts`. An operator CLI beside `scripts/backup-db.ts` applies it to
an explicit private database in ONE `BEGIN IMMEDIATE` transaction through
service-owned orchestration and import-specific repository methods. There is no
Discord route and no phone route, and no transport or network is reachable from
the importer. Any unsupported, foreign-owner, over-capacity or
configuration-incompatible document is refused before a single write, and the
refusal reports counts and rule names, never content.

`BEGIN IMMEDIATE` does not stop a live WAL coordinator from writing a moment
later, and a CLI flag that says "I stopped it" proves nothing. So a **runtime
liveness lock** (`runtime_lock`, one row) is shared by the coordinator and the
importer: the coordinator takes it at start and refreshes it on its tick; the
importer takes it for the duration of the import and refuses while a live holder
exists (same-host pid alive, or a fresh heartbeat). A coordinator refuses to start
while an import is in progress.

### Durable identity, tombstones, no resurrection

A permanent correlation ledger maps `(namespace, category, source id)` to the
Ducky record. Repeat import recognises a live identity and neither overwrites
Ducky-side edits nor re-advances checkpoints nor re-sends anything. While a
record exists the ledger holds a content fingerprint, so a later export that
changed a correlated record is a counted **conflict**, not an ignored update.
Deleting an imported record (Forget, or the owner's cancel) leaves an
**identity-only tombstone**: no content and no digest. Retention never touches
the ledger (it is on `RETENTION_FORBIDDEN_TABLES`), and never removes a live
recurring series or a live watch checkpoint. Deletion is audited by count.

### Tasks and reminders keep their state and their policy

Import writes closed tasks as closed (with their times), writes an explicit due
**kind** (timed instant or all-day date; all-day is never inferred from a
midnight), and writes delivered reminders as delivered occurrences so a settled
one can never become a pending send. A per-task **reminder policy** (enabled
flag, optional offset list, "no offsets remain, so remind at the deadline")
exists only for tasks that carry one; native tasks keep the 24 h / 1 h / 08:00
defaults of ADR 0026 unchanged. Done cancels pending linked reminders, Edit
re-derives them from the stored policy, and Snooze stays a notification-only
postpone that never moves a deadline. The existing signed, owner-bound controls
and the plain card are reused unchanged.

### Indefinite weekly schedules with dated exceptions

Weekly recurrence is stored as a **rule** (weekday, wall-clock start and end,
label, optional course, section and room, an `active` flag and a nullable
effective-until) and dated **exceptions** (a civil date plus an optional course
and optional label target, a kind, a note). Nothing is materialized and there is
no horizon: occurrences are computed for the civil-date window a reader asks
for, in the owner's zone (ADR 0014), and a window larger than the bound is
refused rather than returned half-empty. Only active rules drive behavior;
inactive batches are preserved as inert data. Exceptions apply as audited: an
untargeted cancellation removes every class that day; a targeted one removes the
rules whose course or label matches, trimmed and case-insensitive. Reads
(`/schedule` list, briefings) merge confirmed one-off rows with computed
occurrences. Forget on a schedule handle reaches rules and exceptions by an
unambiguous prefix. Bounded interval reminders (ADR 0013) and indefinite
schedule rules are separate contracts.

### Notification-only watch targets, not a wider engineering allowlist

`github_watches` and its allowlist semantics are left exactly as they are. The
owner's larger selection lives in `assistant_watch_targets`, keyed by a
validated GitHub reference and independent of `repos` and `allow_jobs`: it can
never grant a job, a model, an owner role or an allowlist entry, and the
allowlist auto-cancel path never applies to it. Hard capacity is a fixed public
**1000** (well above what the owner actually has, deliberately round), distinct
from the ordinary 20-watch add limit and the 64-entry config cap.

Throughput is a budget, not a hope: every subprocess read an observation makes is
charged against **20 calls per tick** and **2400 per rolling hour** (headroom
below a typical 5000/hour authenticated quota for the feed and jobs), units are
served oldest-due first with persisted progress so nothing starves and a mass
first poll cannot burst. At the cost one snapshot observation had (about 14
calls), 1000 targets would need over five hours of this budget per complete sweep;
the typed incremental reads here carry persisted per-surface and per-page
progress instead and charge every request. No fixed full-sweep latency is
claimed.

### Typed checkpoints and an explicit transition

Source cursors are not Ducky snapshot hashes, so they are stored as what they
are: one checkpoint per target and surface, and one event per stable typed
identity with **separate alert and digest settlement**. A target that arrives
without a baseline, a surface that was only partly read and an event kind the
build cannot observe are **explicit states**; none is turned into a silent
baseline or an automatic "Started watching". The first observation reconciles from
the last known checkpoint across the stopped-notifier window before it advances;
settled identities stay suppressed; an incomplete page or an unobservable surface
**never advances its cursor** and never delivers. Watermark and outbox changes
commit together under a compare-and-set with unique event keys. Only the review
verdict "changes requested" interrupts; everything else is delivered in the next
briefing digest and marked digested only after that briefing was sent.

Where an imported target and the native feed observe the same repository, the
imported typed observation takes precedence for the events it covers, and the
corresponding native proactive event is suppressed; nothing about a job read or
an authorization changes. Imported alerts and digests are private to the owner's
destinations and are never routed to the shared GitHub feed channel.

### Preferences are scoped and never authoritative

Owner preferences (per-slot briefing enablement and the weekend, lookahead and
section choices) live in a non-authoritative owner-scoped table and are applied
only when the active profile explicitly selects imported preferences. Frozen
configuration always wins for owner, profile, timezone, destinations, channel
roles, visibility and every safety flag; a preference that disagrees with an
explicit configured value is a parity **conflict** the importer refuses to paper
over, never an overwrite. A briefing weather section is a bounded, key-less
forecast read behind a port (a timeout, a short cache, silent omission on any
failure); its coordinates are explicit configuration, never stored data, and an
active weather preference with no configured location is a refusal.

### Hardening recorded after independent review

- **Identity, not a pid.** The lock records the boot and the process start, so a
  reused pid, a reboot and a second handle in the same process are judged on what
  they are; a live holder is refused whoever asks, and a stale row (an earlier boot
  or a replaced pid, even this process's own number) is recovered. The coordinator
  takes it inside `createApp` right after migrations, before the configuration
  mirrors or the feed selection are written, and beats on a fixed period of its own.
- **Importer order.** The lock is taken first, for a dry run too, then the backup is
  compared by the content of every table. Paths are judged by realpath; the
  document, database and backup must be `0600` in `0700` directories. A source
  namespace is pinned once the ledger has seen one, so a typo cannot import
  everything again.
- **Atomic checkpoints.** A checkpoint, its events, the holds it releases and its
  second checkpoint commit in one savepoint, so a fault never leaves a cursor past
  events that were not recorded.
- **Boundary overlap.** A late event with the cursor's own timestamp is reconciled
  by identity, but only when the items at the cursor were processed by a Ducky pass
  (`boundary_known`); a baseline or a source cursor stays strict.
- **Private sections stay private.** The capture inbox and the repository digest go
  only into the owner's DM copy, and the importer refuses preferences that want
  them with a channel delivery. A briefing the owner ASKS for follows the same
  rule: they are included only when the reply is a DM or guaranteed ephemeral, never
  in a role channel, where replies persist (ADR 0023). Native feed suppression covers only kinds an
  imported surface sees in full.

## What this ADR deliberately does not do

- It does not claim a live bridge. The existing reader seams (ADR 0029; `gh api`
  and `gh search prs` each allowed in one exact shape) do not observe release
  publication, nor the closing time of a pull request or an issue, nor
  discover repositories. Those surfaces are declared **unsupported** with
  `capabilities` flags; an import whose present watch category needs one is
  refused (fail closed) and reported as a required blocker. A synthetic reader
  in a test proves the engine, not a live bridge.
- It adds no `gh` shape, no HTTP path to GitHub and no new owner command. The
  owner-only command manifest is unchanged; list and cancel for these targets,
  and Forget for schedules, reuse the existing owner-only commands.
- It does not support AI wording of briefings, which needs a provider path of its
  own, nor meals, the `urgent` priority, task categories or a paused global watch
  switch. Each is **source behavior full parity must preserve**, so each is a
  required parity blocker: the importer refuses the input (the fail-closed form of
  the blocker), and nothing here proposes dropping it. The same is true of the
  other known differences listed in `docs/CURRENT_STATE.md` (alert "areas
  mentioned", the morning staleness rule, schedule-batch rollback, discovery and
  the polling cycle, and overlap with the ordinary watch's snapshot DM).
- It performs no deployment, no production setting change and no stop or
  removal of the source module. The operational gates in
  `docs/runbooks/dcstro-cutover.md` stay required and unverified.

## Alternatives considered

- *Finite expansion with a refresh job.* Rejected by the owner's decision: it is
  not indefinite recurrence and adds a scheduler that can lapse.
- *Raise `MAX_GITHUB_WATCHES_PER_OWNER` and the allowlist cap.* Rejected: it
  widens an authorization-adjacent bound for a notification-only need.
- *Reset watch snapshots to a silent baseline.* Rejected: it misses the
  transition interval and discards typed identities already settled.
- *Replay `add` service calls.* Rejected: they create open, unfired records.
- *An acknowledgement flag that the coordinator is stopped.* Rejected: it proves
  nothing; the lock is mechanical.

## Consequences

- A new migration (29, because another lane already registered 28), several
  tables and a new service layer; none touches existing rows.
- The ledger and the checkpoint tables are permanent state, not records.
- Full operational parity is still gated by evidence this repository cannot
  produce: a fresh live backup and configuration, private semantic and count
  parity, a live synthetic notification and control check, a proven
  reverse-delta rollback and an operator cutover.

- Migration 29 introduces the runtime lock, which a build that predates it cannot
  honour: the coordinator must be stopped before migrations, and a scratch database
  migrated from an earlier, unpublished revision of 29 must be recreated.
- The engine reads runs and releases as one window that always closes; a real reader
  must page them or prove it returns everything newer than the cursor. Required
  blocker; unreachable while the shipped reader declares nothing.

## Follow-up

- A reader surface for release publication, closing times and repository
  discovery needs an explicit owner-approved constraint change and pinned
  tests before it can exist; until then those imports fail closed.
