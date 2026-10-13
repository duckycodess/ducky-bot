# ADR 0023 — Channel roles, and persistent replies inside them

**Status:** accepted
**Supersedes nothing.** Extends [ADR 0012](0012-opt-in-shared-job-visibility.md),
which is about a different thing and must not be confused with this one.

## The problem

Every owner reply was ephemeral in a guild. That was the right default and it
had a real cost: the owner could not scroll back to their own task list, their
own briefing, or the job they submitted an hour ago. "Ephemeral" was buying
privacy from people in the channel — and in the owner's own private channel
there is nobody to buy it from.

The request was "public output is fine, I dislike ephemeral replies." That
sentence contains three separable decisions, and two of them were already true:

| | Was it already true? | What it exposes |
|---|---|---|
| Command **discoverability** — commands visible in the guild list | Yes, all 12 registered | Names and descriptions. No data. |
| **Shared projections** — what non-owners see | Yes, deliberately narrow (ADR 0012) | Public job id, slug, coarse state. Never a control. |
| Reply **visibility** — the owner's own replies persisting | **No. This ADR.** | Everything in the reply, to everyone who can read the channel. |

Only the third needed a decision.

## The decision

An owner may configure up to four **role channels** — `briefing`, `task`,
`coding`, `gpt` — each naming one channel they have decided is private enough
for their own output to live in. Inside those channels, and nowhere else, the
owner's replies persist.

### Role is presentation. It is never authorization.

This is the load-bearing sentence of the whole design, and it is the same
sentence ADR 0012 has for shared channels.

`ChannelRolePolicy` answers *where does this output belong, and does it
persist?* `Authorizer` answers *who may act?*, from frozen environment
configuration, unchanged. A non-owner who types an owner-only command in a role
channel gets the same `not authorized` refusal they get anywhere else — and
that refusal stays ephemeral, because a refusal is not owner output.

A friend with read access to the channel may **see** the owner's persistent
messages. That is what configuring a private channel for this means, and it is
the owner's judgement to make about their own channel. They still cannot do
anything: pressing a control they can see is refused by the signature, which is
bound to the owner.

### Controls persist too

A signed control sitting in scrollback is bound to the owner and refuses a
different presser. So this is **disclosure, not privilege escalation** — and
disclosure inside a channel the owner designated private is precisely what was
asked for.

### One documented exception

`/forget`'s confirm step stays ephemeral.

Not because its signature is weaker — it is not — but because a durable
one-press **delete** in scrollback is a different class of object from a task
list. The owner is the person who scrolls back through their own channel, and a
stale confirm button is a hazard to *them*, not to a reader. This is the only
exception, it is named in code (`isPersistenceExempt`), asserted by a test, and
recorded here rather than left implicit.

### Refused at boot: a channel that is both role and shared

A shared channel shows other people a narrow projection. A role channel
persists the owner's replies in full. A channel that is both means the owner's
whole task list in a channel somebody configured for coarse job status.

Resolving that by precedence would be silent whichever way it went, so it is a
startup failure naming both variables. One channel serving two roles is refused
too — not dangerous, but certainly a typo, and one that would send briefings to
the coding channel forever without anybody noticing.

## How persistence is implemented

**One rule, at the router boundary, that can only ever remove ephemerality.**

Not in each of thirty presenters. A presenter chooses ephemerality for a reason
— *this is personal data*, *this is a signed control* — and thirty places each
deciding again is thirty chances to get it wrong for a channel none of them
knows about.

Every condition must hold: the actor is the owner, the request arrived in a
configured role channel, and the reply is not already persistent. The direction
is asserted by test: a presenter that deliberately chose a visible reply is
never made ephemeral by a channel setting.

A DM cannot reach this rule, because a role requires a guild id. That is not an
oversight — a DM channel has an id like any other, so matching on channel id
alone would let a configured role collide with a private conversation. A DM
needs nothing from this anyway: replies there already persist.

## Roles narrow what may fire; they never widen it

A DM and an unconfigured channel have no role, and every deterministic rule
stays live there exactly as before. Nothing an owner relies on today stops
working because they configured a channel for something else.

- `coding` — coding jobs only. A stray "i need to renew the domain" there means
  nothing rather than silently becoming a task.
- `task` — the personal-record writes and the reads describing them. A coding
  job is not a note.
- `briefing` — reads only. It is where output is *delivered*; a channel that
  wrote because somebody typed into it would be a surprise.
- `gpt` — left entirely to the provider. Deterministic rules intercepting
  ordinary sentences is the opposite of what that channel is for, and even a
  bare "yes" belongs to whichever channel proposed something.

### Configuring `gpt` also contains conversation

With the MessageContent intent the bot receives every message in every channel
it can read, so conversation answered anywhere. On a small guild that was
merely noisy; once an owner designates a channel for the model it is wrong
twice over — model output in channels chosen for something else, and
subscription quota spent on strays.

So when, and only when, a `gpt` channel is configured, other **guild** channels
are silent for conversation. DMs are never silenced, because there is no other
channel a DM could belong to. Slash commands are unaffected: a command is an
explicit act and is answered wherever it is typed.

The check sits on the conversation fallthrough, **not** at the top of the
message handler. Putting it earlier silenced the coding channel entirely —
deterministic rules must still run there, and only the fallthrough to the model
is contained. A test asserts both halves.

### Visibility is decided BEFORE the deferral, by one shared rule

`deferReply` fixes whether an interaction's reply is ephemeral, and `editReply`
cannot change it afterwards. The first implementation missed that: the router
faithfully marked a reply persistent *after* routing, the transport had already
deferred it ephemeral, and Discord showed the ephemeral one. The flag was set
and discarded silently — which looks exactly like the feature working.

So the decision moved to where it has to be, and both callers were made to
share it. `ReplyPersistencePolicy` is one object: the transport asks it before
deferring, the router asks it when setting the flag. Two rules could disagree;
one cannot.

It decides on **trusted transport context and the configured owner id only** —
never a channel name (a Discord name is not identity and changes freely), never
the reply text (output must not widen its own exposure). A test asserts both
exclusions against the source.

### A component press still answers privately

Its visibility would be fixed at a deferral that happens *before* the
signature has been verified, so publishing it would mean publishing the refusal
for an invalid or replayed control. The **message carrying the control**
persists, which is what the owner scrolls back to; pressing it answers
privately.

## The coding proposal

Natural-language coding intent is **proposal → explicit confirmation →
`JobsService.submit`**. The same call `/job submit` makes, so every gate stays
where it is: owner check, allowlist, `allowJobs`, placements, reservation, and
the approval gate for anything the job later proposes.

The repository is part of the **grammar** — `implement in <repo>: <task>` — not
a field inferred afterwards. "fix the login bug" names no repository and there
is no safe way to pick one; an assistant that guessed would eventually point a
real agent with edit capability at the wrong working tree. An unknown slug is
refused at proposal time, so the owner is never asked to confirm something that
would fail a moment later.

The capability is passed to `IntentsService` as a **function**, not the service,
so an inferred intent can submit a job and nothing else — not cancel one, not
answer one, not approve an action.

## What this does NOT change

- **No new owner-only command.** `OWNER_ONLY_COMMANDS` is unchanged and no
  interaction kind was added. Roles are configuration.
- **Shared projections stay narrow.** ADR 0012 is untouched.
- **Authorization never reads channel visibility.** ADR 0009 is untouched.
- **Profile isolation.** Role channels are profile-scoped like every other
  cross-profile setting; production reads its own and never inherits.

## Threads under a role channel

**Superseded in one respect by [ADR 0027](0027-native-thread-conversations-and-the-first-non-owner-controls.md).**

When this ADR was written, a role matched on the channel id alone, and a
thread's id is not its parent's. So a thread under a role channel had no role:
replies there fell back to ephemeral, and under `gpt` conversation was silenced
outright — a thread under the channel designated *for* conversation was the one
place conversation did not happen.

A thread now **inherits its parent's role**, through `parentChannelId` on the
incoming context. Both a plain message and a SLASH COMMAND resolve it, through
one shared helper: they did not at first, and the two then disagreed about the
same channel, so `/task list` typed in a thread under the task channel fell back
to ephemeral while a message in that same thread persisted. Everything this ADR says about what a role means is unchanged
by that: it still answers *where does this output belong, and does it persist*,
and it still grants nobody anything. A non-owner in an inherited role channel is
refused exactly as they are in the parent.

### Operator setup for conversation threads

Naming a channel in `DUCKY_*_THREAD_PARENT_CHANNEL_IDS` makes every top-level
message a person posts in it open one visible thread. The bot needs two
permissions **in that channel**:

- **Create Public Threads**, or no thread is ever opened;
- **Send Messages in Threads**, or the thread is opened and the answer cannot be
  posted in it.

Either missing produces a visible refusal naming the permission, and **no answer
anywhere** — never a fallback reply in the parent. `GuildMessages` already
covers messages inside a thread, so no new intent is needed; a **private** thread
the bot was not added to delivers nothing at all, which is why the feature only
ever creates public ones.

Recovery, for the three cases that are not simply "it worked":

| What happened | What Ducky does |
|---|---|
| The starter message already has a thread (Discord code 160004) | Rejoins it. A thread made from a message carries that message's id, so the conversation continues rather than forking |
| Discord is rate-limiting thread creation | Refuses visibly and asks for a retry. Nothing is stored and nothing is answered |
| The thread exists but cannot be posted in | Says so in the parent, and does not publish the answer there |

A channel listed here may not also be a shared channel, a briefing channel or a
task channel; all three are refused at boot rather than resolved by precedence.

## The residual risk, stated plainly

**Ducky cannot verify that a configured channel is private.** It has no view of
channel membership and does not pretend to. Configuring a role channel is the
owner asserting that the channel is private enough for their own output, and if
that assertion is wrong, the disclosure is real.

The mitigations are that it is opt-in per role, off by default, refused when it
overlaps a shared channel, and reported in `/status`. None of them substitutes
for the owner choosing the right channel. This is recorded in
[SECURITY.md](../SECURITY.md) under known residual risk.
