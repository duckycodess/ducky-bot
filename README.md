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
- **The Herdr/Pi orchestrator is verified against recorded live responses**
  for workspace, pane and worktree creation (`pnpm probe:herdr`). Starting and
  prompting a Pi agent was not exercised — see `docs/integrations/herdr.md`.

## Quick start

```bash
pnpm install
cp .env.example .env                       # fill in the owner id and a signing key
cp config/repos.example.json config/repos.json
pnpm migrate
pnpm dev:coordinator                       # mock Discord transport with no token
pnpm dev:executor                          # in a second shell
```

With `DISCORD_TOKEN` unset the coordinator uses the in-memory transport, so the
whole lifecycle is exercisable without touching Discord.

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

Every Discord surface except plain conversation is **owner-only**. See
`docs/SECURITY.md`.

## Documentation

Start at [`docs/INDEX.md`](docs/INDEX.md).
