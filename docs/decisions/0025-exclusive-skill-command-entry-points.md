# 0025 — Three commands are the only way into the repository workflow

Status: accepted (2026-10-13)

## Context

The owner's engineering work already has a pipeline, and it is not Ducky's.
A user-installed Agent Flow front door (`workflow.py`) owns the canonical
TicketSpec schema, the GitHub issue body, the label policy including the exact
`agent:ready` that authorizes implementation, the Beads dependency graph and
the dispatcher registration. Ducky is public source and runs as a Discord bot
on the owner's own host.

Ducky also had its own way of starting work. `implement in <repo>: <task>`
matched a rule in the deterministic intent table, proposed a coding job, and a
plain `yes` submitted it through `JobsService` to the Herdr/Pi executor. That
is a second engineering entry point, and it is one a message can reach by
accident: a quoted line, a pasted log, somebody repeating what the owner said.

The owner selected exactly three commands for the workflow: `$grill-me`,
`$ticket` and `$agentize`. Installed `$ticket` creates UNQUEUED issues by
default and `--ready` separately authorizes queueing.

## Decision

**One entry, three tokens, first position only.** A message reaches the
repository workflow when its FIRST unquoted token is `$grill-me`, `$ticket` or
`$agentize`. A fenced block, a quote prefix (`>`), an inline code span and any
other first token all mean the message is data. Nothing matches a phrase:
"implement this", "ticket it" and "queue it" are ordinary English and stay
ordinary English.

**The prose job path is removed, not disabled.** `job_submit` is gone from
`INTENT_KINDS`, the rule table and `IntentsService`, and the composition root
hands that service no job capability at all. A capability that is not passed
cannot be reached by a later edit that has forgotten why it was switched off.

**`/job submit` is untouched.** It is the Ducky executor path that
`pnpm probe:live-job` certifies end to end, it is owner-only, and it is a
different thing from dispatcher admission. The two paths are kept separate and
neither can reach the other: `SkillBridgeService` is handed no `JobsService`,
asserted by a test that scans its source.

**Queue authorization is typed, never inferred.** `--ready` is recognised only
as a bare token, only on `$ticket`, and only after code spans have been
stripped from the argument text. The flag is passed to the installed publisher,
which applies the exact label and then reads it back; Ducky reports `queued`
only when BOTH the owner asked and the helper verified.

**Classification is named, never chosen.** `$ticket --label <name>` is
repeatable and bounded at four; without one, nothing is classified. Deciding
whether a piece of work is a bug or an enhancement from a sentence would be
exactly the guess every other rule here refuses to make. `agent:*` is refused
before a spawn, so a classification can never become the label that authorizes
implementation, and a label the owner asked for that the publisher did not read
back fails the run rather than being reported as a published ticket.

**Ducky publishes nothing itself.** No `gh issue create`, no label API, no
Beads edge. The bridge calls the installed front door through a typed port and
reads structured fields back. A test asserts the service and its presenters
name no GitHub surface and spawn nothing.

**Three separate switches, not one.** `DUCKY_SKILL_BRIDGE_ENABLED` decides
whether the tokens mean anything; `DUCKY_WORKFLOW_HELPER` says where the
installed program is, with no default and no search; and
`DUCKY_WORKFLOW_MUTATION_ENABLED` decides whether publishing and onboarding may
run at all. The third exists on exactly the terms
`DUCKY_APPROVED_ACTIONS_ENABLED` exists: an external write is an operator
decision, not something a feature flag sweeps in. All three are profile-scoped
and production inherits none of them.

**The grill is the installed skill's own text, read at call time.** The
upstream grilling skill is handed to the conversation provider as instructions
for that turn, read from a configured absolute path. It is not copied into this
repository: a copy would be a second version of somebody else's method, and the
one that drifted would be the one nobody was watching. With no verified
provider, `$grill-me` refuses rather than printing questions from a fixed list
and calling it an interview.

**Statuses are words, and the words are the contract.** `scanning`, `grilling`,
`publishing`, `published`, `queued`, `onboarding`, `onboarded`, `needs_input`,
`failed`, `cancelled`. `published` says creating an issue does not authorize
implementation. `queued` says the exact label is verified AND that this is not
evidence a worker started. Ducky never observes a worker, so it never has a
status that claims one is running.

## Alternatives considered

**Reimplement ticket creation in TypeScript.** Rejected. It would be a second
canonical schema, a second label policy and a second graph, and the ticket's
own constraints forbid an alternate pipeline. The failure mode is silent
divergence from the pipeline the dispatcher actually consumes.

**Keep `implement in <repo>:` alongside the three commands.** Rejected. Two
engineering entry points means one of them is the one nobody checked, and the
prose one is the one that can be triggered by text somebody else wrote.

**Make the owner confirm each publication with a button.** Rejected as the
primary control. The authorization step already exists and is the owner typing
`--ready`; adding a second one would make the typed flag decorative.

**One flag for the whole bridge.** Rejected. Reading a repository and opening a
GitHub issue on it are different risks, and an operator who wants the first
should not get the second by consequence.

**A new slash command, `/ticket`.** Rejected: `AGENTS.md` forbids widening the
owner-only command surface, and the bridge rides the conversation route the
deterministic intents already use. `OWNER_ONLY_COMMANDS` is unchanged at
twelve. Two owner-only INTERACTION kinds were added -- `agent_details` and
`agent_cancel` -- because the ticket requires real buttons rather than action
words printed in message text; they are signed and owner-bound like every other
control, and "View issue" is a link with no custom id at all.

## Consequences

- `implement in demo: ...` now does nothing. An owner who relied on it uses
  `/job submit` or the three commands.
- A thread binds one repository. Rebinding clears the canonical id and the
  issue number, so a retry after a rebind creates rather than enriching the
  wrong issue.
- The ticket body is built from lines the OWNER typed -- the command's argument
  text and the grill replies. Nothing is generated, so an acceptance criterion
  nobody wrote cannot appear in a published contract.
- `/forget conversation` removes the workflow thread records too, including the
  grill notes. It cannot remove a published GitHub issue, and it says so.
- Cancel stops the next step. It does not interrupt a helper call already in
  flight, and the reply says that rather than implying otherwise.
- The integration is UNVERIFIED against the real helper on this host: every
  test drives a recording stand-in, because the real publisher opens GitHub
  issues. See `docs/CURRENT_STATE.md` for what that does and does not prove.

## Follow-up

A live certification against a disposable registered repository, on the model
of `probe:live-job`: one unqueued publication, one retry proving the canonical
id is reused, and one `--ready` run proving the label is applied and read back.
Until that exists, the bridge is unit-tested and nothing more.
