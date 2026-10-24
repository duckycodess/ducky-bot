# Current state

What is actually true today.

## How to read this document

**The status table below is the single authority.** Everything after it
explains, and nothing after it overrides. This document previously carried five
sections that each described status from a different angle — "certified",
"verified against the live host", "mocked or unverified", "blocked", and the
smoke-test evidence — and they drifted, twice, in ways that took measurement to
catch. There is one table now.

Three status words, and they are not interchangeable:

- **Verified** — exercised for real on this host, with recorded evidence a
  reader can go and look at.
- **Unit-tested** — the logic is covered; the external system it talks to has
  never been contacted from here.
- **Blocked** — named blocker, named remedy. Not "not done yet".

**Nothing here says production-ready, and nothing will until a production
cutover has actually happened.** No production credentials exist on this host,
no production instance has ever run, and no production command has been
registered.

## Status

| Capability | Status | Evidence |
|---|---|---|
| Owner-only Discord surface (12 commands) | **Verified** (registration), **unit-tested** (behaviour) | 12/12 registered, read back with `register-commands --diff`; `discord.fixtures/gateway-connect.json` |
| Discord gateway + MessageContent intent | **Verified** | `pnpm probe:discord-gateway`, READY in 2 276 ms; the intent is enabled, or the gateway would have refused |
| Human Discord interaction | **Verified for the configured GPT channel** | After the controlled development restart, the owner sent `hi` in the configured GPT guild channel and confirmed an actual reply. This verifies one guild-message round trip; DMs, slash commands and the other role channels remain untested live |
| Herdr/Pi production path | **Verified, repeatably** | 3 consecutive isolated `probe:live-job` passes: 162 s / 193 s / 192 s, full evidence gate |
| Conversation tool policy | **Verified text-only** | The rule is `tools.profile=minimal` plus the full group deny list and no override scope. The development host passes the provider check. Tools handed to the model went 31 → **0**, measured against the `ducky` agent |
| OpenClaw conversation (GPT) | **Verified on development for one owner-initiated guild turn** | `probe:openclaw` exits 0; request argv, reply envelope and zero-tool evidence are recorded. The development profile sets `DUCKY_CONVERSATION_PROVIDER=openclaw`, and the owner confirmed `hi` produced a real reply after the latest restart. DMs, slash commands and production delivery remain unverified |
| GitHub read surfaces (repo/PR list/runs/issues) | **Verified** | `probe:gh-live`; production schemas accepted live responses |
| GitHub PR / review / check surfaces | **Blocked** | The watched repository has no pull request; opening one is a GitHub write |
| CI dependency checker | **Blocked** | Same: `prChecks` has never run against a real PR, so `verified: false` stands |
| GitHub repository watches | **Verified** (observe + deduplicate) | `probe:gh-live` ran the loop twice; the second pass was correctly silent |
| GitHub feed: alerts and the daily commit digest (issue #6) | **Unit-tested; read half observed live, delivery half not** | Tests cover baselines, dedup across restart, partial failure, pending-to-failed, reruns, review episodes, routing with fresh visibility, the 09:00 local digest (Manila, DST), catch-up bounds. `pnpm probe:github-feed` ran the real reader and service against `duckycodess/ducky-bot` with the mock transport: see *Detail: the GitHub feed* |
| `github` channel role (delivery only) | **Unit-tested** | Configured by `DUCKY_DEV_GITHUB_CHANNEL_ID`; no channel is configured here, so no card has reached a real channel |
| Multi-executor placements | **Unit-tested** | One host is configured here, so the multi-host path is covered by tests and not by a second machine |
| Channel roles + persistent replies | **Verified for the GPT smoke path; unit-tested elsewhere** | All four roles are configured from owner-supplied ids. The owner confirmed a real reply in the configured GPT guild channel after the transport and policy restart. The other role channels, unconfigured-channel silence and slash-command persistence remain covered by tests or configuration rather than live evidence |
| Pasted-list task capture (Discord) | **Unit-tested** | Preview, clarification, idempotent save and quote/code refusal covered against the mock transport with an injected clock; no live Discord paste |
| Phone capture page (`/app`) | **Unit-tested**; the manual flow is **unverified** | Auth, CSRF, bind refusal, parse and idempotent save covered through the real Fastify instance. No tailnet exists on this host and no phone has opened it — see *Detail: what is covered by tests but not by a live system* |
| Deadline-linked reminders | **Unit-tested** | Offsets, skipped past offsets, resync on edit, cancel on close, snooze and outage catch-up covered with an injected clock |
| Task reminder cards in a channel | **Unit-tested** | Mention, controls, refusal of a non-owner and staleness after an edit covered against the mock transport; no channel configured here |
| Briefing delivery to a channel | **Unit-tested** | Ledger and refusals covered; no channel configured here |
| Reminder / briefing / watch DMs | **Unit-tested** | Same gateway path no human has exercised |
| Shared-channel visibility | **Unit-tested** | Off by default; unreachable with no channel configured |
| Approved Git actions | **Unit-tested** | Opt-in flag off; no live external write performed here |
| Conversation attachments | **Closed by capability** | The recorded OpenClaw turn takes text only; no attachment byte has ever been fetched |
| Native conversation threads (issue #4) | **Unit-tested** | Off by default: no channel is configured to open one here, and no Discord thread has ever been created from this build. 114 tests cover thread creation, routing, role inheritance, participation, compaction, the controls, anchor attribution, the ThreadDelete path and deletion |
| Conversation thread live checks | **Blocked** | No `.env`/`.env.development` exists in this worktree, so no development profile, token or guild is configured. Discord thread creation, reply anchoring, the Branch and Compact buttons and a two-store Forget have NOT been exercised against a real guild |
| Provider session deletion | **Blocked** | `RECORDED_SESSION_DELETION` is null. `pnpm probe:openclaw` exits 2 here because the pinned binary is not installed, so the deletion-capable command surface is unrecorded and `/forget` reports provider deletion as PARTIAL and rotates the session epoch instead |
| Image / PDF schedule extraction | **Blocked** | `probe:extraction`: all six decoders absent; no provider reports `supportsBinary` |
| Retention and deletion | **Unit-tested** | Ships disabled; enabling is an operator decision |
| Azure / Tailscale deployment | **Templates only** | Nothing provisioned; `deploy/azure/APPROVAL_PROPOSAL.md` awaits a decision |
| Repository workflow bridge (`$grill-me` / `$ticket` / `$agentize`) | **Unit-tested** | Off by default. 39 behaviour tests plus invariants drive a recording stand-in for the installed helper. **The real `workflow.py` has never been called from Ducky on this host**, because calling it creates GitHub issues |
| Private-assistant migration: contract, atomic importer, correlation ledger (issue #9) | **Unit-tested; nothing has ever been imported** | Strict whole-document validation, one-transaction apply, repeat-import, conflict, capacity, owner-mismatch and backup/lock gating covered against real files outside the repository. No live source, live target database or production profile was touched. See *Detail: the private-assistant migration* |
| Indefinite weekly schedules with dated exceptions | **Unit-tested** | Rules are computed for a requested window, never materialized: thirty years out, leap days, DST weeks, replaced batches, exception targeting, owner scoping, Forget and retention covered through the real briefing |
| Imported task reminder policy and preferences | **Unit-tested** | Disabled, custom, default-deferring and deadline-fallback policies through Done, Edit and Snooze; preferences apply only when `DUCKY_IMPORTED_PREFERENCES` is set |
| Notification-only watch targets: observation engine, budget, digest, alerts | **Unit-tested with a scripted reader** | Boundary rules, atomic checkpoint commits (fault-injected), held partial reads, resume after a restart, fair oldest-due scheduling and the 20-per-tick / 2400-per-hour budget are covered. Captures and the repository digest go only into the owner's DM copy of a briefing. **No real reader exists for this surface** (next row) |
| Notification-only watch targets: observing a real repository | **Unit-tested; probed read-only on a public repository; live completeness unproven** | The owner approved typed GET-only reads on 2026-10-14 (ADR 0031). `GhWatchReader` reads repository, pulls, reviews, issues, runs, releases and commits through seven exact `gh api` shapes, one request per unit, with pinned schemas, identity checks, a re-read proof for multi-page windows and a `window_exceeded` blocker. It is OFF by default (`DUCKY_ASSISTANT_WATCH_READER_ENABLED`). `pnpm probe:watch-reader` showed real non-empty answers for the repository, pull request, issue and commit surfaces on the public probe repository and EMPTY answers for reviews, runs and releases (so those item schemas are documented-shape only); it exits 4 for an empty answer unless `--allow-empty` accepts shape-only evidence. That proves shape, not completeness, latency or runtime eligibility. Discovery, the 40-target recency-limited cycle and the monitoring switch are implemented and unit-tested; discovery has never been enabled or probed live. **Multi-page completeness is NOT proven (a required blocker)**; residuals are in ADR 0031 and below |
| Private imported sections in owner-requested briefings | **Unit-tested** | `/briefing` and "brief me" put the capture inbox and repository digest in the reply only when it is a DM or a guaranteed-ephemeral command reply; in a role channel (where replies persist) and in a guild message reply they are left out, while the native tasks, schedule and reminders are unchanged |
| Briefing weather | **Unit-tested; no live request made** | Parsing, caching, failure-to-null, the fixed host, refused redirects and a streamed size ceiling are covered with an injected `fetch`. The natural-language `brief me` includes it. No request to Open-Meteo has been made from this host |
| Shared runtime lock (coordinator and importer) | **Unit-tested** | The lock records the boot and the process start, so a reused pid, an earlier boot, a second handle in the same process and an equal pid on another host are each judged on what they are. The coordinator takes it right after migrations, before any other write, and beats on its own fixed period. The `main.ts` wiring has not been run against a live process |
| Production profile | **Never run** | No credentials on this host, no instance, no registration |

## The development profile is configured and the current process loaded it

The configuration on disk selects the verified OpenClaw route
(`DUCKY_CONVERSATION_PROVIDER=openclaw`, the pinned binary, the `--dev`
profile store holding the ChatGPT/Codex subscription OAuth profile, a loopback
URL) and names all four assistant channels from owner-supplied ids.

The coordinator was restarted after the transport, persona and tool-policy
changes. Its boot diagnostics report `conversation: openclaw-gateway`, current
migrations, the provider transcript boundary and a passing text-only policy.
The executor remains running with the verified Herdr/Pi setting.

The configuration was verified with an in-memory database and the mock
transport so the live database and Discord gateway were not touched:

| Check | Result |
|---|---|
| provider selected | `openclaw-gateway`, `verified: true` |
| attachments | still unsupported — the recorded turn takes text only |
| roles resolved | briefing, task, coding, gpt — all four |
| shared visibility | none, so no role/shared overlap exists to refuse |
| `hi` in the GPT channel | a real reply in 24 s, not `[mock]`, persistent through the router. This was not a Discord round trip and predates the final persona and tool-policy checks |
| `hi` in another guild channel | silent, as containment intends |
| a task proposal in the task channel | proposed, and persistent |

**Those checks ran through the ROUTER, not through Discord**, and that
distinction turned out to matter: a live test in the real guild channel got no
reply at all, because of two transport bugs the router-level checks could not
see. Both are fixed and neither has been re-tested live yet — see below.

**Proactive briefings remain OFF.** `DUCKY_BRIEFING_ENABLED` is unset, so
configuring a briefing channel pushes nothing on its own, and
`DUCKY_BRIEFING_DELIVERY` is still `dm`. Both are deliberate: the owner
supplied channel ids, which is not the same as asking for a daily push.

## Two transport bugs, fixed and confirmed for the GPT smoke path

The owner sent `hi` in the configured GPT guild channel and **no reply
arrived**. That was not a provider failure, and the checks above could not have
caught it: they exercise the router, and both faults were below it.

**1. The gateway never delivered guild messages.** The client requested
`Guilds + DirectMessages + MessageContent`. `Guilds` carries guild and channel
metadata and delivers no message, so `MessageCreate` never fired for a guild
channel. DMs worked; every guild channel was silent. `GuildMessages` is now
requested by the transport and by the gateway probe.

**2. The persistence decision was being discarded.** `deferReply` fixes whether
a reply is ephemeral and `editReply` cannot change it. The transport deferred
every command ephemerally *before* routing, so the router's downgrade changed
nothing in Discord — the flag was set faithfully and thrown away silently. That
is why a full green suite did not catch it: the router was correct in
isolation, and so was the transport.

Visibility is now decided before the deferral, by one `ReplyPersistencePolicy`
that both the transport and the router hold. Two rules can disagree; one cannot.

**Status of the fix: implemented, unit-tested and confirmed for one live GPT
message.** After a controlled development-only restart loaded the rebuilt
adapter, the owner retried `hi` and confirmed that Discord delivered the reply.
This does not certify slash-command delivery, DMs, reminders or the other role
channels.

## Conversation storage: two stores, one of them not Ducky's

Ducky's bounded memory is **off by default**, per `(user, thread)`, bounded
three ways, and deletable with `/forget conversation`.

The provider keeps its **own session transcript** and there is no flag that
stops it. `/forget conversation` does not reach it, and now says so rather than
reporting "no conversation turn is stored" — which was true of Ducky and read as
a claim about everything. See
[decisions/0024](decisions/0024-two-conversation-stores.md).

The provider session key is `sha256(userId:threadKey)`. It was the thread alone,
so two people in one channel shared one session: Ducky's isolation was real and
the layer underneath it was not.

## Two Discord identities

`DUCKY_PROFILE` selects `development` or `production`. They share no token,
application id, guild, database, port or command scope, and neither falls back
to the other. Development may run token-less on the mock; production refuses to
start without its own credentials. The active profile is in the startup
diagnostics and in `/status`.

## What is built

Detail on each capability. The status table above says how far each has been
exercised; this says what it does.

- **Pasting a list of deadlines, from a phone or from Discord.** Two numbered
  lines or more, each with an optional parenthesised month-name date and an
  optional clock time, become a PREVIEW and nothing else until the owner
  presses Save. One ambiguous line refuses the whole batch with a clarification
  naming it: `10/13` means two different days to two different people and is
  never guessed at. Quoted text, fenced code and ordinary prose are never read
  as a list, a **configured shared channel is closed to the path entirely** --
  the preview is a visible message with signed controls, and a shared channel
  is where other people read a narrow job projection -- and a non-owner never
  reaches the path at all. Saving is
  all-or-nothing and idempotent on the preview, so a retry or a double tap
  reports the same tasks rather than creating a second set. **No command was
  added:** the Discord half is a message the owner pastes, and the three
  controls are interaction kinds on the existing owner-only manifest.
- **A deadline now schedules its own reminders.** 24 hours and 1 hour before a
  timed deadline; 08:00 on the day of a date-only one. An offset already in the
  past is skipped rather than fired, so saving a task an hour before it is due
  produces no instant "due in 24 hours". Closing a task withdraws its pending
  notifications, moving its deadline re-derives them in the same transaction,
  and Snooze postpones the notification while leaving `due_at` untouched. The
  link is a column, so two tasks with the same title cannot cancel each other's
  reminders. See
  [decisions/0026](decisions/0026-deadline-linked-reminders-and-plain-cards.md).
- **A date-only task is overdue only once its day has ended.** It used to be
  overdue from one second past midnight on the day it was due, which made the
  overdue section wrong every morning. Timed deadlines are unchanged: a 09:00
  task is late at 17:00.
- **Task cards carry a title, a deadline and three real buttons** — Done, Edit,
  Snooze — with no timezone label, no "Reminder: 1 hour before" line and no
  internal UUID. The deadline is rendered as the owner typed it, which is the
  one deliberate departure from ADR 0014's Discord timestamps. A card may be
  posted in a configured reminders channel with the owner's mention; its
  controls are signed, owner-bound and additionally versioned on the task, so a
  card whose deadline has moved stops acting.
- **The phone capture page, off by default.** `/app` on the coordinator's
  existing listener, behind the owner's own passcode, reachable only when the
  listener is bound to loopback, RFC1918 or a tailnet range. It refuses to
  start otherwise. It is a transport in front of the same service Discord
  uses, and it offers the same three choices: Save, Edit and Discard. Edit puts
  the list back in the box in the form the parser reads and corrects the SAME
  preview, so a few rounds of correction leave one draft rather than a trail of
  them.
  See
  [decisions/0025](decisions/0025-owner-authenticated-phone-capture-on-the-tailnet.md).
- Owner-only Discord surface: `/capture`, `/inbox`, `/schedule`, `/job`
  (submit, status, cancel, answer, cleanup, execute), `/jobs`, `/repo status`,
  `/status`, `/task` (add, list, done, cancel), `/reminder` (add, list,
  cancel), `/briefing`, `/watch` (add, list, remove), `/forget` (job,
  conversation). **The manifest is closed:** no command was added by the final
  milestone, and `AGENTS.md` forbids widening the owner-only surface.
- **The owner's private assistant channels, off by default.** Five roles --
  `briefing`, `task`, `coding`, `gpt`, `reminder` -- each naming one channel the owner has
  decided is private enough for their own output to live in. Inside them, and
  nowhere else, the owner's replies PERSIST instead of being ephemeral;
  everywhere else, including every unconfigured guild channel, behaviour is
  exactly what it was. A role is presentation and never authorization: a
  non-owner is refused there identically to anywhere else, and their refusal
  stays ephemeral. A channel that is also a shared channel is refused at
  startup. `/forget`'s confirm step stays ephemeral even in a role channel,
  because a durable one-press delete in scrollback is a different class of
  object from a task list. See
  [decisions/0023](decisions/0023-channel-roles-and-persistent-replies.md).
- **Roles narrow which deterministic rules may fire, never widen.** A DM and an
  unconfigured channel keep every rule, exactly as before. `coding` proposes
  coding jobs and nothing else; `task` takes the personal-record writes;
  `briefing` is reads only; `gpt` is left entirely to the provider, so
  deterministic rules never intercept a sentence meant for the model.
- **Coding jobs by proposal: REMOVED.** `implement in <repo>: <task>` used to
  propose a coding job that an explicit `yes` submitted through
  `JobsService.submit`. That rule is gone -- deleted, not disabled -- because
  the owner's workflow contract is that engineering work starts at
  `$grill-me`, `$ticket` and `$agentize` and nowhere else, and a sentence that
  can start a coding agent is one a paste or a quote can start by accident.
  `IntentsService` is now handed no job capability at all, so there is nothing
  for a later edit to switch back on. `/job submit` is unchanged: it is
  owner-only and it is the path `pnpm probe:live-job` certifies.
- **The repository workflow bridge, OFF by default.** Three commands, each
  recognised ONLY as the first unquoted token of a message: `$grill-me`,
  `$ticket`, `$agentize`. A fenced block, a quote prefix, an inline code span
  and every other first token are data, and no phrase triggers anything --
  "implement this", "ticket it" and "queue it" are ordinary English. See
  [decisions/0025](decisions/0028-exclusive-skill-command-entry-points.md).
  - **Ducky publishes nothing itself.** The installed, user-owned Agent Flow
    front door keeps the canonical schema, the issue body, the label policy,
    the Beads graph and the dispatcher registration. Ducky calls it through a
    typed port and reads structured fields back: no `gh issue create`, no
    label API, no second pipeline. A test scans the service's source and
    asserts it names no GitHub surface and spawns nothing.
  - **Queueing is typed, never inferred.** `--ready` is read only as a bare
    token on `$ticket`, after code spans are stripped. Ducky reports `queued`
    only when the owner asked AND the helper verified the exact `agent:ready`
    label on the issue. The card says in words that this authorizes
    implementation and is not evidence a worker started, because Ducky never
    observes a worker.
  - **Three switches, not one.** The bridge, the helper path, and publication.
    The third is separate on exactly the terms
    `DUCKY_APPROVED_ACTIONS_ENABLED` is separate. With publication off,
    `$ticket` scans and validates and creates nothing. All are profile-scoped
    and production inherits none of them.
  - **One repository per thread, bound once.** Explicit beats bound, bound
    beats a single candidate, and anything else ASKS rather than guessing. A
    rebind clears the canonical id and the issue, so a retry cannot enrich an
    issue in a different repository. Host paths are never rendered.
  - **The grill is the installed skill's own text, or there is no grill.**
    Read from a configured absolute path at call time and handed to the
    provider as instructions for that turn; nothing is copied into this
    repository. Unset, absent, unreadable, empty or oversized all REFUSE,
    before a card exists and before the repository is read, and the same check
    runs on every turn so a file that becomes unreadable mid-interview closes
    the grill. There is deliberately no fallback: an interview Ducky
    improvised because the file was missing is not the installed skill, and
    the owner would have no way to tell. The installed `grill-me` skill is a
    157-byte POINTER at `grilling`, so one hop through that redirect is
    followed; a pointer to a pointer refuses. `$grill-me` also refuses without
    a `verified` provider. Plain replies continue an open interview, and they
    are read BEFORE the coding channel's ordinary conversation silence.
  - **A queue outcome has four states, not two.** `not_requested`,
    `not_queued`, `queued` and `unknown`. The publisher writes `agent:ready`
    and then reads it back, so a failure after that write leaves a label that
    may well be there; reporting it as "nothing was queued" is a false
    negative about the only label that authorizes an agent, and the owner
    stops looking. `unknown` says to open the issue and check.
  - **Two slots, and the owner's two-step works because of it.** The RETRY
    binding is released on success, so the next different `$ticket` cannot
    rewrite the previous issue. The SETTLED ticket -- the canonical spec the
    publisher accepted -- is kept, so `$ticket --ready` with no arguments
    authorizes that exact issue through the installed publisher, with the
    original id and spec. Anything newly said is a new ticket instead; a bare
    `$ticket` authorizes nothing and says which step does; an already-queued
    ticket is answered rather than re-applied; a failed authorization keeps
    the settled ticket so it can be retried and reports `unknown`; and a
    rebound thread is not offered the previous repository's issue. The stored
    contract is the owner's own words and goes with `/forget conversation`.
  - **A repository is addressed with `owner/name` as the leading token, or
    not at all.** A bare slug is a word in a sentence, and matching one in the
    prose silently retargeted the thread.
  - **An abandoned run is ended by the next command in its thread**, bounded
    by `STALE_RUN_AFTER_MS`, so a coordinator crash cannot make a thread
    permanently unusable. A merely slow run is never swept.
  - **Classification is named, never chosen.** `$ticket --label <name>` is
    repeatable and bounded; with none, nothing is classified. `agent:*` is
    refused before a spawn, and a requested label the publisher did not read
    back fails the run rather than reading as a published ticket.
  - **The ticket is the owner's own words.** Acceptance criteria are the lines
    they typed, in the command and during the grill, bounded at 24 lines per
    thread. Nothing is generated: a requirement Ducky invented would be the
    one part of a contract nobody wrote.
  - **One run at a time per thread**, enforced in the UPDATE statement. A
    second command while one is in flight is REFUSED, not queued. Cancel stops
    the next step and kills an in-flight read; the publisher is never killed,
    because that could leave an issue created with its canonical read-back
    unverified. A terminal status is final, so a subprocess returning after
    Cancel cannot rewrite the card to "queued" -- and when a publication does
    complete anyway, the card stays cancelled and the owner is told what was
    created, with the URL. A publication is recorded against the run that made
    it, so a late answer cannot point the next retry at the wrong issue.
  - **The card never contradicts the Details view.** Its "what this means"
    copy is per-status, and for a failure that copy says nothing happened --
    which is wrong whenever the queue state is `unknown`, so the card renders
    the unknown truth instead. It also links only to the issue its OWN run
    touched: the issue URL is cleared when a run starts and set again when
    that run learns one, while the retry binding deliberately survives. A run
    that authorizes or reports on an already-published ticket records that
    issue against itself, so the two-step card carries the same Details /
    View issue controls the single-step card does.
  - **One card, edited in place**, with real controls -- a signed Details, a
    signed Cancel while the run is live, and a "View issue" LINK that carries
    no custom id and whose URL the sanitizer admits only as an exact https
    GitHub URL. A terminal outcome sends a fresh card rather than an edit
    somebody has to scroll back for. `OWNER_ONLY_COMMANDS` is unchanged at
    twelve; two owner-only interaction kinds were added.
  - **A shared channel never reaches it.** A message there is ordinary
    conversation, and a non-owner's `$ticket` is ordinary conversation
    anywhere.
  - **`/forget conversation` removes the thread records**, grill notes
    included, and says plainly that it cannot remove a published GitHub issue.
- **Briefings to the DM, the briefing channel, or both.**
  `DUCKY_BRIEFING_DELIVERY`, default `dm`. Each target is its own ledger row,
  so the two copies succeed, fail and retry independently; `channel` or `both`
  without a configured channel is refused at startup rather than failing once a
  day forever.
- Opt-in shared job visibility (milestone 2A), **off by default**. With
  `DUCKY_SHARED_CHANNEL_IDS` empty the feature is unreachable. When a channel
  is listed, anyone who can read it gets a safe projection from `/jobs` and
  `/job status` — public job id, allowlisted repo slug, coarse state, safe
  timestamps, sanitized summary and verdict, next-step copy — and nothing
  else. **Scoped to that channel:** only jobs submitted in it are listed or
  reachable by id. A job from a DM or another shared channel is refused
  identically to one that never existed. Task, context, owner id, questions, answers, events, workspace
  ids/paths, action details and signed controls never appear there. Writes,
  captures, schedules, approvals and every control stay owner-only and
  ephemeral. See [decisions/0012](decisions/0012-opt-in-shared-job-visibility.md)
- Captures and inbox with per-row management
- **Daily owner assistant (milestone 2B), owner-only in full.** See
  [decisions/0013](decisions/0013-bounded-reminder-recurrence-and-catch-up.md)
  and [decisions/0014](decisions/0014-single-owner-timezone-as-a-projection.md)
  - **Tasks** — title, optional due instant, priority (low/normal/high), state
    (open/done/cancelled). A separate record from a capture: a capture is an
    unsorted thought, a task is a commitment. `today` and `overdue` filters are
    computed against the owner's own civil day. A bare due date stays an
    all-day date rather than being given a time nobody typed.
  - **Reminders** — one-shot, or a FIXED interval with an explicit occurrence
    count. There is no cron grammar and no unbounded schedule: both bounds are
    validated at input and enforced again by table CHECK constraints.
  - **Reminder delivery** — to the **owner's DM only**, over a durable
    `reminder_occurrences` outbox with the same guarantees the job notification
    ledger has: an occurrence row exists from the moment it is due, a unique
    key makes recording delivery idempotent, one failure is isolated and
    retried on the next tick, and everything passes through the same
    `sanitizeOutbound` boundary. After a bounded number of failures an
    occurrence is marked abandoned and kept as a record rather than retried
    forever or deleted.
  - **Missed reminders** — collapse, count, and still deliver. However long the
    host was off, a repeating reminder produces at most one message per tick;
    the occurrences it stands for are recorded as `missed_count` and named in
    the message; nothing is dropped for being stale; the recurrence advances
    exactly once. Nothing ever fires early.
  - **Briefings** — `/briefing` with `morning`, `evening` or `today`, defaulting
    from the hour in the owner's zone. Assembled from stored tasks, reminders
    and schedule rows by counting them. `BriefingService` holds no provider, so
    no sentence in a briefing can be generated; every briefing says so.
  - **Proactive briefings, OFF by default** — the piece 2B deferred, because
    pushing one needs a delivery time. `DUCKY_BRIEFING_ENABLED` plus two LOCAL
    times (`07:30` / `20:30` by default), validated at startup so a typo fails at
    boot rather than at 07:00. Delivered to the **owner's DM only** over a
    durable `briefing_deliveries` outbox with the same guarantees the reminder
    ledger has: a row from the moment a slot comes due, a unique
    `(user, kind, day_key)` index that makes delivery idempotent, isolated
    retries, and abandonment as a RECORD after a bounded number of failures.
    Rides the same coordinator interval — still one scheduler.
    **One rule reminders do not have:** a briefing more than
    `BRIEFING_STALE_AFTER_MS` (6 h) late is marked `skipped` rather than sent. A
    reminder names a commitment and is worth having late; a briefing is a summary
    OF A DAY, and this morning's summary arriving tonight describes a day that has
    already happened. There is no backfill for a day the host was off, either.
    The body is assembled at DELIVERY time and nothing rendered is stored.
  - **Timezone** — one configured `DUCKY_OWNER_TIMEZONE` (default `UTC`),
    validated at startup against the runtime's own ICU data and reported in
    `/status` and the boot diagnostics. Used ONLY as a projection: instants are
    still stored as UTC, Phase 1's `schedules.starts_at` rows keep the
    wall-clock text the owner typed, and nothing is migrated. Times render as
    Discord timestamps (`<t:…:f>` beside `<t:…:R>`) so each is shown in the
    reader's own zone.
  - **One scheduler** — the assistant tick runs on the existing coordinator
    interval alongside the reconciler and the job notifier, each isolated from
    the others. There is no second scheduler and no per-reminder timer, so a
    reminder is late by at most one `DUCKY_RECONCILE_INTERVAL_MS`.
- Text and CSV schedule extraction → preview → correction modal → explicit
  confirm
- **Deterministic-first natural language, owner-only, no new command.** A fixed
  rule table over the owner's own messages on the EXISTING conversation route.
  No provider is consulted, so none of it waits on 2D, and none of it can
  generate a sentence.
  - **Reads** are answered immediately: a briefing (the same assembly `/briefing`
    uses, same provenance line), a **Filipino meal suggestion** from a short
    fixed list in Ducky's own source, and a **study plan** that arranges the
    owner's own topic into a fixed schedule. Both helpers state their own limits
    in the reply — the meal list says it is neither generated nor complete, the
    study plan says Ducky knows nothing about the subject, has read nothing and
    kept nothing.
  - **Writes are PROPOSED, never applied on inference.** "i need to renew the
    domain" produces a proposal; the owner replies `yes` (or `no`) in their own
    words, and only then does `TasksService` — the same service `/task add` uses
    — write anything. One proposal per (user, thread), expiring after ten
    minutes, so a later `yes` cannot mean something the owner had stopped
    thinking about.
  - **Ambiguity produces nothing.** Two rules matching, a reminder with no time,
    an over-long message: all mean nothing rather than a guess.
  - **A non-owner reaches none of it.** A whitelist user's message is ordinary
    conversation, exactly as before.
  - **No command and no interaction kind was added**, and `OWNER_ONLY_COMMANDS`
    is unchanged. `/meal`, `/study` and a one-press confirm button would each
    widen the owner-only surface, which `AGENTS.md` forbids; conversation is an
    existing permitted route and the owner gate on it is the one conversation
    attachments already use.
- **Bounded conversation continuity, OFF by default.** See
  [decisions/0021](decisions/0021-bounded-conversation-continuity.md)
  - `DUCKY_CONVERSATION_MEMORY_ENABLED` defaults to false, and with it off
    Ducky reads and writes no conversation row. The provider-owned OpenClaw
    transcript is a separate store and is reported separately below.
  - When enabled, ordinary channels and DMs keep histories scoped to one
    (user, thread). Native Discord threads share their transcript among actual
    participants: a thread read requires an explicit participation proof, and
    visibility alone grants no access. Neither path exposes an unrestricted
    cross-user history read.
  - **A configured shared channel is excluded from both reading and writing.** A
    message event carries no channel context, but its thread key IS the channel
    id, so the two can be compared — and a channel other people can read never
    becomes a store of the owner's words nor a source of replayed context.
  - Ordinary channels and DMs use a replay window
    (`DUCKY_CONVERSATION_MEMORY_TURNS`, default 10), a transactional row cap
    and a per-turn length cap. Native threads retain their full transcript;
    checkpoints plus recent turns bound model context by the configured byte
    budget. An over-long turn is stored visibly truncated.
  - Ordinary history uses configurable retention windows of 30 days for the
    owner and 7 days for other chat users when retention is enabled. Native
    threads bypass those windows: live threads retain their transcript; closed
    threads are purged whole only after their separate retention window.
  - The `role` column allows `user` and `assistant` only. There is deliberately
    no `system` role: a stored preamble would be configuration masquerading as
    history.
  - **The coordinator memory is separate from provider history.** OpenClaw is
    now verified and can receive the bounded history Ducky supplies when this
    feature is enabled. Its own session transcript remains provider-owned and
    is not removed by `/forget conversation`.
- **Conversation attachments (milestone 2C): the PIPELINE only, and closed on
  this host.** See
  [decisions/0015](decisions/0015-provider-agnostic-conversation-attachments.md)
  - One image or file may be attached to an ordinary conversation message.
    Several in one message are refused concisely, before anything is inspected
    further.
  - **Nothing is downloaded unless all three hold:** the operator has opted in
    (`CONVERSATION_ATTACHMENTS_ENABLED`, default off), the provider reports
    itself `verified`, and it declares attachment support. Both shipped
    providers advertise none and throw if one reaches them anyway, so on this
    host the refusal is on metadata alone and **no attachment byte is ever
    fetched**.
  - The port carries **metadata plus a bounded read** — never a path, never
    base64 — with an explicit lifetime the coordinator owns. The provider is
    handed a narrower type with no `dispose`, and the handle is poisoned after
    the reply, so a retained reference reads an error rather than the owner's
    file.
  - **Owner-only.** Plain conversation keeps its Phase 1 whitelist behaviour;
    an attachment does not, because it is personal data leaving the host and
    fetching one is an action taken on somebody else's say-so. Conversation is
    not a shared route, and a message event carries no channel context.
  - Accepted types: `image/png`, `image/jpeg`, `image/webp`, `text/plain`,
    `text/csv`, `text/markdown`, `application/json`. **PDF is deliberately
    excluded.** Accepting a type is not a claim that anything can read it — no
    vision or extraction capability is claimed anywhere.
  - Controls: exact HTTPS host from the existing `DISCORD_CDN_HOSTS`; declared
    type and size checked before any network request; the smaller of the
    configured cap and the provider's own; no redirects; no compressed
    transfer; the received stream capped again because a declared size is a
    claim; a `0700` directory and a `0600` file removed on success, failure
    and provider error alike; the startup sweep extended to the new prefix;
    per-owner hourly budget. No byte reaches SQLite, a log line, or a Discord
    reply.
- **One logical repository, several hosts.** A repository may name a checkout
  per executor (`placements`), and the slug stays the only thing anyone names:
  Discord supplies a slug and never a path, and the coordinator resolves the
  path at CLAIM time for the executor that is claiming. An executor is told
  where its own checkout is and never about anybody else's.
  - **The reservation is unchanged and still keyed on the slug**, so one job
    runs in one logical repository at a time however many hosts have it checked
    out. A test asserts that, and asserts `repo_reservations` has no executor
    column that could split it per host.
  - **`placements` is EXHAUSTIVE once present.** An unlisted executor is not
    eligible and its jobs WAIT — the owner's private `/job status` says so,
    naming the configured hosts. Waiting is recoverable; running against a
    directory that means something else on that machine is not.
  - `preferredExecutorId` is a preference, never a pin: while that host is live
    it takes the work, and once it is not, the other placed hosts become
    eligible. One host being off must not mean one repository being dead.
  - **The single-path form is unchanged in meaning**, so no existing
    configuration needs an edit. Setting both forms is refused at startup
    rather than resolved by precedence.
  - **`/repo status` reports executor IDS, never paths.** A filesystem path
    still never reaches Discord in either direction.
- **A watch-only GitHub mapping.** `allowJobs: false` separates "may be
  observed" from "may be edited". Before it, adding a GitHub mapping so a
  repository could be watched also made it a job target — and a job target is a
  directory a real agent gets edit capability in. `/job submit` refuses a
  watch-only repository outright, so no job row is created for work that could
  never run.
- **The executor proves the checkout is the right repository.** When
  configuration says which GitHub repository a slug IS, `origin` is checked
  against it before anything else happens; both URL forms are accepted, and
  anything else is refused rather than assumed. A repository with no mapping is
  not refused — plenty of real checkouts have no remote. The remote URL is
  never echoed in the refusal, because it can carry a username.
- **Opt-in `fetchBeforeJob`**, default off, the only part of workspace
  resolution that touches the network. A FAILED fetch is not fatal: the base
  stays the local ref, because `origin/main` after a failed fetch is an older
  local copy with a more convincing name.
- Job lifecycle: queue, claim, lease, heartbeat, result intake, cancellation
  (supervised mid-turn, acknowledged only once a stop is observed), owner-input
  rounds, per-repo reservations, durable workspace registration, crash
  recovery, reconciliation
- **Engineering work phases, now actually reported.** `preparing`, `planning`,
  `implementing`, `reviewing`, `fixing`, `verifying`, persisted beside the job
  state rather than replacing it. Set on claim, moved by an **allowlisted**
  `phase` on the executor's job heartbeat, validated against an exhaustive
  phase machine
  (a report cannot walk backwards from implementing to planning), idempotent
  for a repeated report, and cleared whenever the job stops being lease-bearing
  so a paused job never renders a stale phase. Shown privately as
  "Working — reviewing"; never in a shared channel.
  **`running` is still the only lease-bearing state**, so the partial unique
  index, the lease-expiry sweep, the supervised cancel branch and the claim
  predicate are unchanged. `approved` / `executing_approved_action` were
  deliberately NOT added: the performer is still unimplemented, so they would
  be dead states. See
  [decisions/0016](decisions/0016-work-phases-dependency-waits-and-audit.md)

  **Where each phase comes from, exactly.** Until this milestone no executor
  code path ever sent `progress.phase` at all, so a live job sat at `preparing`
  from claim to terminal state while this document claimed otherwise. Now:
  - `preparing` — set by the coordinator on claim.
  - `planning` — emitted by the orchestrator when the brief is handed over.
    That is a fact it observes.
  - `implementing`, `reviewing`, `fixing`, `verifying` — read from
    `.ducky/phase`, a one-word file **Pi writes about itself**, which the brief
    asks for. Herdr can only report `idle | working | blocked | done | unknown`,
    so nothing else could observe these; inferring them from a terminal scrape
    would be a guess dressed as an observation. If Pi does not write the file,
    the job honestly stays at `implementing` or earlier.
  A report is carried by a **coalesced immediate heartbeat** (2 s debounce, one
  in flight, the regular lease interval never reset), so a phase appears in
  seconds rather than after a full interval. A phase the machine would refuse
  is not sent, and one the coordinator refuses is not resent — a refused report
  fails the whole heartbeat, and losing a lease renewal to it would be a bad
  trade.
- **Explicit approved Git actions.** An owner can use `/job execute` after a
  per-action approval; the immutable proposal and a durable execution ledger
  are checked before the opt-in same-filesystem performer can commit, push or
  create a PR. The default flag remains off, and no action is executed merely
  because it was approved.
- **Durable waiting-on-dependency path.** A result may report
  `waiting_on_dependency` with a closed dependency shape (type, description,
  optional opaque external key, next check, and TWO ceilings: a check count
  and a wall-clock deadline). Persisted in the same transaction as the result
  and the transition. **The lease is released and the repository reservation is
  retained**, so nothing else starts in that repository while the job waits.
  Visible in the owner's private `/job status` only.
  - A bounded `DependencyResolver` runs on the existing coordinator interval —
    no second scheduler, no per-dependency timer, no unbounded polling. Batched
    per pass, compare-and-set on the check count, bounded exponential backoff,
    re-entrancy guarded. A checker that throws or hangs counts as `pending` and
    **still spends a check**.
  - Outcomes: `ready` → requeued keeping its reservation; `failed` → job fails
    and the repository is released; `pending` with budget → rescheduled;
    **budget spent → `needs_owner_input`**.
  - **The DEFAULT checker never reports ready.** `UnavailableDependencyChecker`
    answers `pending` for everything, so a wait ends at the owner's desk rather
    than being resumed on a check that did not happen. A `ready` from an
    unverified checker is downgraded, not believed.
  - **A real one now exists, opt-in and still unverified.**
    `DUCKY_DEPENDENCY_CHECKER=github` selects `GitHubCiDependencyChecker`, which
    reads CI status for `<repo slug>#<pr number>` through the same read-only `gh`
    surface everything else uses. It answers `ci_run` only; anything else stays
    `pending` rather than a confident guess. It reports itself **unverified** —
    no GitHub repository is configured here, so no live check has run — which
    means on this host it can **fail** a job whose CI definitely failed and
    **cannot resume** one. That asymmetry is the correct one: failing on a
    definite failure is safe, resuming on an unexercised integration is not. A
    malformed key, an unknown repository or a `gh` error is `pending`, never
    `failed`: a lookup problem is not evidence about the work.
  - Cancelling a waiting job closes its dependency in the same transaction, so
    the resolver cannot later requeue a job the owner stopped. The cursor is
    durable, so a restart resumes from it.
- **Central command policy.** Every `gh`, `git` and `herdr` operation is
  classified `read_only` / `local_mutation` / `external_mutation` /
  `high_risk`. Ordinary workspace inspection has a `local_mutation` ceiling;
  the explicit, owner-approved action performer may opt into the narrow
  external entries. Force, hook-bypass and high-risk verbs remain refused.
  `gh-cli`, the executor's `git` helper and **now `HerdrCli`** consult it before
  spawning: the frozen argv table decides what can be constructed, the policy
  decides whether it may run. No arbitrary shell anywhere.

  Until this milestone that sentence was two binaries out of three. Every herdr
  invocation went straight to a subprocess, and `agent get`, `workspace close`
  and `worktree remove` were not classified at all — so the claim above was
  false for the surface that starts agents. Both spawn points in `HerdrCli` now
  assert, `agent get` / `agent read` / `agent wait` are classified `read_only`,
  `workspace close` / `worktree remove` are `local_mutation`, and a test drives
  every method the orchestrator uses and asserts each argv it builds is
  classified. One consequence is deliberate: `--force` is a forbidden flag, so
  a forced worktree removal is refused **before** a subprocess exists rather
  than deleting a checkout that still holds uncommitted work.
- **Structured audit log.** Job creation, claim, every transition (written from
  the single point of state change, so coverage is structural), phase changes
  including refused ones, cancellation, failure, approval decisions, executor
  connect/offline and every dependency event. It is a record and **never an
  authority** — nothing reads it to decide anything, asserted by a test. No
  secret, no raw authentication material, no terminal output, no environment;
  the owner is recorded as the role `owner` rather than a Discord id. Details
  are redacted and clamped, recording never throws, and the reconciler prunes
  past the retention window.
- Per-action approvals, decided individually, with a separate View Details
  control. `/job execute` is an explicit owner-only second step; a durable
  per-approval ledger prevents replay. Same-filesystem development execution
  supports commit, push and PR when `DUCKY_DEV_APPROVED_ACTIONS_ENABLED` is
  deliberately enabled; the default remains disabled and issue/deploy/Azure
  actions remain recorded-only.
- Proactive job notifications on lifecycle transitions (running,
  needs_owner_input, needs_approval, completed, failed, cancelled), delivered
  to up to two independent targets:
  - the **owner DM**, with the same signed Answer/Approve/Reject components
    `/job status` offers;
  - the **originating shared channel**, when the job was submitted from one
    and that channel is still configured — the safe projection only, never a
    control.

  Both are swept off the durable `job_transitions` ledger on the existing
  reconcile interval, **not pushed instantly**: delivery lags by up to one
  interval. The ledger is keyed per `(transition, target)`, so the two
  succeed, fail and retry independently and neither can be double-sent. An
  upgrade backfills prior history as already delivered rather than replaying
  it. An owner-caused transition is skipped for the DM (already answered
  synchronously) but is posted to the channel, where nobody saw that reply.
- Plain-language job state labels and explicit "what happens next" copy on
  both the private and shared surfaces, derived exhaustively from the
  persisted state. Work phases refine the private running label, and
  `waiting_on_dependency` is an explicit validated state.
- Authenticated, signed, replay-resistant, rate-limited executor API
- Executor: outbound polling, fail-closed workspace resolution, single-writer
  lock, Herdr/Pi orchestration behind a port
- Read-only GitHub inspection through a frozen `gh` argv table, plus bounded
  owner-configured repository watches with normalized-snapshot deduplication
  and owner-DM change summaries. **The final milestone widened what a watch can
  see** — merges (via `pr list --state all`, so a merge is observable as a merge
  rather than as a pull request that vanished), approvals, requested changes,
  review comments, the commits under review, workflow **failures and the recovery
  after one**, and issue activity. Every `--json` selector is recorded from `gh`
  itself by `pnpm probe:gh` — locally, with no repository named and no network
  request — and a test asserts the argv table against that record. Response
  VALUES are still unrecorded, because no GitHub repository is configured in this
  host's allowlist, so every added schema field is optional: a missing field
  degrades the summary and never fails the observation.
- **Requested changes propose a job; nothing submits one.** A pull request whose
  review asked for changes produces one owner-DM proposal naming the exact
  `/job submit` command. No job is created, no approval is bypassed, and every
  existing gate is untouched because nothing reaches them. The proposal is tied
  to the repository, the PR number, the head commit AND the review timestamp, and
  deduplicated by the database (`UNIQUE (watch_id, fingerprint)`, inserted `OR
  IGNORE`) — so it appears once per genuinely new review or new code, never once
  per pass, and stops entirely once the PR is merged. A one-press signed control
  would have been friendlier and would have needed a new entry on the owner-only
  interaction manifest, which `AGENTS.md` forbids widening; the owner types the
  command instead.
- Redaction at the transport boundary; no secret in the database or logs

## Detail: the GitHub feed (issue #6)

What it does, off by default (`DUCKY_GITHUB_FEED_ENABLED`): reads a **selected
list** of repositories (the enabled, GitHub-mapped allowlist entries, plus
`DUCKY_GITHUB_FEED_REPOS`, minus `DUCKY_GITHUB_FEED_EXCLUDE`) and announces, once
each, a newly opened pull request or issue, a review that requested changes, a
failed Actions run (by id and rerun attempt) and a failed check on one of the
five newest open pull requests that is not an Actions run (external CI statuses
and app check runs, by pull request, head commit, name and completion time).
With `DUCKY_GITHUB_FEED_REVIEW_REQUESTS`, a review requested of the signed-in
account personally is also found in any repository it can see. Default-branch
commits, direct pushes included, are buffered by (repository, sha) and sent as
ONE digest at the configured local time (`DUCKY_GITHUB_DIGEST_AT`, default
09:00). Public selected repositories post to the `github` channel; everything
else goes to the DM. See
[ADR 0029](decisions/0029-github-feed-and-the-delivery-only-github-channel.md).

Bounds and limits, stated rather than implied:

- Open PR, issue and run lists are 20 deep; commits are read newest-first, 30 per
  page, at most 3 pages; review requests are the 25 most recently updated;
  external checks cover five pull requests per pass. Anything beyond is not
  watched, and a force-push or more new commits than the walk reads is reported
  in the next digest as possibly incomplete.
- Review requests have no request timestamp in the search, so a renewed request
  is recognised only after the PR is seen absent from a read that was not full.
  While the window is full that cannot be told, and `/status` says so.
- `gh pr checks` reports the Go zero time (`0001-01-01T00:00:00Z`) for a commit
  STATUS (reported by review; this host has no pull request with a status to
  confirm it, and no unrelated repository was queried to find one). An empty,
  unparseable or pre-1990 timestamp is treated as missing and never moves the
  watermark. A failing status is then identified by pull request, head, check
  name and a failure episode, and announced only when that check was previously
  seen not failing (a failure after pending or passing), the head is new on a
  pull request already known, or the pull request was created after the checks
  baseline (judged from its own creation time, so it does not depend on the
  pull-request unit having run first); an old pull request or head met for the first time is recorded
  silently. A status that is already failing the first time its head is seen, on
  a pull request that is neither new nor known, is therefore never announced.
- If ANY pull request's checks cannot be read, the pass keeps the old watermark
  and that pull request's old state (so a failure there is not mistaken for
  history when it is read again), and the baseline is not recorded at all until
  every one of them reads.
- Actions-backed checks are announced from the run path only, never twice.
- The digest waits up to 30 minutes after the slot for a post-slot read of every
  selected repository, then sends what it has; a slot more than 20 hours old is
  skipped (its commits stay for the next digest, and are retired 14 days after they were OBSERVED, not by their commit date).
- Live observation (`pnpm probe:github-feed`, public `duckycodess/ducky-bot`,
  mock transport, injected clock, in-memory database): history recorded and not
  announced; three repeated polls announced nothing; the same poll again
  announced nothing; five real open issues and the two newest commits were
  treated as new by pre-seeding the cursors (that simulates WHEN the watch
  began, it is not an observed new event); all five card link buttons and the
  digest's View commits link returned HTTP 200; zero control buttons; the
  allowlist table unchanged. The review-request search ran and returned nothing
  for this account, so its element shape has not been seen live; no failing
  external check and no new pull request exist to observe; `gh pr checks` here
  only ever answered "no checks reported". **No real Discord channel or DM
  received a card.**
- A paused model quota cannot stop it: the service imports no provider and a
  test runs it beside a provider that always fails.

## Native conversation threads (issue #4)

**Built, off by default, and never run against Discord from this worktree.**

A qualifying top-level message in a channel named in
`DUCKY_*_THREAD_PARENT_CHANNEL_IDS` opens one visible thread, and that thread's
id becomes the conversation's identity. Nothing is configured here, so nothing
happens here: the list is empty by default and an instance that names no channel
behaves exactly as it did before.

What is true of the implementation:

| | |
|---|---|
| One thread per starter | Idempotent on the starter message id; Discord's `MESSAGE_ALREADY_HAS_THREAD` recovered by the documented id identity |
| Failure | Refuses visibly, answers NOWHERE. No fallback into the parent channel |
| Role | A thread inherits its parent's role, and nobody's rights. `Authorizer` still reads frozen env config |
| History | Full transcript while the thread lives; the bound is a per-turn BYTE budget, with compaction and a refusal past it |
| Reads | A thread read takes a participation proof, issued only when a participation row exists |
| Controls | Branch and Compact, the first two interaction kinds a non-owner may press, on their own positive manifest |
| Deletion | `/forget conversation` rotates the provider session epoch and reports PARTIAL; retention removes a CLOSED thread whole |

**This reverses the roadmap's own proposal**, which said Ducky would create no
thread. The owner asked for the opposite in issue #4 and the issue wins; both
documents now say so, and the reasoning is in
[ADR 0027](decisions/0027-native-thread-conversations-and-the-first-non-owner-controls.md).

**What has NOT been verified**, stated rather than implied by the test count:

- no Discord thread has ever been created by this build. There is no `.env` or
  `.env.development` in the worktree it was written in, so there is no
  development token, no guild and no configured parent channel;
- the Branch and Compact buttons have never been rendered by a real client, and
  no human has pressed one;
- `probe:openclaw` could not run (the pinned binary is absent), so the provider
  session-deletion surface is unrecorded and `RECORDED_SESSION_DELETION` stays
  null;
- the thread-permission failure paths (Create Public Threads, Send Messages in
  Threads, rate limiting, `Unknown Channel`) are covered by faked transport
  outcomes, not by Discord refusing anything;
- `Events.ThreadDelete` is wired and asserted structurally -- the handler is
  registered and routed, and the requested gateway intents are still the same
  four -- but no real thread has been deleted in a guild to see it fire.

## Retention and deletion (milestone 2E, the substance of it)

- **Bounded retention, OFF by default.** `DUCKY_RETENTION_ENABLED=false` means
  no window is consulted and nothing is deleted. When enabled it rides the
  existing coordinator interval — no second scheduler — and every table is
  capped at `DUCKY_RETENTION_BATCH` per pass, so a tick is short and a pass that
  hits the cap resumes on the next one.
- **Per kind of record, each with its own window** (ADR 0022). Job metadata —
  the row, its transitions and its delivery ledger — at **90** days; the job's
  **DETAIL** (result snapshot, events, the owner's answers) at **30**, so the
  most specific thing Ducky stores about a repository goes first while the shape
  of what happened survives; done/archived captures at 365; closed tasks at 90;
  finished reminders and their occurrences at 90; past confirmed schedules at
  180; the audit log at 90; settled watch events at 90; idempotency keys at 7;
  conversation turns at 30 (owner) and 7 (a chat-whitelist guest). Cancelled
  watches and the retention run log stay fixed at 365 and are deliberately not
  configurable. `executor_nonces` keeps its existing prune.

  Pruning the detail of a job it keeps is safe because every reader already
  treats a missing result as normal — a queued job has none — and the count is
  reported separately from the child rows of jobs that went entirely, so a job
  surviving without its detail is visible rather than hidden in one total.

  The two earlier variables (`TERMINAL_JOBS_DAYS`, `CLOSED_ASSISTANT_DAYS`) are
  kept as **deprecated aliases** rather than silently ignored: an operator who
  set one expressed an intent, and an explicit new value always wins.
- **Schedules are time-zone correct.** `schedules.starts_at` is wall-clock text
  in the owner's zone, so a schedule goes only when it was confirmed longer ago
  than the window AND its event is genuinely past in `DUCKY_OWNER_TIMEZONE`. The
  SQL selects on `confirmed_at` (a real instant); the zone-aware test happens in
  TypeScript. An unparseable stored time is kept, never deleted.
- **Six guards per job, and a skip is counted.** A job is skipped whole — never
  partially deleted — if it is non-terminal, has no `finished_at`, holds a
  repository reservation, has an open workspace, has a pending approval, or has
  an open dependency. A terminal job still holding a reservation is an
  inconsistency somebody should see, so `jobsSkipped` is reported rather than
  swallowed.
- **Never reachable at all:** `repos`, `authorized_user_audit`, `executors`,
  `executor_credentials`, `repo_reservations`, `schema_migrations`. Tests assert
  the source of both the repository and the service names none of them in a
  `DELETE`.
- **Every pass is recorded twice** — in `retention_runs` and in the audit log —
  with counts only, including a pass that deleted nothing.
- **`/forget job <id>` and `/forget conversation`**, owner-only, on the
  owner-only manifest, never shared-readable. `/forget job` is two-step: the
  command shows what will go and returns a signed control bound to the owner;
  only pressing it deletes. An unknown id and somebody else's id are answered
  identically. **`/forget` also names one `capture`, `task`, `reminder` or
  `schedule` entry** — choices on a command that was already owner-only, so no
  command and no interaction kind was added and the owner-only surface is
  unchanged. With no id it LISTS the owner's records with the ids they can type,
  as a plain read with no controls; captures and schedule entries are named by
  the 8-character id prefix `/inbox` already shows, and an ambiguous prefix is
  refused rather than resolved. Every statement is owner-scoped in its WHERE
  clause, a reminder takes its occurrence outbox with it child-first, and every
  deletion is audited by count. **`/forget conversation` now deletes for real** — every stored
  turn of every thread for that owner, one step (there is no id to confirm and
  no live-work reason it could be refused), reporting and auditing the COUNT. It
  works even when continuity has since been switched off, because rows an
  earlier run stored are still the owner's to remove; and when nothing is stored
  it says so plainly.
- **No wipe-all path at any layer.** `FORGET_TARGETS` cannot express one.

Both `/forget` and the scheduled pass use the SAME deletion implementation, so
there is one child-first order and one set of guards rather than two that could
drift apart.

## Detail: what the smoke-test evidence actually shows

The owner confirmed one development smoke test: after a controlled restart,
`hi` in the configured GPT guild channel produced an actual reply. **This host
still holds no durable interaction record**, because the coordinator does not
log message content or replies; the confirmation is therefore recorded here as
owner-provided live evidence rather than as a replayable fixture.

What was inspected, read-only:

- **`/tmp/ducky-coordinator-dev.log`** — the running development coordinator's
  own stdout. It is **20 lines: boot diagnostics and the listening line, and
  nothing else.** No interaction, command, DM or reply is recorded, because the
  coordinator does not log them. So the log neither confirms nor contradicts
  the smoke tests; it simply has nothing to say about them.
- **The running coordinator is the rebuilt development process.** Its boot
  diagnostics report the current 21-migration schema, two allowlisted
  repositories, the selected OpenClaw provider and the passing text-only policy.
- **The development database is current.** `pnpm migrate --dry` reports the
  schema is up to date, and the running coordinator passed readiness against it.

**What was verified independently, and is not a report:** the registered command
set (12/12, read back), the gateway accepting the privileged intent, the current
policy check, and the coordinator health and readiness endpoints. The live GPT
reply itself is owner-confirmed evidence.

One defect fell out of this inspection. The boot diagnostics printed
`WARN discord intents: enable the privileged MessageContent intent` **whenever
the transport was real** — an instruction phrased as a warning about a state it
had no way of checking. It marked a healthy instance as warning forever, and on
this host it was simply wrong: the intent is enabled. It now states the fact
that IS knowable — Discord refuses the connection outright when the intent is
off, so a client that connects has proved it — and points at
`pnpm probe:discord-gateway` for an answer that does not need a coordinator.

## Security audit events

The audit log recorded the lifecycle in detail and nothing about who was turned
away. It now also records `auth.failed`, `auth.replay_detected`,
`authz.refused` (the **role**, never a Discord id), `rate_limit.exceeded` — for
both the Discord buckets (the **bucket**) and the HTTP routes (the **route**) —
`credential.reloaded`, `retention.pruned`, `data.deleted`,
`approval.requested`, `approval.expired`, `provider.failed`,
`config.rejected` and `workflow.requested` (the command token and the status
word, never the repository or anything the owner typed). None says why
authentication failed, and none records the material that failed.

Local commit/push/PR outcomes map onto the existing `approval.execution_*`
events, whose detail carries the action kind and, on failure, the redacted
reason. Startup configuration errors are logged rather than audited: they happen
before the database exists. Both distinctions are documented in
[SECURITY.md](SECURITY.md) and asserted by tests.

`AuditLogRepo.record` never throws by design, which means an enum value the
table's CHECK constraint does not allow is dropped **silently**. That happened;
migration 13 widens the constraint, migration 15 widens it again for the
approval, provider and configuration subject kinds, and a test now asserts every
declared event, actor kind and subject kind is actually persistable.

## Detail: what queueing a ticket can actually end in

This was inspected rather than assumed, because the ticket that asked for the
workflow bridge named it as a risk: **ticket prose cannot enforce a merge
policy.**

What the installed dispatcher does, read from its own source and its own
configuration on this host:

- `~/.config/agent-flow/config.json` registers **`duckycodess/ducky-bot` as
  `enabled: true` with no `completion` key.** Two other registrations on this
  host DO set `completion: pr_only`; this repository is not one of them.
- `agentflow.py`'s `auto_merge` returns early **only** when the registration
  says `completion == "pr_only"`. Otherwise, once its own `merge_ready` gate
  passes -- an explicit worker signoff (`ready_to_merge: true`, empty
  `merge_blockers`, a `pr_url` matching the open PR), GitHub reporting
  `mergeStateStatus == "CLEAN"`, and the required checks green -- it runs
  `gh pr merge … --merge` or `--rebase` with `--match-head-commit`. It refuses
  when the repository permits only squash, because that would lose the commit
  history.

**So an `agent:ready` label on a ducky-bot issue can end in an automatic merge
to the default branch.** That is the dispatcher's configured behaviour, it is
not new, and nothing in Ducky changes it: Ducky applies no label itself, and
the only thing it can do about this is say so.

It does say so. When `$ticket --ready` succeeds, the card states which policy
the registration carries -- `pr_only` and the dispatcher stops at a pull
request, or not `pr_only` and the dispatcher may merge once its worker signs
off. The fact is read from the registration the installed helper reports, so
the card cannot drift from the configuration.

**Changing it is an operator decision and was deliberately not made here.**
Setting `completion: pr_only` for `duckycodess/ducky-bot` is a change to the
dispatcher's own configuration, outside this repository, and the owner makes
it or does not.

## Detail: the certified production code path

`pnpm probe:live-job` drives the **shipped** chain — router → `JobsService` →
real Fastify HTTP with bearer/HMAC/nonce auth → `CoordinatorClient` →
`ExecutorLoop` → `runClaimedJob` → `resolveWorkspace` (real git) →
`acquireWriterLock` → `HerdrPiOrchestrator` → `HerdrCli` → Herdr → Pi →
`.ducky/result.json` → `FileResultReader` → `ResultIntake`. Only the Discord
transport is mocked, and deliberately: a certification run must never open a
gateway.

A successful run against the disposable allowlisted repository recorded:

- `orchestrator=herdr-pi` (not the mock) from the executor's own selection;
- `queued → running → completed (result_implemented)`;
- the **full engineering loop**, `preparing → planning → implementing →
  reviewing → fixing → verifying`, including the review⇄fixing back-edge;
- audit rows for creation, claim, every transition and every phase change, with
  none of `AUDIT_FORBIDDEN_SUBSTRINGS` present;
- a `herdr_workspaces` row with `mode=worktree` and a checkout path under
  `~/.herdr/worktrees`;
- the exact Herdr argv sequence, including `worktree create --label ducky-mgd:…`
  and `worktree remove`;
- an accepted result: `verdict=implemented`, an independent passing review, four
  verification commands with real exit codes, `changedFiles=["README.md"]`;
- **271 seconds elapsed** — direct evidence that the 30-second subprocess cap
  which used to kill every real turn is gone.

Not certified by that run, and stated plainly: no Discord gateway interaction,
no OpenClaw, and `DUCKY_HERDR_VERIFIED` was not set.

**Repeatability is now CERTIFIED: three consecutive clean runs.** Before the
readiness fix this said the opposite, and honestly so — of the runs attempted
then, two reached `completed` (271 s and 240 s) and three failed with
`agent_prompt_stalled`, because `agent start` reported `interactive_ready: true`
while Pi was still painting startup banners and the prompt was silently dropped.

Since the fix, `pnpm probe:live-job` has been re-run **three times in a row,
each against its own throwaway database**, and each exited 0 through the full
evidence gate:

| Run | Elapsed | Phases observed | Result |
|---|---|---|---|
| 1 | 162 s | preparing → planning → implementing → reviewing → verifying | `implemented`, independent review passed |
| 2 | 193 s | same | `implemented`, independent review passed |
| 3 | 192 s | same | `implemented`, independent review passed, two verification commands |

Every run recorded the full transition and audit history, the exact Herdr argv
sequence including `worktree create --label ducky-mgd:…`, a `herdr_workspaces`
row with `mode=worktree`, `changedFiles=["README.md"]`, and no leak at teardown.
Not one run stalled.

**The stall's absence is evidence, not luck.** The readiness observation is in
each run's argv: `agent read --source detection` appears two or three times
between `agent start` and `agent prompt`, which is the orchestrator waiting for
Pi's input frame on two consecutive reads rather than trusting
`interactive_ready`.

Ducky reported that honestly — its own error code, bounded observation, never a
re-prompt, workspace and reservation retained, and a non-zero probe exit.

**That cause is now fixed by observation rather than trust.** Before the first
prompt the orchestrator reads the agent's own pane (`herdr agent read --source
detection`, which answers plain text and needed its own call path) and waits for
Pi's interactive input frame on two consecutive reads. Recorded by
`pnpm probe:herdr --with-agent` across two independent agent starts: Herdr claims
`interactive_ready: true` from ~6 s while the pane shows no frame, and the frame
appears at 8.16 s / 8.24 s. The probe FAILS if the marker never matches a real
pane — and it did fail once, which is what corrected the marker: a freshly
started Pi never paints the status footer the first version also required.

There is no timing heuristic: stability is two consecutive observations, and if
the marker never appears the orchestrator falls back to exactly the previous
behaviour rather than refusing the job.

**Repeatability is measured now** — see the three runs above.
**`HerdrPiOrchestrator.verified` nonetheless stays `false`, `/status` still
reports `experimental`, and `DUCKY_HERDR_VERIFIED` is unset.** That is not an
oversight and it is not modesty: promoting the integration is a deliberate
operator act, and a probe that promoted itself on its own evidence would be
grading its own work. The evidence is on the table; the decision is the
owner's.
See [integrations/herdr.md](integrations/herdr.md) and
[runbooks/live-job-certification.md](runbooks/live-job-certification.md).

## Detail: what was exercised against live tools

- SQLite behaviour (`node:sqlite`, WAL, partial unique indexes, triggers)
- Herdr `agent list`, `workspace list`, `workspace create`,
  `workspace report-metadata`, `pane split`, `worktree create` — recorded as
  fixtures by `pnpm probe:herdr` and parsed by the production schemas
- Herdr `agent read`, recorded by the agent probe: **plain text, not a JSON
  envelope**, exit 0, four snapshot sources. The readiness observation and the
  banner-versus-frame timings are recorded with it — shape, digest and timings
  only, never pane content
- The `gh` read-only JSON surface
- Development Discord bot identity and configured guild REST access (HTTP 200)
- Development coordinator gateway startup on `127.0.0.1:8787`
- Slash-command registration, stated as two separate facts because they have
  drifted apart:
  - **DEFINED: 12 owner commands** — `/capture`, `/inbox`, `/schedule`, `/job`,
    `/jobs`, `/repo`, `/status`, `/watch`, `/forget`, `/task`, `/reminder`,
    `/briefing`. `OWNER_ONLY_COMMANDS` and the registration payload agree on all
    12, asserted by a test.
  - **REGISTERED LIVE: eleven of the twelve, measured rather than recalled.**
    This document previously said seven, and named five commands as never
    registered. That was wrong: `pnpm register-commands --diff --profile
    development` performs a GET against the configured guild and compares it
    with what this build defines, and the guild has `/briefing`, `/capture`,
    `/inbox`, `/job`, `/jobs`, `/reminder`, `/repo`, `/schedule`, `/status`,
    `/task` and `/watch`. Nothing stale is registered either.

    **`/forget` is the one missing command**, and it is the one that deletes
    the owner's own data. Registering it is an external write: it replaces the
    whole guild command set, so it is never done at boot and never inferred.
    Run `pnpm register-commands --apply --profile development` deliberately;
    the default remains a dry run.

    The lesson is the reason `--diff` now exists. "What is registered?" had
    been answered from memory of a past run for several milestones, and memory
    was wrong in the direction that makes a system look less finished than it
    is -- which is the safer direction, but still wrong.
- Development executor authentication, polling, and liveness heartbeat

The probe caught a real detail: Herdr checks a linked worktree out under its own
directory, not inside the source repository, so the result file must be read
from the reported checkout path.

**Now probed:** `herdr agent start`, `agent prompt` and `agent get` have been
exercised repeatedly against a real Pi agent, by `pnpm probe:herdr --with-agent`
(which records `agent-start.json`, `agent-prompt.json`, `agent-get.json` and a
result file a real agent wrote) and by `pnpm probe:live-job`. Their contracts are
recorded and parsed by the production schemas.

That is a recorded CONTRACT, not a certification of the integration: the
end-to-end path is intermittent (see above), so `HerdrPiOrchestrator.verified`
stays `false` and `/status` reports `experimental`.

## Detail: what is covered by tests but not by a live system

| Area | Status |
|---|---|
| OpenClaw conversation | **VERIFIED — the full contract is recorded and the shipped adapter answers.** The owner signed in with a ChatGPT/Codex **subscription** (`models auth login --provider openai --device-code`, under `--dev`); read-only checks report `oauth=1, token=0, **api_key=0**` and the runtime route `openai via codex … status=usable`. No API key is configured and nothing here reads one. Model: `openai/gpt-5.6-sol`, the documented Codex route, chosen from what that account actually exposes. `pnpm probe:openclaw` exits **0** and records both halves: the argv it actually ran, the reply envelope as a **type-only shape**, and zero tools exposed to the `ducky` agent under the required policy. `RECORDED_CONTRACT_VERSION = '2026.7.1-2'` and `verified` is DERIVED from it, so the two cannot drift. A live turn through the shipped `GatewayOpenClawProvider` returned the exact expected text in **33 s** with `mock: false`. The provider session is isolated by user and thread, but its transcript remains provider-owned. **Attachments stay unavailable** because the recorded agent turn takes text only. |
| Conversation attachment delivery | **Unreachable, by design.** The pipeline is unit-tested against an injected `fetch` and a test-only provider that supplies the one thing this host lacks — a verified, attachment-capable endpoint. **No live attachment byte has been fetched on this host, and none is sent anywhere.** It becomes reachable only when 2D produces a verified provider that declares attachment support. |
| Image / PDF schedule extraction | **Unsupported, and now re-checked rather than remembered.** Those uploads are refused before download. No decoder ships in Phase 1, and 2C did not add one: it forwards bytes, it does not read them. `pnpm probe:extraction` records what is actually installed, so the claim cannot drift the day somebody installs poppler for something else. A test asserts the shipped extractor reports `supportsBinary: false` whatever is on PATH — a decoder appearing on the host does not open the path. |
| `herdr agent start` / `agent prompt` | **Now exercised, repeatedly, against a real Pi agent** — by `pnpm probe:herdr --with-agent` (contract) and `pnpm probe:live-job` (production path). Five real defects were found and fixed as a result; see [integrations/herdr.md](integrations/herdr.md). The orchestrator nonetheless still reports `experimental`: `DUCKY_HERDR_VERIFIED=1` is a deliberate operator act and this run did not set it. |
| Cleanup after a completed worktree job | **Keeps the workspace, by design.** `herdr worktree remove` refuses a checkout holding uncommitted work, and a finished job's checkout holds the implementation plus `.ducky/result.json`. Ducky does not force — that would delete the work — so it reports the workspace as kept. The repository reservation IS released, so nothing is blocked; the owner clears the workspace with `/job cleanup`, and the reconciler sweeps a stale one after `HERDR_WORKSPACE_TTL_MS`. |
| Real Discord gateway | **The gateway accepts this bot, with the privileged intent, measured.** `pnpm probe:discord-gateway --profile development` connected and reached READY in 2 276 ms with `Guilds + GuildMessages + DirectMessages + MessageContent` — so **Message Content is enabled in the portal**, because the gateway refuses the connection outright rather than degrading when it is not. The owner also confirmed one post-fix GPT message round trip through the running coordinator. The probe registers NO handler and answers nothing, deliberately, because a coordinator may be running on the same bot identity and two wired connections would race for the same interaction. Proactive job notifications still lack an owner-initiated live DM test. |
| The phone capture flow end to end | **Unverified, and blocked on this host.** Every route is exercised through a real Fastify instance -- the passcode, a forged cookie, a missing CSRF token, an executor bearer token on the page, a phone session on the executor routes, the parse, the idempotent save and the boot refusals -- but **no phone has ever opened it**. Tailscale is not installed here, no tailnet address exists, and nothing in this repository installs one. What is therefore untested is the part a browser owns: the home-screen shortcut, the standalone manifest, real cookie handling on iOS/Android, and whether the page is pleasant to use with one hand. Remedy: install Tailscale on both nodes, set `DUCKY_HTTP_HOST` to the tailnet address, enable the page, and walk `docs/SMOKE_CHECKLIST.md`. |
| Reminder cards in a channel | **Unit-tested only.** Routing, the owner mention, the controls and their refusal for a non-owner are covered against the mock transport. No card has been posted to a real Discord channel on this host, and no channel is configured here. |
| Reminder DM delivery | **Unit-tested only.** Materialization, collapse, retry, abandonment and DM-only targeting are covered against the mock transport with an injected clock. No reminder has been delivered to a real Discord DM on this host; it uses the same unverified gateway path as job notifications. |
| Shared-channel delivery | **Unit-tested only.** `channelAwareSink` is covered against a structurally-typed stand-in client, and the sanitization boundary is asserted for a channel send. No message has been delivered to a real Discord channel on this host. |
| Shared-channel command routing | **Unit-tested only.** Channel/guild/DM context is populated from `discord.js` interaction fields (`channelId`, `guildId`) but has never been exercised by a real interaction, so the DM-versus-guild distinction the whole policy rests on is verified against constructed events, not live traffic. |
| Slash-command registration | **All twelve** development commands are registered to the configured test guild. `/forget` was applied in this milestone with explicit owner approval, and the result was read back with `pnpm register-commands --diff --profile development`: 12 defined, 12 registered, nothing stale. Production remains unregistered; the default command-registration mode remains a dry run. |
| Interrupting a live Pi turn | Herdr exposes no verified way to interrupt one without risking a half-written edit, so cancellation aborts our wait *immediately* and then observes the agent. A still-working agent is reported honestly, the writer lock is retained, and the repository stays reserved for the owner. |
| Approved action execution | **Unit-tested only.** An opt-in same-filesystem performer validates the immutable proposal, allowlisted workspace, branch and GitHub origin before commit/push/PR. The default flag is off; no live external write has been performed here. Production executor routing, issues, deployments, Azure and high-risk actions remain unsupported. |
| GitHub repository watches | **Now observed against a real repository, in part.** `pnpm probe:gh-live` drives the shipped `GhCliReader` and the watch loop against `duckycodess/ducky-bot` (watch-only, `allowJobs: false`). Five read surfaces — `repoView`, `prList`, `prListAll`, `runList`, `issueList` — returned live responses that the production schemas accepted; the watch loop observed the repository and then produced NOTHING on an identical second pass, which is the deduplication property a watch lives or dies by and which had only ever been tested against a mock. `prView` / `prChecks` / `prReviews` remain **unexercised**: that repository has no pull request, open or closed, and opening one is a GitHub write. Nothing reached Discord — the loop ran through the real composition root with an in-memory database and the mock transport. Previously, and still true of the unexercised surfaces: |
| GitHub repository watches (the rest) | **Unit-tested only, and now wider.** The loop reads merges, approvals, requested changes, review comments, commits under review, workflow runs (failure and recovery) and issue activity — all through the frozen read-only argv table, with every `--json` selector recorded from `gh` itself by `pnpm probe:gh`. What is NOT recorded is any response VALUE: **no GitHub repository is configured in this host's allowlist** (`github: null`), so no live watch has run and picking a repository to point at would mean reaching for one nobody selected. Schemas are tolerant for that reason. Recent commits on the DEFAULT BRANCH are now readable, by one exact `gh api --method GET` shape (see the GitHub feed section); `api` stays on the forbidden-verb list for every other table. |
| Dependency checking | **A real checker exists and is opt-in; it is not verified.** `DUCKY_DEPENDENCY_CHECKER=github` reads CI status through the read-only `gh` surface. It is unit-tested against a mock reader and has never run against a real repository — none is configured here — so it reports `verified: false` and the resolver downgrades its `ready`. Net effect on this host: it can fail a job on a definite CI failure and cannot resume one. The default remains `none`, which only ever answers `pending`. |
| Repository workflow bridge | **Unit-tested against a stand-in, and that is the whole of it.** 39 behaviour tests plus invariant tests drive `MockFrontDoor`, which records every call: the `--ready` flag, the canonical id reuse, the issue number on a retry. **The installed `workflow.py` has never been invoked by Ducky on this host.** It could not be without creating a GitHub issue on a real repository, and no disposable registered repository exists here to point it at. So: the argv the adapter builds is tested, the policy refusals are tested, the temp-file lifetime is tested, and the end-to-end integration is NOT certified. |
| Azure deployment | Documented only; nothing provisioned. |

## Detail: the blockers, and what would clear each

Every one of these is blocked by a specific fact, not by effort. Each names what
would unblock it.

| Blocked | The exact blocker | What unblocks it |
|---|---|---|
| Real conversational replies | **UNBLOCKED on development.** The owner signed in with a ChatGPT/Codex subscription, the probe records a successful turn under the verified zero-tool policy, the shipped adapter returned a real reply in 33 s, and the owner confirmed a GPT reply after the latest restart. | Nothing technical for development. For a DIFFERENT host, such as production, its own sign-in under its own `OPENCLAW_PROFILE` and its own text-only tool policy; a signed-out or permissive host refuses rather than falling back. |
| Conversation ATTACHMENT delivery | **One blocker now, not two, and that is worth stating rather than celebrating.** The provider used to be unverified AND incapable; it is now verified, so the only thing refusing an attachment is the capability flag — honest, because the recorded agent turn has no attachment input at all. A test asserts the two shipped providers are shut for *different* reasons, so this cannot be flattened into "both unavailable" and flipped later. | A verified provider that genuinely declares attachment support. Not OpenClaw's agent turn as recorded. |
| Image / PDF schedule extraction | No decoder ships and none is installed. **Re-checked, not recalled:** `pnpm probe:extraction` runs `--version` on six candidates and records the result — `pdftotext`, `pdfinfo`, `qpdf`, `tesseract`, `pdftoppm` and `gs` are all ABSENT. No provider reports `supportsBinary`, so nothing could read the bytes anyway. Uploads are refused **before download**. | `poppler-utils` (for `pdftotext`) **plus** a provider reporting `supportsBinary: true` **plus** `SCHEDULE_BINARY_EXTRACTION_ENABLED=true`. Three separate things, and installing a decoder is a host mutation of its own. OCR is deliberately not the answer: it returns a guess about pixels that misreads digits, and a wrong time the owner then confirms is worse than a refusal. |
| Herdr/Pi **certification** | **Unblocked.** Three consecutive clean `probe:live-job` runs (162 s / 193 s / 192 s), each on its own throwaway database, each through the full evidence gate. The race that made this unmeasurable is now DETECTED rather than described: the probe refuses to start when another executor has checked into the same database in the last two minutes. | Nothing technical. `DUCKY_HERDR_VERIFIED=1` remains a deliberate operator act, and no probe sets it. |
| A live GitHub watch | **Unblocked.** `ducky-bot` carries a watch-only mapping and `pnpm probe:gh-live` has observed it, twice, deduplicating the second pass. What remains blocked is narrower: the pull-request surfaces, because that repository has no PR. | A configured repository that HAS a pull request. Opening one is a GitHub write and nothing here makes it. |
| Recent commits on a repository's default branch | Reachable only through `gh api`, and `api` is on the forbidden-verb list. | A different read-only surface, or a deliberate decision about `gh api` with its own classification. |
| Verified dependency checking | The GitHub CI checker still has never run against a real repository — the watched one has no pull request, so `prChecks` has nothing to check. It reports `verified: false` and the resolver refuses its `ready`. | One recorded live check against a repository with a PR. It can already **fail** a job on a definite CI failure. |
| Live Discord delivery | **Partially verified.** All twelve commands are registered (read back with `--diff`), the gateway accepts the connection with the MessageContent intent (`probe:discord-gateway`, READY in 2 276 ms), and the owner confirmed one GPT guild-message round trip after the restart. Slash-command delivery, DMs, reminders, briefings, watches and shared-channel posts remain unverified live. | Interaction records that outlive the terminal. The coordinator logs boot diagnostics and nothing else, so the owner-confirmed reply leaves no durable local interaction record. |
| `/meal` and `/study` as slash commands | `AGENTS.md` forbids widening the owner-only surface. | Nothing here. Both features shipped on the conversation route instead, owner-gated, with no manifest entry. |
| A certified repository-workflow run | Installed adapter inspection, canonical validation and reuse of existing parent #3 were verified against the real helper and GitHub. Isolated creation, retry and explicit queue verification remain pending. | Complete the disposable-target deployment checks tracked in #13; existing reuse evidence does not certify that full scenario. |
| The phone capture page, on a real phone | Tailscale and development Discord guild access are available on the remote host. Physical-phone capture and live reminder controls remain unverified. | Configure the private listener and owner passcode, then complete the device and Discord deployment checks in #13. |
| Azure deployment | Azure files remain templates; the selected remote runtime uses an existing Tailscale-connected computer. | Azure provisioning is outside this remote-host deployment scope. |

## Deferred

Collaborator job submission (visibility shipped; writes stay owner-only);
multi-user permissions beyond shared visibility; public bot; autonomous
deployment; automatic GitHub or Azure writes; arbitrary shell; browser
automation; container sandboxing; concurrent implementation writers; executor-
routed production actions; issue/deploy/Azure performers.

## Detail: the private-assistant migration

Issue #9 retires the owner's private assistant module only after its records and
accepted behavior work in Ducky. The owner chose **full parity** on 2026-10-13.
The design is [ADR 0030](decisions/0030-private-assistant-migration-and-parity-capabilities.md)
and the procedure is [runbooks/dcstro-cutover.md](runbooks/dcstro-cutover.md).

**What exists and is covered by tests:** the `ducky-assistant-import/v1` contract
and its content-free failure report; `pnpm import:assistant` (validate, `--verify`,
`--apply` behind a matching backup and the runtime lock); the permanent correlation
ledger with trigger-written tombstones; indefinite weekly schedules and dated
exceptions integrated with the briefing, `/forget` and retention; a per-task
reminder policy that survives Done, Edit and Snooze; scoped, non-authoritative
preferences with lookahead, captures, GitHub-digest and weather briefing sections;
notification-only watch targets with typed checkpoints, held partial reads,
separate alert and digest settlement and a fixed call budget; the
`/watch list targets` / `/watch remove` owner controls; and exact, delivered-only
reconciliation between the native paths and the imported targets (ADR 0034, migrations 36 and 37):
a ledger of native receipts and reservations by exact transition and by native HOLDER (a feed card and
an ordinary summary can both hold one transition), a shared codec, ordinary watches that record the
repository they queried, exact new requested-changes reviews and proven pull request openings in the
ordinary summary, durable held facts, pause provenance, withheld-event accounting and a v4 rollback
export. Migrate through 37 before the final export; an older build cannot honour the holders. **Operator sequencing it needs:** stop the coordinator, back up,
migrate, and only then take the final source export, so imported cursors lie after the ledger
cutoff; then require `pnpm import:assistant --verify` to exit 0 (it exits 5 when the data is present
but not at parity: drift, a withheld event, a held native card, a held ordinary requested-changes fact or a cursor at or before the cutoff). Never run an older build against a migrated database.

**Upgrade notes.** Migration 29 introduces the runtime lock, which a coordinator from an
older build does not know; stop the coordinator before migrations, and never start an
older build against a migrated database. A scratch database migrated to 29 from an
earlier revision of this branch must be recreated, because that unpushed migration
was revised.

**What does not exist, or was not done, and is therefore still required** (see also *Required parity blockers* below):

- **A real typed reader: partly done.** Release publication, closing times, reviews,
  runs, issues and the default branch are now read by `GhWatchReader` (ADR 0031) when
  `DUCKY_ASSISTANT_WATCH_READER_ENABLED` is set; it is off by default, so the shipped
  default still declares nothing and an import with watch targets still fails closed.
  Repository discovery and the source's recency-limited poll cycle are implemented and
  unit-tested (ADR 0031) but have never run live; completeness and latency are unproven.
- **Every operational gate in the runbook.** No fresh live source backup or
  restoration configuration, no private source-to-target parity, no live synthetic
  notification or Done/Edit/Snooze/non-owner check, no reverse-delta rollback
  bridge, no cutover and no module retirement. Nothing was imported, deployed,
  stopped or changed on any real system.
- **A rollback-delta export: implemented; the bridge is not.** `pnpm
  export:rollback-delta` (ADR 0033) writes one private file of what changed in Ducky
  since an import (changed and added records, deletions by identity and cause, and
  watch, briefing and switch state), under the runtime lock or from a verified backup,
  exiting 5 and writing nothing when it cannot say something (an unknown baseline, a
  deletion with no recorded cause, a table past its cap). It is unit-tested with a
  synthetic replay against a model of the source, which proves completeness and
  idempotence for the listed categories and nothing more. **No reverse bridge to the
  source exists or was rehearsed**, and the export authorizes no restore of stale data;
  the proven reverse-delta rollback stays a required operational gate.

**Required parity blockers.** The owner settled full parity on 2026-10-13. Every
item below is a behavior the source has that Ducky does not yet have. None is an
accepted exclusion or a proposed omission: each stays a required blocker, and
cutover and module retirement stay blocked, until it is supported and proven.
Where Ducky refuses an input instead of carrying it, the refusal is the
fail-closed form of the blocker, not a decision to drop it.

- **Unsupported source values (refused by validation, never normalized):** AI
  wording of briefings (the only approved provider is a session-keyed OpenClaw turn
  whose transcript `/forget` cannot delete, so it needs a stateless-call contract, an
  owner decision and live evidence; every briefing stays deterministic), and meals
  (their preferences, suggestion history and the meal-in-briefing behavior; the source's
  built-in catalog cannot be copied, so mechanics alone would not be parity). The `urgent` priority and the two task categories are
  now carried as data (ADR 0032): urgent is stored as `high` plus a flag, ranks above
  high in lists and the lookahead and is shown as urgent, and the category is shown
  with the task; no native command sets either, and the task command definitions are
  unchanged. Unit-tested only. The paused
  global watch switch is carried over and gates reads, and the owner sets it with
  `/watch monitoring state:on|off` (explicit, never a toggle; the same state changes no
  row, timestamp, audit row, pause period or delta). **Resuming is no longer refused because history
  exists** (ADR 0034, which replaced the earlier blanket guard): pause provenance (owner, import or
  unknown, a real start only for an owner's pause), the repository an ordinary watch actually queried and the
  exact transitions native paths delivered are recorded, and every imported event is decided against
  that ledger. It refuses only when the ledger boundary cannot be read. **Still required, not
  waived:** what predates the ledger cannot be placed, so on a database that is not verifiably new every
  imported event with a native counterpart at or before the migration-36 cutoff (plus one second)
  and no exact receipt is **withheld**, never delivered or settled, counted in `/status`, `--verify`
  and the export, with no clearing control; counts and unnamed aggregates are never receipts (a per-author
  review line told without exact review identity is durable, counted evidence and a required blocker, ADR
  0034); a review is withheld or held, never told twice by an id mismatch, until REST `node_id` equality with
  the native id is proven on a live provider. Unit and synthetic tests only; command registration with
  Discord is not performed here.
- **Alert content:** a requested-changes alert omits the source's "areas
  mentioned". The review BODY is now read (and is the only approved source: file and
  review-comment endpoints are not approved), but the private audit does not define
  the extraction rule (what counts as an area, which file paths are sensitive), and
  inventing one would be unsupported behavior, so this stays a **named blocker on the
  rule**, not on access.
- **Briefing timing:** when the profile selects imported preferences, a pending
  morning briefing is due until the evening time and is then recorded skipped, an
  evening briefing is due until the end of its day, and nothing survives into a later
  day (ADR 0032). Without imported preferences the native six-hour rule is unchanged.
  Unit-tested only.
- **Schedule batches:** the owner flips the schedule back one batch with `/schedule
  rollback:preview` and then `/schedule rollback:<code>` (never with text or a file; no new
  command, subcommand or interaction kind). The active batch becomes replaced and the most
  recently replaced one becomes active, deleting nothing and touching no exception. The
  code digests every rule by identity, batch, flag and replacement time plus the target and
  is rechecked in the flipping transaction, so a stale or replayed code changes nothing; any
  replaced batch of unknown or unreadable order (even beside known ones), a tie, a split
  batch or a non-newer stamp is refused. A successful flip is audited as
  `schedule.batch_rolled_back` (counts only) in the same transaction; a clock that is not after the
  newest stored stamp is refused as `clock_not_newer`, in the preview as well (ADR 0032 corrects the
  earlier claim that this needed a table rebuild: `audit_log.event` has no CHECK).
  Unit-tested only; the Discord command definition is not registered by this build. **Still
  required:** the private source's repeated-rollback semantics (a fresh second preview flips
  again here), and the source's keep-three-versions retention is not mirrored.
- **Repository discovery and the polling cycle:** the source discovers new
  repositories on a schedule and polls the 40 most recently pushed per cycle. With
  the real reader enabled Ducky now does the same (ADR 0031): scoped, tombstone- and
  mute-preserving discovery, and a 40-target recency cycle with a slow metadata
  refresh for the rest. Unit-tested only; discovery has never been enabled, the
  account that IS the owner is stated by configuration rather than proven, and whether
  the timing holds under the real quota and selection is unproven.
- **Overlap with the ordinary `github_watches` snapshot DM:** when an imported target
  will really DELIVER the same repository's pulls or issues surface (watching on, inside
  the poll cycle where one applies, healthy, and for digest-only kinds a briefing that
  can carry the digest: briefings on, imported preferences with the GitHub section, a DM
  copy; a requested change is an alert and needs no digest), the ordinary snapshot DM
  leaves out the parts that surface already reports (pull request updates, merges, approvals, requested changes, review comments,
  issue activity) and says nothing at all if nothing else changed. It keeps what the
  imported side cannot see (a check flipping on a pull request head, a workflow run on
  any branch) and the follow-up job proposal, so nothing unrelated is lost. The native
  feed's duplicate cards are retired the same way, for the kinds an imported surface
  sees in full, under the same conditions. Paused, outside the cycle, preferences off,
  no GitHub section or briefings off keep the native DM and card. Unit-tested only.
  **Superseded by ADR 0034:** that prospective trimming (and the resume refusal that went with it) was
  replaced by exact, delivered-only reconciliation; nothing is left out on a promise of future coverage.
  The duplicate-free observation gate stands.
- **Equal-time late reviews:** a late event that shares the cursor's timestamp is
  reconciled by identity for commits, pull-request-level events, reviews, issues,
  runs and releases once Ducky has processed the boundary (a pull request touched at
  the cursor is listed and its reviews re-read, and a review is told from an
  announced one by its id). A cursor that came from the source or a baseline stays
  strict (re-reading its boundary could announce history). Unit-tested only.
- **Paging and completeness of the real reader.** Runs and releases sort on creation
  while their events carry a later time, so the engine no longer assumes one read
  closes them: a window closes on an item created STRICTLY before both the cursor and the
  oldest item that was unsettled at the last close (`scan_floor`, which has no age cutoff:
  only settlement, publication or absence releases it), pages are separate units, and a
  window that spanned pages is committed only after its last page is re-read and held
  still. A window past its cap is blocked as `window_exceeded`, with cursor, floor and held
  events kept.
- **First observation of runs and releases (ADR 0031).** A NEW baseline reads the whole
  bounded inventory and commits a boundary frozen before its first request
  (`floorToSecond(now) - 1ms`, written before that request so a failed first call cannot
  re-anchor the retry; kept across a drift restart with the creation floor so far). It
  delivers nothing; the next ordinary pass announces, once, what moved after the boundary,
  including an older-created run or draft that settled or published while later pages were
  being read. A run already running at the boundary announces no historical `ci_started`: the baseline's
  commit records it as a marker in a RESERVED identity namespace (`baseline-marker:v1:...`, settled,
  empty payload, never the real `<run>:ci_started` identity), decided everywhere by one exact classifier
  and applied only while the pass's cursor is at or after the marker's boundary, so an import adopting
  an earlier source cursor still announces the start once. A start is otherwise announced from an update
  after the cursor. An id that cannot be encoded, or a marker lookup that overflows its bound, refuses
  the surface visibly (`baseline_marker_invalid` / `baseline_marker_overflow`); the importer refuses the
  reserved prefix; counts report markers separately; the rollback export is now schema v2 with a per-row
  `baselineMarker` flag (a v1 document's marker status is unknown). **Required limitation:** commit
  `b88b701` is pushed but never deployed, and a development or scratch database that ran it holds
  canonical-identity markers that are not reinterpreted or migrated; resetting a cursor or re-baselining in that database does not delete or repair them. A release with no creation time that is a draft, or was published after the boundary,
  is refused (`release_untrackable`, counted by reason in `/status`).
  **Limits that remain required blockers, not claims of completeness:** a first inventory
  of 100 or more runs or releases is REFUSED as `window_exceeded` (page cardinality cannot
  tell a full tenth page from a longer list, so at most 99 can be proven), which leaves
  that surface unobserved with the CI state unset and no recovery control; a first
  observation costs up to eleven requests per surface and a deep steady-state floor costs
  its depth plus one per 15-minute pass; imported and preexisting targets keep the floors
  they already lost, and a source cursor carries no unsettled inventory; the boundary is
  local time, so skew beyond the one-second floor is unproven; a run re-run long after it
  settled is outside the floor. Synthetic tests only, no live evidence.
- **Other named residuals, each a required blocker until accepted or closed:** multi-page
  completeness is not proven (the last-page re-read narrows the window for a miss and
  cannot see a deletion that left that page untouched, or a deletion paired with an
  insertion); a pull request with over 100 reviews; release ordering and the runs/releases
  schemas are unprobed on real data (the live answers were empty). Unit-tested and probed
  for shape on a public repository only.
- **Native reconciliation limits (ADR 0034), required until closed:** events that predate the
  ledger are withheld and counted with no clearing control; counts and unnamed aggregates prove
  no item; a review is withheld (imported side) or its native fact HELD (feed or ordinary side) when its id
  cannot be compared, until REST `node_id` equals the native id on a live provider (a live-probe gate
  nobody has run, and the provider lifecycle assumed here, that a submitted review never leaves the list and
  changes state only by being dismissed, was never probed live); **REQUIRED MERGE BLOCKERS, each named, none an
  accepted residual and none a parity claim:** a NEW submitted review in each observed state (requested changes,
  approved, commented, first seen dismissed), a known review observed dismissed and a PROVEN opening are exact now
  (migrations 37 and 38; a dismissal is a state observation with no dismissal time, and the target, like the
  source, never reports a dismissal of a review its cursor has passed). Still open: a per-author approvals or
  requested-changes line told while no exact list could identify it (kept as durable gap-marker evidence, counted in
  status, verify and the export, never cleared); a PR-level decision is its own unclaimed line and no cause is
  inferred from it; a pull request merely "newly listed" is not provably opened; pull requests with 100 or more
  reviews are counted and told no new review exactly; an exact segment cut off by the clamp or inside a redacted
  summary claims nothing and may leave a duplicate; the no-longer-listed (not a close), issue-count and
  workflow-run lines and the follow-up are open on the same terms; summaries sent before migration 37 or 38 and
  review rows with no recorded state or hash stay unreconciled (the new families are exempt from the migration-36
  cutoff and migration 38 records provenance only); a start-up
  crash between a Discord send and its SQLite write may repeat one message (at-least-once); the
  ledger grows by a few identifiers per delivered native transition for the life of the database.
- **Digest throughput is bounded, not certified fair:** a briefing looks at no more than 10,000 unread
  events, so a backlog beyond that can still starve later work. A **required throughput blocker** until a
  fair scheme is proven.
- **Withheld events (including one withheld as `state_conflict`, a review reporting a state change the provider
  lifecycle does not allow), held native cards and held ordinary review facts are durable UNDELIVERED
  work**, kept and counted (a held fact survives a cancel, an identity stop, a restart and retention), never
  deleted and not an acceptable omission; each stays a required cutover blocker with no clearing control. So are
  the pull requests whose exact review facts are refused and the per-author lines delivered without exact
  identity (gap markers): counted in `/status`, `--verify` (exit 5) and the v5 export.
- **Scratch databases migrated at `819a420`, `55266b9` or `09f9463` must be recreated** from a backup taken
  before migration 36 (it was revised in place before ever being deployed, so they lack `provider_at` and
  `held_reason`). No live-data reset is authorized.
- **A real typed reader, the rollback-delta export and every operational gate**
  (above).

## Verification

`pnpm typecheck` and `pnpm build` pass on the remote Linux host.
The unmodified `pnpm test` command passes all **2705 tests in 161 files**.
Coordinator redaction checks use the current home directory, and placement
checks validate both shipped example configurations instead of depending on
a private, gitignored development file. No HOME override or synthetic
operator configuration is needed. Live Discord, phone and provider integration
remain separate verification requirements.
See [TESTING.md](TESTING.md) and [SMOKE_CHECKLIST.md](SMOKE_CHECKLIST.md).

Live probe results below are historical evidence from the original development host; they do not certify the new remote runtime.

Probes run in this milestone, with their real outcomes:

| Probe | Outcome |
|---|---|
| `pnpm probe:herdr --with-agent` | Run twice. The FIRST exited 3 — the readiness marker never matched a real pane — which is what corrected the marker. The second exited 0, with the input frame observed 8.16 s after `agent start`. |
| `pnpm probe:openclaw` | Exits **0**: the full contract recorded, including a successful agent turn and its reply envelope. It exited 2 for two milestones and the exit code moved only when the evidence did. |
| `pnpm probe:gh` | Exits 0. Field lists recorded for seven read-only surfaces (now including `search prs`), locally and repo-less. |
| `pnpm probe:github-feed` | Exits **0** against the public `duckycodess/ducky-bot` with the mock transport: no gap in what it set out to observe (see *Detail: the GitHub feed* for what that does and does not include). |
| `pnpm probe:extraction` | Exits **2**. All six PDF/OCR candidates absent, recorded with the reason each would or would not help. Installs nothing, reads no document, enables nothing. |
| `pnpm probe:discord-gateway` | Exits **0**. READY in 2 276 ms with the privileged MessageContent intent, so the portal toggle is on. Registers no handler, sends nothing, and disconnects immediately. |
| `pnpm probe:live-job` | **Run three times, all exit 0**, each against its own throwaway database in a directory outside the repository. 162 s / 193 s / 192 s, full evidence gate each time. The development coordinator and executor were left running throughout and were never touched. |
| `pnpm probe:gh-live` | Exits **2**. Five read surfaces returned live responses that the production schemas accepted, and the watch loop observed and then deduplicated against a real repository. `prView` / `prChecks` / `prReviews` are unexercised: the target has no pull request, and opening one is a GitHub write. |

## Next

[ROADMAP.md](ROADMAP.md) — the serial Phase 2 milestones, with every
unresolved product or API decision marked rather than guessed.
