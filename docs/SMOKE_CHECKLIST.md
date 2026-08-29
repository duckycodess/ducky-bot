# Smoke checklist

What to run, in order, to convince yourself an instance is actually working —
and, just as importantly, what each step does **not** prove.

Everything in "Offline" contacts nothing and changes nothing. Everything after
it is opt-in, costs something, or writes somewhere, and each says which.

---

## Offline — nothing is contacted, nothing is written

| # | Command | What it proves | What it does not |
|---|---|---|---|
| 1 | `pnpm install` | dependencies resolve | nothing about behaviour |
| 2 | `pnpm typecheck` | the whole workspace compiles, tests included | nothing at runtime |
| 3 | `pnpm test` | every unit and integration guarantee, against temp databases | nothing about a real Discord, GitHub, Herdr or OpenClaw |
| 4 | `pnpm build` | the compiled output the systemd units run | — |
| 5 | `pnpm migrate --dry` | which migrations are pending | applies none |
| 6 | `pnpm register-commands --list` | the 12 commands this build DEFINES | **not** what Discord currently has |
| 6b | `pnpm register-commands --diff --profile development` | what Discord ACTUALLY has, compared against this build. A **GET**: it needs a token but writes nothing | not offline — it is listed here because it is read-only, not because it contacts nothing |
| 6c | `pnpm probe:discord-gateway --profile development` | that the gateway ACCEPTS this bot with the privileged MessageContent intent | **not** that anything round-trips: it registers no handler and answers nothing, so it cannot race a running coordinator |
| 7 | `pnpm register-commands` | the exact payload a registration would send | writes nothing |
| 8 | `pnpm backup --db <a copy> --out /tmp/x` | the backup path works | not that your live database is safe |
| 9 | `pnpm backup:verify --file <that file>` | integrity + a schema this build knows | not that the data is *correct* |
| 10 | `pnpm probe:extraction` | which PDF/OCR decoders this host actually has | nothing is installed or enabled; exits 2 while none is present |

If 1–9 pass, the code is sound. Nothing above has spoken to another system.

---

## Local runtime — starts processes, touches the local database

10. **Start the coordinator** (development profile):
    ```bash
    pnpm dev:coordinator
    ```
    Read the boot diagnostics. Every line is a fact about THIS instance:
    - `profile` names the profile you meant;
    - `migrations: schema up to date`;
    - `conversation` says `mock`, `disabled` or a verified provider — never
      silently something else;
    - `chat attachments`, `chat memory`, `proactive briefings`, `retention` and
      `dependency checker` say on/off, matching your env file.
11. **`curl -s localhost:8787/healthz`** → `{"ok":true}` (liveness only).
12. **`curl -s localhost:8787/readyz`** → `ok`, or `notReady` naming codes.
    `info.retentionRanHoursAgo` is context, not a readiness condition.
13. **Start the executor** (`pnpm dev:executor`) and watch it authenticate and
    poll. `/status` in Discord — or the diagnostics line — should then show one
    active executor.

---

## Probes — opt-in, and each costs something

| Probe | Cost | Exits non-zero when |
|---|---|---|
| `pnpm probe:gh` | none: local, repo-less, no network | it cannot read a field list |
| `pnpm probe:openclaw` | starts nothing; runs one local agent turn that fails | the reply half is unrecorded (2) |
| `pnpm probe:herdr` | creates and removes a temp git repository | evidence is missing, or cleanup left something (3) |
| `pnpm probe:herdr --with-agent` | **starts a real Pi agent; real model capacity** | the readiness marker never matched (3) |
| `pnpm probe:live-job` | **a real Pi agent with edit capability, on the disposable repo** | evidence missing (4), leftovers (5) |

Before `probe:live-job`, check the things it will refuse for anyway: the target
repository carries a committed `.ducky-disposable` marker, is clean with no
`ducky/*` branches, and the database has no non-terminal job and no held
repository reservation. **A reservation blocks every claim, so a run against one
measures nothing.**

Note that `probe:live-job` uses the same database as a running coordinator. If a
development executor is already polling it, that executor can claim the probe's
job and the run measures the wrong thing. Stop it, or point the probe at an
isolated database.

---

## External writes — never part of a smoke test by accident

Each of these changes something outside this host. None happens at boot, none
happens without an explicit flag, and none is implied by any step above.

- **`pnpm register-commands --apply --profile <development|production>`** —
  writes the command set to Discord. Required once per bot, and again whenever
  the surface changes.
- **A real Discord DM or slash command.** The gateway path is exercised only by
  a human doing it. Until then reminder delivery, briefing delivery, watch
  summaries and shared-channel posts are unit-tested only, and
  `docs/CURRENT_STATE.md` says so.
- **`/job execute` with `DUCKY_*_APPROVED_ACTIONS_ENABLED=true`** — commit, push
  or PR, after an approval, one action at a time.

---

## What a green checklist still does not mean

- **Not that the Herdr/Pi integration is certified.** One observed success is not
  repeatability; `/status` says `experimental` until it is.
- **Not that conversation works.** No provider is verified: OpenClaw's reply
  contract is unrecorded and the mock is marked `[mock]`.
- **Not that a watch has ever observed a real repository.** None is configured.
- **Not that a reminder or briefing has reached a real DM.** That needs step 3
  of "External writes".

The point of this list is to make each of those absences visible, rather than to
turn a green run into a claim nobody checked.
