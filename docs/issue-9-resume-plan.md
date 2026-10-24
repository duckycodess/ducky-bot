# Issue 9 resumed implementation plan

Run: agent-flow a497333429, continuing 566d08edde and 8c7fb474fd. Existing branch `codex/issue-9`, draft PR #16.

## Authority and preserved gates

The owner's 2026-10-14 approval permits narrowly typed GET-only GitHub reads through the existing `runArgv`/gh policy boundary. Full owner-scoped parity remains required. No private source, records, exact selections, configuration, credentials or personal preferences may enter this public repository. Derive behavior independently from the private language-independent audit; public fixtures are synthetic. No deployment, production changes, source stop/removal, merge, force-push or history rewrite occurs in this run.

Prior BLOCKER/IMPORTANT and operational blockers remain required until individually proven cleared. Refusal protects data but is not parity. Issue #8 runtime eligibility remains an independent prerequisite for live operation. This plan continues, rather than replaces, the existing OpenSpec migration design and ADR.

## Sequence

1. Recheck the actual integration ref and PR base; preserve history. At resume, live GitHub `refs/heads/main` and `origin/main` are `0a58ef01fe34ad60b91180d6e32fc6aae3b0925f`, already an ancestor of the issue head `568d9f7fbc7cf20808182e55f3bb74f5b6d15f32`. No incoming CI fix exists at this point. Recheck before publication; if a necessary base fix arrives, use a normal merge, resolve conflicts and rerun gates.
2. Obtain one independent read-only plan review. Sonnet 5.5/high implementer is the sole code writer; Opus 5.5/high reviewer uses a separate approved claude.ai subscription profile. Preserve and reuse role sessions. Account/model limits block work rather than permit fallback billing or account switching.
3. Implement the owner-approved real notification-watch reader with exact endpoint/query/argv validation, pinned runtime response schemas, metadata/default branch, explicitly authorized discovery, releases, pull/issue closing times, reviews and bounded resumable workflow/notification pagination. Charge every request to the existing 20-call tick and 2,400-call rolling-hour budget; retain the 1,000-target cap. Partial, malformed, inaccessible or incomplete observations cannot advance settled checkpoints. No arbitrary HTTP/API/write path or engineering permission expansion. Update AGENTS, gh policy docs and ADR with the precise new read shapes and negative regression tests.
4. Close remaining accepted public behavior gaps against the private semantic audit: urgent/category preservation; optional non-authoritative AI wording through an existing approved subscription provider with deterministic fallback; existing meal behavior without copying unlicensed catalogs; paused global monitoring; requested-changes areas where owner-approved read surfaces suffice (otherwise record a specific approval/capability blocker); source-compatible morning staleness; owner-only schedule-batch rollback; discovery/poll-cycle eligibility semantics; ordinary-watch overlap suppression without losing unrelated events; late equal-time review identity reconciliation; runs/releases paging. Avoid speculative interfaces and maintain existing owner/privacy/profile/transport boundaries. Unknown private semantics remain explicit blockers, not invented behavior.
5. Add a private offline read-only rollback-delta export through existing persistence boundaries, with explicit baseline/identity/version/deletion/checkpoint semantics and coverage for Ducky-native additions, edits/completions/snoozes, delivery state and watch/briefing deltas. Use private paths/modes, consistent snapshots/runtime locking and counts-only diagnostics. Synthetic replay tests establish export completeness/idempotence; they do not prove a source reverse bridge or authorize restoring stale data. A private source bridge must remain independently rehearsed before cutover.
6. Verify focused regressions for all changed seams, then deterministic formatting if available, lint, typecheck, full tests, build, diff check, migration compatibility and existing strict OpenSpec validation. Commit meaningful batches with verification and rationale, without co-author trailers. Run a fresh real secret scanner against the public branch/history; no placeholder scan or unrelated base-fix assumption. Inspect findings privately and publish counts/status only.
7. Have the independent reviewer inspect the complete final diff against the current integration base and all issue requirements. BLOCKER/IMPORTANT findings require corrections and scoped re-review. Push normally, verify remote SHA, then obtain explicit approval for that exact pushed head. Any later change invalidates exact-head checks/review.
8. Update the existing draft PR and issue with honest checks and the per-blocker disposition. Keep `Closes #9`, Bead in_progress and `ready_to_merge=false` unless every required gate passes. Atomically publish the dispatcher JSON with exact pushed head, fresh scanner evidence and `independent-review-exact-head`.

## Independent plan review amendments

The independent reviewer conditionally approved the direction with seven IMPORTANT amendments. These are implementation requirements, not waivers:

1. Exact new argv is `gh api --method GET <canonical-relative-endpoint>` only. Pin builders/parser grammar and runtime schemas for `repos/{owner}/{repo}`, `repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=10&page={page}`, `repos/{owner}/{repo}/pulls/{number}/reviews?per_page=10&page={page}`, `repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&per_page=10&page={page}`, `repos/{owner}/{repo}/actions/runs?branch={encoded-branch}&per_page=10&page={page}`, `repos/{owner}/{repo}/releases?per_page=10&page={page}`, and `user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page={page}` (discovery at most five pages, explicit incompleteness if more exist). Keep the existing branch-commits builder. Validate repository/branch/page/number components, reject alternate order/extra query keys and all extra CLI flags, including implicit POST fields, unbounded paginate, input, headers, hostname, jq/template, cache and include. Review page/body bounds and subprocess output buffer are explicit. Verify full_name against requested identity; transfers/renames block rather than silently retarget.
   “Notification results” means the typed event surfaces above, NOT a new `/notifications` endpoint. No unrelated notification enumeration. Discovery scope is explicitly enabled and identity-pinned by frozen profile configuration; audited imported selection/eligibility metadata is non-authoritative runtime data, never engineering authorization. Do not enable live discovery in this run. Discovered targets count toward the 1,000 cap; overflow/incomplete discovery is a blocker, never truncation or cancellation. Preserve cancelled/tombstoned targets, owner mute/monitored state and untouched `repos`/`github_watches`.
2. Page completeness cannot be inferred from the event timestamp when the API sorts on another key. Runs sort by creation while events may update later; release creation order differs from publication. Use bounded full-window scans or an independently justified reconciliation scheme and keep unprovable completeness a blocker. Issues' `hasMore` uses raw page cardinality before filtering pull requests. Full pages mean possibly more. Detect/reconcile page drift with held checkpoint windows; test insertion, update/movement and deletion between reads, including close-then-update events. Never mark settled on an unproven unstable snapshot, provider truncation or window exhaustion. Count `window_exceeded` in private content-free evidence. Maintain source strict boundary provenance and identity-based equal-time processing for locally known boundaries.
3. Every resumable unit's worst-case cost is at most 20 calls. Review/discovery/run/release pages must be separate budgeted units rather than hidden pagination inside one method. Test each unit bound, oldest-unit progress and restart/retry behavior. Charge every subprocess/API request, including failures. 403/429/auth errors require explicit failure/backoff with no checkpoint advance; do not treat an empty error response as observation.
4. Privately compare source cycle eligibility/latency with bounded target coverage. At 1,000 targets even six calls each consumes at least 6,000 calls, or 2.5 hours of the rolling budget before reviews/pages. Preserve the source recency-limited cycle semantics where audited, not an unapproved sweep or omission. If quotas/budgets cannot satisfy accepted timing, keep a named required blocker, never raise budgets or silently reduce selection.
5. Rollback export is CLI-only, owner-scoped and holds the shared runtime lock or reads a separately verified consistent backup snapshot. It includes native and imported records, schedule rules/exceptions/batch state, preferences, cancelled/discovered watches, all cancelled reminders, delivered occurrences, briefing slots and watch progress/events. Specify baseline identity/version and reverse-bridge replay semantics. Identity-only deletion tombstones cannot distinguish retention-after-completion from Forget or reconstruct lost content. Add a content-free cause/state where sufficient, or fail closed and require export before pruning; never pretend already lost history is reconstructible. Do not defeat Forget by adding a content-bearing deletion audit. A source reverse bridge remains unproven until privately rehearsed.
6. Optional AI wording uses only the existing OpenClaw provider/mode if opted into by frozen profile config and eligible; otherwise retain an explicit capability/live-evidence blocker with deterministic fallback. Never send DM-only captures/digest into a channel wording generation/reuse path. Limit generation to non-authoritative prose; validate that deterministic item identities/counts/states remain unchanged and fall back on timeout/error/changed or omitted items. Transport sanitation remains mandatory. Never create a billed fallback. Do not copy a private catalog or assert parity from mechanical meal support alone.
7. New reader shapes require a read-only live probe with explicit selection and no disclosure of provider bodies/private identity, non-zero on missing/incomplete evidence, no writes or notifications. Probe each approved shape on an owner-approved public repository and separately gate discovery authorization; synthetic schemas are not live certification. Real reader completeness/latency and runtime eligibility remain required operational checks until proven.

No owner-only command manifest expansion is authorized: use existing owner-scoped service/control boundaries for schedule rollback, or report the missing control as a blocker. “Areas mentioned” may use the approved review body; separate file/review-comment endpoints are not approved and must not be added implicitly. The manager observed both role startup panes reporting Claude Team with the exact pinned model/high-effort flags; a role's inability to introspect its own billing is not substituted for that evidence.

## 2026-10-19 continuation plan

The manager rechecked live `main` and the PR branch: `main` remains
`0a58ef01fe34ad60b91180d6e32fc6aae3b0925f`, already an ancestor of the
preserved pushed issue head `de0746dd0c4d9117a4ab5d22de8a93f89dbd0166`.
No incoming CI fix currently requires a merge. Recheck before publication and
use a normal merge if a necessary fix arrives; never rewrite existing history.

This continuation targets two concrete public implementation blockers, without
claiming that they exhaust full parity:

1. Expose the imported notification-only global monitoring switch through the
   existing owner-only `/watch` boundary. Preserve ordinary engineering watches,
   frozen authorization, target selection, checkpoints, pending events and budgets.
   Make setting the same state idempotent; neither resume nor replay may reset or
   baseline observation state. Keep replies private and audit state changes without
   record contents. Do not enable discovery or change any live runtime setting.
2. Expose the existing recurring schedule-batch rollback through the existing
   owner-only `/schedule` boundary, preserving its current text/file preview flow.
   Require explicit, stale-safe confirmation of the selected batch transition;
   replay must not toggle the schedule a second time. Reject ambiguous ordering,
   preserve indefinite rules and exceptions, and atomically audit successful
   changes by counts only. Use additive persistence if the existing closed audit
   event set cannot represent this without rebuilding a parent table. Do not
   expand the owner command/interaction manifests or introduce a second write path.
3. Obtain one independent plan review before implementation. The prescribed
   Sonnet 5.5/high subscription session is the sole implementer; the separate
   Opus 5.5/high session is read-only. Incorporate required review conditions.
   Verify owner/non-owner routing, shared-channel privacy, replay/staleness,
   rollback atomicity and repeated-import behavior with synthetic regressions.
   Update the existing ADR, current-state and migration/runbook contracts honestly.
4. Commit meaningful implementation batches, run focused tests then deterministic
   lint/typecheck, full tests, build, diff and existing strict OpenSpec checks.
   Run a fresh real scanner on final history and tree; audit any exact synthetic
   fixture finding rather than hide a rule/path. Recheck base, push normally and
   obtain independent approval of the exact pushed head and complete final diff.
5. Keep the draft PR, Bead in_progress and `ready_to_merge=false` while any prior
   parity, runtime or operational gate remains. Controls implemented and tested
   synthetically are not live Discord/control certification. In particular the
   reader completeness/timing, AI/meals/areas, private reverse bridge, runtime
   eligibility and every gate below remain required, not waived by this scope.

### Independent continuation-plan conditions

The separate reviewer approved the direction conditionally, with these required
implementation amendments. This records the source/ADR contradiction explicitly:
`audit_log.event` is unconstrained text in the actual migration; only its subject
kind is constrained. ADR 0032's assertion that new audit events require a table
rebuild is incorrect and must be corrected, not implemented around.

- Preserve `/schedule text/file`; add an optional rollback preview/confirmation
  string, not subcommands or repurposed signed button kinds. Refuse mixed inputs.
  Confirmation binds all active batch keys/counts and the selected target/order,
  recomputed inside the transaction. Stale and replayed confirmations cannot flip
  again. A fresh deliberate second rollback follows the existing service behavior;
  its private source-semantic parity remains a required evidence gate.
- Audit successful transitions with new typed event names using an error-propagating
  write inside the same transaction and injected time. Fixed owner actor identity,
  NULL or fixed config subject, counts/state only. Audit failure rolls state back.
- Owner monitoring choices win over unchanged repeated imports, which must report
  drift instead of silently undoing a native change. The same applies to schedule
  active-state changes. Both transitions must appear in rollback exports.
- Monitoring takes explicit on/off state. A no-op creates no settings row, changes
  no timestamp and produces no spurious delta or transition audit. Resume preserves
  checkpoints, pending state and rate-limit backoff. A pause during a running tick
  applies at the next tick, and this must be tested/documented.
- Resume must not silently replay native notifications delivered while paused.
  If exact cross-path reconciliation cannot be proven in this continuation, refuse
  resume when an active ordinary watch overlaps rather than reset a checkpoint or
  introduce duplicates. Such refusal remains a named full-parity blocker, not an
  approved omission or completed resume acceptance criterion.
- Owner-only gates precede services; shared and GitHub-role responses stay private;
  manifests remain unchanged. Public codes/replies contain no schedule labels,
  course codes or repository selections. Command registration is not performed by
  this dispatcher and remains part of real operational control certification.

## Run a497333429: bounded unsettled-observation continuation

At resume, the preserved pushed head is
`f62407b42c49900b488f22a0808d0b3352f44e0d`. Live integration `main` remains
`0a58ef01fe34ad60b91180d6e32fc6aae3b0925f`, already an ancestor; no incoming
CI fix currently requires a merge. Recheck before push and exact-head review;
use a normal merge, never rebase or force-push, if a necessary fix arrives.
The manager's session records openai-codex/gpt-6.1-sol with high reasoning.
Both prescribed isolated claude.ai preflights succeeded, and the startup panes
report Team subscription, Sonnet 5.5/high and Opus 5.5/high respectively.

### Implementation scope and stop condition

Remove two concrete watch gaps without declaring full parity: newly baselined
runs/releases must discover unsettled items beyond page one, and tracking must
not silently expire a still-unsettled run after one day or a draft after thirty
days. Use the existing typed reader, durable scan progress, atomic event/cursor
commit and budgets. No new endpoints, authorization, live settings, source access
or production mutation. The implementer remains sole code writer after independent
plan review. This manager-owned plan is the only concurrent repository edit.

1. Remove age-cutoff inputs/constants and age-based clearing of `scan_floor`.
   Recompute the floor from actual observations; settlement, publication or
   confirmed absence can release it, elapsed time alone cannot. Identity-based
   event deduplication and retained event history remain unchanged. A floor that
   falls beyond the existing page cap must block visibly with committed cursor
   and held events preserved, never expire or silently reset.
2. For a NEW null-cursor runs/releases baseline only, page to the end of the
   bounded inventory, durably resuming one existing request unit at a time.
   Apply the existing drift re-read also to these multi-page baselines. Other
   surfaces retain their existing initial behavior. Exceeding the unchanged
   ten-page cap must leave the cursor null and report `window_exceeded`.
   Busy-repository refusal is a required parity/capacity blocker, not an accepted
   omission or a reason to raise budgets or request a reduced migration.
3. A multi-request baseline must not announce pre-baseline history or silently
   suppress a transition that occurs while it is running. Freeze a baseline
   boundary before its first request and persist it across restart/retry.
   Commit no historical events; the following normal pass must reconcile all
   transitions since that boundary, including an older-created item that settled
   or published before its later baseline page was read. A bounded conservative
   creation floor covering the initial inventory may be needed for that first
   reconciliation. The reviewer must check this design before implementation;
   merely committing the newest observed timestamp would lose those transitions.
4. Do not reset existing/imported checkpoints or invent source provenance.
   Existing targets that were previously baselined shallowly, source-cursor
   unsettled inventory reconciliation, arbitrary pagination drift, late reruns of
   already settled runs, and review depth remain required blockers until separately
   proven. No migration is expected; if the existing persistence contract cannot
   represent safe progress, stop and revise the reviewed plan rather than silently
   corrupting old state.
5. Synthetic regressions: deep initial draft/run observation and later settlement;
   transitions during baseline and restart; no initial historical delivery;
   old unsettled items retained beyond both former cutoffs; floor recomputation
   after settlement/absence; page-cap refusal including held-event preservation;
   drift restart with null cursor; per-unit/tick/hour call bounds; unchanged other
   surfaces; exact identity deduplication across repeated scans. Test existing
   saved-state compatibility and document added initial scan/quota costs honestly.
6. Independently review this plan once. Implement and verify in meaningful batches
   (at least code/regression and contract/documentation commits, no artificial
   split). Run narrow tests then lint/typecheck/full suite/build, full-PR diff
   check and existing strict OpenSpec validation. Update ADR 0031, current-state,
   runbook and existing OpenSpec contracts without checking off remaining parity.
7. Run a fresh real Gitleaks scan on final pushed history including merges and an
   exact archived tree. Preserve raw evidence; allow only independently classified
   exact synthetic-fixture fingerprints, never path/rule exceptions. Obtain a
   separate final full-diff review and explicit exact-pushed-head approval; fix and
   re-review every new BLOCKER/IMPORTANT. Retain all prior required blockers,
   draft PR, Bead in_progress and `ready_to_merge=false`. No live Discord or
   operational evidence is implied by synthetic tests.

### Independent plan-review requirements C1–C11

The separate Opus reviewer conditionally approved the continuation with the
following mandatory safety amendments, recorded before code changes. These
supersede any conflicting suggestions in the exploratory investigation.

- C1: Store `baseline.boundaryMs` in the existing scan JSON, not as a ratcheting
  newest timestamp. Every new runs/releases baseline commits exactly this
  boundary. Marker/cursor mismatch or old null-cursor pending state without the
  marker restarts safely; test compatibility and adoption.
- C2: The boundary is `floorToSecond(pre-request nowMs) - 1ms` so provider
  whole-second timestamps in the first second are not dropped. Any additional
  skew margin must be a documented constant. Skew beyond it remains a required
  evidence blocker, not a lossless claim. Test same-second and just-after events.
- C3: Use this boundary path for single-page AND multi-page new runs/releases
  baselines, with `boundaryKnown=false`. Other surfaces keep their current path.
- C4: A drift restart preserves only the original boundary and the minimum
  creation floor seen so far; discard page, last, total, CI state, cap and queue.
  Transient failures preserve the whole scan. Prove process-restart and
  drift/retry/commit continuity using the original boundary.
- C5: For the first following normal pass, preserve a creation floor covering
  every unsettled item and every old-created run/release touched/published after
  the boundary. A conservative oldest-inventory floor is allowed if its cost is
  documented. Recompute normally after reconciliation, with NO age cutoff.
  Prove a mid-baseline settlement/publication is announced exactly once.
- C6: Creation-sorted windows close only at `created < threshold`, not equality,
  or at the true end. Same-second items can span pages; test the unsettled one
  on the following page.
- C7: A draft's normal-pass cursor cap is also
  `floorToSecond(read nowMs) - 1ms`, not raw local milliseconds. Keep a run's
  update-minus-1ms cap. Test publication in the read's same second.
- C8: Import adoption of an unbaselined checkpoint clears pending cursor/page/
  state atomically, preventing a source cursor from inheriting a half-read
  baseline. Prove already-read-page events are reconciled after adoption.
- C9: A run already running at the boundary must not announce a historical
  `ci_started`. Require creation after the observation cursor or retain settled
  identity markers; choose explicitly and test. No baseline delivery is added.
  **Superseded by the final-review correction below:** the creation-after-cursor
  option was unsafe (it loses the start of a run inserted late once an older run's
  conclusion carries the cursor past its creation) and was removed.
- C10: Preserve multi-page drift re-read, runs total-shrink detection and ten-page
  refusal with null committed cursor. Refuse runs on page one if `total_count`
  exceeds the bounded inventory capacity. Charge every call and preserve the
  existing per-unit/tick/hour bounds. Block a draft with no usable creation time
  rather than silently leave it untracked.
- C11: Update ADR/current-state/runbook/OpenSpec honestly: mature branches with
  over 100 runs refuse initial inventory; deep steady-state floors cost depth
  plus one calls per 15-minute pass; `window_exceeded` has no recovery control.
  First-observation residual is replaced by bounded refusal, NOT declared full
  parity. Previously lost/cleared floors, imported/preexisting shallow targets,
  clock skew beyond the margin, uncertified release ordering and all prior
  required blockers remain explicit. Test refusal leaves CI state unset and
  `observes()` false, so native coverage is retained and other surfaces work.

No schema change is expected; stop and revise if scan-state preservation cannot
be represented safely. Old-code rollback mid-baseline degrades to its shallow
behavior and must be documented; monitoring pauses, cycle exclusion and backoff
retain an old boundary and later reconcile from it. The reviewer made no edits
or publications. Conditional approval becomes effective with these conditions
included; deviations require scoped re-review. This is code-safety plan approval,
not issue acceptance or readiness approval.

### Final-review correction (I1, I2, M1, M2)

The final reviewer rejected the first candidate and the corrected plan is recorded
before the fix: (I1) a release with no usable creation time that is a draft, or was
published after the boundary, cannot be floored, so the surface is refused as
`release_untrackable` rather than committed; (I2) moving-cursor suppression of
`ci_started` is unsafe and superseded: a start is again announced from an update after
the cursor, and a run already underway at a baseline is silenced ONLY by a durable
identity marker, the existing settled-at-birth write with an empty payload, written in
the baseline's atomic commit (no schema change, no held or delivered row, dedupe state
rather than a delivery claim, identifiable in the export as a settled observed event
with an empty payload); (M1) refusals are counted by reason in the status line without
naming a repository; (M2) a tick ends rather than re-picking a unit that made no request
and did not move. All C1-C11 limits, the 99-item capacity, the cost, skew, imported and
shallow targets and every earlier blocker remain required.

### Marker design review D1-D10 (I3, M3, M4)

The reviewer rejected the canonical-identity markers (I3): a canonical `<run>:ci_started`
settled as suppression silenced a start that an import adopting an earlier source cursor
(below the boundary) must announce, and the unique identity kept the real event out for good.
Approved, with these conditions, and implemented exactly:

- D1 one exact pure shared classifier (`classifyBaselineMarker`, `@ducky/contracts`): kind
  `ci_started`, origin `observed`, identity
  `^baseline-marker:v1:ci_started:(0|[1-9]\d{0,15}):([1-9]\d{12})$`, safe run id, `B % 1000 === 999`,
  `occurred_at === iso(B)`, payload `{}`, not held, alert/digest/created all set, equal and at or after
  the boundary; anything else is an ordinary event. Suppression, counts, export and tests all use it.
- D2 generation through one encoder that checks itself against the classifier; an unencodable id
  refuses the runs surface (`baseline_marker_invalid`, counted), never skipped, never announced.
- D3 suppression only for a marked run, only while the committed cursor is at or after its boundary;
  the lookup reads a bounded candidate set plus one and an overflow fails the surface closed
  (`baseline_marker_overflow`, counted), never silently truncated.
- D4 below the boundary the real identity is announced once and deduplicates; markers exist only in
  the baseline's atomic commit.
- D5 import refuses the reserved prefix broadly (validation, counted, no value) and again at the write.
- D6 counts exclude exactly the classifier's rows (SQL only narrows) and report `baselineMarkers`.
- D7 export: per-row `baselineMarker` boolean and a replay rule; schema bumped to
  `ducky-rollback-delta/v2` (a v1 document's marker status is UNKNOWN, never inferred; no consumer of
  v1 exists here, nothing is rewritten, migrated or contracted).
- D8 `b88b701` is PUSHED, never deployed, released or imported live. Databases that ran it keep their
  canonical, settled, empty-payload `<run>:ci_started` rows; they are not reinterpreted, unmarked or
  migrated and nothing is inferred from them, so the rewind defect persists for those development or
  scratch databases only. Resetting a cursor or re-baselining in the same database does NOT delete a
  canonical event identity and repairs nothing; only a fresh database or a separately reviewed owner-run
  offline step could, and none is provided or authorized. This stays a REQUIRED limitation. The
  classifier also requires the settlement and creation times to be canonical `toISOString` instants
  (equal malformed strings never authenticate a row).
- D9 waiting, pending or requested runs at the boundary set the floor and get no marker; a later start
  is announced. D10 the near-miss table, cross-run and cross-target isolation, drift-restart
  recomputation, unencodable ids, the 200-character identity bound, count/export agreement and the I3
  reproduction (earlier adopted cursor announces exactly once; repeated adoption nothing more; a cursor
  at or after the boundary stays silent) are tested. No database migration. All earlier limits and
  blockers, the private reverse bridge, and `ready_to_merge=false` stand.

## Run b6072c5430: monitoring provenance and exact native reconciliation

Manager: openai-codex/gpt-6.1-sol/high. Resume head `6a461c72f110df7d41c5923afbd657cb253a20b0`; live `origin/main` and PR base remain `0a58ef01fe34ad60b91180d6e32fc6aae3b0925f`, an ancestor. PR #16 stays draft. The only repository edit during investigation is this manager-owned plan; the prescribed separate Team Sonnet 5.5/high implementer is the sole implementation writer after independent Opus 5.5/high plan approval. No new workflow helper, source mutation, live probe, service activation, real import, notifier stop, deployment or merge is permitted. Recheck base before publication and use a normal merge if a required integration fix arrives.

### Goal, decisions and stop condition

Implement the previously authorized missing monitoring pause provenance, historical slug identity and exact cross-path/import-time reconciliation. Retained **provable** ordinary-watch history must no longer cause blanket resume refusal. Unknown historical evidence is not magically recoverable: refuse/hold only the genuinely unprovable case with counts-only diagnostics, preserve it as required parity work, and never silently reset a cursor, re-baseline, repeat or mark an untold event delivered. This is a concrete engineering continuation, not a new product-policy question or permission to waive prior blockers.

The manager rejects exploratory options that knowingly repeat pre-ledger events, infer historical slug meanings, silently re-baseline after a remap, prune necessary evidence, or use ambiguous timestamp-only review matching. Imported/native precedence must work through all coverage gaps, not just the off-to-on command. A count-only summary does not prove that any specific item was told. Do not suppress those item details; document residual aggregate overlap honestly rather than equate counts with exact deliveries.

### Implementation sequence and invariants

1. Additive persistence, next actual free migration number (36 at resume), no legacy provenance backfill. Persist the repository key actually queried by ordinary-watch observations and by their outbox events. A fresh watch may bind at creation; a legacy unbound watch cannot use today's `repos` mirror to authenticate its past. A remapped bound slug must fail closed/cancel its ordinary observation with an explicit identity mismatch, preserving prior snapshot/events; no cross-repository diff or silent re-baseline. Identity evidence is non-authoritative and never grants engineering jobs/access. Use one canonical validated key function shared across native/imported matching.
2. Persist owner monitoring pause intervals with origin (`owner`, `import`, `unknown`), nullable real start and explicit observation/import bound. Owner pause uses injected time; imported or existing paused state has unknown actual start. Closing an interval does not invent its start. Same-state calls remain no-ops. Switch, provenance and strict counts/state-only audit change atomically. Keep next-tick pause semantics, pending outbox delivery, budgets and backoff. Audit logs are not durable provenance.
3. Add a durable, content-free native transition ledger and completeness/provenance boundary that survive native outbox/watch pruning. Include owner, canonical repository, exact transition key, native path/event reference, delivery disposition and timestamp; no titles, summaries, review bodies, selections or credentials. Add necessary tables to `RETENTION_FORBIDDEN_TABLES`; retention must not erase a blocker or evidence. Preserve pre-ledger unknown/legacy evidence even if cancelled watches/feed rows are later pruned; never classify existing settled native rows from today's mapping. Ledger records and pending claims must be bounded by existing batch/item limits per operation; no API calls are added.
4. Generate structured transition claims from the same rendering decision and item slices as native output, never parse free-text summaries. One pure contracts codec translates exact native/imported identities. Feed opened PR/issue and requested-change review IDs, named commit digest SHAs and ordinary explicitly named lifecycle/update transitions may reconcile only when their exact identity/time evidence exists. For reviews, retain provider review ID where available; timestamp alone is insufficient when multiple reviews share a time. Ordinary aggregate approval/count/run/review-comment summaries and truncated-away items are not item receipts. Follow-up proposals are distinct actionable content, not proof of every review transition. `baseline`, `skipped`, `abandoned`, failed, expired and merely observed states do not count as delivered. Existing baseline markers stay separate from real deliveries.
5. Write pending native claims with outbox creation in its observation/CAS transaction, and delivered receipts with outbox settlement only after successful transport. Preserve the existing at-least-once crash limitation between Discord send and SQLite settlement; do not promise transactional exactly-once transport. Resolve the pending-native/target race using a shared transactional claim or hold protocol: one path owns an exact transition; another cannot send concurrently or advance a cursor past unrecorded work. Failed/abandoned native delivery releases the claim without losing target events; retry/restart cannot lose or duplicate deterministic transitions. Native suppression or target settlement must never consume unrelated kinds or recipients. A changed mapping during an awaited read cannot change the recorded queried identity.
6. Reconcile exact native receipts against both newly derived and held/imported target events, before alert/digest output and at held-event release. Mark native-settled provenance explicitly, separate from a real Ducky delivery or baseline marker. Handle native-before-target, target-before-native, pending native work, native-only kinds, exact near misses and multiple delivery modes. No blanket surface-level/history-based assertion may replace item-level reconciliation across pause, cycle exclusion/re-entry, read failure/recovery, blocked/unblocked surfaces and digest deliverability changes. Keep incomplete observations held and cursor CAS atomic.
7. Import create, discovered-target adoption and initial monitoring-setting writes use the same local reconciliation/provenance boundary inside the existing offline import transaction and runtime lock. No network/transport or acknowledgement bypass. Repeat import preserves native choices and drift reporting. Legacy ambiguity refuses before partial writes; no checkpoint reset or source identity mutation. Import-time overlap must not bypass the runtime resume protections merely because an absent settings row defaults to on.
8. Version rollback delta explicitly (`v3` if its shape/meaning changes), covering pause intervals, native receipts/claims, completeness boundaries and native-settled flags consistently under the existing snapshot/lock boundary. Older v1/v2 documents lack this provenance; do not infer it or rewrite them. A private source reverse bridge is still unproven and is not needed to mutate private state in this public continuation. Document older-build/downgrade incompatibility: stop coordinators before migration and never run older code against this migrated state.
9. Synthetic regressions through actual services/store/router: fresh provable history can pause/native-deliver/resume without repeats; unrelated history no blanket refusal; legacy unknown still refuses and survives enabled retention; slug remap/reboot/read-await race; import create/adoption/on/off/repeat/drift/atomic refusal; pending send races, failed/abandoned send and restart; same-second distinct reviews; >3 summary items and commit truncation; exact identities/near misses; target held-event release, alert and briefing settlement; cycle/failure/block/digest coverage recovery; audit failure rollback; migration from populated v35; private counts-only replies and unchanged authorization; coherent v3 export. No required old regression is weakened to hide a real failure.
10. Implementer runs focused tests per logical batch, then lint/typecheck/full suite/build/diff and existing strict OpenSpec validation. Update ADRs, current-state, runbook and OpenSpec honestly, correcting the prior claim that retention cannot bypass the old history guard. At least two meaningful commits, no artificial split/co-author trailers. Manager independently verifies final gates, reviews diff, rechecks base and pushes normally after commit-message inspection. Fresh real Gitleaks full reachable history including merges and exact archived tree after final push; raw findings retained and any synthetic exception exact-fingerprint-only, independently classified. Separate reviewer checks complete PR scope plus continuation and explicitly approves the exact pushed SHA after every BLOCKER/IMPORTANT correction. Any later edit invalidates that approval.

All pre-existing reader completeness/depth/capacity/recovery, late reruns/old floors/skew, real item/discovery/quota/timing, ambiguous scratch markers, source schedule rollback/AI/meals/areas, private reverse bridge, issue #8/runtime/live-adapter and every backup/parity/controls/notification/rollback/cutover/module-retirement gate remain required. This scope may narrow specifically proven engineering blockers only. Keep `ready_to_merge=false`, draft PR and Bead in_progress until all required acceptance evidence exists. No repeated unchanged external-only blocker probes.

### Independent plan review A1–A7 and manager implementation choices

The separate Opus reviewer conditionally approved the plan with seven IMPORTANT amendments. These replace conflicting exploratory details above; no code is approved merely because a plan is approved.

- A1: Remove prospective `covers()`-based native loss. A native skip/omission is allowed ONLY for an exact, actually delivered target transition, not a promise of future coverage. Prefer this conservative delivered-only design over speculative target-owned suppression with a new fallback notifier. A target awaiting delivery cannot permanently hide native output: the native path may reserve the matching item, and the target waits on its durable claim. A native failure/abandonment releases ownership so the target can deliver. Do not drop coarse/unnamed/aggregate parts on the theory that a target will eventually tell them. Multiple native paths may retain existing duplicate behavior; this scope prevents new deterministic native/target duplicates and loss. If speculative ownership is unavoidable, every skipped native item must have a durable exact target claim and an existing-route fallback on cancellation/block/window overflow/digest loss/abandonment, with fresh visibility; stop for scoped design review before adding that complexity.
- A2: Parse bounded optional REST `node_id` in the already approved review DTO and match native GraphQL review IDs by exact string equality only, no decoding/normalization or timestamp-only suppression. Hash the comparison identity before durable reconciliation/export, never log/export a new raw node ID. A same-repository/PR native requested-changes receipt with missing/mismatched node evidence withholds rather than tells the possibly repeated target event. Missing live equality evidence stays a required gate; no live probe is run in this dispatcher continuation.
- A3: One pure per-kind codec table covers EVERY imported kind. Exact repo/item is mandatory. Opened PR/issue keys use number; named commits use SHA; merges use canonical mergedAt. Sampling-dependent PR/issue updates use a conservative per-repository/item dominance rule (target time at/before a proven native-told update is already covered), never cross-item/time-only matching. Runs must parse bounded `run_attempt` from the same DTO or withhold ambiguous attempts; no cross-attempt suppression. Releases and default-branch changes have no native counterpart and are never legacy-withheld/suppressed. Count-only/unnamed native summaries do not prove item receipts. Same-second distinct review/missing-ID/attempt/update tests are required.
- A4: Replace whole-import/history refusal with a durable event-level legacy cutoff L captured in migration 36 BEFORE retention. Native observation refuses if that boundary is unreadable. A verifiably fresh database (all migrations applied in one run, represented explicitly) has no pre-ledger native history; otherwise counterpart transitions at/before L plus a documented 1-second skew margin without positive receipts are withheld. Legacy delivered feed rows can seed positive raw path/event-key references using their own durable repo/time; apply the shared TypeScript codec, never SQL identity decoding. Missing/pruned/skipped/baseline/abandoned rows prove no delivery. Resume refuses only unreadable ledger/cutoff, not history. Import refuses structural contradiction only, atomically withholds ambiguous individual events. Required operator sequencing: migrate stopped target before the final source export, prove cursors beyond L+margin and zero withheld count in `--verify`; this is not permission to reset live cursors.
- A5: Withheld event and advancing cursor commit atomically. It is neither delivered nor settled nor a baseline marker; status/export/verify count it separately. No fabricated acknowledgement or release control. It remains a required cutover blocker until evidence or separately authorized remediation exists.
- A6: Ordinary watches bind durable queried identity on new creation or first post-migration observation. Legacy past remains unknown. Later slug remap cancels with an additive reason, preserves old snapshot/outbox, sends no new DM and reports a counts-only stopped-mapping count in status. Ledger has no cascade/prunable native foreign keys. Test remap/reboot and awaited-read races.
- A7: Pause intervals are non-authoritative status/export/import provenance only. They never suppress or authorize delivery. Record unknown source/legacy start honestly. They and ledger/cutoff survive retention. Per-operation work is bounded; lifetime evidence grows and is documented.

Claims have no arbitrary 15-minute expiry: elapsed time cannot prove whether a send occurred or whether its owner remains live. Release is tied to explicit no-send/failure/abandonment/cancellation state, with restart/retry behavior preserving the existing at-least-once transport crash caveat. A pending unknown send is not silently converted into a receipt or a clean retry proof. Add tests for native/target cancellation, block, digest loss, retention after populated-v35 migration, fresh-database boundary exemption, stale updates, exact unmatched reviews, run attempts and remap status. Existing fixture tests may change only to assert the reviewed new item-level contract, not to waive failures. Record meaningful verification per commit and keep every previous required blocker.

### Scoped delivered-only approval C1–C5

The independent reviewer approved the simpler A1 alternative subject to these mandatory conditions, now recorded before implementation:

- C1: Shared unique `(owner, canonical repo, transition key)` reservation, checked/reserved in one synchronous transaction. Native reserves with outbox creation and skips only actual target delivery; an in-flight target send defers the feed event or the entire ordinary observation CAS without changing its snapshot. Target reserves only during one actual send attempt; success delivers, failure releases and stays pending. Startup recovers crashed target sends to pending (never a receipt), retaining at-least-once transport caveat. Native-pending target events wait without settlement, digest consumption or abandonment charge.
- C2: Release native ownership for every terminal no-send: abandonment, retired/skipped/deselected/stale feed events, cancelled/remapped ordinary outbox that will not be sent, and disabled-feed frozen config once at startup while retaining rows. Ordinary remap outbox that remains deliverable stays reserved. Commits carried to a later digest stay reserved. Table-driven terminal-transition tests are mandatory.
- C3: Briefings contain only deliverable items, carrying waiting ones forward; per-tick rechecks remain bounded. Counts-only status exposes waiting-on-native and legacy-withheld separately.
- C4: Document changed precedence explicitly: actual delivered transition wins, native usually first on overlapping repositories, so imported digest may empty; no prospective imported precedence. Manager adopts the reviewer's recommendation that a successfully delivered configured public `github_channel` card counts as an owner receipt, just like owner DM; tests assert channel and DM receipts and failure/non-delivery do not count. No visibility routing changes.
- C5: Remove prospective `importedCovers` / `coveredByImport` suppression inputs and app wiring completely. Keep `covers()` only if genuinely needed for status; no native path may consult future coverage. Rewrite, do not delete, the named old coverage regressions to prove delivered-only behavior, and list them in commit evidence.

The coordinator starts these ticks concurrently; normal awaited sends race, so the above is not merely crash protection. Native/target retry abandonment remains the existing delivery limitation, not an accepted cutover waiver. Count-only summary plus item detail is documented aggregate/detail overlap, never an exact receipt. All A2/A4 live evidence/legacy sequencing and every previous blocker remain required. Sole implementer now owns public implementation and documentation edits; manager stops editing repository files until explicit handoff.

### Implementation record (sole implementer)

Code and tests: `819a420` (on top of the preserved `6a461c7`; `main` `0a58ef0` remains an ancestor; no
push, no rebase, no force-push). Documentation, OpenSpec and this record are the second commit.
Authoritative description: [ADR 0034](decisions/0034-exact-native-reconciliation.md). Implemented as
approved (A1-A7, C1-C5), with these choices a reviewer should check against the plan:

- **A4 is global, as the manager required.** On any database that is not verifiably new, every imported
  event with a native counterpart at or before the migration-36 cutoff plus one second and no exact
  receipt is withheld, whatever rows survive; surviving delivered feed rows are staged by the migration
  (through the shared codec, in its own transaction, before any retention) and become receipts at the
  first reader that knows the owner (start-up, or the importer's own transaction). `fresh` is decided by
  the migration runner (no version applied when the run began), not by SQL. The cost is large on a
  not-new database (a pre-cutoff backlog of counterpart events is withheld) and is owned: it is why the
  runbook requires migrating before the final source export and `--verify` to report `nativeLedger.clear`.
- **Ambiguous identities are withheld whenever a native path could tell them** (a native claim for the
  item, or ANY feed row for the repository, a durable tombstone). Only the case where no native path
  could ever tell it is delivered. This is stricter than "withhold on a native claim" because a send
  with no exact key leaves no reservation a later native card could see.
- **The review comparison is a hash of the REST `node_id` against the native id (exact equality);
  live equality is unproven** (the reviews probe returned an empty answer; no probe was run), so until
  it is proven a review may be told twice, never silently suppressed. No timestamp is ever a match;
  one only proves a review later than a native observation and so deliverable.
- **Target reservation rules.** A second send of a transition never runs while one is in flight; the
  same event's other mode may follow a delivered one; another event of an already-told transition is
  settled. Native `deferred` observations repeat each tick without touching the snapshot.
- **`AssistantWatchRepo.observes` is kept** as a diagnostic read for the baseline tests only; no
  delivery path calls it (a source-scan test asserts it, and that `covers`, `importedCovers`,
  `coveredByImport`, `nativeWatchedEver` and the digest-deliverability input are gone).
- **Start-up recovery** releases target reservations only when the process holds the runtime lock.

Gates run at `819a420` before the docs commit: `pnpm typecheck` (build + test projects) clean; full
`vitest` 158 files / 2605 tests passing; `git diff --check` clean; strict OpenSpec validation passing.
Synthetic tests only; no live probe, import, notification, source or runtime access.

**Retained, still required (not waived by this work):** pre-ledger history is withheld and counted with
no clearing control; counts and unnamed aggregates are never receipts (aggregate/detail overlap
remains); live REST/native review-id equality; at-least-once across a crash between a send and its
write; lifetime ledger growth; migration-36 operator sequencing and `--verify` clear; the reader,
runs/releases depth, skew, imported/shallow target and window limits of the earlier runs; AI wording,
meals and areas; issue #8 runtime eligibility; the private reverse bridge; and every operational gate
below. `ready_to_merge=false`, draft PR and Bead `in_progress` stand.

## Required operational gates, not waived

- Fresh live source/config backup with separate restore and academic-health proof, plus stopped target backup/restore.
- Private complete source-to-target semantic/count parity and repeated-import rehearsal without notifications.
- Real synthetic development Done/Edit/Snooze, unauthorized-action refusal and notification delivery evidence on an eligible runtime.
- Proven reverse-delta rollback including native records, deletions, delivery and checkpoint deltas, preserving source backup.
- Authorized operator final snapshot/cutover with both notifiers stopped, duplicate-free observation and academic health.
- Stable observation followed by separately reviewed private module-only retirement.

This dispatcher cannot perform the forbidden production/source changes. Unavailable operational evidence is a required merge blocker, not a reason to mark acceptance complete or request a reduced migration.
