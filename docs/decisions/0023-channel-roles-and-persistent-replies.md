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

## The residual risk, stated plainly

**Ducky cannot verify that a configured channel is private.** It has no view of
channel membership and does not pretend to. Configuring a role channel is the
owner asserting that the channel is private enough for their own output, and if
that assertion is wrong, the disclosure is real.

The mitigations are that it is opt-in per role, off by default, refused when it
overlaps a shared channel, and reported in `/status`. None of them substitutes
for the owner choosing the right channel. This is recorded in
[SECURITY.md](../SECURITY.md) under known residual risk.
