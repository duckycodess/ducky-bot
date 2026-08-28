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

## 2B — Daily owner assistant

The half of the product `PROJECT_CONTEXT.md` always described and Phase 1 only
started: captures and schedules exist, but nothing brings them together.

Scope:

- **Tasks** — a real task record (title, due date, priority, state), distinct
  from a capture. A capture is an unsorted thought; a task is a commitment.
  Promoting one to the other is the point of the inbox.
- **Reminders** — one-shot and recurring, delivered proactively over the same
  durable ledger 2A built, not a second notification mechanism.
- **Briefings** — a morning and an evening summary assembled *from stored
  records*. DCStro's rule is worth keeping verbatim: AI may supply an opening
  or closing sentence and nothing else. A briefing that hallucinates a
  deadline is worse than no briefing.
- **Schedule and timezone** — schedules are already stored; they are not yet
  read back, and every timestamp is currently UTC. A single configured owner
  timezone (DCStro defaulted to `Asia/Manila`) with Discord relative
  timestamps (`<t:…:R>`) so rendering stays correct without re-sending.

Owner-only in full. Tasks, reminders and briefings are personal data: they
never reach a shared channel, and 2A's projection has no field that could
carry them.

Open decisions:

- 🔶 **Recurrence grammar.** Fixed intervals only, or a cron-like expression?
  A DSL is a parsing surface and a support burden; fixed intervals may not
  survive contact with real use.
- 🔶 **Briefing delivery target.** DCStro split briefing / chat / general
  channel roles because a daily summary landing mid-conversation is bad, and
  "add milk" typed during a conversation being turned into a task is worse.
  That split is sound. Whether Ducky needs it before it has more than one
  destination is not yet clear.
- 🔶 **Missed-reminder policy.** After the host is offline for a day: fire
  everything, fire only the most recent, or summarise? Each is defensible and
  they are not interchangeable.
- 🔶 **Natural-language capture.** DCStro guessed intent from plain messages,
  deterministic rules first and AI only to improve a low-confidence read. That
  is a good design, but it depends on a verified conversation provider, which
  we do not have (see 2D).

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
