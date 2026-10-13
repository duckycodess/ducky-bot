## ADDED Requirements

### Requirement: Complete notification-only selection
The system SHALL privately derive the effective selection from all existing owner notification watches and audited filters. Targets SHALL have bounded hard capacity and fair read-throughput budgets independent of frozen engineering repository/action permissions. Imported selections SHALL never grant jobs, model access or owner authority.

#### Scenario: Notification target not engineering-allowlisted
- **WHEN** an authorized private import selects a valid GitHub target outside the engineering allowlist
- **THEN** owner-only notification observations may proceed within budgets while engineering operations remain forbidden

### Requirement: Private lifecycle and overlapping observations
Imported notification targets SHALL remain private to the owner's audited destination and SHALL use existing owner-only list/cancel/Forget controls. Their allowlist independence SHALL never bypass native watch add authorization. Imported typed-event delivery SHALL take precedence over overlapping native proactive events so the same event does not appear twice.

#### Scenario: Cancel and repeat import
- **WHEN** the owner cancels a notification-only target and repeats the same import
- **THEN** the target remains cancelled and no allowlist auto-cancellation or reactivation occurs

#### Scenario: Imported target overlaps native feed
- **WHEN** an event is eligible for both imported private notification behavior and a native feed/watch
- **THEN** the defined precedence emits it once without exposing imported personal state to a shared channel

### Requirement: Explicit event transition continuity
The system SHALL preserve audited typed checkpoint and event identity semantics including alert/digest settlement. It SHALL reconcile the stopped-notifier transition window before advancing cursors, explicitly represent missing baselines and partial reads, and never silently reset to a snapshot baseline or drop required event types/pages.

#### Scenario: Transition event already settled
- **WHEN** a first target observation contains an imported settled event and an unseen transition event
- **THEN** the settled event stays suppressed, the unseen event follows its audited delivery policy and only complete observation progress advances

#### Scenario: Incomplete observation
- **WHEN** a required page/surface fails or cannot yet be represented
- **THEN** that surface's cursor does not falsely advance, retry progress remains durable and no lossless-parity claim is made
