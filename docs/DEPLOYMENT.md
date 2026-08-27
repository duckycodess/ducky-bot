# Deployment

**Nothing has been provisioned.** This is the intended shape, written so the
decision is reviewable before anything is created.

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
| `/etc/ducky/executor-credentials.json` | **0600** | refused otherwise |
| `/var/lib/ducky/ducky.db` | 0600 | SQLite on persistent disk |

### Backups

`node:sqlite` exposes `backup`, so a consistent snapshot can be taken without
stopping the service. Back up the database and the credential file separately;
the credential file is the trust root and must never land in a shared backup.

## Executor (WSL)

A user service, because it needs the developer's own environment, Herdr and Pi.

**`Linger=no` is the confirmed default on this host**, so without
`loginctl enable-linger $USER` the executor stops when the session ends. That is
a deliberate call, not an oversight — enable it only if the executor should run
unattended.

## systemd

Templates are in `deploy/systemd/`. They are **templates**: nothing is
installed by this repository.

```bash
# coordinator
sudo cp deploy/systemd/ducky-coordinator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ducky-coordinator

# executor (WSL, user scope)
mkdir -p ~/.config/systemd/user
cp deploy/systemd/user/ducky-executor.service ~/.config/systemd/user/
loginctl enable-linger "$USER"     # only if it should survive logout
systemctl --user daemon-reload && systemctl --user enable --now ducky-executor
```

## Networking

Long term: Tailscale on both hosts, the coordinator reachable only over the
tailnet, and no public listener at all. Tailscale is **not installed** here yet;
the private-URL guard already accepts the `100.64.0.0/10` range and `.ts.net`
names, so the code is ready for it.

The executor always dials out. There is no inbound path to WSL, and a test
asserts the package has no listener.

## Migrations

Forward-only, transactional, versioned, and applied at boot. `pnpm migrate
--dry` lists what is pending. Credential rotation needs no migration.

## Recovery

The executor restarts with `Restart=always`; its client backs off with jitter,
which covers laptop sleep, network changes and coordinator restarts. The
reconciler heals anything orphaned across the gap — see
[runbooks/orphan-recovery.md](runbooks/orphan-recovery.md).
