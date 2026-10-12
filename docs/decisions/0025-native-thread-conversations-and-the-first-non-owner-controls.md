# ADR 0025 — Native thread conversations, and the first controls a non-owner may press

**Status:** accepted
**Supersedes** [ADR 0021](0021-bounded-conversation-continuity.md) §2 and §3 in
part, and reverses the "follow-only" proposal recorded in
[docs/ROADMAP.md](../ROADMAP.md). It extends [ADR 0023](0023-channel-roles-and-persistent-replies.md)
and leaves [ADR 0009](0009-env-config-sole-authorization-authority.md) and
[ADR 0012](0012-opt-in-shared-job-visibility.md) untouched.

## The contradiction this resolves, stated first

The roadmap assessed Discord thread continuity and proposed the **narrow**
version: `DUCKY_THREAD_CONTINUITY=off|follow`, where a thread the owner made by
hand would inherit its parent's role, and **"Ducky would still create no
thread."** The reason given was sound — auto-creating a thread is Ducky writing
objects into the owner's guild on inference.

Issue #4 asks for the wide version, in the owner's own words: *each new
top-level user message in configured chat/agent conversation channels creates
exactly one normal visible thread.* That is the opposite of "creates no
thread".

**The issue wins, because the owner is the person the roadmap was protecting.**
The roadmap's caution was about doing something the owner had not asked for;
once they ask for it, the caution has nothing left to protect. What survives is
the *mechanism* the roadmap derived: the opt-in has to name which channels may
sprout threads, rather than being a boolean.

So `DUCKY_*_THREAD_PARENT_CHANNEL_IDS` is a **list of channels**, empty by
default. An instance that names none behaves exactly as every instance did
before this. The roadmap section and `CURRENT_STATE.md` are updated to record
the reversal rather than quietly agreeing with whichever document was read last.

## The decision

### One thread per qualifying starter, and the thread IS the conversation

A qualifying top-level message opens one normal, visible Discord thread, and
that thread's id becomes the conversation's `threadKey`. Memory, participation
and the provider session all key on it, so nothing has to translate between two
identities.

"Qualifying" is a pure policy over frozen configuration and transport context,
so every branch is testable with no Discord at all:

- the feature is configured, and the channel is one of the named parents;
- a **person** sent it. A bot, a webhook, or an author kind the transport could
  not determine is excluded — `unknown` is treated exactly like a bot, so a
  notification feed cannot carpet a configured channel with threads;
- it is a **guild** channel, and not already a thread;
- it is not a shared channel, and not a thread under one;
- the sender is conversationally authorized by the **existing** `Authorizer`.

The effect sits behind a `ThreadStarter` port implemented by the one module
allowed to import discord.js, and faked by the mock transport — so the tests
exercise the real decision, the real mapping write and the real rerouting.

### Failure is visible and never falls back to the parent

A missing permission, a rate limit or an unreachable channel produces a refusal
naming the cause, **and no answer anywhere**. Replying in the parent instead
would publish the answer into a different conversation with a different
audience, which is the precise leak the per-thread design exists to prevent.

`MESSAGE_ALREADY_HAS_THREAD` (160004) is recovered rather than treated as a
failure, by Discord's own documented identity: a thread created from a message
carries that message's id. So a crash between the API call and the database
write rejoins the first thread instead of opening a second beside it. The
mapping's `starter_message_id` is UNIQUE, which makes the same guarantee hold
for two concurrent starters.

### A thread inherits its parent's role, and nobody's rights

`ChannelRolePolicy.roleOf` falls back to `parentChannelId`. This fixes both
faults the roadmap recorded: a thread under the configured `gpt` channel was
silenced (a thread's id is not its parent's), and a thread under a role channel
lost reply persistence.

**Role is still presentation.** It answers *where does this output belong, and
does it persist*; it has never answered *who may act*. `Authorizer` reads frozen
environment configuration and nothing else. A test drives every owner-only
command from inside a thread as the extra chat user and gets the same `not
authorized` refusal they get anywhere else.

The same `parentChannelId` is also an **exclusion** input: a thread under a
shared channel is no more private than the channel is, so it never becomes a
conversation store. That is a separate method (`touchesSharedChannel`) from the
one deciding which requests get the shared projection, because widening the
projection to parents would make a thread serve its parent's job list — a
visibility change nobody asked for.

### Full transcript while the thread lives; the bound moves to what is SENT

ADR 0021 §4 capped every thread at 200 rows because an unbounded thread is a
transcript nobody asked for. Issue #4 asks for exactly that transcript, for a
native thread, while it exists.

So the cap became a property of the **caller**: `ConversationMemoryService`
passes the row cap for an ordinary channel or DM, and passes 0 — uncapped — for
a thread it holds a mapping row for. Nothing else may pass 0.

What bounds the system instead is a **byte budget on the prompt**. Bytes, not
tokens, and that is the honest part: no provider on this host reports a token
limit, and a token count derived from characters would be a measurement nobody
made. When a conversation outgrows the budget, compaction folds older turns into
a checkpoint table and keeps the recent ones verbatim, progressively harder
until it fits. Manual Compact and automatic compaction are the same method with
a different `keep`, so the two cannot drift.

Three properties hold throughout:

- **Context assembly is all-or-nothing.** A version that filled the budget
  newest-first and stopped would drop turns that left no trace anywhere, so the
  model would answer from a conversation it was never told was incomplete.
- **Compacting deletes nothing** — not a stored turn, not a Discord message.
  The reply says so in those words, because "compact" means "delete" in enough
  other tools that an owner should not have to find out by trying it.
- **A turn that cannot be brought under the budget is refused**, before the
  provider is called and before anything is stored.

The checkpoint is built **deterministically, by excerpting**, not by asking a
model. A generated summary would need a provider call that can fail, costs
budget, and can invent a decision nobody made; an excerpt can only
under-report. It carries the number of turns it stands for, so a reader can see
it covers more than it quotes, and the full transcript stays queryable.

### ADR 0021 §2 is superseded by a stronger rule, not dropped

§2 said every `ConversationsRepo` method takes a user id and puts it in the
WHERE clause, and that there is deliberately no thread-only read. That rule
cannot express a **shared** conversation, which is what a visible thread is.

The replacement is not weaker. A thread-scoped read takes a
`ParticipationProof`, and the only function that returns one is
`ConversationThreadsRepo.proveParticipation`, which returns `undefined` unless a
row exists in `conversation_participants`. Participation rows are written when
somebody **speaks**, never on a read — so *being able to see a thread is not
being in it*, and a reader who only watched can have nothing replayed to them.
There is no overload taking a bare thread id, so the check cannot be skipped by
a caller who forgot it.

§3 (a shared channel is excluded, matched on thread key) is widened rather than
reversed: the parent is checked too.

### The first two controls a non-owner may press

`CONVERSATIONAL_INTERACTION_KINDS` is a **positive manifest**, declared beside
`OWNER_ONLY_INTERACTION_KINDS` rather than defined as "whatever is not
owner-only". The router registers them into a separate map and asserts, at
construction, that the owner-only map equals its manifest exactly, that the two
manifests are disjoint, and that their union is the complete registered set. A
control therefore cannot become non-owner-pressable by omission.

Both act on a conversation the presser is already in, and neither can reach a
record, a job, a repository or a credential:

- **Compact** replaces what the model is sent with a summary plus recent turns.
- **Branch** opens a separate visible thread seeded with the one anchor the
  presser explicitly selected.

Three independent checks run on every press, because none covers the others:

1. the **signature**, bound to the presser — a control copied out of scrollback
   does not verify for anybody else;
2. **conversational authorization**, from the frozen `Authorizer` — removing
   somebody from the whitelist stops controls they already hold, with no
   migration;
3. **participation**, re-read from the database on every press.

Which gate applies is chosen from the id's kind segment before verification,
and that is safe because the choice only ever selects a *narrower* gate and the
signature still has to verify afterwards. The MAC covers the kind, so an
owner-only control cannot be routed down the conversational path by editing its
text.

`SHARED_READABLE_ROUTES` is unchanged and still contains only reads. No
interaction kind — owner-only or conversational — is shared-readable, and the
router asserts that over the union now rather than over the owner-only list.

### Branch seeds a checkpoint, not a turn

The anchor was said in **another** thread. Writing it into `conversation_turns`
would claim it was said in this one, which is the same dishonesty the table's
missing `system` role exists to prevent. So it is written as a labelled
checkpoint: *carried over from the message this conversation was branched
from*.

A branch is a standalone thread in the same **parent channel**, because Discord
has no thread-on-a-thread. That also keeps it visible to exactly the people who
could already see the source. `branched_from` records provenance and is the only
link between the two conversations; no context is ever read along it.

### A reply anchors inside its own thread, or not at all

A reply's reference is included only when it is present, carries text, and is in
the **same visible thread**. A reference to another channel or thread is
labelled unavailable in the reply's footer and dropped — importing it would pull
another conversation into this one. Either way a reference never changes which
conversation the message belongs to.

Whose words the anchor is comes from the frozen authorizer, not from anything
Discord said: a conversational actor's message is a `user` turn, anything else
in the thread is Ducky's own and is an `assistant` turn. Mislabelling would hand
the model an answer as though somebody had asked it.

## What this does NOT change

- **No new owner-only command.** `OWNER_ONLY_COMMANDS` is byte-for-byte
  unchanged, and a test asserts the list.
- **Authorization never reads the database.** ADR 0009 is untouched;
  participation decides what may be *replayed*, never what may be *done*.
- **Shared projections stay narrow.** ADR 0012 is untouched.
- **Profile isolation.** The parent list is profile-scoped like every other
  cross-profile setting, and production never inherits the unscoped or
  development value.
- **No wipe-all.** `FORGET_TARGETS` is unchanged and still cannot express one.

## Residual risks, stated plainly

**A live thread's transcript is unbounded.** That is what the issue asked for,
and it is a real cost: the longer a conversation runs, the more of somebody's
words sit on disk. The mitigations are that memory is off by default, that the
feature needs a named parent channel, that retention reaches a thread once it is
closed, and that `/forget conversation` removes every turn. None of them makes
the live thread small.

**A guest cannot delete their own words.** `/forget` is owner-only and stays
that way — it is a write, and widening it would widen the owner-only surface. A
chat user who wants their turns removed has to ask the owner, who can do it.
This is recorded in [SECURITY.md](../SECURITY.md) rather than solved, because
the alternative is a non-owner deletion path.

**Ducky cannot verify that a configured parent channel is private**, exactly as
ADR 0023 says of role channels. Naming a channel here is the owner asserting
that a conversation belongs in it.
