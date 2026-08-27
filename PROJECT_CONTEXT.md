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

## Phase boundary

Phase 1 delivers the whole spine — Discord, authorization, storage, jobs,
recovery, approvals — but stops before *performing* approved actions and before
any deployment. Executing approvals, provisioning Azure, and Tailscale
networking are later phases.

## Deferred on purpose

Multi-user permissions; a public bot; automatic GitHub or Azure writes;
arbitrary shell from Discord; browser automation; container sandboxing;
concurrent implementation writers on one repository.
