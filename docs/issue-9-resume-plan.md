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

## Required operational gates, not waived

- Fresh live source/config backup with separate restore and academic-health proof, plus stopped target backup/restore.
- Private complete source-to-target semantic/count parity and repeated-import rehearsal without notifications.
- Real synthetic development Done/Edit/Snooze, unauthorized-action refusal and notification delivery evidence on an eligible runtime.
- Proven reverse-delta rollback including native records, deletions, delivery and checkpoint deltas, preserving source backup.
- Authorized operator final snapshot/cutover with both notifiers stopped, duplicate-free observation and academic health.
- Stable observation followed by separately reviewed private module-only retirement.

This dispatcher cannot perform the forbidden production/source changes. Unavailable operational evidence is a required merge blocker, not a reason to mark acceptance complete or request a reduced migration.
