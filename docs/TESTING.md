# Testing

`pnpm test` runs everything with Vitest. No test touches the network, a real
Discord gateway, a cloud API, or performs a git write.

## What each suite guarantees

**contracts** — the state machine accepts exactly the intended edges; result
payloads are strictly typed, so `question` is required only for
`needs_owner_input` and actions only accompany `implemented`; repository-relative
paths reject absolute, traversal, UNC, drive, home and NUL forms.

**contracts / time** — a timezone is validated against the runtime's own ICU
data and a bad one throws at startup; a civil day starts at local midnight, not
UTC midnight, and stepping days across a `Europe/London` spring-forward lands on
local midnight every time rather than drifting by an hour; a clock time already
past today resolves to tomorrow; a bare date stays all-day; an unrecognised
expression is refused with the accepted forms quoted back rather than guessed
at; `2026-02-31` is an error, not the third of March; a cron expression is
refused as a repeat interval; and a stored schedule wall clock is read in the
owner's zone, with anything unparseable returning undefined so the raw text can
be shown instead.

**persistence / assistant** — the schema itself refuses a half-specified
recurrence (a one-shot with an interval, an interval reminder without one, a
zero interval) and a scheduled reminder with no cursor; the same occurrence of a
reminder cannot be recorded twice; every task read is owner-scoped, so another
account's row is absent rather than forbidden; closing a task only ever moves an
open one, so a repeated click cannot flip "done" into "cancelled"; advancing a
reminder is a compare-and-set, so a second pass that read the same fired count
writes nothing; marking delivery twice records one delivery; failures abandon an
occurrence only after the configured attempt ceiling; cancelling clears the
cursor and abandons anything still undelivered.

**persistence** — migrations are forward-only and idempotent; foreign keys hold;
only one job per repository can be `running`; only one reservation can exist per
repository, and the guarded upsert refuses to move it to another job; a recorded
result snapshot cannot be mutated; a duplicate nonce is a replay; no column can
hold a plaintext secret; there is no table that could store a schedule before
confirmation.

**adapters** — redaction vectors for every token shape, plus path folding and
idempotence; `runArgv` refuses shell strings, non-array argv and metacharacter
commands, and does not interpret metacharacters inside arguments; the OpenClaw
gateway guard accepts loopback and tailnet and rejects everything else; the
`gh` table is frozen and contains no write verb; the schedule extractor never
guesses; attachment policy rejects binaries, bad hosts and oversize files.

**adapters / herdr contract** — the production schemas parse **recorded live
responses** from `pnpm probe:herdr`. Until fixtures exist the cases skip and the
orchestrator stays experimental: passing mocks is not evidence.

**adapters / pi-herdr** — recovery behaviour: a working agent is reattached, not
restarted; a blocked agent is never answered automatically; an unprovable agent
is not touched at all; a finished turn's result is submitted rather than re-run;
a worktree job reads its result from the checkout path Herdr reported.

**coordinator** — the owner-only matrix at the service layer with the router
bypassed; the registered surface equals the manifest; a forged audit row grants
nothing; claim atomicity and idempotency; reservations spanning every
nonterminal state; cancellation from each state, including `cancel-ack
{terminated:false}` leaving the job running; result idempotency by payload hash
with a conflicting payload rejected; approvals decided individually and never
executed; schedule previews leaving **every** table untouched until confirmation;
transport sanitization with a fake client that never sees a raw secret;
`discord.js` imported by exactly one module; executor auth including rotation
and the nonce-not-burned-on-failure property; rate limits.

**coordinator / daily assistant** — a task is a different record from a capture
and adding one never writes the other; a due time is resolved in the owner's
zone and a bare date stays all-day; an unparseable time is refused rather than
guessed; a past due date is accepted (overdue is a real state) while a past
reminder time is refused; every recurrence is bounded and a cron expression is
refused; `/task` and `/reminder` round-trip through the router with signed,
owner-bound controls that a stranger cannot reuse; every assistant service
method refuses a chat user and a stranger at the service layer with the router
bypassed; and with a shared channel configured, no shared route names `task`,
`reminder` or `briefing`, an owner request from that channel still answers
ephemerally, and a stranger's is refused with no assistant content in the reply.

**coordinator / reminder delivery** — `planOccurrence` is exercised directly for
every branch of the missed-reminder policy; nothing fires early; a due reminder
reaches the owner's DM and only the owner's DM, not ephemeral and carrying no
control; repeated ticks send one message and advance a recurrence exactly once;
a day-long outage collapses into ONE message that names the occurrences it
stands for; a one-shot missed during an outage is still delivered, late; one
failed send neither stops the batch nor prevents a later retry; an occurrence
that can never be delivered is abandoned after a bounded number of attempts and
kept in the ledger; a reminder whose stored owner no longer matches the
configured owner is abandoned rather than re-addressed; a cancelled reminder
sends nothing even when already due; and two overlapping ticks share one
in-flight pass.

**coordinator / briefing** — morning or evening is chosen from the hour in the
owner's zone; today's schedule, tasks and reminders come from stored rows only;
a Phase 1 schedule row is read as the owner's wall clock and its stored text is
asserted unchanged; a task due later today is not reported overdue until it is;
the evening briefing closes the day and looks at tomorrow; an empty briefing
says so rather than padding; the same stored rows produce a byte-identical
briefing twice; every briefing carries its provenance, contains no `[mock]`
text, and the service holds nothing that could generate a sentence; and every
task handle in the output belongs to a task that exists.

**coordinator / shared visibility** — a shared-channel member (and a stranger,
and a chat-whitelist user) sees the projection and never the task, context,
owner id or a signed control; an unconfigured channel, a DM whose channel id
deliberately collides with a configured one, and an unconfigured run all refuse
a non-owner; every non-read command is refused for a non-owner in a shared
channel and nothing is written; the owner gets the shared view in a channel and
the private view in a DM; a stale, foreign and malformed job id produce the
identical refusal; a repository since removed from the allowlist is reported as
unlisted rather than named; production inherits neither the unscoped nor the
development channel variable; the projection's key set is asserted against the
contract, so the shared shape cannot grow a field unreviewed; every persisted
state has a phase, a label and both next-step strings, and no label equals its
raw identifier.

**coordinator / shared notifications** — both targets deliver exactly once and
a second sweep sends nothing; a channel outage retries only the channel message
and never re-sends the DM that succeeded; unlisting a channel silences it
immediately without re-sending the DM; a job with no origin has no shared
target at all; an owner-caused transition is skipped for the DM but posted to
the channel; every notifiable state reaches the channel and reports the state
as of its transition rather than at sweep time; overlapping sweeps share one
in-flight promise; the real sink routes a channel target to a channel and a
user target to a DM, sanitizes both at the same boundary, and fails loudly on
an unsendable channel so the notifier retries.

**executor** — fail-closed workspace resolution: bootstrap refuses any directory
holding something unexpected, with commits, dirty, stashed or mid-operation;
worktree mode verifies the base ref before Herdr is called; a dirty main working
tree is left untouched; the writer lock admits one holder and reclaims a stale
one; the package has no server dependency and creates no listener.

**end to end** — a real HTTP server and the real signing client, with only the
orchestrator mocked: submission → claim → result → completion; a proposed action
routed to an approval that is recorded and not executed; a pause for an owner
answer and continuation under the same reservation; a rejected workspace that
never reaches the orchestrator; a revoked credential and a wrong signing secret
both refused.

## Adding tests

Assert the guarantee, not the implementation. Prefer driving a service directly
over going through the router when the point is authorization. When something
cannot be verified on this host, make the test say so rather than mocking it
into looking verified.
