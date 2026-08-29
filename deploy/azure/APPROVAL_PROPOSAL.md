# Azure provisioning: proposal for approval

**Nothing in this document has been executed.** No `az` command has run from
this repository, no subscription has been contacted, no resource exists. This
is the decision put in front of the owner *before* anything is created, which
is the same posture the rest of `deploy/` takes.

Approving this means approving a specific, itemised set of resources. It is not
a standing permission to provision.

---

## 1. What would be created

| # | Resource | Type | Notes |
|---|---|---|---|
| 1 | `ducky-vnet` | `Microsoft.Network/virtualNetworks` | one subnet, private address space only |
| 2 | `ducky-nsg` | `Microsoft.Network/networkSecurityGroups` | one inbound rule, see §3 |
| 3 | `ducky-nic` | `Microsoft.Network/networkInterfaces` | attached to the subnet |
| 4 | `ducky-vm` | `Microsoft.Compute/virtualMachines` | one Linux VM |
| 5 | `ducky-data` | `Microsoft.Compute/disks` | managed data disk for the SQLite file |

Five resources. No load balancer, no application gateway, no public IP for the
API, no DNS record, no managed database, no container registry, no storage
account, no Key Vault.

**Why one VM and not a platform.** Ducky is a single-owner assistant whose
entire state is one SQLite file. A managed database, an orchestrator and a load
balancer would each be a moving part with no problem to solve, and each would
be a bill.

## 2. Region, size, disks

| Choice | Proposed | Why, and what would change it |
|---|---|---|
| Region | **`southeastasia`** | Nearest to `Asia/Manila`, the configured owner timezone. Latency barely matters for a Discord bot; data residency might, and this keeps the owner's data in their own region. |
| VM size | **`Standard_B2s`** — 2 vCPU, 4 GiB, burstable | The coordinator is idle almost all the time and does short bursts of work on a timer. Burstable credits fit that shape exactly. B1s (1 vCPU, 1 GiB) is likely enough but leaves no room for `pnpm build`. |
| OS disk | **30 GiB Premium SSD**, from the template default | Small; holds the OS and the application checkout only. |
| Data disk | **32 GiB Premium SSD**, `/var/lib/ducky` | Separate from the OS disk deliberately, so the database survives a rebuild of the machine. 32 GiB is far more than a SQLite file needs; the smallest managed tiers are not meaningfully cheaper. |
| Image | Ubuntu LTS | Node 24 available; nothing exotic required. |

**These are the numbers to argue with.** If any of them is wrong, it is wrong
now, in review, and not after a bill arrives.

## 3. Exposure — the part that matters most

**One inbound rule: SSH (TCP 22), from one source address prefix**, supplied as
a parameter and expected to be a `/32`. The template also carries an explicit
`deny-all-other-inbound` rule, which Azure would do by default; naming it means
a later "just open a port for a minute" has to delete a rule that says what it
is.

**No public inbound to the API, at all.**

- The coordinator's HTTP API binds to loopback or the tailnet. Never `0.0.0.0`.
- The executor dials **out**. There is no inbound path to it — a test asserts
  the executor opens no listener — so no rule is needed for it on any host.
- The intention is to remove even the SSH rule once Tailscale is in place, and
  reach the host over the tailnet. See [`../tailscale/README.md`](../tailscale/README.md).

**A public IP is required for outbound SSH access before Tailscale exists.**
That is the one exposure this proposal actually adds, and it is worth being
plain about: between provisioning and the tailnet being up, the VM has a public
address with port 22 open to one source prefix. If that window is not
acceptable, the order is: provision → configure Tailscale over the serial
console → delete the SSH rule and the public IP.

## 4. Cost

An estimate, not a quote. Prices vary by region and change; check the current
Azure pricing calculator before approving.

| Item | Rough monthly |
|---|---|
| `Standard_B2s`, running continuously | ~USD 30–40 |
| Premium SSD, 30 GiB OS | ~USD 5 |
| Premium SSD, 32 GiB data | ~USD 5 |
| Public IP (static) | ~USD 4 |
| Egress | negligible at this traffic |
| **Total** | **~USD 45–55 / month** |

Ways to spend less, in the order they are worth considering:

1. **Standard HDD instead of Premium SSD** for both disks — roughly halves the
   storage line. A SQLite file with one writer does not need Premium IOPS.
2. **`Standard_B1s`** — roughly halves the compute line. Verify `pnpm build`
   completes in 1 GiB first, or build elsewhere and copy `dist/`.
3. **Deallocate when not in use** — but this is an always-on assistant that
   delivers scheduled reminders and briefings, so this defeats the purpose.

## 5. What is deliberately NOT in scope

- **No secret is passed as a deployment parameter.** Azure keeps deployment
  history; a secret in a parameter is a secret in that history. `cloud-init`
  creates `/etc/ducky/` at `0700` with EMPTY `0600` env files, filled in over
  SSH afterwards. The only parameter that looks secret is the SSH **public**
  key, which is not one.
- **No OAuth or token store is copied to Azure.** The OpenClaw auth store stays
  on the machine where the owner signed in. The VM would run a coordinator
  and/or an executor; an executor holds no model credential at all.
- **No Discord registration.** `pnpm register-commands --apply --profile
  production` is a separate, deliberate external write and is not part of
  provisioning.
- **No CI workflow that deploys.** Autonomous deployment is on the deferred
  list in `PROJECT_CONTEXT.md` and stays there.
- **No `az` invocation from this repository**, including a dry run — a
  `what-if` against a subscription is still a call to Azure.

## 6. Rollback

Every resource here is in one resource group, created by the owner
specifically for this. Rollback is therefore complete and cheap:

```bash
az group delete --name <the group> --yes
```

That removes all five resources and stops all billing. What it also destroys is
the data disk, so **take a backup first** if the instance has been running:

```bash
pnpm backup --profile production --out <somewhere off the VM>
pnpm backup:verify --file <that file>
```

Partial rollback is available too and is usually the better move:

- **Close the exposure without destroying anything** — delete the SSH NSG rule.
  The tailnet path keeps working; SSH does not.
- **Stop the cost without losing the data** — deallocate the VM. The disks are
  still billed (~USD 10/month) and the database survives.
- **Roll back the application only** — see
  [`../../docs/runbooks/upgrade-and-rollback.md`](../../docs/runbooks/upgrade-and-rollback.md).

## 7. The order, if this is approved

Each step is a decision, and none of them is implied by approving the one
before it.

1. Read `main.bicep` end to end. It is short on purpose.
2. `cp parameters.example.json parameters.json`, fill it in, do not commit it.
3. Create the resource group yourself, in the subscription you intend.
4. `az deployment group what-if` **first**. Read the diff.
5. Deploy. Note the private address; there is no public one for the API.
6. SSH in; install Node, clone, `pnpm install`, `pnpm build`.
7. Write `/etc/ducky/production.env` (0600). See `.env.example`.
8. Issue an executor credential and place it at `/etc/ducky/executor-production.env`
   (0600) — see [`../../docs/runbooks/second-executor.md`](../../docs/runbooks/second-executor.md).
9. Install the systemd units, start ONE profile.
10. `/readyz` over loopback; read the boot diagnostics.
11. Tailscale, then delete the SSH rule.

---

## What approval means

Approving this authorises **exactly the five resources in §1, in the region and
sizes in §2, with the single inbound rule in §3.** Anything else — a public
endpoint, a second VM, a managed database, a storage account — is a new
proposal.

**Not approved, and not requested here:** any change to a resource that already
exists in the subscription.
