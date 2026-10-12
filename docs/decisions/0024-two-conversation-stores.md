# ADR 0024 — Two conversation stores, and only one of them is Ducky's

**Status:** accepted

## The thing that was easy to get wrong

Ducky said "nothing is stored" about conversation, and meant it about its own
SQLite. It was not true of the system as a whole. There are **two** stores and
they have different owners, different lifetimes and different deletion stories.

| | Ducky's bounded memory | The provider's session transcript |
|---|---|---|
| Owner | Ducky, in its own SQLite | OpenClaw, in its own store on this host |
| Default | **OFF** (`DUCKY_CONVERSATION_MEMORY_ENABLED=false`) | **Always on for any turn that runs.** An agent turn writes a session and there is no flag that stops it. A turn refused before it starts — by the tool-policy gate, say — writes nothing, but that is a refusal rather than a setting |
| Scope | per `(user, thread)`, in every WHERE clause | per session key, now `sha256(userId:threadKey)` |
| Bounds | replay window, row cap per thread, per-turn length cap | whatever OpenClaw's own retention does |
| Retention | Ducky's windows: 30 days owner, 7 days guest | not Ducky's to set |
| `/forget conversation` | deletes every row, audited by count | **does not reach it** |

## The decision

**State both, and never let one stand in for the other.**

- `/status` and the boot diagnostics report Ducky's memory *and* say the
  provider keeps its own session.
- `/forget conversation` says what it deleted **and** that a provider
  transcript exists which it did not touch. It previously said "no conversation
  turn is stored", which was true of Ducky and read as a claim about
  everything.
- Nothing here deletes a provider transcript. OpenClaw owns those files, the
  supported surface for removing one has not been probed, and a `/forget` that
  silently missed half the data would be worse than one that is honest about
  its reach.

## Why the session key had to change first

The provider transcript was keyed on the thread alone, so two people in one
channel shared one session. Ducky's own isolation was real and the layer
underneath it was not — the worse half to get wrong, because it is the half
nobody looks at. The key is now a digest of user **and** thread. Documenting
two stores would have been misleading while one of them was not isolated.

## What this does not do

- It does not enable memory. `DUCKY_CONVERSATION_MEMORY_ENABLED` stays off.
- It does not delete existing provider transcripts.
- It does not claim Ducky can bound the provider's storage. It cannot.

## What issue #4 changed, and what it did not

**It did not make Ducky able to delete an OpenClaw session.** That is still
true, and the table above still stands. What changed is that Ducky stopped
being merely honest about the gap and started doing the one thing it can.

### The session key carries an epoch

`sha256(userId:threadKey)` became `sha256(userId:threadKey:e<epoch>)`, with the
suffix omitted at epoch 0 so no existing session is abandoned by the upgrade.
`/forget conversation` bumps the epoch, so the next turn opens a **different**
session and the old context can never come back.

This is **orphaning, not erasure**, and the reply says so in those words. The
old session is still in OpenClaw's own store on this host. A message that let
the owner infer otherwise would be worse than the old one that admitted it
could not reach the provider at all.

### A shared thread contaminates more than one session

A visible thread replays everybody's turns to everybody's provider session, so
after the owner deletes their conversation the other participants' sessions
still hold the deleted words. `conversation_provider_sessions` records one row
per `(thread_key, user)` precisely so that deletion can address all of them,
and `/forget` rotates every one.

It **deletes nothing of theirs**: their own stored turns are untouched and their
next turn simply starts a fresh session. The counts are reported separately
rather than added into one reassuring number.

### Deletion support is a declared capability, derived from evidence

`ConversationProvider.capabilities.sessionDeletion` is required rather than
optional, so a new provider has to state its position instead of defaulting
into one. For the gateway it is DERIVED from `RECORDED_SESSION_DELETION`, the
same discipline `verified` follows: an operator can set a variable, an operator
cannot conjure a recording.

That constant is **null**, and the reason is recorded rather than implied:

- `pnpm probe:openclaw` now records the deletion-capable command surface --
  subcommand and flag NAMES under `sessions`, `transcripts` and `memory`, from
  `--help` only. It never lists a session, never reads a transcript and above
  all never deletes one. A probe that deleted something to find out whether it
  could delete things would be the worst possible way to learn it;
- recording a surface is not evidence that it works. The fixture carries
  `verifiedDeletion: false` and `verifiedReadback: false` for exactly that
  reason, and deletion stays unsupported until a **narrow command** and an
  **independent readback** have both been observed;
- the finding is reported as an **observation, not a blocker**, and never
  touches the probe's exit code. It was briefly both -- the classification
  pushed a blocker whether a deletion command was found or not, which made a
  clean run impossible and made the probe print blocker consequences ("the
  provider stays unverified", "conversation refuses to answer") that were
  false of a run whose contract had been fully recorded. A probe that cannot
  succeed is not a certifier. The classification is now a pure function with
  its own unit tests;
- `ALWAYS_FORBIDDEN_COMMAND_VERBS` refuses `rm`, `destroy`, `purge`, `drop`,
  `reset` in any argv this system builds, and that list will not be relaxed to
  make a deletion possible. If the supported surface needs one of them, the
  honest answer stays "unsupported".

**The probe could not be run while this was implemented**: the pinned binary is
not installed on that host, so `probe:openclaw` exits 2 and no
`session-deletion-surface.json` fixture exists. Running it is the next owner
action, and it changes nothing on its own.

## Residual risk

**A conversation leaves a trace Ducky does not control.** On a single-owner host
that is a filesystem the owner already owns, which is why this is recorded
rather than treated as a defect. It matters most for a shared or hosted
deployment, and it is the reason `/forget conversation` no longer implies a
completeness it cannot deliver.
