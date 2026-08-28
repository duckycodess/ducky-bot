# Deployment

**Nothing has been provisioned.** This is the intended shape, written so the
decision is reviewable before anything is created.

## Two profiles

Ducky runs as two isolated identities. Nothing is shared between them, and
neither can fall back to the other:

| | development | production |
|---|---|---|
| token | `DISCORD_DEV_TOKEN` | `DISCORD_PROD_TOKEN` |
| application id | `DISCORD_DEV_APP_ID` | `DISCORD_PROD_APP_ID` |
| commands | guild-scoped to `DISCORD_DEV_GUILD_ID` (instant) | global, unless `DISCORD_PROD_GUILD_ID` is set |
| database | `./data/ducky-dev.db` | `./data/ducky-prod.db` |
| port | 8787 | 8788 |
| repositories | `config/repos.dev.json` | `config/repos.json` |
| env file | `/etc/ducky/development.env` | `/etc/ducky/production.env` |
| component signing key | `DUCKY_DEV_COMPONENT_SIGNING_KEY` | `DUCKY_PROD_COMPONENT_SIGNING_KEY` |
| executor credentials | `DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE` | `DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE` |

Every secret is profile-scoped, not only the Discord ones. Production reads
**none** of the unscoped or development variables: a shared component key would
let a control minted by one bot verify on the other, and a shared executor
credential file would let a development executor claim production jobs. A
single-profile development box may still use the unscoped names.

Development may run with no token at all, which selects the mock transport.
**Production fails to start without its own token** rather than borrowing the
development bot, and production never registers into the development guild.

The active profile appears in the startup diagnostics and in `/status`, so an
instance is never ambiguous.

## Azure templates — written, never executed

[`deploy/azure/`](../deploy/azure/) now carries a Bicep template, a cloud-init
file and an example parameter file. **Nothing there has been run**: no `az` call
has been made from this repository, no subscription has been touched, and no
resource exists. They describe one small VM, one data disk, and an NSG that opens
SSH from one address and nothing else — deliberately no public IP for the API.

Secrets are **not** deployment parameters: cloud-init creates the env files empty
and `0600`, and you fill them in over SSH, because a parameter lives in Azure's
deployment history. See [`deploy/azure/README.md`](../deploy/azure/README.md) for
the order to do it in.

## Coordinator (Azure VM)

- Ubuntu 24.04 LTS x64, a small B-series instance
- SSH key authentication only; password authentication disabled
- No public inbound beyond SSH, and preferably not even that once a tailnet is
  in place
- OpenClaw bound to loopback; the code refuses a public gateway URL outright
- The executor API bound to loopback or the tailnet interface, never `0.0.0.0`

### Files

| Path | Mode | Notes |
|---|---|---|
| `/opt/ducky` | 0755 | application |
| `/opt/ducky/config/repos.json` | 0644 | slugs → absolute paths |
| `/etc/ducky/<profile>.env` | **0600** | one per profile, never shared |
| `/etc/ducky/executor-credentials-<profile>.json` | **0600** | refused otherwise |
| `/var/lib/ducky/ducky-<profile>.db` | 0600 | SQLite on persistent disk |

### Backups

`pnpm backup` takes a consistent snapshot through SQLite's online backup API,
without stopping the service, and writes it `0600`. `pnpm backup:verify` proves
the copy is restorable before you need it to be. The credential file is **not**
included: it is the trust root and must never land in the same artifact. See
[runbooks/backup-and-restore.md](runbooks/backup-and-restore.md).

## Executor (WSL)

A user service, because it needs the developer's own environment, Herdr and Pi.

**`Linger=no` is the confirmed default on this host**, so without
`loginctl enable-linger $USER` the executor stops when the session ends. That is
a deliberate call, not an oversight — enable it only if the executor should run
unattended.

## systemd

Templates are in `deploy/systemd/`. They are **templates**: nothing is
installed by this repository.

Both units are instanced on the profile name.

```bash
# coordinator, once per profile
sudo cp deploy/systemd/ducky-coordinator@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ducky-coordinator@development
sudo systemctl enable --now ducky-coordinator@production

# executor (WSL, user scope), once per profile
mkdir -p ~/.config/systemd/user
cp deploy/systemd/user/ducky-executor@.service ~/.config/systemd/user/
loginctl enable-linger "$USER"     # only if it should survive logout
systemctl --user daemon-reload
systemctl --user enable --now ducky-executor@development
```

Each instance reads `/etc/ducky/<profile>.env` (mode 0600). Give every profile
its own executor credential file too: a shared one would let a development
executor claim production jobs.

## Networking

Long term: Tailscale on both hosts, the coordinator reachable only over the
tailnet, and no public listener at all. Tailscale is **not installed** here, and
nothing in this repository installs it; the private-URL guard already accepts
loopback, the `100.64.0.0/10` range and `.ts.net` names (and now `ws:`/`wss:`,
which is what OpenClaw actually speaks), so the code is ready for it. The
intended tags, ACL and the things that must never happen — no auth key in the
repository, no `tailscale funnel` — are written down in
[`deploy/tailscale/README.md`](../deploy/tailscale/README.md).

The executor always dials out. There is no inbound path to WSL, and a test
asserts the package has no listener.

## Migrations

Forward-only, transactional, versioned, and applied at boot. `pnpm migrate
--dry` lists what is pending. Credential rotation needs no migration.

Forward-only means rollback is **restore the backup you took first**, not "run
the down migrations" — there are none, and inventing them would silently drop
rows a newer schema accepted. The whole procedure, including how to tell whether
the database has to go back too, is in
[runbooks/upgrade-and-rollback.md](runbooks/upgrade-and-rollback.md).

## Recovery

The executor restarts with `Restart=always`; its client backs off with jitter,
which covers laptop sleep, network changes and coordinator restarts. The
reconciler heals anything orphaned across the gap — see
[runbooks/orphan-recovery.md](runbooks/orphan-recovery.md).
