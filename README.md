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
                                                            → owner approval → (deferred)
```

## Daily assistant (milestone 2B)

Beside the development controller, Ducky keeps the owner's day:

- `/task add|list|done|cancel` — commitments with an optional due time and a
  priority. A task is a different record from a `/capture`: a capture is an
  unsorted thought, a task is something you have decided to do. `list` filters
  by `today` and `overdue` against your own civil day.
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
- **Approved actions are recorded, never executed.** Commits, pushes, pull
  requests, deployments and cloud mutations all stop at the approval gate.
  There is no GitHub writer anywhere in the codebase.
- **Conversation replies come from a marked mock.** OpenClaw is not installed
  here, so its API could not be verified. Every mock reply is prefixed
  `[mock]`; the real HTTP provider throws rather than guessing an API.
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
- **The Herdr/Pi orchestrator is partly verified.** Workspace, pane and
  worktree creation are checked against recorded live responses
  (`pnpm probe:herdr`); starting and prompting a Pi agent was not exercised, so
  it reports itself `experimental`. See `docs/integrations/herdr.md`.
- **The development Discord gateway has now been smoke-tested live.** The
  configured bot and guild returned HTTP 200, the coordinator connected, and
  the seven development commands then defined were registered. The three added
  by 2B (`/task`, `/reminder`, `/briefing`) are defined but not yet registered;
  registering is an external write and is never done at boot. A human
  DM/slash-command interaction has not yet been exercised; Message Content
  intent still must be enabled in the portal.

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

Every Discord surface except plain conversation is **owner-only**. See
`docs/SECURITY.md`.

## Documentation

Start at [`docs/INDEX.md`](docs/INDEX.md).
