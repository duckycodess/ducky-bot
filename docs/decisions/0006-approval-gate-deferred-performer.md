# 0006. Per-action approvals with a deferred performer

**Status:** Accepted

## Context

Jobs propose consequential actions: commits, pushes, pull requests, deployments,
cloud mutations. Repository content reaching the model is untrusted, so prompt
injection is assumed possible.

## Decision

Each proposed action becomes **one approval row**, decided individually and
exactly once. There is no bulk-approve control in the UI or the service API.

In Phase 1 an approved action is **recorded and not performed**:
`DeferredActionPerformer.perform()` throws, no GitHub writer exists anywhere,
and the read-only `gh` adapter uses a frozen argv table containing no write verb
— asserted by a test.

The job leaves `needs_approval` only once nothing is pending. The approval
*decision* path never yields `cancelled`; only an explicit owner cancellation
does, because a rejected action does not undo work that already happened.

## Alternatives considered

- **One approval for the whole result.** Forces all-or-nothing on a mixed set.
- **An "approve everything" flag.** The single most likely way for this system
  to do something unattended and irreversible.
- **Filtering prompt injection instead.** Not reliably possible. A human
  decision is the control.

## Consequences

Nothing consequential can happen without a deliberate, per-action human
decision. Phase 1 is safe to run against real repositories because the
performer is inert. Enabling execution later is a contained change: implement
the performer, keeping the gate exactly as it is.
