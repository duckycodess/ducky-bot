## 1. Preparation and review

- [x] 1.1 Complete private semantic audit and mapping with source snapshot backup/restore evidence; distinguish live-state unknowns.
- [x] 1.2 Independently review the public plan once and resolve BLOCKER/IMPORTANT findings.
- [x] 1.3 Correct settled-policy/stale-base runbook facts and record ADR contract decisions; commit meaningful foundation.

## 2. Import and parity capabilities

- [x] 2.1 Add strict versioned interchange contract, whole-document validation and counts-only failure reports.
- [x] 2.2 Add transactional import-specific persistence and durable identity/tombstones; integrate owner-scoped Forget/retention.
- [x] 2.3 Preserve task/reminder lifecycle and per-task policies through existing owner controls.
- [x] 2.4 Implement indefinite recurring schedules, audited exceptions and bounded read-time occurrences for list/briefing.
- [x] 2.5 Implement bounded notification-only selection and fair per-tick/rolling resource budgets without engineering authorization changes.
- [x] 2.6 Preserve typed watch checkpoints and alert/digest event settlement with explicit transition reconciliation and resumable partial reads. (Engine and persistence, proven with a scripted reader. No real reader exists: release publication, closing times and discovery remain blocked, so a document with watch targets fails closed. See ADR 0030.)
- [x] 2.7 Preserve audited active preference/briefing behavior with no imported authorization or deployment config writes. (AI wording, meals and a paused watch switch are refused, not supported.)
- [ ] 2.8 Add explicit offline importer, dry validation/semantic verification and private read-only rollback-delta export where sufficient. (Importer, dry run, `--verify` and the lock/backup gates are done. The rollback-delta export is NOT implemented and the reverse-delta bridge stays an unproven gate.)

## 3. Synthetic verification and final review

- [x] 3.1 Test every agreed record category, owner mismatch, all-or-nothing failures, ID collisions and capacity bounds.
- [x] 3.2 Test repeat import after edit/delivery/deletion, completed suppression, due-kind conversion, reminder resync, owner-bound controls and delivery routing.
- [x] 3.3 Test recurrence far beyond a date horizon, DST/leap days, exception matching and retention/deletion.
- [x] 3.4 Test complete notification selection, throughput/fairness, checkpoint boundary/transition, settled versus pending/digest events and partial-read retries.
- [ ] 3.5 Run focused checks then lint, typecheck, full suite, build and diff check; inspect final diff/private-public boundary and commit messages.
- [ ] 3.6 Independent final review; fix BLOCKER/IMPORTANT findings with scoped re-review; push verified branch, open PR with Closes #9 and obtain exact-pushed-head approval.

## 4. Required operational evidence (authorized private operator; not performed by this dispatcher)

- [ ] 4.1 Fresh live source/config backup restores; verify academic health and stopped-target backup.
- [ ] 4.2 Private source-to-target semantic/count parity and repeated-import rehearsal with no notifications.
- [ ] 4.3 Synthetic-only live development notification and actual Done/Edit/Snooze/non-owner-control verification.
- [ ] 4.4 Rehearse reverse-delta rollback including native new records and notification/checkpoint deltas; preserve source backup.
- [ ] 4.5 Operator-only final-snapshot cutover with both notifiers stopped, duplicate-free Ducky observation and academic health.
- [ ] 4.6 After successful stable observation, separately reviewed module-only retirement in private source repository.

Unchecked operational evidence is required and blocks merge readiness for issue #9; public/mock checks cannot satisfy it.
