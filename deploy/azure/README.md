# Azure deployment — code only, nothing provisioned

**Nothing in this directory has been executed.** No Azure CLI call has been made
from this repository, no subscription has been touched, and no resource exists.
These are templates written so the decision is reviewable *before* anything is
created, which is the same posture `docs/DEPLOYMENT.md` has always taken.

Provisioning is an owner action. When it happens, it happens deliberately, from
a shell, by somebody who has read what follows — starting with
[`APPROVAL_PROPOSAL.md`](APPROVAL_PROPOSAL.md), which itemises exactly what
would be created, what it would cost, what it would expose, and how to undo
it.

## What the templates describe

| File | What it is |
|---|---|
| `main.bicep` | One small Linux VM, one NSG, one managed disk, and nothing public but SSH |
| `cloud-init.yaml` | First-boot configuration: the `ducky` user, directories, permissions |
| `parameters.example.json` | The values you must supply. Every one is a placeholder |
| `executor.env.example` | The executor environment for this host. Its own identity, its own credential |
| `APPROVAL_PROPOSAL.md` | **Read this first.** The itemised decision: region, sizes, disks, exposure, cost, rollback |

## The shape, and why

**One VM, not a container platform.** Ducky is a single-owner assistant with a
SQLite file. A managed database, an orchestrator and a load balancer would each
be a moving part with no problem to solve.

**No public inbound except SSH, and ideally not even that.** The executor always
dials OUT; there is no inbound path to the WSL host at all. The coordinator's
HTTP API binds to loopback or the tailnet, never `0.0.0.0`. The NSG in
`main.bicep` opens port 22 and nothing else, and the intent is to close that too
once Tailscale is in place — see `../tailscale/README.md`.

**Secrets are files, not template parameters.** `cloud-init.yaml` creates
`/etc/ducky/` `0700` and the profile env files `0600`, EMPTY. You fill them in
over SSH afterwards. A secret passed as a deployment parameter is a secret in a
deployment history, and Azure keeps those.

**The disk is separate from the OS disk.** `/var/lib/ducky` is where the SQLite
file lives, and it should survive a rebuild of the machine.

## What is deliberately NOT here

- **No `az` invocation, in any script.** Not even a "dry run": a dry run against
  a subscription is still a call to Azure.
- **No secret, no token, no subscription id, no tenant id, no resource group
  name.** `parameters.example.json` is placeholders.
- **No CI workflow that deploys.** Autonomous deployment is on the deferred list
  in `PROJECT_CONTEXT.md` and stays there.
- **No public HTTP surface.** Nothing here provisions a load balancer, an
  application gateway, a public IP for the API, or a DNS record for one.

## When somebody does provision this

The order matters, and each step is a decision:

1. Read `main.bicep` end to end. It is short on purpose.
2. `cp parameters.example.json parameters.json` and fill it in. Do not commit it.
3. Create the resource group yourself, in the subscription you intend.
4. `az deployment group what-if` FIRST. Read the diff.
5. Deploy. Note the VM's private address; there is no public one for the API.
6. SSH in, install Node, clone the repository, `pnpm install`, `pnpm build`.
7. Write `/etc/ducky/production.env` (mode 0600). See `.env.example` for every
   variable, and `docs/SECURITY.md` for which are per-profile secrets.
8. Issue an executor credential with `pnpm executor:issue-credential`, and put
   the file at `/etc/ducky/executor-credentials-production.json`, mode 0600.
9. Install the systemd unit from `../systemd/`, then start ONE profile.
10. Check `/readyz` over loopback, and read the boot diagnostics.

Registering Discord commands is a separate, deliberate write —
`pnpm register-commands --apply --profile production` — and is not part of
provisioning.
