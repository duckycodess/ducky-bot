# Tailscale — configuration shape only, nothing installed

**Tailscale is not installed on this host, and nothing here installs it.** No
`tailscale up`, no auth key, no ACL push, no DNS change. This is the shape the
network is meant to take, written down so it can be reviewed before it exists.

Installing it is an owner action, on both machines, deliberately.

## Why a tailnet at all

The coordinator's HTTP API is the executor's only inbound surface, and it should
not be on the public internet under any circumstance. Today it binds to
loopback, which works because there is one machine. The moment the coordinator
is on an Azure VM and the executor is on WSL, they need a private path between
them — and a tailnet is that path without opening a port, running a tunnel
daemon of our own, or issuing a public certificate.

The alternative — a public listener with an allowlist — was rejected for the
obvious reason: an allowlist is a thing you can get wrong, and a closed port is
not.

## What the code already assumes

This part is **not** aspirational; it is enforced today:

- `assertPrivateGatewayUrl` accepts loopback, `100.64.0.0/10` (the CGNAT range
  Tailscale allocates from) and `.ts.net` MagicDNS names, and refuses everything
  else — at construction AND at startup.
- `DUCKY_HTTP_HOST` defaults to `127.0.0.1`. Binding `0.0.0.0` is a thing an
  operator would have to type.
- The executor has no listener at all, asserted by a test.

So the code is ready for a tailnet and refuses a public one. What is missing is
the tailnet.

## The intended shape

| Node | Role | Reachable by |
|---|---|---|
| Azure VM | coordinator, HTTP API on the tailnet address | the executor only |
| WSL host | executor, Herdr, Pi | nothing — it dials out |

- **Both nodes tagged**, e.g. `tag:ducky-coordinator` and `tag:ducky-executor`,
  so the ACL names roles rather than machines.
- **One ACL rule**: `tag:ducky-executor` may reach `tag:ducky-coordinator` on the
  coordinator's port, and nothing else on the tailnet may reach either.
- **`DUCKY_HTTP_HOST`** set to the coordinator's tailnet address, never
  `0.0.0.0`.
- **Key expiry left ON.** A node key that never expires is a credential with no
  rotation story, and this repository already rejects that pattern for the
  executor credential.
- **The Azure NSG SSH rule removed** once tailnet SSH works. That is the point of
  the exercise.

An ACL sketch, for review rather than for pasting:

```jsonc
{
  "tagOwners": {
    "tag:ducky-coordinator": ["autogroup:admin"],
    "tag:ducky-executor": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:ducky-executor"],
      "dst": ["tag:ducky-coordinator:8788"]
    }
  ]
}
```

## What must never happen

- **No auth key in this repository, in an env file that gets committed, or in a
  cloud-init.** Tailscale auth keys are bearer credentials; treat them exactly
  like the executor credential file.
- **No `tailscale funnel`, and no `tailscale serve` to the public internet.**
  That would put the API back on the internet through a different door, and the
  private-URL guard would not see it happen.
- **No exit node, no subnet router** for these two machines. They need to reach
  each other, not each other's networks.

## Verifying it later, honestly

When it exists, the claim "the API is not publicly reachable" should be checked
rather than assumed: from a machine that is NOT on the tailnet, confirm the
coordinator's port does not answer. Record that check in
`docs/CURRENT_STATE.md` the way every other verified fact is recorded — and
until then, that section keeps saying Tailscale is not installed.
