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
- **The Herdr/Pi orchestrator is partly verified.** Workspace, pane and
  worktree creation are checked against recorded live responses
  (`pnpm probe:herdr`); starting and prompting a Pi agent was not exercised, so
  it reports itself `experimental`. See `docs/integrations/herdr.md`.
- **The real Discord path has never run against a live bot.** The payload
  conversion is unit-tested and the transport is wired, but no token has been
  used here and no command has been registered.

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
