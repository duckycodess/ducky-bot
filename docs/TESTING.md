# Testing

`pnpm test` runs everything with Vitest. No test touches the network, a real
Discord gateway, a cloud API, or performs a git write.

**Live probes are reported, never asserted.** `pnpm probe:herdr --with-agent`
and `pnpm probe:live-job` start a real Pi agent, so their results are recorded
in a completion report and in `CURRENT_STATE.md` — a test that needs a live
agent is not a test. What the suite does assert is the *contract* those probes
recorded, as fixtures.

**Two test-authoring hazards found the hard way**, both worth knowing before
adding a case here:

- A `sleep` stub that resolves immediately (`async () => {}`) combined with a
  WALL-CLOCK-bounded loop spins instead of advancing, and allocates until the
  heap dies. The orchestrator suites use a real short sleep and small windows.
- A mock that is *more helpful* than the real thing hides defects. `MockHerdr`
  used to synthesise a `ducky-mgd:` workspace label regardless of what it was
  given, so every test believed cleanup could prove ownership — while the live
  CLI, given no `--label`, named the workspace after the branch and cleanup
  silently refused on every real job. Mocks must mirror, not improve.

## What each suite guarantees

**contracts** — the state machine accepts exactly the intended edges; result
payloads are strictly typed, so `question` is required only for
`needs_owner_input` and actions only accompany `implemented`; repository-relative
paths reject absolute, traversal, UNC, drive, home and NUL forms.

**contracts / lifecycle** — `waiting_on_dependency` is nonterminal, holds no
lease, is reachable only from `running` and leaves in exactly four ways; its
reservation TTL outlives the longest permitted wait, so the sweep cannot fail a
job that is still on schedule; every state has a phase, a label and both
next-step strings, and the shared copy says the detail is private;
`LEASE_BEARING_STATES` is still exactly `['running']`; the work-phase machine
accepts the real loop, refuses walking backwards to planning, treats the same
phase as a no-op, and every edge names a known phase; and the detailed owner
label refines only a running job, never rendering a stale phase on a paused or
finished one.

**contracts / command policy** — nothing in the table is classified above a
local mutation; no forbidden verb appears anywhere in the table itself; an
unclassified command and an unknown subcommand are REFUSED rather than allowed
by default; a forbidden verb is caught before the table is consulted and even
when buried mid-argv; a `--flag` is not mistaken for a verb; the longest verb
match wins; and every argv the frozen `gh` table can actually produce passes.

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

**persistence / lifecycle** — migration 8 is forward-only and idempotent; every
existing job starts with no work phase; the phase column refuses a value off
the allowlist; **the single-writer index is still keyed on `running` only** —
a second running job is refused while a dependency wait is not; the dependency
schema requires a waiting row to have a cursor and a resolved one not to,
permits only one OPEN dependency per job while allowing any number of closed
ones, and refuses an unknown type or a zero check budget; the due query respects
the cursor and the batch cap; recording a check is a compare-and-set so two
overlapping passes cannot both spend one; resolving clears the cursor and
cannot happen twice; the audit repo clamps a long detail, never throws, and
prunes in bounded batches; and **no repository that decides anything ever reads
`audit_log`**.

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
OpenClaw provider checks a full text-only tool policy before spawning, isolates
provider sessions by user and thread, and bounds persona instructions; the
`gh` table is frozen and contains no write verb; the schedule extractor never
guesses; attachment policy rejects binaries, bad hosts and oversize files.

**adapters / attachment policy** — the shared metadata policy normalizes a
parameterized, upper-cased content type before comparing it; accepts only an
exact type; rejects a negative, NaN, infinite or oversize declared size;
requires HTTPS and an EXACT host, so `cdn.discordapp.com.evil.tld`, a path that
merely contains an allowed host, and `notcdn.discordapp.com` are all refused;
checks type before size before host, so the cheapest decisive check runs first;
and the schedule surface still layers its own capability-honest image/PDF
wording on top of the same shared rules.

**persistence / retention** — the six job guards each refuse independently
(non-terminal, no `finished_at`, reservation held, workspace open, approval
pending, dependency open); a refused guard deletes NOTHING, not even a child
row; a deleted unit leaves `PRAGMA foreign_key_check` empty; the notification
delivery row goes together with its transition, so a pruned transition cannot
resurface as undelivered; a reservation row is never touched; only terminal jobs
past the cutoff are offered, oldest first, within the batch cap; an open
capture, task and reminder occurrence survive however old; and the repository
source names none of `RETENTION_FORBIDDEN_TABLES` in a `DELETE`.

**persistence / audit vocabulary** — every declared `AUDIT_EVENTS`,
`AUDIT_ACTOR_KINDS` and `AUDIT_SUBJECT_KINDS` value round-trips into the table.
This exists because `record()` never throws, so an enum the CHECK constraint did
not know about was dropped silently; the test is the thing that would have
caught it. Migration 13's rebuild is asserted to preserve existing rows.

**coordinator / retention** — disabled by default and in the composed app;
enabled, it removes a terminal job past the window and keeps one inside it;
a second pass over a settled database deletes nothing (idempotence); the batch
cap is respected and the next pass resumes; a job holding a reservation is
SKIPPED and counted, not deleted; every pass is recorded in `retention_runs` and
the audit log with counts and no task text, including a pass that deleted
nothing; active credentials, the repo mirror and the authorized-user trail all
survive a one-day window; the service source names no forbidden table and has no
`deleteAll`/`purge`/`wipe`/`truncate`.

**coordinator / forget** — deletes one job and its children and ONLY the named
job; refuses a chat user and a stranger at the service layer with the router
bypassed; answers an unknown id and a foreign id identically; refuses a running
job, an open workspace (saying uncommitted work may be there) and an empty id;
records counts and never the task text, including on a refusal; leaves no
foreign key violation. On the route: `/forget` is on the owner-only manifest and
no shared route names it; the command shows and does not delete; the signed
control deletes; a stranger cannot reuse the owner's control; and
`FORGET_TARGETS` cannot express a wipe-all, asserted alongside a source scan for
bulk methods.

**coordinator / conversation provider** — production refuses `openclaw` while no
contract is recorded, says why, points at the probe rather than a flag, and names
the mode that works today; production still boots on `disabled`, so an instance
is never bricked; the contract constant is asserted not to read `process.env`;
the OpenClaw route is refused unless its effective tool policy is provably
text-only; and a conversational reply is rendered as a sanitized branded
embed.

**coordinator / audit coverage** — `approval.requested` records action KINDS and
a count and never an action's details; `approval.expired` is recorded by the
reconciler; `provider.failed` carries the provider and the error code and never
the owner's message; HTTP `rate_limit.exceeded` carries the route. Local
commit/push/PR outcomes are asserted against the existing `approval.execution_*`
mapping rather than duplicated as new events.

**coordinator / retention time zones** — a confirmed schedule whose EVENT has not
passed the window is kept; one well past it goes; the zone is able to change the
verdict at the boundary (otherwise the zone is being ignored, which was the
defect); an unparseable stored time is kept; an all-day date is treated as local
midnight rather than UTC midnight. Also asserts which windows are configurable
and that the two fixed ones ignore the environment.

**coordinator / security audit** — an unsigned request records `auth.failed`
with the route; a bad bearer and a wrong signature appear nowhere in the log and
neither does any of `AUDIT_FORBIDDEN_SUBSTRINGS`; a malformed executor id is
recorded as absent rather than echoed; `authz.refused` carries the ROLE and
never a Discord id; the owner passing through records nothing;
`rate_limit.exceeded` carries the BUCKET and never a user id, driven through the
real router until the bucket exhausts.

**adapters / brief permissions** — a `.ducky/` directory and `brief.md` that
already exist at 0755/0644 are tightened to 0700/0600 on overwrite, and stay
owner-only on every round rather than only the first; no temp file is left
behind. `mode` on `mkdir`/`writeFile` applies only on creation and is masked by
the umask even then, and Pi creates that directory too.

**adapters / stale phase** — a phase left by a previous turn is cleared, the
clear is silent when there is nothing there, and it leaves `result.json` alone.
At the orchestrator level the order is asserted to be clear → brief → prompt, on
a fresh turn and on a RESUMED one, because a resumed job reuses its workspace and
would otherwise report the phase the last turn finished on.

**coordinator / observability** — every level carries a `correlationId` even on a
logger built with no options; a caller-supplied id wins; a child keeps the
parent's. Key-aware redaction replaces the value of any field whose name contains
a sensitive part (twenty names asserted, including the hyphenated `x-api-key`),
including when the value is an object or an array, while leaving innocent
neighbours like `jobId` and `phase` intact.

**adapters / herdr subprocess budgets** — a blocking `agent prompt` is spawned
with a subprocess timeout strictly GREATER than the wait it hosts, and the same
wait is passed to herdr, so the two cannot drift; `agent start` sends an
explicit readiness timeout; ordinary commands keep the default. This is the
regression test for a 30-second `execFile` cap that killed every real Pi turn
and reported it as a Herdr outage while the agent kept writing.

**adapters / herdr failure classification** — against stderr **recorded from
this host**: `agent_not_found` is an absent target, `agent_prompt_stalled` gets
its own code and is never an outage, `agent_not_ready` is transient,
`dirty_worktree_requires_force` is the normal result of cleaning up after real
work, an exit-2 syntax error is an outage, and a secret in a failure message
never reaches the error text. Classification is on the machine `code`, with the
old wording match kept only as a fallback.

**adapters / brief handover** — the brief travels as a `0600` file in a `0700`
directory and only a one-line pointer is pasted; the pointer is one line, under
300 characters, names a forward-slash path, and tells the agent to do the work
rather than acknowledge and stop. Measured cause: 3.3 KB over 66 lines was left
unsent in Pi's input buffer.

**adapters / phase file** — every real phase word is accepted, whitespace and
casing tolerated, and an absent, empty, oversized, directory-shaped or
unrecognised file yields no phase at all rather than an invented one; the shared
machine predicate declines an edge the coordinator would refuse.

**executor / phase reporting** — a report reaches the coordinator without
waiting for the regular lease beat; the ACCEPTED phase is read back; a burst
coalesces into one request; a refused phase is never resent; a transport failure
retries; a lease beat still happens with no phase to report; Pi's phase file is
picked up only once a workspace exists; a throwing reader never disturbs the
beat.

**executor / orphan writer lock** — an orphan outcome RETAINS the host writer
lock, and an ordinary or unavailable outcome releases it. The release used to be
unconditional and ran before the orphan branch, so a retry could start a second
writer beside a live agent.

**adapters / herdr contract** — the production schemas parse **recorded live
responses** from `pnpm probe:herdr`, now including `agent start`, `agent prompt`,
`agent get` and a result file a real Pi agent wrote. Until fixtures exist the cases skip and the
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

**coordinator / dependency waits** — recording one parks the job, releases the
lease (so the expiry sweep does not see it) and RETAINS the reservation, with
the work phase cleared; the dependency lands in the same transaction as the
transition; a schedule outside the ceilings is REFUSED by the contract rather
than clamped, leaving the job still running under its own lease; defaults are
applied when only the essentials are given; `ready` requeues the job and it can
genuinely be claimed again; `failed` fails it and releases the repository;
pending reschedules with growing backoff until the budget is spent and then
hands the job to the OWNER; the wall-clock deadline stops it even with checks
left; a throwing checker still spends a check; one pass checks at most the batch
size; cancelling closes the dependency so even a `ready` checker cannot
resurrect the job; a dependency whose job moved on is closed rather than polled;
a brand-new resolver picks up the durable cursor after a restart; two
overlapping ticks share one pass; and a `ready` from an UNVERIFIED checker is
not believed. The shipped default is asserted to answer only `pending`, to take
a wait to `needs_owner_input`, and to say so in `/status`.

**coordinator / work phases and audit** — a claim starts at `preparing`;
progress reports advance the phase and report it back; the same phase is
idempotent and writes no new event; a backwards edge is refused and leaves the
phase untouched; a heartbeat with no phase still renews the lease; the phase is
cleared when the job pauses; a stale lease is refused; the phase shows on the
owner's surface and on no shared one. The audit log records creation, claim,
phase change, approval, failure and cancellation; a REFUSED phase change is
recorded as refused (outside the transaction, so it is not rolled back with the
rejected write); the executor is named by id and the owner by role, never by
Discord id; after a full lifecycle the dump contains none of the forbidden
substrings, no live bearer or HMAC, and no lease id; an action's details are
not copied into the record; and a forged audit row confers nothing.

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

**coordinator / conversation attachments** — both shipped providers advertise
attachments unavailable AND throw if one reaches them; the gate requires
verified AND capable AND opted-in, and a provider that claims capability while
unverified is still refused; every refusal path is asserted to make **zero
fetch calls** and leave no temp directory — unsupported provider, operator
switch off, unverified provider, several attachments, a foreign host, plain
HTTP, a host that merely ends with an allowed one, an unsupported or absent
type, and an oversize claim; attachments are refused for a chat-whitelist user
and a stranger while plain conversation still works for the whitelist; the
effective limits are the smaller cap and the intersection of the type lists;
the request sets `redirect: 'error'` and `accept-encoding: identity`; a lying
declared size is caught by the stream counter; the provider receives exactly
the declared metadata and the exact bytes, and a bounded `read(n)` returns a
prefix; the temp directory is `0700` and the file `0600` *while the provider
holds it* and both are gone afterwards, including when the provider throws; a
handle the provider retained reads an error after the reply while its metadata
stays inert; the startup sweep removes a stale conversation directory; and no
byte, base64 blob, temp path or `attachments` table appears in the reply or the
database.

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

**adapters / herdr readiness** — the readiness marker classifies a banner-phase
pane, a painted input frame and an empty snapshot; an empty one is treated as an
observation that could not be made rather than as evidence of banners; the
orchestrator prompts once the frame is seen TWICE, keeps looking while banners
paint, falls back to Herdr's own signal when the marker never appears, survives
an unreadable pane, and never reads a pane for an agent that is already working.
In every case exactly ONE prompt is submitted.

**adapters / readiness evidence** — asserted against `agent-readiness.json`,
which only `pnpm probe:herdr --with-agent` can produce: that `agent read`
answers with TEXT and not an envelope, that Herdr claimed `interactive_ready`
during the banner phase, that the input frame separates banners from a
promptable agent, and that no recorded sample carries the status footer the
first version of the marker wrongly required. With no fixture the suite says so
and skips.

**adapters / herdr policy** — every method the orchestrator uses gets past the
central command policy, and the argv each builds is classified; a forced
worktree removal is refused BEFORE a subprocess exists; an unclassified herdr
surface is refused rather than defaulted.

**adapters / openclaw contract** — what `pnpm probe:openclaw` recorded: the
agent-turn request shape, a WebSocket gateway rather than the HTTP endpoint
first assumed, the auth model observed by running a real turn, the successful
reply envelope, zero tools handed to the `ducky` agent under the required policy,
and that an agent turn has NO attachment input. The reply contract is pinned by
`RECORDED_CONTRACT_VERSION`; a missing contract still makes initialization
refuse. No fixture may contain a credential, model text or a host path.

**adapters / gh fields** — every `--json` selector the frozen argv table sends is
one this `gh` supports, checked against what `pnpm probe:gh` recorded from `gh`
itself; no write verb appears anywhere in the table; every list is bounded by
`--limit`.

**adapters / github CI checker** — ready only when every check finished and
passed, failed on a definite failure, pending while anything runs; unverified by
default, which is what stops it resuming a job; `ci_run` only; a malformed key,
an unknown repository, a missing key and a `gh` error are all pending and never
failed; no raw `gh` error reaches a detail field.

**coordinator / conversation memory** — Ducky memory is off by default; rows an
earlier run stored are still deletable after the flag goes off; history is
isolated per user AND per thread; a configured shared channel takes no part in
memory at all; the replay window, the per-thread row cap and the per-turn
truncation all hold; `/forget conversation` deletes every Ducky row for that
user only, reports the count, and audits by count with no content; retention
keeps the owner's history longer than a guest's and only past each window; and
the provider-owned transcript is disclosed as a separate store rather than
claimed to be deleted.

**coordinator / intents** — the rule table reads the shapes it claims and means
nothing far more often than something; a reminder with no time is refused rather
than given an invented one; an inferred write is PROPOSED and never applied;
a refusal drops it; an unrelated later message is not consent; proposals expire;
one per thread, isolated per thread; a service refusal is reported as a refusal;
a non-owner reaches none of it; the meal and study helpers answer from fixed
data, honour only constraints they can check, are deterministic for a day, and
state their own limits; and no command or interaction kind was added.

**coordinator / proactive briefings** — the schedule is validated at startup and
a bad time refuses to boot; a slot resolves in the owner's zone rather than UTC;
a slot is claimed once and only once however many ticks run; the next civil day
is a new slot; there is no backfill; delivery retries and abandons as a record;
and a briefing more than six hours late is SKIPPED rather than delivered.

**coordinator / retention (extended)** — a job's detail is stripped while the job
itself is kept, and the two counts are reported separately; the audit log prunes
on its own window and converges; every per-kind window reads from its own
variable; the two deprecated aliases are still honoured; the shipped defaults are
the conservative ones.

**coordinator / per-record deletion** — one task, reminder, capture or schedule
entry deleted by id, with a confirm step; a reminder takes its occurrence outbox
with it; a capture is named by the id prefix the inbox already shows; an
ambiguous prefix is refused rather than resolved; another owner's id and a
missing id are answered identically; a stranger cannot press the owner's control;
every deletion is audited by count under the `record` subject kind.

**coordinator / GitHub watches (extended)** — merges, approvals, requested
changes, review comments, workflow failure AND recovery, and issue activity each
produce a summary line; every call the loop makes is a read; a requested change
proposes a job and creates none; the proposal is deduplicated by
`(watch, fingerprint)` so it appears once per genuinely new review or new code,
and stops once the pull request merges.

**persistence / backup** — the real scripts, run as subprocesses against a real
temporary database: the copy verifies, is written `0600`, and excludes the
credential file; a file that is not a Ducky database and a corrupt file are both
REFUSED rather than passed; a missing source writes nothing; `--keep` reports
prunable copies and deletes none.

## Adding tests

Assert the guarantee, not the implementation. Prefer driving a service directly
over going through the router when the point is authorization. When something
cannot be verified on this host, make the test say so rather than mocking it
into looking verified.
