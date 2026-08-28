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

- 🔶 **Natural-language capture.** DCStro guessed intent from plain messages,
  deterministic rules first and AI only to improve a low-confidence read. That
  is a good design, but it depends on a verified conversation provider, which
  we do not have (see 2D). `/task` and `/reminder` are explicit commands until
  then.
- 🔶 **Proactive briefings.** A briefing is pulled, not pushed. Pushing one
  needs a delivery-time preference and reopens the channel-role question above.

---

## 2C — Provider-agnostic multimodal chat attachments

Ducky should accept an image or a file in conversation. Phase 1 refuses both,
honestly: `SCHEDULE_BINARY_EXTRACTION_ENABLED` defaults off and no provider on
this host can read those bytes
([ADR 0011](decisions/0011-capability-honest-schedule-extraction.md)).

This milestone builds the **pipeline**, provider-agnostic, and keeps that
honesty: with no capable provider configured, an upload is still refused
before download.

Non-negotiable controls, most of which the existing
`fetchTextAttachment` path already enforces for text and which extend
unchanged:

- **CDN allowlist** — download only from `DISCORD_CDN_HOSTS`. An attachment
  url is attacker-influenced input.
- **Declared type allowlist**, checked against the metadata *before* any
  network request. DCStro allowed exactly `image/png`, `image/jpeg`,
  `image/webp`; that narrowness is a feature.
- **Size ceiling**, enforced on the declared size and again on the received
  stream, since a declared size is a claim.
- **Temp cleanup** — a private-mode file with an explicit lifetime, deleted on
  every path including failure, plus the existing startup sweep for a
  previous run's leftovers. DCStro wrote `0o600` and dropped the bytes
  immediately; keep both.
- **Rate limiting** per owner, as attachments already are.
- **No bytes in SQLite and none in a log.** Unchanged from Phase 1.

Open decisions:

- 🔶 **Where content is sent.** Passing an image to a provider sends personal
  data off the host. Which providers are acceptable, and does the owner
  confirm per upload, per provider, or once in configuration?
- 🔶 **Transfer shape.** Inline base64 or a temp file path? DCStro used a path
  because its CLI read from disk. A provider-agnostic port must not assume
  either, and the answer shapes the port.
- 🔶 **Non-image files.** PDFs and text are a different parsing surface from
  images. Same milestone or a later one?
- 🔶 **Retention of derived text.** Extracted text is durable where the image
  was not. Stored, or used once and dropped?

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

2B's natural-language capture and 2C's multimodal chat both depend on this.
Neither should ship against a mock.

Open decisions:

- 🔶 **The API itself.** Not yet known. Everything else here is contingent.
- 🔶 **Conversation memory.** How much history is sent, and is it stored? A
  thread key exists today and nothing is persisted. DCStro's rule is worth
  keeping: only the owner's own messages and the assistant's own output enter
  a prompt, because anyone who can post in a channel can post in a thread on
  it.
- 🔶 **Failure behaviour.** When the provider is down mid-conversation: fail
  loudly, or fall back to the marked mock? Silent degradation to a mock in a
  *conversation* is the kind of plausible-looking fake `PROJECT_CONTEXT.md`
  rules out.

---

## 2E — Privacy and retention decisions

Currently implicit and due to be written down. 2A already created one new
retention surface — a shared channel keeps its history, where an ephemeral
reply kept none.

Open decisions, all 🔶:

- **Shared channel history.** Projection messages persist in Discord. Deleted
  after a period, on job completion, or left as the record?
- **Job data retention.** Jobs, transitions, events, results and owner inputs
  grow without bound. What is pruned, when, and does pruning cascade to the
  notification ledger?
- **Assistant data retention.** Completed tasks, fired reminders, past
  schedule entries, captures.
- **Conversation retention.** Whether transcripts are stored at all (2D).
- **Attachment retention.** Bytes, and any text derived from them (2C).
- **The owner's own deletion controls.** Deleting a capture exists; there is no
  "delete everything about job X" or "forget this conversation".
- **What survives a profile switch.** Development and production share no
  database today; a retention policy must not quietly assume otherwise.

---

## Explicitly still deferred

Unchanged from Phase 1, and none of the above reopens them: multi-user
permissions beyond shared *visibility*; a public bot; autonomous deployment;
automatic GitHub or Azure writes; arbitrary shell from Discord; browser
automation; container sandboxing; concurrent implementation writers on one
repository; performing approved actions.
