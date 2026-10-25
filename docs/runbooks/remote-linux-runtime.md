# Remote Linux runtime (issue 8): preparation, not deployment

**Nothing here has been run on the intended host as a deployment.** This is the
preflight, the install shape and the checks to pass before anybody says the bot
is deployed. Every command below is read-only unless it says otherwise, and none
of them is executed by this repository.

Read first, because it shapes everything after it:

- **Engineering stays OFF.** It needs TWO switches: `DUCKY_ENGINEERING_ENABLED`
  (default off) and, in addition, `DUCKY_SHARED_ADMISSION_ELIGIBLE` (default off,
  with the ledger path, pins and co-located executor ids). The engineering SLOT
  lives in ONE coordinator database. What makes the two Ducky profiles and the
  separate agent-flow dispatcher exclude each other is the host-local shared
  admission ledger of [decision 0031](../decisions/0031-shared-engineering-admission.md),
  and that is **source only here**: no ledger has been created, no pin set, and the
  Agent Flow companion is a private, unapplied candidate. Until the integration is
  installed and a controlled second admission is refused on this host, turning
  engineering on means two programs can each start an agent against the one shared
  account, so the second switch stays off. See also
  [decision 0030](../decisions/0030-remote-linux-runtime-and-ducky-local-admission.md).
- **Additional-user AI stays OFF** (`DUCKY_ADDITIONAL_USER_AI_ENABLED`).
- Reminders, tasks, briefings and GitHub watches do not depend on the model and
  keep working with both of the above off.

## 1. Preflight readbacks

Record what you actually see; do not copy these numbers into a report.

```bash
uid=$(id -u)
# Account-wide ceiling. Read on 2026-10-19: MemoryMax=17179869184 (16 GiB),
# MemoryHigh=15032385536 (14 GiB), MemorySwapMax=0, TasksMax=1536, and the owner
# authorized that envelope. (2026-10-13 read 8589934592 / 7516192768; historical.)
systemctl show -p MemoryMax,MemoryHigh,MemorySwapMax,TasksMax "user-$uid.slice"
# What the executor's memory guard will actually read:
cat /sys/fs/cgroup/user.slice/user-$uid.slice/{memory.max,memory.high,memory.current,memory.swap.max,pids.max}
# Survives logout only if this says yes:
loginctl show-user "$USER" -p Linger
# Existing owned-process and temp cleanup (a user timer on the recorded host):
systemctl --user is-active devwork-cleanup.timer
# Tailnet reachability and that nothing is published:
tailscale status --peers=false
tailscale serve status        # must NOT show a Funnel
```

Limits of these readbacks:

- The guard compares `min(memory.max, memory.high)` minus `memory.current`
  against the engineering plus notification reserves. `memory.current` includes
  page cache, so it can refuse when there is reclaimable room. That is the safe
  direction. On 2026-10-13, under the then 7 GiB high mark, the host used about
  4 GiB with nothing of Ducky running; the high mark is 14 GiB as of 2026-10-19,
  so re-read `memory.current` rather than carrying that figure forward.
- The account slice is not the dispatcher's worker service. The worker unit
  `agent-flow-herdr.service` has its own limits (7 GiB high, 8 GiB max,
  `TasksMax` 512) and the lightweight `agent-flow.service` dispatcher is a
  third, separate unit; Ducky's guard reads the slice, not either of them.
  The dispatcher's configured global-2 / per-repository-1 concurrency is its own
  authorized setting, not proof of Ducky's cross-program admission.
- Herdr's server owns the agent processes, and a Ducky unit's limits do not
  reach them. Verified on 2026-10-19 (read-only, by the manager): the **current**
  Herdr server runs inside `agent-flow-herdr.service`, so descendants that stay in
  that cgroup inherit its 7 GiB high / 8 GiB max / `TasksMax` 512, and every
  account process shares the 16 / 14 GiB slice. **Not verified:** that any
  individual agent, tool, scope or provider process is such a descendant (tool
  processes can run in separate scopes such as a `devwork-job` scope), so do not
  assume it. Ducky's executor unit limits alone do not bound a separate Herdr
  server, and none of this shows a Ducky-dedicated session or cross-program
  admission. A user unit may set its own limits only if the user manager has
  controllers delegated, which is a host change this repository does not make.

## 2. Install shape (not performed)

Existing checkout only. Do not clone another copy, provision Azure or duplicate a
runtime.

```bash
# Templates: deploy/systemd/remote/ . Copy, never edit in place.
mkdir -p ~/.config/systemd/user ~/.config/ducky
cp deploy/systemd/remote/ducky-coordinator@.service deploy/systemd/remote/ducky-executor@.service \
   ~/.config/systemd/user/
install -m 0600 /dev/null ~/.config/ducky/coordinator-development.env   # then fill it in
install -m 0600 /dev/null ~/.config/ducky/executor-development.env
pnpm install --frozen-lockfile && pnpm build
systemctl --user daemon-reload
```

Per-profile state lives under `~/.local/state/ducky/<profile>/` (database and a
Ducky-specific `tmp`), and the env files and credential file under
`~/.config/ducky/`, all mode 0600, none in the repository. Production reads none
of the development variables and shares no secret with it. Fill the env files
from `deploy/systemd/remote/*.env.example`; systemd does not expand `%h` inside
an env file, so write real paths.

### Private listener and phone page

The coordinator HTTP routes and the phone capture page share ONE Fastify
listener. There is no second phone server to configure.

- Bind the coordinator to loopback (`DUCKY_HTTP_HOST=127.0.0.1`). The phone page
  accepts that, and refuses `0.0.0.0` at boot.
- To reach it from the phone, use tailnet-only `tailscale serve` proxying to the
  loopback port. Check the exact flags against the installed version
  (`tailscale serve --help`); they are not recorded here and differ between
  releases. **Never `tailscale funnel`**, and confirm with
  `tailscale serve status` that nothing is public.
- The phone page needs its own owner passcode verifier (`pnpm phone:passcode`).
  It is never the executor's machine credential.
- The executor dials `http://127.0.0.1:<port>` and has no listener.
- The provider (OpenClaw) stays on loopback with its own authentication.

## 3. Subscription-only checks

The coordinator and executor refuse to start if any `*_API_KEY` name is set in
their own environment. **That is partial evidence.** It does not see the
provider's private configuration, nor the environment Herdr agents inherit (the
Herdr server's, not the executor's). It says nothing about quota. Check those
places yourself, printing names only:

```bash
# Names only, never values. Agents inherit the environment of the Herdr SERVER
# they were started by. There can be more than one herdr process on the account
# (another program's server, or your own interactive one), and picking the first
# match can inspect the wrong one. Inspect EVERY match, and prefer the PID of
# the server Ducky is actually pinned to (its systemd MainPID, or the process
# that owns the socket the executor talks to) once that is pinned:
for pid in $(pgrep -u "$USER" -x herdr); do
  echo "herdr pid $pid:"
  tr '\0' '\n' < "/proc/$pid/environ" | cut -d= -f1 \
    | grep -E '(^|_)API_KEY$|ADMIN_KEY$|AUTH_TOKEN$' || echo "  none"
done
# Provider store: confirm it is subscription OAuth with no API key profile.
openclaw --dev models status     # expect oauth=1, token=0, api_key=0
```

If either shows an API key, the route is ambiguous: **stop and refuse** rather
than describing the quota as supported. A signed-out or ambiguous provider fails
closed. Ducky does not distinguish a sign-in failure from an exhausted quota
without a recorded response, and it keeps no quota counter: see "What is not
implemented" below.

## 4. Start, restart, logout, recovery, backup

```bash
systemctl --user enable --now ducky-coordinator@development
systemctl --user enable --now ducky-executor@development
systemctl --user restart ducky-coordinator@development
journalctl --user -u ducky-coordinator@development -n 100 --no-pager
```

- **Logout continuity** holds only while `Linger=yes`; verify by logging out of
  every session and reading `systemctl --user is-active` over a fresh SSH login.
- **Upgrade is a synchronized stop, not a rolling restart.** The claim response
  and the failure report are strict schemas, so an executor and a coordinator
  from different builds can reject each other's messages (an older executor
  cannot parse a claim carrying the attempt deadline, and an older coordinator
  rejects a failure report carrying `quiescent`). The optional claim field
  helps only a NEW executor reading an OLD coordinator, which is not a
  supported pairing. Stop both units with engineering off (it is off by
  default), take a backup, update, migrate, then start the coordinator and the
  executor together.
- **Upgrade preconditions (all must hold before the first stop; any miss means
  do not upgrade, not "upgrade carefully").** Run the checks on a copy taken from
  the verified backup below, or with the database opened read-only, never by
  editing the live file:

  1. **No live jobs and no open agent workspaces.** Migration 28 only creates the
     empty `engineering_admission` table and adds `jobs.attempt_deadline_at`. It
     does **not** backfill admission for a job that is already running: that job
     holds no slot and has no attempt deadline, so a second job could be admitted
     beside it and the coordinator backstop would never time it out. The agent
     also lives in Herdr, outside either unit, and survives the stop.

     ```sql
     SELECT id, state FROM jobs WHERE state NOT IN ('completed','failed','cancelled');
     SELECT workspace_id, job_id FROM herdr_workspaces WHERE closed_at IS NULL;
     SELECT repo_slug, job_id, reason FROM repo_reservations;
     ```

     All three must return no rows. Finish, cancel, or `/job cleanup` first.
  2. **No non-scratch database ever applied the unpublished migration 27.** While
     this branch was developed, `engineering_admission` was numbered 27 (commit
     `3d507bf`). Published main's 27 is `github_feed`, and the branch now carries
     `engineering_admission` as 28. The migrator records and compares **version
     numbers only** (`packages/persistence/src/migrate.ts`), so a database that
     applied the branch-only 27 would skip `github_feed` as already done and then
     fail migration 28 on a table that already exists.

     ```sql
     SELECT version, name FROM schema_migrations WHERE version >= 27 ORDER BY version;
     ```

     Version 27 must be absent or named `github_feed`. If it is named
     `engineering_admission`, stop: that database needs a hand-reconciled
     schema plan and a verified backup, and this runbook does not provide one.
     Synthetic scratch databases used by the tests are not affected.
  3. **A verified backup exists** (the next bullet), and engineering is still off.
- **Restart** is safe: leases expire, a job that lost its executor is requeued
  for recovery and KEEPS its engineering slot and its original attempt deadline,
  and the coordinator never assumes the agent stopped.
- **Orphans** are never cleared automatically. See
  [orphan-recovery.md](orphan-recovery.md). A held slot also blocks every other
  engineering job until `/job cleanup` is run for the orphaned one.
- **Backup and migrate use explicit paths here, not defaults.** `pnpm backup` and
  `pnpm migrate` load `.env` and `.env.development` from the current directory
  if they exist, and otherwise fall back to the profile's default database under
  `./data/`. Neither is the systemd env file or this account's private runtime
  state, so a bare `pnpm backup` could back up (or migrate) the wrong database,
  or none. Name the database, and run the scripts directly so no env file is
  loaded and no secret is read:

  ```bash
  profile=development   # or production
  state=$HOME/.local/state/ducky/$profile
  cd ~/projects/ducky
  # A consistent online snapshot of THIS profile's database, written 0600:
  node_modules/.bin/tsx scripts/backup-db.ts --db "$state/ducky.db" --out "$state/backups"
  node_modules/.bin/tsx scripts/verify-backup.ts --file "$state/backups/<the file it printed>"
  # Pending migrations for the same database (the coordinator also applies them
  # at boot). Inline, non-secret variables; --dry only lists them:
  DUCKY_PROFILE=$profile DUCKY_DB_PATH="$state/ducky.db" \
    node_modules/.bin/tsx packages/persistence/src/cli/migrate.ts --dry
  ```

  `--db` wins over `DUCKY_DB_PATH` and the default. Do not `source` the env file
  or pass it to `--env-file` just to find the path; the path is in the
  `DUCKY_DB_PATH` line of that file, and nothing else in it is needed. The
  executor credential file is not in a backup and is saved separately
  ([backup-and-restore.md](backup-and-restore.md)). A backup proves state is
  recoverable. It is no evidence about the provider, the network or admission.

## 5. Temp files and cleanup ownership

Ducky only ever removes `ducky-sched-*` and `ducky-conv-*` directories that are
real directories owned by the running user, in the Ducky-specific `TMPDIR` the
units set, once they are stale. It never removes anything else, follows a
symlink, or touches another account's files. It does not touch
`~/.cache/devwork`, agent-flow roots, detached sessions, transcripts, task
records or provider state, and it never clears an `orphan_agent` reservation.

The existing `devwork-cleanup.timer` understands neither Ducky's activity nor
its orphan records, so its reclaiming of processes is **not** evidence that
Ducky's orphans are handled. Automatic reaping of stale Ducky workspaces is also
not wired: `Reconciler.reapableWorkspaces` only reports candidates.

## 5b. The shared admission ledger (source; nothing here has been run on the host)

What each command does, so the steps are reviewable before anybody runs them.
None of this is performed by this repository, and none of it turns engineering on.

```bash
# 1. Create the ledger ONCE, in a private directory outside any temp or cleanup
#    root. It refuses to overwrite anything. The policy is immutable afterwards.
pnpm shared-admission init --path ~/.local/state/shared-engineering-admission/ledger.sqlite3
#    prints ledger_id and policy_digest: every participant pins BOTH.
# 2. Read-only view of the identity, the policy digest and every hold.
pnpm shared-admission inspect --path <ledger> --ledger-id <id>
# 3. The owner's explicit recovery for a hold nothing else will clear (a crash
#    between confirm and the local commit, a lost local database, a worker whose
#    workspace never proved closed). Exact holder, and an attestation that no
#    worker is running. It frees ONE fence and nothing else.
pnpm shared-admission release --path <ledger> --ledger-id <id> --program <ducky|agent-flow> \
  --instance <instance id> --job <job ref> --fence <n> --i-verified-no-worker-is-running
```

Pins in the coordinator environment: `DUCKY_SHARED_ADMISSION_PATH`,
`_LEDGER_ID`, `_POLICY_DIGEST`, `_EXECUTORS` (this host's executor ids only), and
the two reserve estimates. `DUCKY_SHARED_ADMISSION_ELIGIBLE=1` is a separate act
that is NOT part of installing anything: set it only after the Agent Flow companion
is installed in the live dispatcher (a deliberate, separately authorized change)
and a controlled second admission was refused. A coordinator that is told it is
eligible and cannot open the ledger does not run engineering and says why in its
log and audit trail; it never creates a ledger.

What stops engineering on its own (each is logged as a reason word): a missing,
replaced or re-policied ledger; a pin that differs; a local slot whose fence the
ledger does not confirm; a surviving shared hold after a database restore; a
release the ledger refused or that failed 100 times. The way out of each is a
person looking, then `release` or `/job cleanup` -- not a retry.

Upgrading to schema 30 adds two tables and two columns and backfills nothing. A
database that set only `DUCKY_ENGINEERING_ENABLED` stops claiming until the second
switch is set deliberately.

## 6. What is not implemented, and what blocks merge and deployment

Do not call the bot deployed, and do not close issue 8, while any of these is
open. All fourteen are required, and the list matches
[CURRENT_STATE](../CURRENT_STATE.md#remote-runtime-preparation-issue-8) and
[decision 0030](../decisions/0030-remote-linux-runtime-and-ducky-local-admission.md):

1. **Cross-program and cross-profile admission.** Source exists (decision 0031):
   a host-local shared ledger, Ducky's claim, slot, outbox and gates standing on it,
   and a private Agent Flow companion candidate. **Not installed, not proved:** no
   ledger exists on the host, no pin is set, the dispatcher is unchanged, and no
   controlled second admission has been refused. The Ducky slot itself is still
   local to one coordinator database.
2. **Effective, ancestor-aware headroom.** Implemented in source and unit-tested:
   before every prompt the executor reads the cgroup of the owned agent's own
   foreground processes (found through `herdr pane process-info`) and every
   ancestor, and the tightest remaining room must cover the engineering,
   provider and notification reserves. Still required: a run with a real Ducky
   agent (the one recorded pane response is a manager role pane, not Pi), and a
   shared reservation, because a passing check is not one another program also
   respects.
3. **Active-agent stop.** The recorded Herdr adapter has no supported way to stop
   a working agent. A timeout of a working agent becomes an orphan that holds the
   repository and the slot for the owner; confirmed owned-descendant cancel and
   timeout need an authorized real-agent stop probe.
4. **Idle or no-result model stop without consuming retry budget.** Implemented
   in source and unit-tested for a confirmed quiet agent (fresh, positive name,
   workspace and pane match and `idle` or `done`): the job pauses on the existing
   owner-input state without spending an attempt or a question round, keeps its
   workspace and repository, and resumes through the owner's answer control. It
   is NOT a quota feature. Ducky infers no cause, there is no provider quota
   state, counter or sign-in-versus-quota distinction until a real response is
   recorded (item 5), and no real pause has been observed, so the issue's
   quota-pause criterion is not met. **Durable pause delivery (source, unit- and
   on-disk-tested, never run with a real agent):** a quiet pause is written to the
   executor's durable state (`DUCKY_EXECUTOR_STATE_DIR`, required, explicit, never
   under `/tmp`, `TMPDIR` or the runtime directory) before anything is released or
   sent, and kept until the coordinator answers for that exact report. A lease that
   expires meanwhile is not charged and not exhausted; the job waits holding its
   repository, slot and workspace for the original executor's report or attested
   recovery claim, and the owner's cancel is the other exit. Operate it like this:
   - **A log line `claims withheld: a pause report is still owed`** means the
     coordinator is unreachable, an older one that lacks the routes (a
     coordinated-upgrade limit, never downgraded to a failure), or the agent is not
     provably quiet now. The executor holds every claim and prompt and retries;
     nothing is deleted. Fix the cause, or inspect the job with `/job`.
   - **`pause record(s) cannot be trusted`** means a file in
     `pause-intents/` is corrupt, oversized, foreign or the wrong shape. Nothing was
     deleted or repaired; read it, decide, and move it aside by hand. If a held
     intent's job was forgotten (`/forget`) the coordinator answers `not_found`
     forever; confirm that through `/jobs`, then remove that one file by hand.
   - **`the dispatch journal is full`** means every record belongs to a job the
     coordinator says can still run (running, queued, paused, waiting). Finished
     jobs' records are dropped on the coordinator's word, at startup, on a schedule
     and whenever the journal is full; nothing is aged out. Claims stop until one
     finishes, so no agent is started that could not be journaled. Resolve a stuck
     job (`/job cancel`, `/job cleanup`) and the next sweep frees its record.
   - **A deferred hold** (a lease that expired with a negotiated pause owed)
     DMs you and holds the repository and slot with no timer; see the orphan
     runbook. It needs the ORIGINAL executor to return, and `/job cancel` then
     `/job cleanup` is the exit if it cannot.
   - **There is no mock fallback.** If Herdr is down at boot the executor still
     runs the real orchestrator, which fails closed: it claims nothing, proves
     nothing and stops nothing until Herdr answers.
   - **Never** place the state directory under a temp or runtime path, share it
     between profiles, or delete `dispatch-journal/` to "clear" a job: a job with no
     journal entry is treated as unproven and orphaned, deliberately.
   Still not retry-preserving: a crash before the intent is durable, a lost state
   directory or host, an older coordinator and an older executor.
5. **Supported subscription route, sign-in and quota on this host.** No
   `openclaw` binary or provider profile exists in this account at the time of
   writing. Route, eligibility and quota are unverified, and the binary's absence
   is not a passed integration.
6. **Herdr session pinning** for Ducky, separate from the dispatcher's, is
   undocumented in this repository and therefore not configured.
7. **Periodic orphan, workspace and temp reclamation** that preserves active work
   is not wired (section 5): the reconciler only reports candidates.
8. **Active-job temp-artifact protection.** The owned-temp sweep is by staleness
   and does not prove that an arbitrarily long-lived temp artifact of a live job
   is safe.
9. **Reminders and GitHub events during a quota pause.** Independent of the model
   by construction, never observed through a real pause.
10. **Tailscale Serve, private listener and no Funnel**, verified on the host.
11. **Restart, logout and laptop or app-disconnect continuity**, verified by an
    actual cycle.
12. **No-billed-API fallback across provider and Herdr environments.** The
    startup refusal sees only the coordinator's and executor's own environment.
    The provider and Herdr checks in section 3 are manual and unrun. Never inspect
    secret values.
13. **Live checks:** provider, Discord round trip, a controlled managed job with
    an attempted second admission, cancel, a timeout, a notification, logout,
    phone access and recovery. None has been run.
14. **Closure policy.** The dispatcher requires `Closes #8` in the PR body. Merging
    early would close #8 with items 1 to 13 open. A draft PR and
    `ready_to_merge=false` are signals the dispatcher honours and do not
    technically prevent a manual merge.

Before calling it deployed: provider sign-in on this account, a Discord round
trip, a job path under a development profile, the phone over the tailnet, a
logout cycle, and a deliberate second-admission attempt, each recorded in
`docs/CURRENT_STATE.md` with what it does not prove.
