# 0030. The remote Linux runtime, and a Ducky-local engineering slot

**Status:** Accepted, with open merge blockers listed below

## Context

Issue 8 moves Ducky onto an existing remote Linux account that already provides
Tailscale, the tools, a registered clone, an account-wide 8 GiB `MemoryMax`
(7 GiB `MemoryHigh`, no swap, `TasksMax` 1536), lingering and a periodic cleanup
timer. This supersedes the Azure coordinator and WSL executor placement in
[`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) for this host; those templates are kept
for history and are not deleted. ADR 0010 assumed one writer per repository and
nothing global.

The shared account cap is hit by everything running as that user. Ducky's
per-repository reservations let two repositories run agents at once, and a
timed-out or lost attempt could free its repository while an agent was still
writing.

## Decision

**A single engineering slot, local to one coordinator database.** Migration 28
adds `engineering_admission`, one row with its key pinned to 1. Claim takes it
in the same transaction as the repository reservation. A held slot returns no
claim, and the job stays `queued`: no failure, no attempt consumed, no backoff.
The slot follows the reservation of the job that holds it:

- a pause (`needs_owner_input`, `needs_approval`, `waiting_on_dependency`)
  releases it, because those states are quiescent by ADR 0010's contract, and
  the answered job reacquires it at its next claim;
- a terminal release frees it;
- lease expiry, an orphaned agent, or a reservation timer on a job whose
  workspace is still open **keeps** it as `unconfirmed_stop`, until the same job
  reclaims it and recovery proves the agent quiet, or the owner runs
  `/job cleanup`.

This extends ADR 0010 rather than replacing its spans: the reservation (whole
job), the lease (one executor turn), the writer lock (one Pi turn) and Herdr's
agent names (one host) are unchanged, and the slot sits above them.

**Scope, stated exactly.** The slot is global across the repositories and
executors one coordinator serves, and nowhere else. It is not shared between the
development and production profiles (separate databases, by design: profiles
share no state), and it is **not** shared with the agent-flow dispatcher, which
exposes only internal SQLite worker slots and a singleton lock, with no
supported external admission protocol. Writing its state or configuration is out
of bounds. This ADR therefore does not deliver the issue's cross-program single
job, and no document may say it does.

**Engineering is off by default.** `DUCKY_ENGINEERING_ENABLED` defaults to off
and fails closed (no submission, no claim). Because the slot does not cover
agent-flow, a remote runtime able to start an agent must be switched on
explicitly, and not as a side effect of installing it. This changes the default
for existing development setups, which now set it.

**A persisted attempt budget.** A claimed attempt (claim to a pause or terminal
state, not owner, approval or dependency waits) has a deadline stored on the job
(default 60 minutes via `DUCKY_ENGINEERING_ATTEMPT_MINUTES`, capped at the
existing two hour ceiling). A reclaim after lease expiry keeps the same deadline,
so a restart cannot reset it. The claim carries it as an optional field; a new
executor facing a claim without it applies a bounded local default. The claim and
failure schemas are strict, so this is NOT bidirectional rolling compatibility:
upgrade by stopping the coordinator and executor together, with engineering off. The executor
times itself out through the supervised cancellation path. The coordinator
requests ordinary cancellation after a grace period as a backstop.

**An honest timeout.** On timeout the executor asks `orchestrator.cancel`, which
only observes the agent through Herdr `agent get`. An idle, done or absent agent
is reported as `wall_clock_exceeded` with `quiescent`, and releases the
repository and slot. Anything else becomes an orphan that keeps both. The
recorded adapter has no supported way to interrupt a working agent and sending
keystrokes into a live pane is deliberately not done, so a working agent that
outlives its budget is an orphan, never a fabricated stop.

**Memory headroom, fail closed.** With `DUCKY_MEMORY_GUARD=cgroup` the executor
refuses to claim unless the lower of `memory.max` and `memory.high` minus
`memory.current` of the user slice covers an engineering reserve plus a
notification reserve. Unreadable, non-numeric or unlimited readings refuse. The
reserves are operator estimates. The guard reads the slice that contains Herdr's
agents, which no Ducky unit's own limit bounds.

**No friend-facing model by default.** `DUCKY_ADDITIONAL_USER_AI_ENABLED`
(default off) is frozen into the Authorizer. `Authorizer.mayConverse` is the one
question every model-reaching path asks, including Branch and Compact, native
thread entry and reply anchors. The whitelist names who may be offered chat
later and authorizes nothing. Owner-only commands and the narrow shared reads
are unchanged.

**Subscription-only environment guard, labelled partial.** The coordinator and
executor refuse to start when any billed API key name is set in their own
environment. It reads names and never displays or logs a value. It cannot see
the provider's private configuration or the Herdr server's environment, so it
does not establish that the provider is on a subscription and no quota is
claimed. Those places are checked by hand in the runbook.

**Private listener.** The coordinator routes and the phone page share one Fastify
listener. It binds loopback; tailnet-only `tailscale serve` is the way in, and
Funnel is never used.

## Alternatives considered

- **Raise the per-repo cap with a counter.** Rejected: the cap of one is
  structural (the key is pinned), not a predicate to get right.
- **Release the slot when a lease expires.** Rejected: a silent executor is not
  evidence its agent stopped.
- **Kill the agent on timeout.** Rejected: no stop is recorded as safe; this needs
  an authorized real-agent stop probe.
- **Write agent-flow's state to coordinate.** Rejected: not a supported protocol,
  and not ours to change.
- **A provider quota state and counters.** Not built: no real quota or sign-in
  response is recorded to design against.

## Consequences

One engineering job at a time per Ducky database, with an uncertain stop holding
everything until an owner decides. The cost is availability: an orphan blocks all
engineering, not one repository.

**Open blockers (acceptance and merge):** cross-program admission with agent-flow;
an authorized stop probe for a working agent and with it owned-descendant
termination; the idle or no-result pause that must not consume retry budget (a
turn that ends idle without a result is still an ordinary `no_result` failure);
a recorded supported subscription route and quota on this host; Herdr session
pinning; live Discord, Tailscale and logout checks.

## Follow-up

When the dispatcher owner provides an atomic shared admission protocol, replace
the local table's authority with it rather than adding a second slot.
