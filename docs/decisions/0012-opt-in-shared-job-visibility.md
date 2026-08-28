# 0012. Opt-in shared job visibility through a projection

**Status:** Accepted

## Context

Phase 1 made every surface owner-only. That was right for personal data and
wrong for development work: the owner could not show anyone what a job was
doing without screenshotting a DM, and "owner-only" had quietly come to mean
"invisible", which is not the same thing.

The requirement was that job status be *seen*. "Seen" is dangerously vague, so
this decision fixes its meaning before anything was built.

The legacy DCStro assistant had already solved the location half of this and
got the content half wrong. Its channel configuration is explicitly documented
as *"a location filter, not authorization"* — the owner check still runs, so
nobody else can issue commands, **but everyone who can read the channel sees
the replies**, and those replies are the full private view. Its own
documentation ends the paragraph with "so the channel must be locked down
first". That is a warning, not a design: the safety of every private field
rests on an operator having configured a Discord permission correctly.

## Decision

**"Seen" means an opt-in shared Discord channel, not public Internet
exposure.** Nothing is published to the web, no endpoint is opened, and the
audience is exactly the set of people the operator has given read access to a
channel they explicitly listed in configuration.

Within that channel, a non-owner may see only a **`SharedJobProjection`**:
public job id, allowlisted repository slug, coarse state, safe timestamps,
sanitized result summary and verdict, and explicit next-step copy.

Never, in any shared output: task or context text, the owner's Discord id,
questions or answers, raw events or logs, workspace ids or paths, action
details, or signed controls.

Three structural choices carry that guarantee, rather than a reviewer's
attention:

1. **A projection, not a filter.** `SharedJobsService` builds the projection
   field by field from named sources. It does not call `JobsService.list` or
   `.detail`. A filter over `JobRow` would be a denylist — correct only while
   somebody remembers to extend it every time a column is added — whereas a
   field added to `JobRow` is invisible here until someone deliberately adds
   it and a reviewer sees the diff.
2. **A presenter that accepts nothing else.** `shared-presenters.ts` takes
   `SharedJobProjection` only, so reaching for a richer object that happens to
   be in scope is a type error rather than a review question. It never emits
   controls.
3. **No identity input.** The projection service takes no `ActorContext`. There
   is no parameter to escalate and no natural place to grow an
   `if (isOwner)` branch.

**Visibility is not authorization.** `SharedChannelPolicy` answers "may this
be seen here?" and never "may this person do this?". Writes stay owner-only,
owner-only replies stay ephemeral, and a mis-listed channel therefore widens
what is *visible* and can never widen what is *possible*. That is the specific
failure this design does not inherit from DCStro.

**The owner gets the shared view in a shared channel too.** Serving them the
private view there would put task text and signed controls into a channel
other people can read — the exact leak — so the private view lives in the DM.
The owner can still *write* from the channel; those replies are ephemeral.

**Every ambiguous case fails closed to private:** no context, a DM (identified
by the absence of a guild id, so a configured id can never match a private
conversation), an unconfigured channel, or an incompletely wired router.

**Configuration is the sole authority, as it is for authorization.** A job
records the shared channel it was submitted from, but that stored id is
re-checked against live configuration before every send. Unlisting a channel
silences it immediately, including for jobs already running in it.

**The delivery ledger is keyed per target.** One transition can owe a message
to both the owner DM and a shared channel, and those fail independently. A
composite `(transition_id, target)` key is what makes each idempotent on its
own, so an outage on one neither re-sends nor strands the other.

## Alternatives considered

**Reuse `/jobs` and `/job status` with a redaction pass.** Rejected: a denylist
over a growing row type. The first new column to leak would do so silently.

**A read-only web page.** Rejected outright. It changes "seen" from "people in
a channel you chose" to "anyone with a URL", opens an inbound surface the
architecture does not have, and was not what was asked for.

**Make the shared channel an authorization tier so collaborators can submit
jobs.** Deferred deliberately (see the roadmap). Submitting a job runs code on
the development host; that decision deserves its own milestone rather than
arriving as a side effect of a visibility change.

**Post to a channel chosen at send time from configuration.** Rejected: a job
submitted in one channel would surface in another. Recording the origin keeps
the conversation where it started.

## Consequences

- The shared surface is off by default. With `DUCKY_SHARED_CHANNEL_IDS` empty
  — the default — nothing about this milestone is reachable at all.
- `OWNER_ONLY_COMMANDS` is not widened. `SHARED_READABLE_ROUTES` names two
  reads, both narrowed views of commands already on that manifest, and the
  router asserts at construction that no interaction kind is shared-readable.
- Channel membership is still enforced by Discord's own permissions. The
  operator must lock the channel down to the intended audience; what has
  changed from the legacy design is that getting this wrong now exposes a
  deliberately safe projection instead of everything.
- The shared channel is a **retention surface**: unlike an ephemeral reply,
  these messages persist in Discord's history. Only projection fields are
  ever written there. A retention policy for that history is an open decision
  recorded in the roadmap.

## Follow-up

Collaborator job submission, and the privacy/retention decisions listed in
[`ROADMAP.md`](../ROADMAP.md).
