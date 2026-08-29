# Runbook: adding a second executor

One coordinator, several hosts that can do the work. The slug stays the only
name anybody uses; each host has its own checkout of it, its own identity and
its own credential.

Nothing here provisions anything. This is the sequence for a host that already
exists — a second machine, a WSL box, or the Azure VM once somebody has
deliberately created it.

## The three things that must agree

1. **The executor id** — `DUCKY_EXECUTOR_ID` in the host's environment file.
2. **The credential** — issued by the coordinator *for that id*.
3. **The placement** — an entry in the coordinator's repos file naming that id
   and the absolute path on that host.

If (1) and (3) disagree there is no error at startup. The executor
authenticates, polls, and is simply never handed anything, because no
repository lists it. `/status` shows it connected and nothing happens. Check
this first when a new host looks healthy but idle.

## 1. Issue a credential, on the coordinator host

```bash
pnpm executor:issue-credential --executor azure-prod --name "azure production"
```

The bearer token and HMAC secret are printed **once** and written to the
coordinator's 0600 credential file. They are not recoverable. Do not pipe that
command through anything that keeps output.

Each host gets its own. Copying the WSL executor's credential to a second
machine would give two hosts one identity — so each would be handed the
other's paths, which is the exact failure placements exist to prevent — and
would mean revoking that credential takes down both.

## 2. Put the repository on the new host

However you like: `git clone`, an existing checkout, a restored disk. Ducky
does not clone for you, and deliberately: a first clone is a decision about
what code goes on which machine.

Two things matter about the result:

- **`origin` must be the repository configuration says it is.** The executor
  now checks, and refuses the job otherwise. That check is what makes a stale
  or copy-pasted path safe: it fails rather than editing whatever it found.
- **It must be clean.** A worktree job branches from the base ref; it does not
  stash or reset, and `reset` and `clean` are forbidden verbs.

## 3. Add the placement

In the coordinator's repos file (`DUCKY_REPOS_FILE`):

```json
{
  "slug": "example-app",
  "defaultBranch": "main",
  "github": { "owner": "PLACEHOLDER-ORG", "repo": "example-app" },
  "preferredExecutorId": "wsl-dev",
  "fetchBeforeJob": true,
  "placements": [
    { "executorId": "wsl-dev",    "absolutePath": "/home/you/projects/example-app" },
    { "executorId": "azure-prod", "absolutePath": "/opt/ducky-repos/example-app" }
  ]
}
```

Points worth reading twice:

- **Remove the top-level `absolutePath`.** Configuration refuses both forms at
  once rather than deciding which wins.
- **`placements` is exhaustive.** Any executor not listed is not eligible.
  That is the fail-closed direction: an unlisted host waits instead of running
  against a directory that means something else there.
- **`preferredExecutorId` is a preference, not a pin.** While that host is
  live it takes the work; when it is not, the other listed hosts become
  eligible. Leave it out if you do not care which host runs what.
- **`fetchBeforeJob`** is worth turning on for a host that is not where you
  work. It needs a GitHub mapping and a default branch, and a failed fetch
  falls back to the local ref rather than failing the job.

The coordinator reads this file at startup, so **restart it** for the change to
take effect. Placements are mirrored into `repo_placements`, replacing what was
there — a host removed from the file stops being listed rather than lingering.

## 4. Install the unit

| Host | Unit |
|---|---|
| A developer's WSL machine | `deploy/systemd/user/ducky-executor@.service` |
| A headless host such as the Azure VM | `deploy/systemd/ducky-executor@.service` |

The difference is real: the user unit runs as the developer, with their Herdr
session and their Pi install, and stops at logout unless lingering is enabled.
The system unit runs as the `ducky` service account and starts at boot.

Environment file: `deploy/azure/executor.env.example`, at
`/etc/ducky/executor-<profile>.env`, mode 0600.

**The executor never listens.** It dials the coordinator; nothing dials it. No
port is opened on the new host and the NSG needs no rule for it.

## 5. Check it

```bash
# On the coordinator host — the new id, seen recently.
/status                     # in Discord, owner-only
/repo status <slug>         # names the hosts a repository can run on
```

`/repo status` reports executor **ids**, never paths: a filesystem path never
reaches Discord in either direction.

Then submit a small job and watch which host takes it. If the job stays queued,
`/job status` says why in the owner's private view — including "waiting for an
executor that has `<slug>` checked out", naming the configured hosts.

## What does NOT get copied to a second host

- **The coordinator's database.** One coordinator, one database. An executor
  holds no state that outlives a job.
- **Another host's executor credential.** See step 1.
- **The OpenClaw auth store, or any OAuth or token material.** That stays on
  the machine where the owner signed in. An executor holds no model
  credential, has no conversation provider, and needs neither.
- **`DUCKY_HERDR_VERIFIED`.** It is a claim about a host, based on
  `pnpm probe:live-job` evidence from that host. Evidence from another machine
  is evidence about another machine.
