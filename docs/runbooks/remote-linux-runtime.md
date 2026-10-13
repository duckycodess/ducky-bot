# Remote Linux runtime (issue 8): preparation, not deployment

**Nothing here has been run on the intended host as a deployment.** This is the
preflight, the install shape and the checks to pass before anybody says the bot
is deployed. Every command below is read-only unless it says otherwise, and none
of them is executed by this repository.

Read first, because it shapes everything after it:

- **Engineering stays OFF.** `DUCKY_ENGINEERING_ENABLED` defaults to off. The
  single engineering slot lives in ONE coordinator database. It is global across
  that database's repositories and executors and nowhere else: not across the
  development and production profiles (separate databases), and not with the
  separate agent-flow dispatcher, which has its own slots and no supported
  shared-admission protocol. Turning engineering on before that protocol exists
  means two programs can each start an agent against the one 8 GiB account. See
  [decision 0030](../decisions/0030-remote-linux-runtime-and-ducky-local-admission.md).
- **Additional-user AI stays OFF** (`DUCKY_ADDITIONAL_USER_AI_ENABLED`).
- Reminders, tasks, briefings and GitHub watches do not depend on the model and
  keep working with both of the above off.

## 1. Preflight readbacks

Record what you actually see; do not copy these numbers into a report.

```bash
uid=$(id -u)
# Account-wide ceiling. The recorded host reads MemoryMax=8589934592,
# MemoryHigh=7516192768, MemorySwapMax=0, TasksMax=1536.
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

Two facts the numbers do not show:

- The guard compares `min(memory.max, memory.high)` minus `memory.current`
  against the engineering plus notification reserves. `memory.current` includes
  page cache, so it can refuse when there is reclaimable room. That is the safe
  direction. At the time of writing the recorded host used about 4 GiB of its
  7 GiB high mark with nothing of Ducky running, so a 2.5 GiB reserve is already
  close to the edge.
- Herdr's server owns the agent processes. They are outside every Ducky unit's
  cgroup, so no unit limit bounds them. Only the slice limit does, and a user
  unit may set its own limits only if the user manager has controllers
  delegated, which is a host change this repository does not make.

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

## 6. What is not implemented, and what blocks merge and deployment

Do not call the bot deployed, and do not close issue 8, while any of these is
open:

1. **Cross-program admission.** No supported protocol exists with agent-flow.
   The Ducky slot is local to one coordinator database.
2. **Active-agent stop.** The recorded Herdr adapter has no supported way to stop
   a working agent. A timeout of a working agent becomes an orphan that holds the
   repository and the slot for the owner; owned-descendant termination needs an
   authorized real-agent stop probe.
3. **Idle or no-result model stop without consuming retry budget.** Not
   implemented. A turn that ends idle with no result is still reported as an
   ordinary `no_result` failure. The quota-pause criterion in the issue is
   therefore NOT met, and there is no provider quota state, counter or
   sign-in-versus-quota distinction to build on until a real response is
   recorded.
4. **Supported subscription route and quota on this host.** No `openclaw` binary
   or provider profile exists in this account at the time of writing. Route,
   eligibility and quota are unverified.
5. **Live checks:** Discord, Tailscale Serve and logout continuity, phone access,
   and a controlled managed job with an attempted second admission and a
   timeout. None has been run.
6. **Herdr session pinning** for Ducky, separate from the dispatcher's, is
   undocumented in this repository and therefore not configured.
7. **Provider and Herdr environment** are checked by the commands above, by hand.

Before calling it deployed: provider sign-in on this account, a Discord round
trip, a job path under a development profile, the phone over the tailnet, a
logout cycle, and a deliberate second-admission attempt, each recorded in
`docs/CURRENT_STATE.md` with what it does not prove.
