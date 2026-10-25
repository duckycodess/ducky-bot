## ADDED Requirements

### Requirement: Atomic private owner migration
The system SHALL validate a strict versioned interchange document and frozen owner/profile configuration before atomically importing supported private assistant records through existing persistence/service boundaries. It SHALL preserve state, explicit deadlines, reminder policies, preferences and relevant delivery checkpoints. Unknown active semantics SHALL block parity rather than be silently omitted. No personal contents, source schema, exact watch selection or credentials SHALL be committed or included in public logs.

#### Scenario: Invalid document or owner mismatch
- **WHEN** any category, reference, capacity, temporal field or owner fails validation
- **THEN** no imported rows, correlation records or notifications are committed and the public error contains no record contents

### Requirement: Permanent import identity
The system SHALL correlate source identities durably and SHALL retain identity-only tombstones after owner deletion. Repeated import SHALL not overwrite Ducky-side edits, advance delivery checkpoints, resurrect removed records or produce notifications.

#### Scenario: Import after owner actions
- **WHEN** an owner edits/completes/cancels/deletes an imported record or an occurrence is delivered and the same export is imported again
- **THEN** those actions are preserved and no duplicate or resurrected record or pending notification is created

#### Scenario: Source changed since rehearsal
- **WHEN** a later export changes source content for an already-correlated identity
- **THEN** verification reports a content-free conflict rather than silently keeping a stale record or overwriting target actions

### Requirement: Existing task controls preserve migrated behavior
Imported tasks SHALL use existing compact cards and real owner-bound Done/Edit/Snooze controls. Their displayed local deadlines SHALL have no timezone suffix or reminder-offset line. Timed/default all-day native policies SHALL remain unchanged; audited imported policies SHALL survive resync.

#### Scenario: Owner edits then snoozes a task
- **WHEN** the owner changes its deadline and snoozes a notification
- **THEN** pending reminders resync with its stored policy, snooze changes only notification time and non-owner controls fail closed

### Requirement: Operational gates are not documentation claims
Live source/config restore, private semantic/repeat-import parity, live synthetic controls/notifications, reverse-delta rollback, stopped-notifier cutover and module-only retirement SHALL be required evidence before claiming the issue complete. This dispatcher SHALL not deploy, change production settings or stop/remove the source.

#### Scenario: Only synthetic tests pass
- **WHEN** public code and synthetic tests pass but operational evidence is absent
- **THEN** completion and merge readiness remain blocked and source academics/module remain unchanged
