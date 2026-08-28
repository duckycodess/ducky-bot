# Project context

Founding intent, kept short. Behaviour that can be read from the code belongs
in the code; this records *why*.

## What Ducky is for

Tj wants one private assistant that is always reachable from Discord and can
also drive real development work on a trusted WSL machine — without turning
Discord into a remote shell.

Two roles, deliberately separated:

1. **Personal assistant.** Conversation, quick captures, an inbox, and
   schedules. Convenience features, private data.
2. **Remote development controller.** Submit a coding job from Discord, have it
   executed on the development host under supervision, and approve anything
   consequential by hand.

## Constraints that shaped the design

- **One owner.** Not a multi-user product. A chat whitelist exists for
  conversation only and must never reach personal data or job control.
  Phase 2 adds *visibility* for other people, never authority: see below.
- **Pi stays the orchestrator.** Herdr is the workspace and process layer, Pi
  coordinates the engineering work, Claude implements. Ducky drives those
  through their existing CLIs; it does not become a competing local AI
  framework.
- **The WSL host is never exposed.** All traffic is outbound from the executor.
  There is no inbound port, no tunnel, no listener.
- **Nothing consequential happens unattended.** Prompt injection from
  repository content is assumed possible, so the control is an explicit human
  approval gate rather than filtering.
- **Honesty over coverage.** Where an integration could not be verified on this
  host, it fails loudly or is visibly marked as a stand-in. A plausible-looking
  fake is worse than an obvious gap.

## Owner-only was doing two jobs

Phase 1 made every surface owner-only, and that turned out to conflate two
different things:

- **Privacy** — captures, schedules, tasks, questions, answers, repository
  paths and task text are personal, and must stay owner-only.
- **Secrecy** — the *fact* that a job is running and roughly how it is going
  is not personal at all, and keeping it invisible made the system feel
  opaque without protecting anything.

Phase 2 separates them. Job *status* can be shared; job *content* cannot.

The distinction is enforced by a projection rather than by a redaction pass,
because a redaction pass is a denylist: it stays correct only while somebody
remembers to extend it every time a field is added. A projection built from
named fields fails the other way — something new is invisible until it is
deliberately shared.

**Visibility is not authorization.** Listing a channel says where information
may be *shown*, never who may *act*. Every write stays owner-only, so a
mis-configured channel widens what is visible and can never widen what is
possible. This is the specific failure mode of the legacy DCStro assistant,
whose channel list was documented as "a location filter, not authorization"
while everyone who could read the channel saw the owner's full private
replies.

**"Seen" has an explicit, narrow meaning:** an opt-in shared Discord channel,
not public Internet exposure. Nothing is published to the web and no inbound
surface is opened. Off by default.

## Jobs were confusing because they spoke in state names

`needs_owner_input` is precise and tells the owner nothing about what to do.
Every state now carries a plain-language label and explicit "what happens
next" copy, derived deterministically and exhaustively from the persisted
state so a new state cannot ship with no wording and fall back to leaking a
raw identifier. The state machine itself is unchanged; this is vocabulary, not
behaviour.

The two audiences get *different* next-step copy where a decision is pending.
The owner is told which control to use. A collaborator has no controls, so
telling them to press Approve would be an invitation to try.

## What Phase 2 is building toward

A daily assistant and a chatbot that can accept images and files — the half of
the founding intent Phase 1 only started. Delivered as serial milestones, each
shippable, tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md) with every
unresolved product or API decision marked rather than guessed.

Two constraints carry forward from the legacy audit. Multimodal input goes
through a provider-agnostic pipeline with a CDN allowlist, a narrow type
allowlist, a size ceiling and mandatory temp cleanup — and stays refused until
a capable provider is actually verified. And no real conversational traffic is
enabled until the OpenClaw contract is verified against a running instance,
in the same sense `docs/CURRENT_STATE.md` already uses for Herdr.

## Phase boundary

Phase 1 delivers the whole spine — Discord, authorization, storage, jobs,
recovery, approvals — but stops before *performing* approved actions and before
any deployment. Executing approvals, provisioning Azure, and Tailscale
networking are later phases.

## Deferred on purpose

Multi-user permissions; a public bot; automatic GitHub or Azure writes;
arbitrary shell from Discord; browser automation; container sandboxing;
concurrent implementation writers on one repository.
