## ADDED Requirements

### Requirement: Complete notification-only selection
The system SHALL privately derive the effective selection from all existing owner notification watches and audited filters. Targets SHALL have bounded hard capacity and fair read-throughput budgets independent of frozen engineering repository/action permissions. Imported selections SHALL never grant jobs, model access or owner authority.

#### Scenario: Notification target not engineering-allowlisted
- **WHEN** an authorized private import selects a valid GitHub target outside the engineering allowlist
- **THEN** owner-only notification observations may proceed within budgets while engineering operations remain forbidden

### Requirement: Private lifecycle and overlapping observations
Imported notification targets SHALL remain private to the owner's audited destination and SHALL use existing owner-only list/cancel/Forget controls. Their allowlist independence SHALL never bypass native watch add authorization. The owner SHALL be told each exact transition once, by whichever path actually DELIVERS it first: a native path SHALL skip an item only for a transition the imported target has delivered, and an imported event a native path already delivered SHALL be settled silently. No native notification SHALL be suppressed on a promise of future coverage. Counts, unnamed aggregates, snapshots, skipped or baseline rows and timestamps alone SHALL NOT be receipts. Aggregate/detail overlap therefore remains UNRECONCILED, and each unfinished overlap (the PR-level approval and requested-changes decisions, a pull request newly listed without proof of opening, a pull request no longer listed, issue-count lines, workflow-run lines, the actionable follow-up and the submitted approved/commented/dismissed review families) SHALL stay a required merge blocker, never an accepted residual.

#### Scenario: Cancel and repeat import
- **WHEN** the owner cancels a notification-only target and repeats the same import
- **THEN** the target remains cancelled and no allowlist auto-cancellation or reactivation occurs

#### Scenario: Imported target overlaps native feed
- **WHEN** an event is eligible for both imported private notification behavior and a native feed/watch
- **THEN** the path that delivers the exact transition first owns it and the other tells nothing about it, without exposing imported personal state to a shared channel

#### Scenario: A delivered feed card first, or a delivered digest first
- **WHEN** a native card was delivered to the owner's DM or the configured public channel before the imported event is decided, or the imported briefing delivered it before the native card is sent
- **THEN** the later path tells nothing about that exact transition, settles it without a delivery of its own, and tells every other item and count unchanged

#### Scenario: A send that did not happen
- **WHEN** a native or imported send fails, is abandoned, is retired, is cancelled or its crash left an unknown outcome
- **THEN** its reservation is released (a crashed imported send returns to pending and is never a receipt) and the other path may tell it; nothing expires by elapsed time

#### Scenario: A requested-changes review compared by id
- **WHEN** a native card and an imported event name the same pull request
- **THEN** they match only by exact equality of the review node id (hashed), never by timestamp alone; a review whose id is missing or unequal is never told twice: the imported event is withheld while a native card could be the same review, and a native card is HELD (durably, neither sent nor skipped nor receipted, counted) when the target delivered a review of that pull request whose provider instant is equal or unknown; a review with a provably different provider instant is delivered; live equality of the two ids is a required evidence gate

#### Scenario: History the ledger cannot place
- **WHEN** a database is not verifiably new and an imported event with a native counterpart occurred at or before the migration cutoff plus one second with no exact receipt
- **THEN** the event is withheld together with its advancing cursor, is neither delivered nor settled, is counted in status, verification and export, has no clearing control and remains a required cutover blocker

### Requirement: Explicit event transition continuity
The system SHALL preserve audited typed checkpoint and event identity semantics including alert/digest settlement. It SHALL reconcile the stopped-notifier transition window before advancing cursors, explicitly represent missing baselines and partial reads, and never silently reset to a snapshot baseline or drop required event types/pages.

#### Scenario: Transition event already settled
- **WHEN** a first target observation contains an imported settled event and an unseen transition event
- **THEN** the settled event stays suppressed, the unseen event follows its audited delivery policy and only complete observation progress advances

#### Scenario: Incomplete observation
- **WHEN** a required page/surface fails or cannot yet be represented
- **THEN** that surface's cursor does not falsely advance, retry progress remains durable and no lossless-parity claim is made

#### Scenario: Transition while a first observation spans pages
- **WHEN** a new runs or releases baseline spans pages and an older-created item settles or publishes before its own page is read
- **THEN** the baseline commits the boundary frozen before its first request, delivers no history, and the next pass announces that transition exactly once, including across a failed first request or a drift restart

#### Scenario: First inventory beyond the bounded capacity
- **WHEN** a new runs or releases baseline cannot prove its whole inventory within the page cap (100 or more items)
- **THEN** the surface is refused visibly as `window_exceeded` with its cursor still null and no recovery claimed, never baselined shallowly, and the limitation stays a named required blocker

### Requirement: Exact requested-changes reviews and proven openings in the ordinary summary
The ordinary watch SHALL name a requested-changes review exactly only when it is absent from the last COMPLETE set of that pull request's submitted reviews (the bounded `reviews` list, never the per-author view), identified by a hash of the provider's review id and its canonical submission instant, excluding pending reviews and reviews without a submission instant, and never because a review's state changed. Review observations SHALL be complete, unavailable or truncated (100 or more reviews): an unavailable or truncated read, including a successful answer that omits a field, SHALL carry the last proven values of every review-derived field forward, SHALL absorb nothing it did not see, SHALL create no message and no claim by itself, and a complete read after a gap SHALL tell the reviews that arrived during it. A first or legacy observation SHALL establish silently, a legacy snapshot SHALL be compared and rendered through its legacy projection only, and afterwards the fingerprint SHALL cover every rendered review fact. The PR-level decision lines SHALL remain distinct facts with no per-review claim. A conversation-comment count SHALL be labelled as such and claim no review. A pull request SHALL be told as opened, with an opening claim, only when it is absent from the previous snapshot AND its canonical creation instant is strictly later than the durable boundary (the host instant before the previous successful complete read started) plus the skew margin; otherwise it SHALL be labelled newly listed with no claim. A pull request absent from the capped snapshot SHALL be labelled no longer listed, never closed.

#### Scenario: A new review beside old ones
- **WHEN** a complete read shows a requested-changes review the previous complete set did not contain
- **THEN** the summary names the pull request once, claims exactly that review, claims none of the older ones and does not repeat the same event as an aggregate line

#### Scenario: Unplaceable review
- **WHEN** the imported target delivered a review of the same pull request with a different id at an equal or unknown provider instant
- **THEN** the review is neither told, dropped nor receipted: it becomes its own durable held row (unique per watch and exact transition, kept through cancel, restart and retention, counted in status, verify and export), and the rest of the summary is delivered

#### Scenario: Target send in flight
- **WHEN** the imported target is sending an item the summary would name
- **THEN** the whole observation defers with nothing persisted and proceeds when the send settles or is released

#### Scenario: Several native holders
- **WHEN** a feed card and a summary both reserve one exact transition and either is abandoned
- **THEN** each keeps its own ledger row, a delivery or release touches only its own, and the other's receipt still settles the imported event

#### Scenario: Opening not proven
- **WHEN** a pull request enters the capped list but was created before the boundary, at it, within the skew margin, with no creation time, after a failed read or on a legacy observation
- **THEN** it is labelled newly listed and carries no opening claim

### Requirement: Owner monitoring control with exact pause provenance
The owner SHALL set the global notification-monitoring switch explicitly on or off through the existing owner-only watch command. Setting the state it already has SHALL create no row, change no timestamp, open no pause period and write no audit row. A change SHALL write the switch, its pause period and its audit row in one transaction at the injected time. An owner pause SHALL record its real start; an imported pause, or one recorded before provenance existed, SHALL record no real start, only the latest instant it is known to have begun. A pause period is provenance only and SHALL NOT suppress or authorize any delivery. Neither direction SHALL change a target, checkpoint, pending event, failure count or call budget, and pausing applies at the next tick. Resuming SHALL NOT be refused because native history exists: what native paths delivered SHALL be reconciled per exact transition as targets observe, and only an unreadable ledger boundary SHALL refuse. A resume SHALL NOT reset a checkpoint, and a repeated import SHALL NOT override the owner's choice (verification reports the difference).

#### Scenario: Ordinary-watch history of any age
- **WHEN** an ordinary watch row is retained, cancelled at any time and whatever repository its slug names today
- **THEN** turning monitoring on succeeds, the switch changes, every checkpoint is unchanged, and events a native path told are not told again while events that predate the ledger are withheld and counted

#### Scenario: Same state again
- **WHEN** the owner sets the state monitoring already has
- **THEN** nothing is written and the reply says nothing changed

#### Scenario: A slug now names another repository
- **WHEN** an ordinary watch bound to one repository finds its slug mapped to another
- **THEN** the watch stops with a recorded reason, its snapshot and outbox are kept, no repository is diffed against another, no DM is sent and a count appears in status
