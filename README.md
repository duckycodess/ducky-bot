# Ducky

A private Discord assistant and remote development controller.

Two processes:

- **coordinator** — Discord gateway, authorization, SQLite storage, job
  lifecycle, approval gate, and an authenticated API the executor polls.
  Destined for a small Azure VM; runs locally in Phase 1.
- **executor** — runs on the WSL development host, polls the coordinator
  **outbound only**, and drives Herdr → Pi → a Claude implementation worker.
  It never listens on a port.

```
Discord → coordinator → durable queue → (outbound poll) → WSL executor
                                                            → Herdr → Pi → Claude
                                                            → independent review
                                                            → verification
                                                            → owner approval → explicit action (opt-in)
```

## Job lifecycle

A coding job now reports where it actually is. `preparing` → `planning` →
`implementing` → `reviewing` ⇄ `fixing` ⇄ `verifying`, driven by the executor's
own progress reports through an allowlisted, exhaustively validated phase
machine, and shown privately as "Working — reviewing". `running` remains the
only lease-bearing state, so every single-writer guarantee is unchanged.

A job that cannot continue until something *outside* Ducky happens — a CI run,
a package publish, someone merging another PR — parks in
`waiting_on_dependency`: **the lease is released, the repository reservation is
kept**, and a bounded resolver checks on a schedule with two independent
ceilings. Nothing polls forever.

**No real dependency checker ships.** The one that does answers `pending` for
everything, because nothing on this host can observe a CI run. So a wait runs
out its budget and comes back to you — "I held your repository, I could not
confirm this, over to you" — rather than resuming on a check that did not
happen. See
[`docs/decisions/0016`](docs/decisions/0016-work-phases-dependency-waits-and-audit.md).

Alongside it: a central command policy classifying every `gh`, `git` and
`herdr` operation (nothing above a contained local mutation is permitted in
this phase, and an unclassified command is refused), and a structured audit log
that is a record and never an authority — no secret, no raw auth material, no
terminal output, and the owner recorded as a role rather than a Discord id.

## Daily assistant (milestone 2B)

Beside the development controller, Ducky keeps the owner's day:

- `/task add|list|done|cancel` — commitments with an optional due time and a
  priority. A task is a different record from a `/capture`: a capture is an
  unsorted thought, a task is something you have decided to do. Open inbox
  rows also have a signed promote-to-task control. `list` filters by `today`
  and `overdue` against your own civil day.
- `/reminder add|list|cancel` — one-shot, or a fixed interval with an explicit
  occurrence count, delivered to your DM. There is no cron grammar and no
  open-ended schedule: every recurrence is bounded at input and again by the
  database. If the host is off when reminders come due, the catch-up
  **collapses** — one message per reminder, saying how many occurrences it
  stands for, never a storm and never a silent drop. See
  [`docs/decisions/0013`](docs/decisions/0013-bounded-reminder-recurrence-and-catch-up.md).
- `/briefing morning|evening|today` — assembled from your stored tasks,
  reminders and schedule by counting them. No provider is reachable from the
  assembly path, so nothing in a briefing can be generated; a briefing that
  invents a deadline is worse than no briefing.
- `/watch add|list|remove` — owner-configured, read-only GitHub repository
  monitoring. It stores normalized snapshots and sends a deduplicated summary
  only when the observed PR/check view changes; it does not write to GitHub.
- `DUCKY_OWNER_TIMEZONE` sets which day is "today" and what `tomorrow 09:00`
  means. Instants stay stored as UTC and existing schedule rows keep the text
  you typed — the zone is a projection, not storage, so changing it re-renders
  rather than migrates. Times render as Discord timestamps, so each reader sees
  their own zone. See
  [`docs/decisions/0014`](docs/decisions/0014-single-owner-timezone-as-a-projection.md).

All of it is owner-only. Tasks, reminders and briefings have no shared
projection and no shared route.

## Sharing job status (milestone 2A)

Job *status* can be made visible without exposing job *content*. Add channel
ids to `DUCKY_DEV_SHARED_CHANNEL_IDS` (default empty, which switches the
feature off). Anyone who can read that channel may run `/jobs` and
`/job status` there and see a safe projection **of the jobs submitted in that
channel**: public job id, allowlisted repository slug, plain-language state,
safe timestamps, sanitized result summary and verdict, and what happens next.
Lifecycle updates for those jobs are posted back to the same channel.

A job submitted in a DM, or in a different shared channel, is not visible
there at all — not listed, and not reachable by id. Sharing a channel shares
the work you start in it, not your whole job history.

Never shared: task or context text, the owner's id, questions, answers, events,
workspace paths, action details, or any control. This is a **visibility**
setting only — every write stays owner-only, so listing a channel can never
let anyone act. Channel membership is enforced by Discord's own permissions,
so lock the channel down first. See
[`docs/decisions/0012`](docs/decisions/0012-opt-in-shared-job-visibility.md).

## Phase 1 limitations, stated plainly

- **Document and image schedule extraction is not supported.** No verified
  provider on this host can read those bytes, so `/schedule` refuses image and
  PDF uploads *before downloading them* rather than showing an invented
  preview. Text and CSV work end to end.
- **Approved actions are opt-in and explicit.** The owner must approve an
  individual proposal and then invoke `/job execute` for it; a durable ledger
  prevents a retry from repeating an action. Local commit, push and PR paths
  are implemented for a same-filesystem development topology, but the flag is
  off by default (`DUCKY_DEV_APPROVED_ACTIONS_ENABLED=false`). Issue, deploy,
  Azure and high-risk actions remain recorded-only.
- **Conversation replies come from a marked mock, and that is now an explicit
  choice.** OpenClaw is not installed here, so its API could not be verified.
  `DUCKY_CONVERSATION_PROVIDER` selects `mock`, `disabled` or `openclaw`;
  development defaults to the mock and every mock reply is prefixed `[mock]`.
  **Production must choose and refuses to start otherwise**, and `mock` is
  refused for production outright. The real HTTP provider throws rather than
  guessing an API.
- **Conversation attachments are built but closed.** You can attach one image
  or file to a chat message, and the whole pipeline — capability handshake,
  metadata policy, bounded download, private temp file, explicit disposal — is
  in place and tested. It is **unreachable on this host**, deliberately: bytes
  are fetched only when the operator has opted in *and* the provider is
  `verified` *and* it declares attachment support, and no provider here is
  either of the last two. So an upload is refused **before download** and
  **no attachment byte has ever been fetched or sent anywhere**. Accepting a
  type is not a claim that anything can read it — no vision or extraction
  capability is claimed. Attachments are owner-only even though plain chat is
  not. See
  [`docs/decisions/0015`](docs/decisions/0015-provider-agnostic-conversation-attachments.md).
- **The Herdr/Pi orchestrator has been run for real, and is still
  `experimental`.** `pnpm probe:herdr --with-agent` records the agent contract,
  and `pnpm probe:live-job` drives the production code path with a real Pi
  agent. **One run was observed to pass the full evidence gate** —
  `preparing → planning → implementing → reviewing → fixing → verifying →
  completed` in 271 seconds, with an independent passing review and real
  verification exit codes.
  **That is one observed success, not a certified integration:** other runs
  failed with `agent_prompt_stalled`, so repeatability is not established.
  Running it for real did find five defects no unit test could have caught,
  because every mock was more accommodating than the live CLI. `verified` stays
  `false` and `DUCKY_HERDR_VERIFIED` is unset — it is a deliberate operator act
  and nothing in the code sets it. See `docs/integrations/herdr.md`.
- **A completed worktree job keeps its workspace.** Herdr refuses to remove a
  checkout holding uncommitted work, and Ducky does not force — that checkout
  holds the implementation the job produced. The repository reservation is
  released, so nothing is blocked; clear it with `/job cleanup`.
- **Retention exists but ships disabled.** `DUCKY_RETENTION_ENABLED=false` means
  nothing is ever deleted automatically, so a default instance still grows
  without bound — deliberately: an unbounded database is recoverable, deleted
  history is not. When enabled it prunes only *finished* records, table by
  table, batched, on the existing interval; six tables have no delete path at
  all. Copy the SQLite file before turning it on.
- **`/forget job <id>` and `/forget conversation`** let the owner delete one
  named thing, confirm-then-act. **There is no wipe-all path at any layer** —
  the contract cannot express one. `/forget conversation` reports that nothing
  is stored, because nothing is.
- **The development Discord gateway has been smoke-tested live, once.** The
  configured bot and guild returned HTTP 200 and the coordinator connected. At
  that time the seven commands which then existed were registered — the only
  live registration on record.
  **Twelve owner commands are defined today**, so the five added since
  (`/task`, `/reminder`, `/briefing`, `/watch`, `/forget`) have never been
  written to Discord. Registering is an external write, is never done at boot,
  and has not been done since. A human DM or slash-command interaction has
  **never** been exercised, and the privileged Message Content intent still has
  to be enabled in the portal, so message bodies are unavailable.

## Quick start

```bash
pnpm install
cp .env.example .env.development           # fill in the owner id and a signing key
cp config/repos.dev.example.json config/repos.dev.json
pnpm migrate
pnpm dev:coordinator                       # mock Discord transport with no token
pnpm dev:executor                          # in a second shell
```

The scripts load `.env` then `.env.<profile>` with Node's native
`--env-file-if-exists`; nothing is read implicitly.

With no token for the selected profile the coordinator uses the in-memory
transport, so the whole lifecycle is exercisable without touching Discord.

### Two bots

Ducky runs as **two isolated Discord identities** — `development` and
`production`, selected by `DUCKY_PROFILE`. They share no token, application id,
database, port or command scope, and neither falls back to the other:
development registers its commands to a single guild so they appear instantly,
production registers globally, and a production instance **refuses to start**
without its own credentials rather than borrowing the development bot. The
active profile is shown in the startup diagnostics and in `/status`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm typecheck` | build every package and typecheck the tests |
| `pnpm test` | full suite |
| `pnpm build` | compile to `dist/` |
| `pnpm migrate [--dry]` | apply or list pending migrations |
| `pnpm probe:herdr` | record live Herdr responses as fixtures |
| `pnpm executor:issue-credential --executor <id>` | mint executor credentials |
| `pnpm register-commands` | print the slash-command payload (dry run) |
| `pnpm register-commands --apply --profile <development\|production>` | actually register, for one named bot |
| `pnpm dev:coordinator:prod` | run the production profile locally |

Every write and every personal-data surface is **owner-only**. The only
non-owner route is plain conversation plus the explicitly scoped safe job-status
projection. See `docs/SECURITY.md`.

## Documentation

Start at [`docs/INDEX.md`](docs/INDEX.md).
