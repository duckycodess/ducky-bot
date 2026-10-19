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

### Requirement: Owner monitoring control that never replays native notifications
The owner SHALL set the global notification-monitoring switch explicitly on or off through the existing owner-only watch command. Setting the state it already has SHALL create no row, change no timestamp and write no audit row. A change SHALL be audited in the same transaction. Neither direction SHALL change a target, checkpoint, pending event, failure count or call budget. The switch is global. Turning monitoring on SHALL be refused for ALL targets while any ordinary watch row is retained (its repository cannot be proven, because its allowlist mapping is rewritten at every boot) or a selected feed repository, active or cancelled, overlaps an active target, because pause provenance and native delivery history are not proven; a repeated import SHALL NOT be a workaround; it SHALL NOT reset a checkpoint, SHALL NOT offer deleting native rows as a remedy, and exact cross-path reconciliation remains a required blocker. A repeated import of an unchanged document SHALL NOT override the owner's choice, and verification SHALL report the difference.

#### Scenario: Ordinary-watch history of any age
- **WHEN** an ordinary watch row is retained, cancelled at any time and whatever repository its slug names today, including after the allowlist mapped that slug elsewhere
- **THEN** turning monitoring on is refused for every target with a count and no remedy, and the switch and every checkpoint are unchanged

#### Scenario: Same state again
- **WHEN** the owner sets the state monitoring already has
- **THEN** nothing is written and the reply says nothing changed
