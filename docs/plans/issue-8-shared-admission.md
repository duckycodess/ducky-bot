# Issue 8: shared engineering admission source unit

Manager plan, resume ca06b2212d, 2026-10-25. Starting head 6cce2b9754cabaed89194c50ba2921ead4c11a32 on preserved codex/issue-8 / draft PR 15. Fetched and live integration main 0a58ef01fe34ad60b91180d6e32fc6aae3b0925f is already included. Preserve history; use a normal merge only if a newer base is needed.

## Authority and bounded deliverable

The direct owner update of 2026-10-25 waives independent planning and final reviews for issues 8 and 9. Earlier review mandates in the historical plan are superseded for this pass only. No reviewer will be launched; exact-head independent review will be recorded as unverified and required_for_merge=false, never passed. JG native Claude Team Sonnet 5.5/high is the sole implementation writer. Pi manager is Codex 6.1 Sol/high. Ordinary verification, security checks and all operational acceptance remain required.

Implement the missing shared-admission SOURCE capability, not another runtime or ticket pipeline. Prepare Ducky integration and a matching private Agent Flow candidate adapter outside the installed runtime. Read-only inspection of relevant installed dispatcher code is authorized by this task; do not copy private source into the public repository. No installation, live registration, dispatcher/profile mutation, Ducky activation, real-agent probe, deployment, other-repository/process changes, cutover or merge.

## Chosen conservative policy

- Preserve operator Agent Flow global maximum 2 and repository maximum 1.
- A Ducky runtime job is exclusive across participating programs: admit Ducky only into an empty ledger; while Ducky holds a reservation, admit neither another profile nor Agent Flow. Thus Ducky's unwaived runtime singleton is not silently widened to two. Two Agent Flow jobs on distinct repositories remain possible when Ducky is absent. No change to live operator configuration.
- Canonical lower-case GitHub owner/repository is the cross-program repository key, not a profile-local slug or path.
- Memory defaults are conservative configurable estimates, not a new owner decision or measured footprint. Reserve engineering plus provider cost per entry and retain notification headroom globally. Use the authorized account envelope 16 GiB max / 14 GiB high, swap zero as a bound, not an instruction to modify it. Apply lower observed ceilings. Missing, unsafe, stale or malformed observations refuse admission.

## Protocol and invariants

1. A versioned host-local shared SQLite ledger, separate from either coordinator database and Agent Flow state. Private directory/file ownership and permissions, no symlink/temp roots, FULL synchronous persistence, bounded busy timeout, BEGIN IMMEDIATE for admission. Runtime opens an existing initialized ledger; missing/corrupt/replaced/mismatched ledger never silently initializes a second authority. Pin ledger identity and policy across participants. Do not store credentials or personal task content.
2. Full holder identity includes program, durable instance/profile identity, job reference, canonical repository, resource reservation and monotonically increasing fencing generation bound to ledger identity. Enforce count/repository/Ducky exclusivity and resource bounds atomically. Repeated same-identity acquisitions are idempotent; changed resources/identity cannot adopt a hold. A missing prior fence after restart/restore is a stop, not permission to acquire anew over possible live work.
3. If pending/confirm is used, confirmation MUST commit before any process/workspace/agent launch. Only never-confirmed pending holds may time out. Confirmed holds never expire from elapsed time, lease expiry, missing PID, dead manager or absent local record. Silence is not quiescence. Unknown restore/crash state remains held for explicit recovery.
4. Read actual shared account memory under the admission lock and require available bytes to cover every outstanding reservation plus the proposed one and notification reserve. Conservative double counting of observed usage and held reservations is acceptable and disclosed; subtracting assumed attributed memory is not. Retain actual-agent/every-ancestor prompt guards. Reservations are admission accounting, not kernel enforcement or continuous memory protection; tasks/PID ceilings remain separately unverified.
5. Release requires the exact ledger/fence/holder and the existing positive quiet/owned-cleanup permission. Wrong-job/profile/program/fence/replayed release must not free another generation. No release by repo alone. No TTL or restart-based release of active or unconfirmed work. Bound replay/tombstone storage without weakening stale-fence refusal.

## Ducky composition and crash order

- Integrate before the coordinator returns or replays a claim, not just after an executor has consumed an attempt. Contention leaves jobs queued and accounting/deadlines unchanged. Restrict configured shared-mode claims to proven configured co-located executors; never pretend a coordinator host ledger protects a remote host.
- Acquire/confirm shared ownership before committing a new local claim. Persist its exact identity in the local slot. On any uncertain rollback, err toward an extra held reservation; never compensate by releasing a pre-existing live fence. A crash may leak a hold but cannot create capacity.
- Existing quiet/terminal/cleanup release paths enqueue the exact shared release in the same local transaction that releases the local slot. Drain only after local commit and retry after restart. Crash after local release but before shared release leaves conservative capacity held. A delayed outbox release cannot free a newly acquired generation, including the same job resumed before delivery.
- Check every release path, including paused jobs, lease-free durable quiet settlement, cancellation, deadlines, orphans, owner cleanup, queued wrong-job cancellation, duplicate results and deferred delivery. Unconfirmed ownership remains held. Keep outbox/mapping state out of retention and include schema/backup verification where required.
- Durable local instance/ledger pins survive restarts and are checked before claim/replay. Cached claim responses do not bypass disabled/shared-identity gates. Missing fence/ledger, mismatched restoration or pending releases must fail closed rather than manufacture successful reconciliation.
- Engineering remains default off. Runtime composition must additionally require explicit shared integration eligibility, default off; a participant registration row or candidate existence is NOT actual installed integration proof. Do not enable this gate here. Isolated unit fixtures may inject ports, but production must not silently fall back to local-only admission.

## Private companion

Sole implementer may inspect relevant private dispatcher source read-only and prepare an original companion adapter plus integration candidate/instructions in a new private issue-specific candidate directory. Do not apply them to live code or touch live databases. Cover every supported launch/recovery path or explicitly gate unsupported paths closed. Confirm before launching any managed writer, persist exact fence before dispatch, retain uncertain workspace/worker holds, release only after proven owned completion. Candidate registration is a source test, not runtime eligibility. Report private paths and hashes only; never publish private source. Exercise Python/Node interoperation and races against scratch ledgers only.

## Verification and commits

Implement meaningful batches: shared protocol/core and cross-process tests, then Ducky lifecycle/config/migration/outbox integration with private companion parity. Do not fabricate a split. Run narrow regressions first: simultaneous processes/profiles/programs/repositories, global2/perrepo1 and exclusive Ducky, actual resource ceiling/ancestor refusal and conservative reservations, expiry/restart/kill of fixture processes (never real agents), replay/wrong-job/wrong-fence release, acquire/confirm/local-commit and release-outbox crash windows, restore/ledger drift, owner cleanup, lease expiry and durable pause accounting. Use local temporary child fixtures only through existing subprocess conventions.

Then run lint, typecheck, default full tests, build, diff checks and scratch backup/verify for the resulting schema. No HOME override or hidden baseline failures. Fresh real checksum-verified Gitleaks must scan the final committed tree and history, including merge diffs; adjudicate raw findings explicitly with no suppression or zero-finding claim when raw exit is nonzero. Manager checks final diff and exact pushed head; independent review remains owner-waived/unverified. Audit commit messages, ordinary push, update existing draft PR 15 and Bead in_progress. Record source evidence separately from actual runtime.

All prior fourteen required runtime/closure gate groups remain merge blockers until truly proved. This source unit can narrow the admission implementation gap, never waive integration, owned stop/recovery, provider eligibility/quota/no-billed-API, dedicated Ducky session, safe periodic cleanup/active-temp, notifications during quota pause, private Tailscale/phone, restart/logout/disconnect, development paths/private parity/real backup/rollback/cutover/retirement or full acceptance before Closes #8. Keep ready_to_merge=false and dispatcher must withhold merge.


## Implementation notes (JG, 2026-10-25)

Source delivered in the commits after 6cce2b9: the ledger and operator CLI
(`packages/persistence/src/shared-admission/`, `scripts/shared-admission.ts`), then
Ducky's claim/slot/outbox/gate/config integration and migration 30, then the private
companion's parity and these documents. Decisions: [ADR 0031](../decisions/0031-shared-engineering-admission.md).

Adaptations where the source proved a dependency, all conservative:

- **Acquire/confirm sit inside the claim transaction, before COMMIT,** after the
  early returns and before any accounting changes, rather than in a separate step
  before the transaction, because the claim's chosen job, its deferred lease expiry
  and its exhaustion branch are decided inside it. Confirm still precedes the
  returned or cached response and any launch.
- **Policy cap is structural at 2** (schema CHECK 1..2, `init` and every open
  validate), per the manager's correction; a ledger can never admit more than the
  authorized maximum.
- **A prior fence with no hold behind it is refused** (`resume_fence_missing`)
  instead of allocating, and an adopted hold still requires a valid, sufficient
  memory reading. The prompt-time actual-agent and ancestor guards are in the
  executor and are untouched by a reclaim, replay or adoption.
- **`drain` is enforced to run only outside a transaction,** the cached claim is
  checked against the current lease/executor/job/fence, and stuck release debt is
  detected over the whole outbox, per the manager's three checks.
- **Ledger identity and policy are pinned from configuration AND in the database
  (`shared_admission_binding`, immutable by trigger).** There is no re-pin command;
  a changed ledger is a stop, and the way out is a person.
- **The Agent Flow candidate** lives in
  `/home/profile2/.local/share/agent-flow/operator-reviews/ducky-shared-admission-ca06/candidate`
  (not installed, not committed here). It gates the dispatcher's single launch path
  (its recover and resume commands only mark a job ready), a launch marker written before the first
  managed-writer side effect, release only on a proven-closed workspace or a hold that
  never reached the marker, and a stop on any ledger drift. Installing it would stop
  Agent Flow launching until a ledger and pins exist, by design.

Required and NOT done: installing the companion; creating the live ledger and pins;
setting eligibility; a controlled second admission refused on the host; source/target
parity of the candidate with the installed dispatcher beyond the baseline hash
recorded in the candidate; cgroup membership of a real agent; the other thirteen
blocker groups. Independent review was waived by the owner and is unverified, not
passed. `ready_to_merge` stays false.
