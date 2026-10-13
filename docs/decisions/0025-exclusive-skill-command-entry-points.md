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

**A queue outcome can be UNKNOWN, and says so.** The installed publisher
applies `agent:ready` and then reads it back, so a failure after that write --
a read-back error, a subprocess timeout, a coordinator that died mid-call --
leaves a label that may well be on the issue. The stored outcome is therefore
one of four states rather than a boolean: `not_requested`, `not_queued`
(stopped before any label could be written), `queued` (applied AND verified),
`unknown`. The card, the reply and the Details view all read the same state,
and `unknown` tells the owner to open the issue and look. A false negative
about the one label that authorizes an agent is worse than no answer, because
the owner stops looking.

**Two slots, because there are two questions.** The retry binding
(`ticket_uuid`, `issue_number`) means "this attempt has not landed yet" and is
released the moment a publication succeeds -- keeping it meant the next,
DIFFERENT `$ticket` in that thread inherited it and rewrote the previous issue
with an unrelated contract. The settled slot (`published_spec`,
`published_issue`) means "this thread has a finished ticket" and is what makes
the owner's two-step work.

**`$ticket --ready` with no arguments authorizes the ticket this thread
published.** The issue requires that a bare `$ticket` create unqueued GitHub
work and that `--ready` separately authorize queueing, so the second step has
to reach the first step's issue. It sends the ORIGINAL canonical spec back to
the installed publisher, byte for byte, with the original id and issue number.
That is not an optimisation: the publisher refuses to change the execution
contract of an authorized issue, and a spec rebuilt from a description is a
different ticket wearing the same words.

The rules around it are what keep it from becoming an implicit authorization:

- **Nothing new must have been said.** Settled intent -- argument text or
  grill notes since the publication -- is checked FIRST and always means a
  NEW ticket. Queueing fresh intent onto a published issue would rewrite a
  contract somebody may already be acting on.
- **A bare `$ticket` authorizes nothing.** With a settled ticket present it
  says so and names the explicit step, rather than acting.
- **An already-queued ticket is answered, not re-applied.** Re-writing a
  verified label is a GitHub write with nothing to gain.
- **A failed authorization keeps the settled ticket**, so the same
  authorization can be tried again, and reports the queue state as `unknown`
  because the label may have landed.
- **The settled ticket belongs to its repository.** After a rebind it is not
  offered: the thread is about something else now.
- The stored contract is the owner's own words, bounded, one row per thread,
  and goes with `/forget conversation`. A spec too large to keep is not
  stored, and the authorize step then says it cannot reach the settled ticket
  rather than sending a truncated contract.

**A repository is addressed, never merely mentioned.** Only `owner/name`, and
only as the leading token of the arguments. A bare slug is a word people say in
sentences: matching one anywhere in the prose meant "fix the widgets rendering"
silently retargeted the whole thread. The addressing token is also removed from
the intent, so it cannot become the first words of the ticket's goal.

**An abandoned run is ended on use, not left forever.** A coordinator killed
mid-call leaves a run that never finished, and the single-writer gate would
then refuse every later command in that thread -- one crash, one permanently
unusable thread. The next command in the thread sweeps it, bounded by
`STALE_RUN_AFTER_MS` (ten times the publish timeout, so a merely slow run is
never swept). Its outcome is reported as `unknown` when queueing had been
asked for: nothing here can know what the vanished call did.

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

**The grill is the installed skill's own text, or there is no grill.** The
upstream grilling skill is handed to the conversation provider as instructions
for that turn, read from a configured absolute path at call time. It is not
copied into this repository: a copy would be a second version of somebody
else's method, and the one that drifted would be the one nobody was watching.

**There is no fallback, and that is the point.** Unset, absent, unreadable,
empty or oversized all REFUSE, before a card exists and before the repository
is read, and the refusal names what is wrong. An interview Ducky improvised
because the file was missing is not the installed skill, and it is the worse of
the two failures: the owner believes they are being grilled by the method they
chose, and they are not. The same check runs on every turn, so a file that
becomes unreadable mid-interview closes the grill instead of silently changing
what is conducting it. `$grill-me` likewise refuses without a `verified`
provider.

**One hop through the skill's own redirect.** `grill-me/SKILL.md` as installed
is a 157-byte pointer whose entire body is `Call the Skill tool with
"grilling"`; the method lives in a sibling directory. An operator configuring
the obvious path would otherwise hand the model a pointer and get an invented
interview, so the redirect is followed once. A pointer to a pointer refuses: a
second hop is a loop waiting to happen, and it is not an installation anybody
meant.

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
- **One run at a time per thread**, enforced in the UPDATE statement rather
  than by a caller looking first. Two Discord messages a moment apart are two
  concurrent handlers; before this gate the second replaced the first one's
  run mid-flight, after which the first run's remaining writes either vanished
  or landed on the second run's card. A second command is refused, never
  queued: a queued workflow command would publish something the owner had
  stopped thinking about by the time it ran.
- **Cancel stops the next step, and a terminal status is final.** Read-only
  helper calls (`inspect`, `validate`) are handed an `AbortSignal` and are
  killed. The publisher is NOT: killing it could leave an issue created with
  its canonical read-back unverified, which is worse than a cancel landing a
  few seconds late. So the decision is taken before the irreversible call, and
  `updateRun` refuses to move a run that has already reached a terminal
  status -- without which a subprocess returning after Cancel rewrote the card
  to "queued", the most consequential false report this surface could make.
- **A publication that completes anyway is reported, not hidden.** The card
  stays `cancelled`, and the owner is told what the publisher created, with the
  URL and whether it carries `agent:ready`. Silence about an issue that now
  exists is the same dishonesty pointing the other way.
- **A publication is recorded onto the run that made it.** `setPublication` is
  keyed on the run id, so a late answer cannot attach its issue number to
  whatever the thread is doing now and send the next retry at the wrong issue.
- A grill stops being a RUN once its scan is done -- it has no pending step and
  must not block the `$ticket` it exists to lead to. Its Cancel closes the
  INTERVIEW instead, and keeps the notes it settled.
- The integration is UNVERIFIED against the real helper on this host: every
  test drives a recording stand-in, because the real publisher opens GitHub
  issues. See `docs/CURRENT_STATE.md` for what that does and does not prove.

## Follow-up

A live certification against a disposable registered repository, on the model
of `probe:live-job`: one unqueued publication, one retry proving the canonical
id is reused, and one `--ready` run proving the label is applied and read back.
Until that exists, the bridge is unit-tested and nothing more.
