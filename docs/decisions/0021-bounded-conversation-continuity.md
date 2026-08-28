# 0021 — Bounded conversation continuity, off by default

## Status

Accepted, and shipped disabled.

## Context

Until this decision Ducky stored nothing a person said in conversation. That was
a real guarantee, stated in `CURRENT_STATE.md` and answered by `/forget
conversation` with a statement of fact: there is no transcript table, so there
is nothing to delete.

It was also a real limitation. A conversation with no continuity cannot answer
"and what about the second one?", so every message had to be self-contained.
The milestone asks for bounded per-user continuity with reset, thread isolation
and no shared-channel leakage — which means storing something.

Storing what somebody said is the most sensitive thing this system has ever
written to disk. Job data is about repositories; a conversation is about the
person. So the decision is less "add a table" than "under what constraints is
this defensible".

## Decision

Store conversation turns, bounded, isolated, deletable — and **off unless an
operator turns it on**.

1. **`DUCKY_CONVERSATION_MEMORY_ENABLED` defaults to false.** With it off,
   nothing is read and nothing is written, so the previous guarantee holds
   exactly as it did. An instance that never sets it behaves as it always has.
2. **Isolation is structural, not careful.** Every method on
   `ConversationsRepo` takes the user id and puts it in the WHERE clause. There
   is deliberately no `byId`, no `listAll`, and no thread-only read: a method
   that could return another account's words would be the entire risk in one
   signature, so it is not written. Two people in the same channel have two
   histories.
3. **A shared channel is never a conversation store.** A message event carries
   no channel context, but its thread key IS the channel id — so the configured
   `SHARED_CHANNEL_IDS` are excluded from both reading and writing. A channel
   other people can read never becomes a store of the owner's words, nor a
   source of context replayed into a prompt.
4. **Bounded three ways.** A replay window (`DUCKY_CONVERSATION_MEMORY_TURNS`,
   default 10), a hard row cap per (user, thread) enforced in the same
   transaction as the insert, and a per-turn length cap. A turn over the cap is
   stored **visibly truncated**, because a silently halved sentence replayed as
   context is a small lie about what was said.
5. **Two retention windows, because the owner and a guest are not the same
   thing.** 30 days for the owner's own history, 7 for anyone else on the chat
   whitelist. Collapsing them would mean choosing between keeping a guest's
   messages as long as the owner's or throwing the owner's away as fast as a
   guest's.
6. **`/forget conversation` now deletes.** One step, because there is no id to
   confirm and no live-work reason it could be refused. It deletes every thread
   for that user, reports the COUNT, and audits the count — a deletion record
   that quoted what it deleted would defeat the deletion. It works even when
   continuity has since been switched off, because rows an earlier run stored
   are still the owner's to remove.
7. **No `system` role.** The `role` column allows `user` and `assistant` only. A
   stored preamble would be configuration masquerading as history, and nothing
   may put words in this table that the owner or Ducky did not actually say.

## Consequences

- `CURRENT_STATE.md` can no longer say "nothing is stored" unconditionally. It
  now says what is true: nothing is stored **unless** continuity is enabled, and
  here is exactly what is stored and for how long when it is.
- The provider port grows an optional `history`. Optional on purpose: continuity
  is the coordinator's feature, and a provider is never obliged to use it. Both
  shipped stand-ins ignore it.
- On this host the feature is close to inert: no conversation provider is
  verified, so the only thing that can consume history is the marked mock. It is
  built now because the storage, isolation and deletion rules are the part that
  must not be retrofitted around a provider later.
- `FORGET_TARGETS` is unchanged. `conversation` was already a target; it now
  does something. There is still no bulk form and no wildcard.

## Alternatives rejected

- **Keep storing nothing.** Honest, and the reason it lasted this long. But the
  milestone asks for continuity, and "we cannot do that safely" is not true —
  the constraints above are what makes it safe.
- **Store history in memory only.** Survives no restart, which makes it useless
  for anything but a single sitting, and it would have made `/forget` a lie in
  the other direction (nothing to delete because it evaporated, not because it
  was never kept).
- **One retention window for everyone.** Simpler, and wrong in both directions.
- **Key history by thread alone.** Would have let anyone who can post in a
  channel read the owner's context out of it, which is precisely the legacy
  failure mode `PROJECT_CONTEXT.md` calls out.
