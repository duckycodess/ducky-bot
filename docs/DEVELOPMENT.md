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
- `DUCKY_DEV_THREAD_PARENT_CHANNEL_IDS` — optional, default empty. Comma-separated
  channel ids that may **open a Discord thread per conversation**. Empty is the
  whole feature off, and that is the default: creating a thread is Ducky
  writing into your guild, so it is a list of channels rather than a switch.
  Each listed channel needs the bot to hold **Create Public Threads** and **Send
  Messages in Threads** there; without either, Ducky refuses visibly and answers
  nowhere rather than replying in the parent. A channel that is also a shared
  channel, the briefing channel or the task channel is refused at boot.
  Production reads only `DUCKY_PROD_THREAD_PARENT_CHANNEL_IDS`. See
  [ADR 0027](decisions/0027-native-thread-conversations-and-the-first-non-owner-controls.md).
- `DUCKY_CONVERSATION_MEMORY_ENABLED` — optional, default off. Off means nothing
  you say in conversation is stored. On, a native thread keeps its full
  transcript while the thread exists and the people who have **spoken** in it
  share that context; an ordinary channel or DM keeps the small per-user cap
  ADR 0021 shipped. `DUCKY_CONVERSATION_CONTEXT_BUDGET_BYTES` (default 24000)
  bounds what reaches the model: past it Ducky compacts, and past that it
  refuses the turn. Compacting never deletes a stored turn or a Discord message.
- `DUCKY_DEV_REMINDER_CHANNEL_ID` — optional, default empty. Where a reminder
  that belongs to a **task** is posted, with your mention. Unconfigured means
  the DM every reminder has always used. A free-standing `/reminder` never goes
  there. The card carries signed controls bound to you: anybody else in the
  channel sees the deadline and can do nothing with it.
- `DUCKY_DEV_GITHUB_CHANNEL_ID` — optional, default empty. Where GitHub updates
  are posted. **Delivery only**: it is read by whoever the channel admits, so an
  owner command reply there is ephemeral, nothing typed there is read or stored,
  and no write intent, `$ticket` or model turn starts from it. Only a repository
  that is public AND on the feed's selected list posts there; everything else
  goes to your DM. Production reads only `DUCKY_PROD_GITHUB_CHANNEL_ID`. Refused
  at boot as a shared channel, another role's channel or a thread parent.
- **The GitHub feed**, off by default (see
  [ADR 0029](decisions/0029-github-feed-and-the-delivery-only-github-channel.md)):
  `DUCKY_GITHUB_FEED_ENABLED`; `DUCKY_GITHUB_FEED_INTERVAL_MINUTES` (5 to 1440,
  default 15); `DUCKY_GITHUB_FEED_REPOS` (extra `owner/repo` names, which are
  selected and nothing else); `DUCKY_GITHUB_FEED_EXCLUDE` (seeds to leave off);
  `DUCKY_GITHUB_FEED_REVIEW_REQUESTS` (your statement that the account `gh` is
  signed in as is you, which turns on the cross-repository review-request
  search); `DUCKY_GITHUB_DIGEST_AT` (local `HH:MM`, default `09:00`, in
  `DUCKY_OWNER_TIMEZONE`). The selected list starts as the enabled,
  GitHub-mapped allowlist repositories. None of these writes to the allowlist.
  `pnpm probe:github-feed` drives the feed against a real repository from the
  allowlist file named by `DUCKY_REPOS_FILE`, with an in-memory database and the
  mock transport; it loads no env file.
- `DUCKY_PHONE_CAPTURE_ENABLED` + `DUCKY_DEV_PHONE_PASSCODE_VERIFIER` —
  optional, default off. See *The phone capture page* below.
- `DISCORD_DEV_TOKEN` / `DISCORD_DEV_APP_ID` / `DISCORD_DEV_GUILD_ID` when you
  want the real development bot; leave them unset for the mock transport
- **The repository workflow bridge** (`$grill-me`, `$ticket`, `$agentize`), off
  by default and deliberately split into three decisions rather than one flag:
  - `DUCKY_DEV_SKILL_BRIDGE_ENABLED` — whether those three tokens mean anything
    at all. With it unset they are ordinary text.
  - `DUCKY_DEV_WORKFLOW_HELPER` — the ABSOLUTE path to the installed Agent Flow
    front door (`workflow.py`). There is no default and no search: a helper
    Ducky located on its own would be a program nobody chose to run. Enabling
    the bridge without this fails at boot. `DUCKY_DEV_WORKFLOW_PYTHON` selects the
    interpreter and defaults to `python3`; it is profile-scoped like the rest,
    because a development interpreter is a development host's python.
  - `DUCKY_DEV_WORKFLOW_MUTATION_ENABLED` — whether publishing and onboarding
    may run. Separate on exactly the terms `DUCKY_APPROVED_ACTIONS_ENABLED` is
    separate: creating a GitHub issue is an external write. With it off,
    `$ticket` scans and validates and creates nothing, and `$agentize` refuses.
  - `DUCKY_DEV_WORKFLOW_GRILL_SKILL` — the ABSOLUTE path to the installed
    upstream grilling skill. It is read at call time and handed to the
    conversation provider as instructions for that turn; it is never copied
    into this repository. **`$grill-me` refuses without it**, and without a
    provider that reports itself `verified`: there is no fallback interview,
    because one the owner could not tell apart from the real method is worse
    than none. Point it at the file that CARRIES the method -- the installed
    `grill-me/SKILL.md` is a pointer at `grilling`, and Ducky follows that one
    hop for you, but a pointer to a pointer is refused.

  `$ticket` takes two flags and only two: `--ready`, which is what authorizes
  queueing, and `--label <name>`, repeatable, which names a classification the
  installed publisher applies and reads back. Ducky chooses no label of its
  own.

  The two-step is `$ticket <what the work is>` and then `$ticket --ready` on
  its own, which authorizes the ticket that thread just published. Saying
  anything new first makes a new ticket instead.

  All four have `DUCKY_PROD_*` counterparts, and production reads only its own:
  a development helper path points at a development dispatcher. Paths must be
  absolute, and a relative one is refused at boot rather than resolved against
  whatever directory the process happens to be in.

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
# Required: where this profile keeps its pause outbox and dispatch journal. Absolute,
# private, and NOT under /tmp, TMPDIR or the runtime directory.
DUCKY_EXECUTOR_STATE_DIR=/home/you/.local/state/ducky/development/executor-state
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

## Engineering and additional-user AI are off by default

`DUCKY_ENGINEERING_ENABLED` and `DUCKY_ADDITIONAL_USER_AI_ENABLED` both default to
off (see `.env.example`). A development setup that submits jobs or lets the
whitelist chat sets them to 1. The coordinator and executor also refuse to start
when any `*_API_KEY` environment variable is set, which can bite a developer
shell that exports one; unset it for these processes. For the remote Linux
runtime see [runbooks/remote-linux-runtime.md](runbooks/remote-linux-runtime.md).

## Layout

```
packages/contracts     schemas, state machine, limits, time/timezone, owner-only manifest
packages/persistence   SQLite, migrations, repositories
packages/adapters      credentials, github, herdr, pi, openclaw, schedule, redaction
packages/coordinator   authz, discord, http (executor API + phone page), domain, reconciler
packages/executor      outbound client, workspace resolution, writer lock
```
