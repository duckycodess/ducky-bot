# Local development

## Requirements

Node 24.x (the repository pins `>=24.15 <25`; `node:sqlite` is used, so no
native build step), pnpm 11, git. Herdr and Pi are only needed to exercise the
real orchestrator.

## Setup

```bash
pnpm install
cp .env.example .env
cp config/repos.example.json config/repos.json
pnpm migrate
```

Fill in `.env`:

- `OWNER_DISCORD_USER_ID` — your Discord user id (developer mode → copy id).
  Exactly one. Startup fails otherwise.
- `DUCKY_COMPONENT_SIGNING_KEY` — generate with
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
- `DUCKY_EXECUTOR_CREDENTIALS_FILE` or, outside production only,
  `DUCKY_EXECUTOR_CREDENTIALS`

Edit `config/repos.json` so each slug points at a real checkout. Discord only
ever supplies a slug; the mapping to an absolute path is operator-controlled.

## Running

```bash
pnpm dev:coordinator   # mock Discord transport while DISCORD_TOKEN is unset
pnpm dev:executor      # second shell
```

Startup prints a diagnostic line per subsystem. `/status` reports the same
provider table inside Discord.

## Issuing executor credentials

```bash
pnpm executor:issue-credential --executor wsl-laptop
```

Prints the bearer token and HMAC secret **once**, writes a 0600 credential file
entry, and stores only a verifier and a fingerprint in the database. Copy the
values into the executor's environment immediately; they are not recoverable.

Executor environment:

```bash
DUCKY_COORDINATOR_URL=http://127.0.0.1:8787
DUCKY_EXECUTOR_ID=wsl-laptop
DUCKY_EXECUTOR_KEY_ID=k1
DUCKY_EXECUTOR_TOKEN=...
DUCKY_EXECUTOR_HMAC_SECRET=...
```

## Discord application setup

1. Create an application and a bot.
2. Enable the **MessageContent** privileged intent — DMs are unreadable
   without it.
3. Put the bot token in `DISCORD_TOKEN`.
4. Review the payload with `pnpm register-commands` (a dry run — it prints and
   registers nothing) before registering deliberately.

## Verification

```bash
pnpm typecheck    # builds every package, then typechecks the tests
pnpm test
pnpm build
pnpm migrate --dry
pnpm probe:herdr  # records live Herdr fixtures; creates and removes a temp repo
```

## Layout

```
packages/contracts     schemas, state machine, limits, owner-only manifest
packages/persistence   SQLite, migrations, repositories
packages/adapters      credentials, github, herdr, pi, openclaw, schedule, redaction
packages/coordinator   authz, discord, http, domain services, reconciler
packages/executor      outbound client, workspace resolution, writer lock
```
