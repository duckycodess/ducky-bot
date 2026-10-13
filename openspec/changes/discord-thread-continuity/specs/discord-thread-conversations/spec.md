# Discord thread conversations

## ADDED Requirements

### Requirement: Native visible conversations
Qualifying non-bot/non-webhook top-level user messages in explicitly configured conversational guild channels SHALL create one normal visible native Discord thread per starter message, and SHALL route the starter and all later messages to that thread. Thread creation failure SHALL produce an honest refusal rather than routing into a shared parent session. Unconfigured or non-chat-purpose channels, DMs, bot and webhook messages SHALL not spawn threads.

#### Scenario: Starter followed by native thread reply
- **WHEN** an authorized user writes in a configured conversation parent and then writes in its new thread
- **THEN** there is one visible thread, both turns use its durable identity, and no child thread is spawned.

### Requirement: Scoped reply and branch
A reply to an earlier message SHALL keep the current thread's conversation and include an explicitly identified bounded reference from the same visible thread; unavailable or cross-thread references SHALL never silently import another conversation. Branch SHALL create a separate visible thread and fresh context, seeded only with an explicitly selected permitted anchor, never hidden history from another thread.

#### Scenario: Old-message reply and branch
- **WHEN** a participant replies to an older message and then branches from it
- **THEN** the reply includes the older anchor in the current conversation, while the branch has a distinct session and cannot replay unselected turns.

### Requirement: Durable history with bounded context
Application transcript SHALL retain full turns for a live thread across restart, separately from a bounded model-context window and compact summary/decisions. Manual Compact and automatic near-limit compaction SHALL preserve recent turns and durable decisions without deleting application or Discord-visible history. Context SHALL remain within a measured/configured provider budget; if it cannot be bounded, a turn is refused before sending.

#### Scenario: Restart and compaction
- **WHEN** a thread is restarted after compacting an old conversation
- **THEN** full transcript remains queryable by authorized scope, while the provider gets the compact checkpoint and recent turns only.

### Requirement: Participation is explicit and authorization stays independent
Only authorized conversation actors who explicitly participate in a visible shared thread SHALL have that thread's context replayed. Private runtime records, unrelated threads and other users' private sessions SHALL not be silently imported. Channel/thread visibility SHALL NOT authorize owner commands or controls; the configurable extra user has conversation access only.

#### Scenario: Extra user sees owner control
- **WHEN** an additional chat user presses an owner workflow control visible in a thread
- **THEN** the action is refused even when their message may participate in the conversation.

### Requirement: Targeted two-store Forget
Forget SHALL target a specified conversation scope, delete the corresponding application turns and supported provider session state, and prevent a failed provider deletion from resurrecting prior context. It SHALL audit deletion counts without content and explicitly report unsupported/incomplete provider deletion. Forget SHALL NOT delete Discord-visible threads or unrelated sessions.

#### Scenario: Provider deletion unavailable
- **WHEN** application deletion succeeds but provider deletion cannot be verified
- **THEN** the result reports partial deletion and further turns cannot reuse the stale provider session.

### Requirement: Native thread limitations
Archived, locked, inaccessible or missing threads SHALL have explicit failure/recovery handling without widening owner permissions or silently falling back to another session.

#### Scenario: Locked thread
- **WHEN** a reply cannot be delivered to the locked thread
- **THEN** no fallback answer is published in a parent or unrelated thread.
