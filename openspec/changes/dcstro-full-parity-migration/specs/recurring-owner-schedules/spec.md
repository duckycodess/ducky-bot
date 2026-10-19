## ADDED Requirements

### Requirement: Indefinite owner recurrence
The system SHALL preserve audited owner weekly recurrence and dated exception semantics without substituting a finite materialization horizon. Rules SHALL be owner-scoped, active/inactive state SHALL be preserved and occurrence expansion SHALL be bounded by the requested civil-date window.

#### Scenario: Far future occurrence
- **WHEN** a bounded window decades after import matches an indefinite active rule
- **THEN** the correct occurrence is available to schedule and briefing readers without requiring reimport

### Requirement: Exceptions and lifecycle
Dated cancellations/overrides SHALL apply only to audited targets in the owner's timezone. Retention SHALL skip live series. Owner deletion SHALL remove its series/exception behavior and prevent resurrection by reimport.

#### Scenario: Exception across time changes
- **WHEN** a matching occurrence falls on a cancellation or override date near a DST or leap-day boundary
- **THEN** the audited exception affects precisely that occurrence and unrelated owner occurrences remain unchanged

### Requirement: Stale-safe owner rollback between batches
The owner SHALL be able to roll the recurring schedule back one batch through the existing owner-only schedule command, without a new command, subcommand or interaction kind. A preview SHALL report counts and a confirmation code that binds every rule's identity, batch, active state and replacement time and the selected target. The code SHALL be recomputed, compared, applied and audited in one transaction. A stale or replayed code SHALL change nothing, and a deliberate second rollback SHALL require its own preview. Any replaced batch of unknown or unreadable order, a tie, a split batch or a stamp not newer than every stored one SHALL be refused. No rule or exception SHALL be deleted, and no reply SHALL name a batch, label or course.

#### Scenario: Replayed confirmation
- **WHEN** a confirmation code that already flipped the schedule is presented again
- **THEN** it is refused as stale, nothing changes and no second audit row is written

#### Scenario: Unknown order beside known order
- **WHEN** one replaced batch has no known replacement time while another has one
- **THEN** the rollback is refused rather than choosing the known one

#### Scenario: Audit cannot be written
- **WHEN** the audit write fails during a confirmed rollback
- **THEN** the schedule is left exactly as it was
