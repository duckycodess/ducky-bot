# 0031. Shared engineering admission: one host-local ledger for Ducky and Agent Flow

**Status:** Accepted as SOURCE, with the integration NOT installed and NOT proved. Engineering stays off. Refines [0030](0030-remote-linux-runtime-and-ducky-local-admission.md); does not clear any merge blocker by itself.

## Context

ADR 0030 gave Ducky one engineering slot in one coordinator database and said
plainly that it did not deliver the issue's cross-program single job: the
development and production databases share no state, and the Agent Flow
dispatcher exposes only its own internal worker slots and a singleton lock.
Turning engineering on therefore meant two programs could each start an agent
against the one shared account.

The operator's Agent Flow limits are a global maximum of 2 and a per-repository
maximum of 1. Ducky's runtime is a singleton. Both have to hold at once.

## Decision

**One host-local ledger that every participant passes through.** A separate,
versioned SQLite file (rollback journal, `synchronous = FULL`, `BEGIN IMMEDIATE`,
a bounded busy timeout) that neither coordinator database nor Agent Flow's state
owns. SQLite's own file locks make admission atomic across processes and programs
and are released when a process dies, so a crashed holder cannot wedge the lock;
it can only leave a *hold*. Nothing writes Agent Flow's state: the companion is a
separate adapter, and Ducky only ever opens an existing ledger.

**The policy, as chosen** (the numbers are conservative estimates, not measurements
and not a new owner decision; they are written once at `init` and immutable):

- Agent Flow keeps global 2 and per repository 1 when Ducky is absent.
- A Ducky hold is **exclusive across all participants**: admitted only into an
  EMPTY ledger, and while it exists neither the other Ducky profile nor Agent Flow
  is admitted. Ducky's unwaived runtime singleton is therefore not silently widened.
- The repository key is the canonical lower-case GitHub `owner/name`, never a
  profile-local slug or a path.
- Memory: each hold reserves a conservative estimate (Ducky: the engineering plus
  the provider estimate, 2048 + 512 MiB by default; Agent Flow: its own configured
  per-mode estimate). A global notification reserve (512 MiB) is kept.
  `available = min(observed memory.max, memory.high, the 14 GiB ceiling) -
  memory.current`, read while the lock is held, and it must cover every outstanding
  reservation PLUS the proposed one PLUS the notification reserve. Observed use is
  deliberately double counted against the reservations; nothing assumes which
  process owns which bytes. Any unreadable, non-numeric or unlimited reading
  refuses. The 16 GiB `MemoryMax` and 14 GiB `MemoryHigh` are a bound, not an
  instruction to change them.

**Structural, not only procedural.** The invariants are in the schema, so a
participant with a bug is still constrained: `UNIQUE(repo_key)`, a trigger for the
global cap (the CHECK on the cap is 1..2, so a ledger can never admit more than the
authorized maximum), a trigger for Ducky exclusivity in both directions, and a
trigger for the reservation budget. A hold's identity is fixed at insert and its
state only moves `pending -> confirmed`; policy and identity are immutable (a
change is a NEW ledger). `init` validates every policy field as an exact integer in
range, and so does every open.

**Fences.** Each hold gets a monotonically increasing fence that is never reused.
A release must carry the exact ledger, fence and holder; a replay, a wrong holder
or an old generation changes nothing. "Issued but no longer present" is provable
from the sequence alone, so no tombstone table is needed and the replay record
cannot grow. A name never adopts an existing hold: the caller must present its
fence, and a fence with NO hold behind it (released, reaped, never issued, a ledger
that lost it) is `resume_fence_missing` -- a stop, never an answer with a fresh
hold over work that may still be running. Adopting still needs a valid, sufficient
memory reading and adds no reservation.

**Confirm before launch; only a never-confirmed hold times out.** `acquire` leaves
a `pending` hold, `confirm` makes it real, and every caller confirms BEFORE it
launches anything. A pending hold past its TTL is gone, which is safe only because
nothing launched. A confirmed hold NEVER expires: not by time, a missing PID, a
dead manager, an expired lease or an absent local record. Silence is not
quiescence.

**Pins.** A runtime pins the ledger identity and policy digest from its own
configuration; a missing, replaced, restored or re-policied ledger is refused and
never initialised. The ledger path must be absolute, symlink-free, owned by this
user, mode 0700/0600, a single link, and outside `/tmp`, `/var/tmp`, `/dev/shm`,
`/run`, `TMPDIR` and `XDG_RUNTIME_DIR`.

### Ducky's composition (migration 30)

The rule: **the shared hold is taken BEFORE the local one and given back AFTER it**,
so the ledger holds at least what the database holds at every instant. A crash can
leak a hold; it cannot create capacity.

- `claim` runs the gate, then delivers owed releases, then (inside the claim
  transaction, after the early returns and BEFORE any accounting changes) acquires
  and confirms the hold. A refused acquisition leaves the job queued with its
  attempts, deadline and deferred lease expiry exactly as they were. The fence is
  recorded in the local slot (`engineering_admission.shared_ledger_id/shared_fence`)
  in the same transaction as the claim.
- A failed local half gives back only a fence THIS call minted, only outside a
  transaction and only when the local slot does not stand on it. An adopted fence
  is never touched; any doubt leaves an extra held reservation.
- Every release path (`releaseAdmission`) deletes the local slot and writes the
  exact shared release to `shared_release_outbox` in one transaction. Delivery
  (`SharedAdmissionService.drain`) happens only after a commit -- it refuses while a
  transaction is open -- by exact fence, oldest first, bounded, and is retried every
  tick, at startup and before each claim. A delayed delivery can only name the
  generation released locally; a job resumed before delivery finds its identity
  still held and is refused until the old generation is delivered, then takes a NEW
  fence.
- A cached claim response is served only while it is still exactly the current one:
  the same job, running, under the same lease, for the same executor, standing on a
  fence the ledger confirms. After a pause, resume, expiry or a newer claim it is
  obsolete and cannot launch work.
- Engineering is stopped, with a plain reason, whenever the ledger is missing,
  replaced or re-policied; the database pin differs; the local slot's fence is not
  confirmed (a restored database, a lost ledger); a local slot has no fence; a
  surviving hold exists after the local slot was lost; any owed release is stuck
  (checked over the WHOLE outbox: another ledger, a refusal, or 100 failed
  attempts). Nothing re-pins, adopts or re-acquires over possibly live work.
- Shared-mode claims go only to executor ids listed as co-located. A ledger on the
  coordinator's host protects only that host.
- The memory guards in the executor are unchanged and independent: the actual-agent
  and every-ancestor check before every prompt, and the account check before a claim.
  A reclaim, a replay or an adoption does not alter them; the claim path never
  reaches the prompt.

### Eligibility is a second, explicit switch

`DUCKY_ENGINEERING_ENABLED` is not enough. Engineering runs only when
`DUCKY_SHARED_ADMISSION_ELIGIBLE` is ALSO set (default off), with the ledger path,
the identity and policy pins and the co-located executor ids; eligibility on with
anything missing refuses to boot. Enabled-alone is held off and logged, never
quietly run on the local slot. A participant row, a ledger file or a candidate
patch existing is NOT that proof and never turns it on. The only way to run the
local slot alone is a test-only fixture flag, and a source scan asserts no
production file sets it.

## What is source and what is not

Source, unit- and process-tested against scratch ledgers: the ledger, Ducky's
claim, slot, outbox, gate and config, the operator CLI (`pnpm shared-admission
init|inspect|release`), the backup verifier's schema-30 checks, and a private Agent
Flow companion candidate (a Python protocol client, an unapplied integration patch
and cross-language tests) that is NOT part of this repository.

NOT done, and each remains required: installing the companion into the live
dispatcher; creating the live ledger and setting the pins; a controlled second
admission attempt on the host that is refused; observing the cgroup membership of a
real agent; the other thirteen blocker groups in ADR 0030.

## Alternatives considered

- **Attach the ledger to the coordinator connection for one atomic commit.**
  Rejected: atomic multi-database commit needs the rollback journal on the main
  database, which is WAL here; and Agent Flow could not join it.
- **A flock file.** Rejected: Node has no `flock`, a lock file does not hold the
  state, and SQLite already gives crash-released, cross-language atomicity.
- **Write Agent Flow's state database.** Rejected, as in 0030: not a supported
  protocol and not ours to change.
- **Subtract memory assumed to belong to a holder.** Rejected: unprovable
  attribution. Double counting is the conservative error.
- **TTL or PID-based release of a confirmed hold.** Rejected: silence is not
  quiescence.

## Consequences

Contention costs availability, by design. A leaked hold (a crash between confirm and
the local commit, a lost local database, a worker whose workspace never proved
closed) blocks the other program until `pnpm shared-admission release` is run with
the exact holder and an explicit attestation that no worker is running. After
upgrading, an existing setup that set only `DUCKY_ENGINEERING_ENABLED` stops claiming
until the second switch is deliberately set.

**Residual limits, not waived:** reservations are admission accounting, not kernel
enforcement or continuous protection; tasks and PID ceilings are not covered; the
companion is a candidate and its source/target parity with the installed dispatcher
is unverified; a crash after a confirm and before the local commit leaves a hold
nothing auto-clears; a database restored to before a claim finds the surviving hold
and stops, which is correct and needs an owner; and none of this has been observed
with a real Ducky agent or a live dispatcher.
