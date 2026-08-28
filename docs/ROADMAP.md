# Roadmap

Phase 2 is delivered as **serial milestones**, not one rewrite. Each lands
whole, with tests, and leaves the system shippable.

The milestones after 2A are informed by an audit of the legacy DCStro
assistant (`~/SAgeneral/DCStro`, read-only reference, never modified). What we
take from it is the *product shape* it proved out — a daily assistant is
genuinely useful, and its channel-role split is a real insight. What we
deliberately do not take is its structure: a 2 096-line monolithic Python cog
with a 622-line AI helper, and a channel model whose own documentation admits
that everyone who can read the channel sees the owner's full private replies.

**Unresolved decisions are marked 🔶 throughout.** They are product or API
choices, not implementation gaps, and each needs an answer before the
milestone that depends on it starts.

---

## 2A — Shared, visible job status ✅ delivered

Development job status is visible to a chosen audience without exposing
anything personal. See
[ADR 0012](decisions/0012-opt-in-shared-job-visibility.md).

The safe assumption this rests on, stated explicitly because "make it visible"
does not say how far:

> **"Seen" means an opt-in shared Discord channel, not public Internet
> exposure.** Any member who can read a channel named in
> `DUCKY_SHARED_CHANNEL_IDS` sees only a safe projection. Nothing is published
> to the web and no inbound surface is opened.

Delivered: profile-scoped `DUCKY_SHARED_CHANNEL_IDS` (default empty);
channel/guild/DM awareness on incoming commands; a dedicated projection
service and presenter for `/jobs` and `/job status`; shared lifecycle
notifications in the originating channel alongside owner-DM notifications over
a per-target delivery ledger; plain-language state labels and "what happens
next" copy on both the private and shared surfaces.

Deferred out of 2A on purpose: **collaborator job submission**. Writes stay
owner-only. Submitting a job runs code on the development host, which is its
own decision and its own milestone.

---

## 2B — Daily owner assistant ✅ delivered

The half of the product `PROJECT_CONTEXT.md` always described and Phase 1 only
started: captures and schedules existed, but nothing brought them together.

Delivered:

- **Tasks** — a real task record (title, optional due instant, priority,
  open/done/cancelled), deliberately distinct from a capture. `/task`
  add/list/done/cancel, with `today` and `overdue` filters and signed
  per-row controls. Promoting a capture to a task stays a decision the owner
  makes; nothing does it automatically.
- **Reminders** — one-shot and fixed-interval recurring, delivered to the
  owner's DM over the same durable-ledger architecture 2A built, not a second
  notification mechanism. `/reminder` add/list/cancel.
- **Briefings** — `/briefing` with `morning`, `evening` and `today`, assembled
  from stored records only. DCStro's rule is kept and made structural rather
  than promised: `BriefingService` holds no provider, so there is no path by
  which a generated sentence could become a fact. Every briefing states its own
  provenance.
- **Schedule and timezone** — `DUCKY_OWNER_TIMEZONE`, validated at startup and
  reported in `/status`. Schedules are read back for the first time. Every
  instant is still stored as UTC and Phase 1's schedule rows keep the
  wall-clock text the owner typed; the zone is a projection, never storage.
  Times render as Discord relative timestamps.
- **One scheduler** — the assistant tick rides the existing coordinator
  interval. No cron, no per-reminder timer, and a worst-case lateness of one
  interval that is visible in configuration.

Owner-only in full. Tasks, reminders and briefings never reach a shared
channel, 2A's projection has no field that could carry them, and a test asserts
that no shared route names any of the three commands.

Decisions resolved (see
[ADR 0013](decisions/0013-bounded-reminder-recurrence-and-catch-up.md) and
[ADR 0014](decisions/0014-single-owner-timezone-as-a-projection.md)):

- **Recurrence grammar** → fixed intervals with an explicit occurrence count.
  No cron; both bounds enforced at input *and* by table CHECK constraints, so
  an unbounded schedule cannot be written by any path.
- **Missed-reminder policy** → collapse, count, and still deliver. At most one
  message per reminder per tick however long the outage; the skipped
  occurrences are recorded and named in the message; nothing is dropped for
  being stale; the recurrence advances exactly once.
- **Briefing delivery target** → the owner's ephemeral reply for now. Ducky has
  one destination, so DCStro's channel-role split would be structure without a
  problem to solve. Proactive scheduled briefings, which is where that split
  starts to matter, are not in this milestone.

Still open, and deliberately deferred:

- ✅ **Natural-language capture — DELIVERED by the final milestone, without a
  provider.** DCStro's design was rules first, AI only to improve a low-confidence
  read; the rules half needs no provider, so it shipped. A fixed table over the
  owner's own messages proposes a task, reminder or capture and applies it only
  after an explicit `yes`, through the same services the slash commands use.
  Ambiguity produces nothing. A non-owner reaches none of it. No command and no
  interaction kind was added — `AGENTS.md` forbids widening the owner-only
  surface, so the confirmation is a message rather than a button. The AI half
  still waits on 2D and improves nothing until then.
- ✅ **Proactive briefings — DELIVERED by the final milestone, off by default.**
  The delivery-time preference that was missing is now two validated local times
  (`DUCKY_BRIEFING_MORNING_AT` / `_EVENING_AT`). The channel-role question stays
  answered the same way: the owner's DM only, no shared policy injected, no
  channel branch to configure wrongly. Same durable-outbox architecture, same
  single scheduler, plus one new rule — a briefing more than six hours late is
  skipped rather than delivered, because a summary of a day that has already
  happened is worse than none.

---

## 2B′ — Job lifecycle hardening ✅ delivered

Not originally a numbered milestone; taken on because the engineering loop and
the "blocked on something else" case were the two largest gaps in the Phase 1
lifecycle. See
[ADR 0016](decisions/0016-work-phases-dependency-waits-and-audit.md).

Delivered:

- **Work phases** (`preparing` → `planning` → `implementing` → `reviewing` ⇄
  `fixing` ⇄ `verifying`), persisted beside the job state and driven by
  allowlisted executor progress reports through an exhaustive phase machine.
  **`running` stays the only lease-bearing state**, so every single-writer
  guarantee is untouched.
- **`waiting_on_dependency`**, a real job state with behaviour nothing else
  has: the lease is released and the repository reservation is retained. Backed
  by a `job_dependencies` record with a closed shape and two independent
  ceilings, written in the same transaction as the result.
- **A bounded resolver** on the existing coordinator interval, with an injected
  `DependencyChecker` port. Resume on ready, fail on failed, reschedule with
  bounded backoff, and hand the job to the owner when the budget is spent.
  Nothing polls forever.
- **A central command policy** classifying every subprocess surface, applied at
  the `gh` and `git` call sites — and, since the final milestone, at the herdr
  ones too, which had been constructing argv the policy never saw.
- **A structured audit log**, bounded and pruned, that is a record and never an
  authority.

Deliberately NOT delivered: `approved` and `executing_approved_action` job
states — approvals and execution remain separate so the existing lifecycle is
not rewritten. A real dependency checker arrived in the final milestone
(`DUCKY_DEPENDENCY_CHECKER=github`, CI status over the read-only `gh` surface),
opt-in and still reporting itself unverified, so it can fail a job on a definite
CI failure and cannot resume one; the default still only ever answers `pending`,
so no job is resumed on a check that did not happen. A
same-filesystem, opt-in performer now supports explicit owner-approved commit,
push and PR actions, with a durable per-approval execution ledger; production
executor routing and other action kinds remain deferred.

---

## 2C — Provider-agnostic conversation attachments ✅ delivered (pipeline only)

Ducky can now accept one image or file on an ordinary conversation message.
The **pipeline** is built, provider-agnostic, and it keeps Phase 1's honesty:
with no verified, attachment-capable provider configured — which is the state
on this host — an upload is refused **before download**, and no byte is ever
fetched. See
[ADR 0015](decisions/0015-provider-agnostic-conversation-attachments.md).

Delivered:

- **A capability handshake on the port.** `ConversationProvider.capabilities`
  is required, so a new provider must state its position rather than default
  into one. Bytes are fetched only when the operator has opted in AND the
  provider is `verified` AND it declares attachment support. Both shipped
  providers advertise none and throw if one reaches them anyway.
- **A provider-agnostic handle** — metadata plus a bounded `read`, never a
  path and never base64, with an **explicit lifetime the caller owns**. The
  provider gets a narrower type with no `dispose`, so it is structurally
  unable to keep the bytes alive; the router disposes in a `finally` and the
  handle is poisoned, so a retained reference reads an error rather than a
  file.
- **One attachment per message**, refused concisely if there are more, before
  anything is inspected further.
- **Owner-only attachments.** Plain chat keeps its whitelist behaviour; a file
  is personal data leaving the host on somebody's say-so, so it is owner-only.
- **A shared, strict metadata policy** used by both the schedule and the
  conversation surface, so a second surface cannot ship weaker checks than the
  first.
- Type allowlist checked before any network request; exact HTTPS CDN host from
  the existing `DISCORD_CDN_HOSTS`; a conservative configured size cap and the
  provider's own, whichever is smaller; no redirects and no compressed
  transfer; the received stream capped again because a declared size is a
  claim; a `0700` directory and a `0600` file removed on success, failure and
  provider error alike; the startup sweep extended to the new prefix; and no
  byte in SQLite, in a log, or in a Discord reply.

Decisions resolved:

- **Where content is sent** → answered once, in configuration
  (`CONVERSATION_ATTACHMENTS_ENABLED`, default off), and it is only one of
  three conditions. Per-upload confirmation was rejected: it trains the owner
  to click through, and it does not constrain *which* provider receives the
  bytes.
- **Transfer shape** → neither. The port carries metadata and a bounded read;
  an adapter that wants a file writes one, an adapter that wants base64
  encodes one.
- **Non-image files** → a narrow set that genuinely survives the generic byte
  path (`text/plain`, `text/csv`, `text/markdown`, `application/json`)
  alongside PNG/JPEG/WebP. **PDF is deliberately excluded** — a different
  parsing surface, and accepting it would imply a document capability nothing
  here has.

Still open:

- 🔶 **Retention of derived text.** Moved to 2E with the rest of the retention
  questions. Nothing is derived yet, because nothing on this host can read the
  bytes.
- 🔶 **PDF and other document types**, which depend on a provider that can
  honestly claim to parse them.

**Not delivered, and stated plainly:** no vision or extraction capability. The
bytes are forwarded to a provider that declared it accepts that exact type;
what it does with them is its own contract, and 2D has to verify it. No live
attachment byte has been fetched on this host.

---

## 2C′ — Bounded GitHub repository watches ✅ delivered (read-only)

Owner-configured `/watch add|list|remove` entries run on the existing
coordinator interval. Each observation uses the existing allowlisted,
read-only `gh` adapter, stores only a normalized snapshot and hash, and emits
one owner-DM summary when the snapshot changes. Delivery has its own durable
retry/abandon ledger and never reaches a shared channel.

The first slice covered open PR state/title/branch and a bounded sample of check
status. **The final milestone widened it** to merges, approvals, requested
changes, review comments, commits under review, workflow failures and recovery,
and issue activity — each through the same frozen read-only argv table, with
every `--json` selector recorded from `gh` itself by `pnpm probe:gh` rather than
guessed.

A requested change now produces an owner-DM proposal naming the exact
`/job submit` command, tied to the repository, PR number, head commit and review
timestamp, and deduplicated by the database. **Nothing is submitted**, and no new
manifest entry was added to make it one-press: `AGENTS.md` forbids widening the
owner-only surface.

Still not observable: recent commits on the default branch, which need `gh api`
— a forbidden verb. A live watch still has not been exercised on this host,
because no GitHub repository is configured in the allowlist.

---

## 2C″ — Live Herdr/Pi contract, recorded ✅ delivered (integration NOT certified)

Not a numbered milestone originally. Taken on because the Herdr/Pi path had
never been run for real, and running it found five defects that no unit test
could have caught — the mocks were all *more helpful* than the live CLI.

Delivered: a per-call subprocess budget (a 30-second `execFile` cap was killing
every real Pi turn and reporting it as a Herdr outage while the agent kept
writing); failure classification on Herdr's machine `code` rather than its
prose; `agent prompt` returning the settled agent so `blocked` is
distinguishable from finished; orphan-safe prompt failure that retains both the
writer lock and the reservation; `worktree create --label` so the ownership
proof can actually pass; tolerance for `agent_prompt_stalled` and
`agent_not_ready`; the brief handed over as a file because a 3.3 KB paste was
left unsent; and work phases that are genuinely reported, with
`implementing`/`reviewing`/`verifying` coming from a file Pi writes about
itself.

**Observed once** by `pnpm probe:live-job` on the production code path:
`preparing → planning → implementing → reviewing → fixing → verifying →
completed` in 271 seconds, with an independent passing review and real
verification exit codes.

**Not certified.** Other runs failed with `agent_prompt_stalled`, so
repeatability is not established and the milestone is complete only in the sense
that the contract is pinned and the defects are fixed — not that the integration
is dependable. `HerdrPiOrchestrator.verified` stays `false` and
`DUCKY_HERDR_VERIFIED` is deliberately unset. See
[integrations/herdr.md](integrations/herdr.md) and
[CURRENT_STATE.md](CURRENT_STATE.md).

---

## 2D — Verified OpenClaw adapter contract

The conversation provider is the last major unverified integration:
`HttpOpenClawProvider` throws rather than guessing an API, the mock prefixes
every reply with `[mock]`, and `/status` says so
([ADR 0005](decisions/0005-openclaw-adapter-with-mock.md)).

**No real conversational traffic is enabled until the contract is verified
against a running instance**, in the sense `CURRENT_STATE.md` already defines:
exercised for real, with recorded evidence — the standard `pnpm probe:herdr`
already meets for Herdr.

Scope: install or reach an instance; record request/response fixtures the way
the Herdr probe does; pin the schemas; only then let the provider report
`verified: true`.

2B's natural-language capture and 2C's attachment *delivery* both depend on
this. 2C's pipeline ships without it precisely because it refuses rather than
guesses: until a provider is verified AND declares attachment support, the
capability gate keeps the path closed. Verifying that provider must therefore
include verifying its attachment contract, not only its text one.

Open decisions:

**Boundary delivered, half the contract recorded, the reply still blocked.** `DUCKY_CONVERSATION_PROVIDER`
now makes the choice explicit and **production fails at startup** rather than
silently booting on the marked mock (which it previously did whenever
`OPENCLAW_BASE_URL` was unset — the default). `disabled` is a real mode that
refuses to answer instead of generating a sentence. `pnpm probe:openclaw` is
committed and exits 2 with the blocker; no route, body or auth model is guessed.

- ⚠️ **The API — HALF recorded.** OpenClaw is installed (pinned, local prefix)
  and probed. The transport, the agent-turn request shape, session semantics and
  the auth model are recorded; the REPLY envelope is not, because an agent turn
  needs model provider credentials that are not configured here. Two findings
  changed the code: it is a **WebSocket gateway plus a CLI**, not an HTTP JSON
  endpoint, and **an agent turn takes text only** — so the 2C attachment gate
  stays closed for this provider regardless. See
  [integrations/openclaw.md](integrations/openclaw.md).
- ✅ **Conversation memory — RESOLVED.** Bounded continuity, off by default, is
  shipped: see [ADR 0021](decisions/0021-bounded-conversation-continuity.md).
  DCStro's rule is kept and made structural rather than promised — every stored
  turn is scoped to one (user, thread), the repository has no method that could
  read another account's words, and a configured shared channel takes no part in
  memory at all.
- 🔶 **Failure behaviour.** When the provider is down mid-conversation: fail
  loudly, or fall back to the marked mock? Silent degradation to a mock in a
  *conversation* is the kind of plausible-looking fake `PROJECT_CONTEXT.md`
  rules out.

---

## 2E — Privacy and retention ✅ delivered (retention ships disabled)

Delivered:

- **Centralised redacted logging** (`obs/logger.ts`). Eleven sites had been
  interpolating raw error messages into stderr while `redact()` sat unused two
  imports away.
- **Migrations 11–15.** 11 indexes three queries `EXPLAIN QUERY PLAN` showed as
  full table scans (including `job_transitions`, which had no index at all);
  12 adds `retention_runs` and the partial age indexes each policy selects on;
  13 widens `audit_log.subject_kind`, which had been silently dropping rows;
  14 adds the schedule retention index; 15 widens the subject kinds again for
  the approval, provider and configuration events.
- **A meaningful `/readyz`** — migrations, a loaded credential and a
  recently-seen executor, not `SELECT 1`.
- **Bounded retention**, off by default, table-by-table, batched, idempotent,
  with six per-job guards and skips counted rather than swallowed. Six tables
  have no delete path at all.
- **Owner deletion controls** — `/forget job <id>` and `/forget conversation`,
  owner-only, per-entity, confirm-then-act, with **no wipe-all path at any
  layer**.
- **Security audit events** — `auth.failed`, `auth.replay_detected`,
  `authz.refused`, `rate_limit.exceeded`, `credential.reloaded`,
  `retention.pruned`, `data.deleted`.

Decisions resolved (see
[ADR 0020](decisions/0020-conservative-retention-and-per-entity-deletion.md)):

- **Job data retention** → refined by the final milestone (ADR 0022) into two
  windows: metadata at 90 days from `finished_at`, and the DETAIL (result
  snapshot, events, owner answers) at 30. Pruning still cascades to the
  notification ledger — the delivery row and its transition are removed in the
  same transaction, which is what stops a pruned transition reappearing as
  undelivered.
- **Assistant data retention** → also refined per kind: closed tasks 90 days,
  finished reminders 90, past schedules 180, done captures 365, each from the
  column that marks the record closed. Nothing open is ever in scope.
- **Conversation retention** → nothing is stored, so there is nothing to retain.
  `/forget conversation` says so rather than pretending to act.
- **Attachment retention** → no byte is kept and none is derived, so there is
  nothing to age out.
- **The owner's own deletion controls** → per-entity, confirm-then-act, audited
  by count, and since the final milestone covering captures, tasks, reminders
  and schedule entries as well as jobs and conversation. Deliberately no bulk
  form, and no new command: they are choices on `/forget`, which was already
  owner-only.
- **What survives a profile switch** → nothing: the profiles share no database,
  so retention is per profile and the runbook says so.

Still open:

- 🔶 **Shared channel history.** Projection messages persist in Discord. Ducky
  will not delete them: that needs a Manage Messages write the bot deliberately
  does not hold. Unchanged, and now recorded as a residual rather than an open
  implementation question.

---

## Explicitly still deferred

Unchanged from Phase 1, and none of the above reopens them: multi-user
permissions beyond shared *visibility*; a public bot; autonomous deployment;
automatic GitHub or Azure writes; arbitrary shell from Discord; browser
automation; container sandboxing; concurrent implementation writers on one
repository. Same-filesystem development commit/push/PR actions now have an
explicit opt-in path, but executor-routed production actions, automatic PR
follow-up, issue/deploy/Azure performers and high-risk actions remain deferred.
