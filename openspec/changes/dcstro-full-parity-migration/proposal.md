## Why

Issue #9 authorizes full parity for the owner's existing private assistant behavior before retiring its old module. Ducky currently cannot represent indefinite schedules and exceptions, the complete notification-only watch selection, or source event/checkpoint semantics. Importing through ordinary creation methods would reopen records, regenerate reminders and silently reset watch baselines.

## What Changes

- Define a strict versioned, owner-scoped interchange contract, private semantic mapping/evidence, transactional offline import, durable correlation/tombstones and counts-only verification.
- Preserve recurrence and exceptions without storing a finite horizon; integrate occurrences with existing schedule/briefing reads and deletion/retention.
- Preserve task state, explicit deadline kind, linked reminder policy and settled delivery history through existing controls.
- Add bounded notification-only watch capacity, fair resource budgets and explicit per-surface event/checkpoint reconciliation without changing engineering authorization.
- Preserve existing active preferences and briefing behavior only where supported by privately derived behavioral facts. Independently implement behavior, never copy private code.
- Correct the existing cutover runbook and document live evidence, reverse-delta rollback and assistant-only retirement gates. This run does not deploy, alter production settings, stop the source or retire it.

## Capabilities

### New Capabilities
- `assistant-migration`: atomic repeatable import, durable identity, semantic verification and gated operational cutover.
- `recurring-owner-schedules`: indefinite weekly recurrence and dated exceptions in bounded query windows.
- `notification-watch-transition`: notification-only selection, bounded throughput and explicit event/checkpoint continuity.

### Modified Capabilities

Existing tasks/reminders, preferences/briefings, schedule reads and deletion/retention are extended only as necessary for accepted source behavior. Their owner-only and transport contracts remain unchanged.

## Impact

Contracts, persistence migrations/repositories, coordinator domain services, existing GitHub read adapters, operator scripts, synthetic tests and public runbooks/ADRs. Private schema, mapping, selection, records, backup paths, settings and behavioral audit remain outside the repository. No new engineering runner, pipeline, public import route or permission derived from imported data.
