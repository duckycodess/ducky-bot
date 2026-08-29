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

## Residual risk

**A conversation leaves a trace Ducky does not control.** On a single-owner host
that is a filesystem the owner already owns, which is why this is recorded
rather than treated as a defect. It matters most for a shared or hosted
deployment, and it is the reason `/forget conversation` no longer implies a
completeness it cannot deliver.
