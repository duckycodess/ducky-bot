# systemd templates

These are **templates**. Nothing in this repository installs, enables or starts
a service.

| File | Scope | Host |
|---|---|---|
| `ducky-coordinator@.service` | system, **per profile** | Azure VM |
| `ducky-openclaw.service` | system | Azure VM — placeholder, unverified |
| `ducky-executor@.service` | system, **per profile** | a headless executor host, such as the Azure VM |
| `user/ducky-executor@.service` | user, **per profile** | WSL development machine |

**There are two executor units and the difference is real.** The user unit runs
as the developer, with their Herdr session and their Pi installation, and stops
at logout unless lingering is enabled deliberately. The system unit runs as the
`ducky` service account on a host with no interactive user, and starts at boot.
Pick by host, not by preference.

**One executor identity per host.** `DUCKY_EXECUTOR_ID` must be unique across
every machine that talks to a given coordinator, and must match the
`executorId` in that repository's `placements`. Two hosts sharing an identity
would each be handed the other's paths. See
[`../../docs/runbooks/second-executor.md`](../../docs/runbooks/second-executor.md).

Every unit is instanced on the profile name, so development and production run
as separate services with separate environment files, databases, ports and
executor identities:

```bash
systemctl enable --now ducky-coordinator@development
systemctl enable --now ducky-coordinator@production
systemctl enable --now ducky-executor@production        # headless host
systemctl --user enable --now ducky-executor@development # developer machine
```

Give each profile its own `/etc/ducky/<profile>.env`. Sharing one file would
defeat the isolation the two bots exist for. systemd reads that file itself via
`EnvironmentFile=`, so the units do not need Node's `--env-file` flag — that is
only for running the scripts by hand.

## Before installing

- Put every secret in an `EnvironmentFile` with mode 0600 owned by the service
  user. Unit files are world-readable; never inline a token.
- The executor credential file must be 0600 and owned by the coordinator's
  user, or the coordinator refuses to load it.
- On WSL, decide about `loginctl enable-linger $USER` deliberately. Without it
  the executor stops at logout, which is the safe default.
- `ducky-openclaw.service` guesses at a command line for a package that is not
  installed here. Check it against the real binary first — see
  `docs/integrations/openclaw.md`.

Installation steps are in [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).
