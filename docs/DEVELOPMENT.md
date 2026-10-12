# Local development

## Requirements

Node 24.x (the repository pins `>=24.15 <25`; `node:sqlite` is used, so no
native build step), pnpm 11, git. Herdr and Pi are only needed to exercise the
real orchestrator.

## Setup

```bash
pnpm install
cp .env.example .env.development
cp config/repos.dev.example.json config/repos.dev.json
pnpm migrate
```

Node does not read a `.env` file on its own, so every `pnpm` script here loads
one explicitly with Node's native `--env-file-if-exists`: first `.env`, then
`.env.<profile>`, with the later file winning. A missing file is not an error,
so a token-less run still works. Nothing is loaded implicitly — if you run a
binary directly, pass the flag yourself:

```bash
node --env-file-if-exists=.env.production packages/coordinator/dist/main.js
```

Ducky runs as one of two isolated profiles, selected by `DUCKY_PROFILE`
(`development` by default). Keep a separate env file per profile; the two share
no credentials, database, port or command scope.

Fill in the env file:

- `OWNER_DISCORD_USER_ID` — your Discord user id (developer mode → copy id).
  Exactly one. Startup fails otherwise.
- `DUCKY_COMPONENT_SIGNING_KEY` — generate with
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
- `DUCKY_EXECUTOR_CREDENTIALS_FILE` or, outside production only,
  `DUCKY_EXECUTOR_CREDENTIALS` — give each profile its own file
- `DUCKY_DEV_SHARED_CHANNEL_IDS` — optional, default empty. Comma-separated
  Discord **channel** ids where `/jobs` and `/job status` answer anyone who
  can read the channel, with a safe projection of the jobs submitted in that
  channel only. Empty switches the feature off entirely. Production reads only `DUCKY_PROD_SHARED_CHANNEL_IDS`.
  Lock the channel down in Discord first: membership is enforced by channel
  permissions, not by Ducky. It grants no ability to act — every write stays
  owner-only.
- `DUCKY_OWNER_TIMEZONE` — your IANA timezone (`Asia/Manila`, `Europe/London`),
  default `UTC`. It decides which civil day "due today" and the briefing cover,
  and what `tomorrow 09:00` means. Instants are still stored as UTC, so
  changing it re-renders existing rows rather than rewriting them, and there is
  nothing to migrate. A name the runtime does not recognise fails at startup.
- `CONVERSATION_ATTACHMENTS_ENABLED` — optional, default off. Setting it alone
  changes nothing: a file is downloaded only when the conversation provider is
  also `verified` *and* declares attachment support, and no provider on this
  host is either. Attachments are owner-only even though plain chat is not.
  `CONVERSATION_MAX_ATTACHMENT_BYTES` and `CONVERSATION_ATTACHMENTS_PER_HOUR`
  bound it; downloads reuse `DISCORD_CDN_HOSTS`.
- `DUCKY_DEV_REMINDER_CHANNEL_ID` — optional, default empty. Where a reminder
  that belongs to a **task** is posted, with your mention. Unconfigured means
  the DM every reminder has always used. A free-standing `/reminder` never goes
  there. The card carries signed controls bound to you: anybody else in the
  channel sees the deadline and can do nothing with it.
- `DUCKY_PHONE_CAPTURE_ENABLED` + `DUCKY_DEV_PHONE_PASSCODE_VERIFIER` —
  optional, default off. See *The phone capture page* below.
- `DISCORD_DEV_TOKEN` / `DISCORD_DEV_APP_ID` / `DISCORD_DEV_GUILD_ID` when you
  want the real development bot; leave them unset for the mock transport

Edit `config/repos.json` so each slug points at a real checkout. Discord only
ever supplies a slug; the mapping to an absolute path is operator-controlled.

## Running

```bash
pnpm dev:coordinator        # development profile, reads .env.development
pnpm dev:coordinator:prod   # production profile, reads .env.production
pnpm dev:executor           # second shell
```

`dev:coordinator` loads `.env.development` and `dev:coordinator:prod` loads
`.env.production`; neither reads the other's file. Set `DUCKY_PROFILE` in the
matching env file so the loaded values and the selected profile agree.

Startup prints a diagnostic line per subsystem, including the resolved owner
timezone. `/status` reports the same provider table inside Discord.

One `setInterval`, at `DUCKY_RECONCILE_INTERVAL_MS` (30 s by default), drives
the reconciler, the job-notification sweep and the daily assistant tick. There
is deliberately no second scheduler, so that interval is also the worst-case
lateness of a reminder.

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

## The phone capture page

A small page at `/app`, on the coordinator's existing listener, for pasting a
numbered list of deadlines from a home-screen shortcut. It is **off by
default** and refuses to start rather than serve unsafely.

```bash
pnpm phone:passcode        # type a passcode; prints a scrypt verifier
```

The passcode is read from stdin, never from an argument, so it does not land in
your shell history. What it prints is a verifier and cannot be turned back into
the passcode. Then, in the env file for that profile:

```bash
DUCKY_PHONE_CAPTURE_ENABLED=true
DUCKY_DEV_PHONE_PASSCODE_VERIFIER=scrypt$...
DUCKY_HTTP_HOST=100.x.y.z        # your tailnet address
```

Three things fail at BOOT rather than at the first tap: the flag without a
verifier, a verifier this profile may not read (production never inherits the
development one), and a `DUCKY_HTTP_HOST` that is not loopback, RFC1918,
`100.64.0.0/10` or `fd7a:115c:a1e0::/48`. `0.0.0.0` is refused explicitly.

On the phone: connect Tailscale, open `http://<tailnet-address>:8787/app`,
enter the passcode, then *Share → Add to Home Screen*. The page declares a web
manifest, so the shortcut opens standalone rather than as a browser tab.

This is **your own** credential and is deliberately not the executor's. The
executor's routes on the same listener keep their own HMAC authentication,
unchanged — binding to a tailnet address exposes them to that tailnet, and
that is exactly as true as it was before this page existed. Nothing here
enables Tailscale Funnel; see `deploy/tailscale/README.md` and ADR 0025.

## Discord application setup

Create **two** applications, one per profile, so test traffic never reaches the
real assistant.

1. Create an application and a bot for each of development and production.
2. Enable the **MessageContent** privileged intent on both — DMs are unreadable
   without it.
3. Put each token in its own variable: `DISCORD_DEV_TOKEN` /
   `DISCORD_PROD_TOKEN`, with the matching app id. Nothing reads across.
4. For development, set `DISCORD_DEV_GUILD_ID` to a test server. Guild commands
   appear immediately; global ones take time to propagate.
5. Review the payload with `pnpm register-commands` (a dry run — it prints and
   registers nothing).
6. Register deliberately, naming the bot explicitly:

```bash
pnpm register-commands --apply --profile development   # guild-scoped
pnpm register-commands --apply --profile production    # global
```

`--apply` refuses to run without `--profile`: which bot to write to is not
something to infer from an ambient default.

## Verification

```bash
pnpm typecheck    # builds every package, then typechecks the tests
pnpm test
pnpm build
pnpm migrate --dry
pnpm probe:herdr  # records live Herdr fixtures; creates and removes a temp repo
```

A forward migration is rehearsed against a COPY of a real database rather than
against the live one:

```bash
pnpm backup                                   # consistent snapshot, no downtime
cp data/ducky-dev.db /tmp/rehearsal.db
DUCKY_DB_PATH=/tmp/rehearsal.db pnpm migrate --dry
DUCKY_DB_PATH=/tmp/rehearsal.db pnpm migrate
```

## Layout

```
packages/contracts     schemas, state machine, limits, time/timezone, owner-only manifest
packages/persistence   SQLite, migrations, repositories
packages/adapters      credentials, github, herdr, pi, openclaw, schedule, redaction
packages/coordinator   authz, discord, http (executor API + phone page), domain, reconciler
packages/executor      outbound client, workspace resolution, writer lock
```
