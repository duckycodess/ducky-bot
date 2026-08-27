# 0010. Per-repository reservations as the single-writer boundary

**Status:** Accepted

## Context

Exactly one implementation writer may touch a repository at a time. An earlier
design used `state = 'running'` as the claim predicate, which has a hole: a job
paused in `needs_owner_input` or `needs_approval` is not running, yet still owns
a workspace with uncommitted changes. A second job could claim the repository
and start a writer beside it.

## Decision

A `repo_reservations` row, primary-keyed on `repo_slug`, held for the **entire
nonterminal lifetime** of a job. The reservation — not the job state — is the
claim predicate.

The claim query allows a job whose repository has no reservation **or** whose
reservation is its own, which is what lets an answered job resume while still
excluding every other job. A guarded upsert can only ever extend a reservation
the job already owns, so a concurrent claim by another job changes nothing and
that transaction aborts.

Four guards with deliberately different spans: the reservation (whole job), the
lease (one executor turn), a filesystem lock (one Pi turn), and Herdr's unique
agent names (per host).

The filesystem lock is released **before** `needs_owner_input` is reported,
which is what makes that state quiescent and therefore safe to cancel
immediately.

## Alternatives considered

- **`state = 'running'` as the predicate.** The hole above.
- **The partial unique index alone.** It cannot express "reserved while
  paused". It is kept as a secondary invariant.
- **An advisory lock only on the executor.** Nothing would stop the coordinator
  handing the same repository to a second executor.

## Consequences

Two jobs can never write to one repository, structurally rather than by
predicate. The cost is that a paused job blocks its repository for up to its
TTL; the owner sees the blocker in `/jobs` and can cancel it, and every expiry
has an explicit, atomic outcome. An orphaned agent converts the reservation to a
non-expiring one that only `/job cleanup` clears — availability traded for the
guarantee, on purpose.
