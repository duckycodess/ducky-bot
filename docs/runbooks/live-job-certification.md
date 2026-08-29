# Runbook: certifying the Herdr/Pi production path

`pnpm probe:live-job` drives the shipped chain end to end against the
disposable repository and asserts a fixed evidence gate. This runbook is about
the part that is easy to get wrong: **running it without measuring somebody
else's executor.**

## Why isolation, specifically

A development executor left polling `data/ducky-dev.db` will claim the probe's
job. The run then measures that executor, under its own orchestrator instance,
with its own Herdr calls — and reports a result the probe did not produce. It
is not a crash; it is a certification of the wrong thing, which is worse.

The probe now detects this directly rather than trusting a runbook to be read:
an `executors` row that checked in within the last two minutes stops the run
before a job row exists.

```
probe B failed: another executor is polling this database right now:
dev-executor (last seen 2026-08-29T04:39:43.782Z).
```

**The fix is a separate database, never stopping the executor somebody is
using.** Two Ducky instances on one machine are fine as long as they share no
state.

## Set up an isolated run

Everything below lives outside the repository. Nothing here touches
`data/ducky-dev.db`, the development credential file, or the running
coordinator and executor.

```bash
CERT=~/.cache/ducky-cert                 # anywhere outside the repo
mkdir -p "$CERT" && chmod 700 "$CERT"

cat > "$CERT/probe.env" <<EOF
NODE_ENV=probe
DUCKY_PROFILE=development
DUCKY_INSTANCE_LABEL=live-job-certification
OWNER_DISCORD_USER_ID=100000000000000001
DUCKY_DB_PATH=$CERT/probe.db
DUCKY_REPOS_FILE=$PWD/config/repos.dev.json
DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE=$CERT/probe-credentials.json
DUCKY_DEV_COMPONENT_SIGNING_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
DUCKY_LOG_FORMAT=text
EOF
chmod 600 "$CERT/probe.env"
```

Notes on each choice, because none of them is incidental:

- **`DUCKY_DB_PATH`** is the isolation. A fresh file also satisfies the probe's
  other two preconditions for free: no non-terminal job, no held reservation.
- **`OWNER_DISCORD_USER_ID`** is a placeholder. The probe forces the mock
  Discord transport, so no gateway opens and this id addresses nothing.
- **`DUCKY_DEV_COMPONENT_SIGNING_KEY`** is generated and thrown away. The probe
  presses no signed control; the key only has to exist.
- **`DUCKY_REPOS_FILE`** is the real allowlist, because the target repository
  and its disposability marker are the point.

Then issue a credential **into that database**:

```bash
npx tsx --env-file="$CERT/probe.env" \
  packages/coordinator/src/cli/credentials.ts issue --executor probe-cert
```

It prints a bearer token and an HMAC secret once. They are written to the
`0600` file above and nowhere else. **Do not pipe that command through
anything that will keep the output** — a terminal scrollback, a log, a
transcript. If it lands somewhere it should not, rotate rather than reason
about it: issue a second credential, `revoke-credential --key-id <old>`, and
delete the old entry from the credential file.

## Run it

```bash
npx tsx --env-file="$CERT/probe.env" scripts/probe-live-job.ts
```

Exit codes are the whole point of the probe, so do not paper over them:

| Exit | Meaning |
|---|---|
| 0 | every evidence item present |
| 4 | the run finished but evidence is missing |
| 5 | teardown left something behind |

## Between runs

A completed worktree job **keeps** its checkout and agent, deliberately: the
checkout holds the implementation and nothing has committed it, and
`herdr worktree remove` refuses a dirty checkout rather than deleting work. So
a second run would fail its own baseline check — `already has ducky/* branches`
— which is the check doing its job.

Clearing them is a decision, and it discards the diff the agent produced:

```bash
# 1. Close the Ducky-managed Herdr workspaces (this takes the agent with them).
herdr workspace list        # find the ducky-mgd:<slug> workspace ids
herdr workspace close <id>

# 2. Remove the linked worktree and its branch, in the DISPOSABLE repository.
cd <the disposable repo>
git worktree remove --force ~/.herdr/worktrees/<repo>/<checkout>
git branch -D ducky/job-<id>
git worktree prune

# 3. Confirm the baseline is back.
git status --porcelain      # empty
git branch --list           # no ducky/*
git worktree list           # one entry

# 4. Start the next run from a fresh database.
rm -f "$CERT/probe.db" "$CERT/probe.db-wal" "$CERT/probe.db-shm"
#    ...then issue a credential again, and keep only the newest entry in the
#    credential file: a fresh database knows only the newest key id.
```

`--force` appears once here and is deliberate: it deletes the probe's own
one-line change in a repository that carries a committed `.ducky-disposable`
marker. **Ducky itself never forces a worktree removal** — `--force` is a
forbidden flag in `COMMAND_POLICY`, so a dirty checkout is reported as kept
rather than deleted. This is an operator clearing an operator's own sandbox.

## What a passing run does and does not prove

**Does:** the shipped chain works, repeatably, on this host — router,
`JobsService`, real HTTP with bearer/HMAC/nonce auth, `CoordinatorClient`,
`ExecutorLoop`, `runClaimedJob`, real git workspace resolution, the writer
lock, `HerdrPiOrchestrator`, Herdr, a real Pi agent, the result file, and
result intake.

**Does not:** anything about Discord. The transport is mocked on purpose — a
certification run must never open a gateway. It also proves nothing about
OpenClaw, about GitHub writes, or about any repository other than the
disposable one.

`DUCKY_HERDR_VERIFIED=1` remains a deliberate operator act. A probe reports;
it does not promote itself.

## Tear down

```bash
rm -rf "$CERT"      # the database, the credential file and the env file
```

The credential rows stay in the deleted database, so nothing needs revoking.
If the credential file was ever copied elsewhere, revoke instead — see
[credential-rotation.md](credential-rotation.md).
