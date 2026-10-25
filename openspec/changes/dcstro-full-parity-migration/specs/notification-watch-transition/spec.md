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
The ordinary watch SHALL name a requested-changes review exactly only when it is absent from the last COMPLETE set of that pull request's submitted reviews (the bounded `reviews` list, never the per-author view), identified by a hash of the provider's review id and its canonical submission instant, excluding pending reviews and reviews without a submission instant, and never because a review's state changed. Review observations SHALL be complete, unavailable or truncated (100 or more reviews): an unavailable or truncated read, including a successful answer that omits a field, SHALL carry the last proven values of every review-derived field forward, SHALL absorb nothing it did not see, SHALL create no message and no claim by itself, and a complete read after a gap SHALL tell the reviews that arrived during it. A first or legacy observation SHALL establish silently, a legacy snapshot SHALL be compared and rendered through its legacy projection only, and afterwards the fingerprint SHALL cover every rendered review fact. The PR-level decision lines SHALL remain distinct facts with no per-review claim. A conversation-comment count SHALL be labelled as such and claim no review. A pull request SHALL be told as opened, with an opening claim, only when it is absent from the previous snapshot AND its canonical creation instant is strictly later than the durable boundary (the host instant before the previous successful complete read started) plus the skew margin; otherwise it SHALL be labelled newly listed with no claim. A pull request absent from the whole fetched list (the rich slice and the rest of it) SHALL be labelled no longer listed, never closed, and that label SHALL claim and suppress nothing.

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

### Requirement: Observed-state review families, decisions and per-author lines
A submitted review SHALL be a fact in an OBSERVED STATE (requested changes, approved, commented, dismissed), keyed by pull request, identity domain and state, and no key or index SHALL be shared across states: the same review can be told approved and later dismissed, and both tellings are accepted source behaviour. A dismissal SHALL mean only that the review was observed DISMISSED: no dismissal time, actor or cause SHALL be recorded or invented, and the provider's submission instant SHALL be only an identity discriminator. A stored hash SHALL carry its domain (the provider's review id, or the imported event's own identity when it carried none), hashes of different domains SHALL never be equal and never proof of a different review, and an imported row SHALL record the hash of the REST node id, the state it was observed in and the provider's own submission instant only when the provider supplied one (an unknown instant or state SHALL stay unknown, never guessed or replaced by "now" or the update time). The target SHALL keep one row per kind and identity with its legacy wording, SHALL NOT report a dismissal of a review its cursor has passed, and SHALL withhold, count and never deliver as a fact a row whose known state is an impossible successor of another row of the same review. The ordinary summary SHALL tell a new review in its own state and a known review observed dismissed, claiming only that state's key and only for a whole shown segment, SHALL refuse (as an unavailable read, carrying the last proven facts and counting it) a read in which a review left the list or changed state other than to DISMISSED, and SHALL upgrade a version 2 snapshot without swallowing a review the old facts already prove new. A changed review decision SHALL be a distinct, unclaimed line between two values from reads that carried one. A per-author line SHALL name no review and claim none; it SHALL be left out only where a complete comparable observation holds same-class exact facts that are actually shown, SHALL return when such a fact was cut off or redacted, SHALL be labelled when no exact list could identify it or when its exact facts were not conveyed, and SHALL then be recorded as durable, counted, never-cleared evidence (with the reason no comparison, unavailable, truncated or not conveyed) only by the send that delivered it. Two known submission instants that differ SHALL prove two different reviews on both sides, and a known review's dismissal SHALL be held against a compatible target claim unless the previous complete set recorded that review in a known not-dismissed state and the target claim was committed before that read began (an unknown, identity-only or boundary-less prior state SHALL give no proof). These counterparts SHALL be exempt from the migration-36 cutoff, with migration 38 recording provenance only.

#### Scenario: One review, two states
- **WHEN** the ordinary watch tells a review approved and a later complete read observes the same review dismissed
- **THEN** each telling claims only its own state's key, the dismissal names no time, and neither suppresses nor holds the other

#### Scenario: Dismissal the target cannot see
- **WHEN** a review's submission is already at or before the target's pulls cursor and it is then dismissed
- **THEN** the target emits no event for it and a native dismissal observation has no target counterpart

#### Scenario: Impossible state change
- **WHEN** a known review is read approved then requested changes, or leaves the list, or a dismissed review is read approved
- **THEN** the ordinary read is refused with the last proven facts kept and counted, and a target row for it is recorded but withheld as a state conflict and never delivered

#### Scenario: Version 2 upgrade
- **WHEN** a version 2 snapshot is upgraded and a genuinely new approved review is present while the old projection is unchanged
- **THEN** the review is told and claimed, a requested change the old snapshot recorded is claimed when dismissed, and a review the old snapshot knew only by identity is established silently

#### Scenario: Decision beside a review
- **WHEN** a review decision changes in the same pass as a new approved review
- **THEN** both are told, the decision claims nothing and is not suppressed, and no cause is asserted

#### Scenario: Per-author line during a gap
- **WHEN** a per-author approvals line is delivered while the exact review list is unavailable
- **THEN** the line is labelled, a durable gap marker is written only after the send succeeds, and recovery, cancellation and retention never clear it

#### Scenario: Exact segment cut off
- **WHEN** the clamp or a redaction prevents an exact review segment from being shown in full
- **THEN** no receipt is written for it, the per-author line it would have replaced is shown labelled, and once delivered it is recorded as a durable `not_conveyed` marker (shown or not provably shown) that counts in status, verify and the export

#### Scenario: Dismissal of a review recorded undismissed
- **WHEN** a known review recorded approved is observed dismissed while a compatible target claim was committed before the read that recorded it approved
- **THEN** the dismissal is told, and when the prior state was unknown, identity-only, or no boundary was recorded, or the target claim is not older than that read, it stays held

#### Scenario: Unknown instant
- **WHEN** an imported review row has no known submission instant and a compatible native fact on the same pull request was delivered
- **THEN** the row is withheld, counted and never delivered, while a known submission instant that differs from the native fact's (earlier or later), or a known later one when the native instant is unknown, proves a different review

### Requirement: Exact pull request closes in the ordinary summary and the briefing
A pull request close SHALL be an exact transition: the pull request number AND the provider's canonical close instant, never the number alone. The ordinary watch SHALL tell and claim a close only from the pull request list's own explicit evidence (raw state exactly CLOSED, a merge field present and explicitly null, a valid number and a readable close instant, with the optional per-pull-request read allowed only to confirm it and any merge instant or non-CLOSED state it supplies contradicting the list), only as a change against a comparable previous snapshot, and only as a segment shown in full; it SHALL never infer a close from a disappearance, an update time or a missing, empty or non-null merge field. A pull request beyond the rich slice of the fetched list SHALL keep minimal lifecycle evidence so that its close or merge is applied with no extra read, and one first seen there SHALL establish silently. A change of state to CLOSED and of the update instant alone SHALL be told only by its close segment. An imported close SHALL be reserved, settled and receipted only when its number and literal canonical UTC instant are proven byte-exact inside one retained close line of the final briefing output after the transport's own sanitization; failed, queued, in-flight, clipped, redacted, dropped or abandoned output SHALL never be a receipt, and an unproven close SHALL stay pending and be counted with the age of the oldest in owner status, import verification and the versioned rollback export. A close the target settled before exact receipts existed SHALL NOT become a receipt: it SHALL be permanent, identifiers-only uncertainty that holds, counts and never clears a matching native close.

#### Scenario: A real close
- **WHEN** a pull request the previous snapshot held open is listed with state CLOSED, an explicit null merge field and a readable close instant
- **THEN** the summary names it with its canonical instant and claims exactly that close, no generic update retells it, and a second read, a restart and the target's own event for it tell nothing again

#### Scenario: Not a close
- **WHEN** a pull request disappears from the list, only its update time moves, its merge field is missing, empty or set, its close instant is missing or unreadable, or the per-pull-request read contradicts the list
- **THEN** no close is told or claimed, a disappearance is only "no longer listed", and a contradiction creates no new merge claim either

#### Scenario: Reopened and closed again
- **WHEN** a closed pull request is reopened and closed again at a different instant
- **THEN** the second close is told and claimed under its own key and the first close's receipt never covers it, while an equal instant shares one key because the approved data cannot tell the two apart

#### Scenario: Upgrade from a version 3 snapshot
- **WHEN** the previous snapshot is version 3 and the read only gains the close proof of an already closed pull request
- **THEN** nothing is told, while a real change to an older field in the same read, or a pull request the previous snapshot held open that is now closed, is still told

#### Scenario: Beyond the rich slice
- **WHEN** a previously stored pull request drops out of the five richest but is still in the fetched list and is closed or merged
- **THEN** the close or merge is applied with no extra read, it is not called no longer listed, and one first seen only there establishes silently

#### Scenario: A briefing that cut a close off
- **WHEN** a close line is dropped by the per-repository line cap, the field clamp, the field or total budget, or its repository heading or line is rewritten by redaction
- **THEN** the close is neither reserved nor settled, it stays pending and counted with the age of the oldest, and a close that is proven in the sent output is settled while an unproven one is not

#### Scenario: A close the target settled before exact receipts existed
- **WHEN** a native exact close matches an imported close that carried a delivery or settlement marker before migration 39
- **THEN** it is held durably and counted, not sent, unless a real target receipt for that very close exists (checked first), and the uncertainty survives deleting the event or target and is never cleared

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
