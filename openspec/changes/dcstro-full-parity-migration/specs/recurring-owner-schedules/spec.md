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
