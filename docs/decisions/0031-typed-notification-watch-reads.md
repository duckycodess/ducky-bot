# ADR 0031 — Typed notification-watch reads, one request per unit

**Status:** accepted
**Extends** [ADR 0029](0029-github-feed-and-the-delivery-only-github-channel.md)
and [ADR 0030](0030-private-assistant-migration-and-parity-capabilities.md);
supersedes nothing.

## Context

ADR 0030 built the notification-only watch engine and left its reader
unavailable: the existing `gh` shapes could not see release publication, the
closing time of a pull request or an issue, or repository discovery, and AGENTS.md
allowed `gh api` in ONE exact shape (a branch's commits) and `gh search prs` in
ONE. Lifting that needed an owner-approved constraint change, an ADR and pinned
tests.

On 2026-10-14 the owner approved it (issue #9, comment 6159816030): "approve the
read only github change and continue". The approval is narrow. It permits
separately typed, GET-only operations through the existing `runArgv` and `gh`
policy gate, with exact argv, endpoint and query validation, pinned response
schemas and completeness checks, and keeps the 1,000-target, 20-call-per-tick and
2,400-call-per-rolling-hour budgets. It grants no arbitrary API or HTTP path, no
write, no engineering repository or action permission, no additional-user access
and no billed provider fallback. Incomplete observations must not advance a
checkpoint, private or unverified visibility stays private, and full parity stays
required.

## Decision

### Seven shapes, and nothing else

Each is `gh api --method GET <endpoint>`: exactly four argv words, with a
CANONICAL relative endpoint built by `watchEndpoint` from validated parts and
re-parsed by the policy gate (`parseWatchEndpoint`, which rebuilds the endpoint
from what it parsed and requires byte equality). Any alternate spelling, key
order, extra or repeated query key, encoded traversal, placeholder, absolute URL,
other method, field, input, header, hostname, jq, template, cache, include or
pagination flag is unclassified and refused.

| Surface | Endpoint |
|---|---|
| repository | `repos/{owner}/{repo}` |
| pulls | `repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=10&page=N` |
| reviews | `repos/{owner}/{repo}/pulls/{number}/reviews?per_page=10&page=N` |
| issues | `repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&per_page=10&page=N` |
| runs | `repos/{owner}/{repo}/actions/runs?branch={encoded}&per_page=10&page=N` |
| releases | `repos/{owner}/{repo}/releases?per_page=10&page=N` |
| discovery | `user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=N` (at most five pages) |

The existing commits shape is unchanged. There is **no `/notifications`
endpoint**: "notification results" means these typed event surfaces. There is no
file or review-comment endpoint; the requested-changes alert's "areas mentioned"
may use the review BODY these reads already return and nothing more.

Only `watch-reader.ts` builds these shapes (a test scans the source), and the
engineering reader keeps the single commits shape. Every response is parsed by a
pinned schema; a page longer than the `per_page` asked for, a body past the 2 MiB
output bound, or a shape that does not parse is a failure, never a longer window.
The repository read compares `full_name` with the identity asked for, so a rename
or transfer BLOCKS the target's surfaces rather than silently retargeting.

The reader is off by default (`DUCKY_ASSISTANT_WATCH_READER_ENABLED`). With it
off the shipped reader observes nothing and an import with watch targets is
refused, exactly as before.

### One request per unit

A unit of work is ONE request (plus one more only when a commits or runs read has
to learn the default branch). A pull request's reviews, each review page, each
list page, and a final re-read are separate units with a durable position
(`pending_page`, `pending_cursor`, a JSON `pending_state`) so a restart resumes,
a failure costs exactly the request that failed, and every request, including a
failed one, is charged against the budget. No pagination hides inside a reader
method. Nothing is delivered and no cursor moves until the commit.

A 403 or 429 (rate limit) and an authentication failure stop the whole cycle for
ten minutes and fail only the unit that met them, never advancing a cursor.

### A window is closed by the sort key, and proven by a re-read

- Pull requests and issues sort on the update time that their events use, so
  reaching an item at or before the cursor closes the window. The issues listing
  also returns pull requests; `hasMore` is judged on the RAW page and the raw last
  row's time can close the window when a page held no issue at all.
- Runs and releases sort on CREATION but their events carry a later time, so the
  event time cannot close the window. A window closes on an item CREATED at or
  before both the cursor and the creation time of the oldest item that was still
  unsettled (a running workflow, a draft release) when the last window closed. The
  engine persists that floor (`scan_floor`) and tracks an unsettled run for a day
  and a draft for thirty days, so one stuck item cannot hold a window open.
- A window that spanned pages is committed only after the LAST page is re-read and
  shows the window held still: the original items, shifted down by insertions
  above and possibly with their tail pushed off. A deleted row above slides the
  next page up and would hide an item at a page boundary, so a re-read that shows
  anything else (an item gone or moved, a different order, a page that held items
  and is now empty), or a runs total that shrank, restarts the pass with backoff;
  what was found stays held, because it is real and deduplicates by identity. A
  window that fitted one page is one consistent answer and is not re-read.
  **This narrows the window for a miss; it is not a proof** (see the residuals).
- A window that closes on an EMPTY page is verified against the last page that held
  items, not against the empty one: a row deleted from an already-read page slides its
  successor onto it, leaving the next page empty both times, and an empty page proves
  nothing about a boundary.
- A lifecycle change on an unread page is not lost when a comment moves it to a read one.
  A pull request merged, or an issue opened or closed, on page two can be bumped onto page
  one before page two is read; the pass then commits a cursor past its lifecycle time. A
  window that spanned pages hands its STARTING cursor to the next read (`lifecycle_floor`,
  migration 35) for exactly one read, and opened/merged/closed times count from there;
  their identities are stable, so what is looked at again is deduplicated. An issue keeps the audited ONE classification per pass (opened if
  created after the cursor, else closed if closed after it, else updated), judged against the real
  cursor first, so a close in this window is never replaced by a replay of an earlier opening;
  the floor never replaces or suppresses that current classification (a comment-only touch after an
  announced opening is an update, for issues and pull requests alike); it only ADDS a transition
  from the window before, with the same precedence, deduplicated by identity. An issue opened in one window and closed in the next still announces both; across consecutive multi-page passes the floor
  stays the EARLIER of the inherited one and the new window's start. An item AT the
  cursor re-read in inclusive mode is no longer called "updated" a second time. This is not
  a proof against arbitrary paging drift, which stays a named residual.
- What settles in the middle of a pass is not jumped over. The committed cursor is
  capped at an unsettled run's last update (less a millisecond), or at the moment a
  draft release was read, so something else on the same pass cannot carry the cursor
  past an update that is still to come. What the cap makes the next pass read again
  is told apart by identity. A first sight is not capped: nothing was announced for
  it, and re-reading would announce history.
- A window past its page cap (3 commit pages, 50 pull and issue pages, 10 runs,
  releases or review pages) is **blocked as `window_exceeded`** with the cursor and
  the held events untouched. It is a counted, visible blocker, not a partial scan.

### Late reviews at the cursor

When the items at the cursor were processed by a Ducky pass
(`boundary_known`), a pull request touched exactly at the cursor is listed again,
its reviews are read again, and a review at the cursor is told from an announced
one by its id. A baseline or a source cursor stays strict.

## What this ADR deliberately does not claim

- **Completeness is NOT proven, and no parity claim rests on it.** Comparing the
  last page cannot see a deletion that left that page untouched, nor tell a pure
  shift from a deletion paired with insertions that cancel out, so a multi-page
  window can still miss an item at a page boundary. This is a **required
  completeness blocker** until the owner accepts it or a stronger scheme exists, not
  a passed gate. The other residuals are named, not hidden: (1) the one above; (2) a draft release
  or an in-flight run that sat BEYOND the first page when a target was first seen
  is not tracked, because the first sight reads one page; (3) a run re-run long
  after it settled, a run unsettled for more than a day and a draft untouched for
  more than thirty days are outside the tracked floor; (4) a pull request with more
  than 100 reviews cannot be read whole and blocks. Each remains a required
  parity blocker until the owner accepts or a stronger scheme exists.
- **No live certification of completeness or latency.** `pnpm
  probe:watch-reader` showed real, non-empty answers for the repository, pull
  request, issue and commit surfaces on the public probe repository, and EMPTY
  answers for reviews, workflow runs and releases, so those three item schemas are
  checked against GitHub's documented shape only; the probe exits non-zero for an
  empty answer unless `--allow-empty` accepts it as shape-only evidence. None of
  that is evidence of completeness, latency, quota behaviour under the source's real
  selection, or runtime eligibility (issue 8), all of which remain required
  operational checks. Discovery has not been probed at all.
- **Discovery is implemented and unit-tested, and not enabled or probed live.** It
  is a per-owner pass of one page per unit (at most five pages of a hundred, every
  six hours, resumable), enabled only by frozen configuration that also names the
  account that IS the owner (`DUCKY_ASSISTANT_WATCH_DISCOVERY_ENABLED`,
  `DUCKY_ASSISTANT_WATCH_ACCOUNT`; the account cannot be proven through an approved
  read, so it is stated, as with review requests). A repository is stored only if its
  relationship to that account (owner, organization, collaborator) is in the
  configured scope; a repository the owner deleted is not brought back; a cancelled
  or muted target keeps its state and only its recency and eligibility facts are
  refreshed; discovered targets count toward the 1,000 ceiling, and overflow or more
  than five pages is reported in `/status` as an incomplete pass, never truncated or
  cancelled.
- **The source's poll cycle is preserved, not swept.** With the real reader the
  service covers at most 40 eligible active targets per cycle, most recently pushed
  first (not archived, and not a fork the account owns, unless included); a target
  beyond that is not read, as in the source, but its metadata is refreshed every six
  hours so a quiet repository that wakes up can rise into coverage. A target whose
  recency is not yet known has only its metadata read until it is. Counts are in
  `/status`. Whether this meets the source's timing under the real quota and the real
  selection is unproven.
- **The global monitoring switch** is carried over from the import and gates reads
  only (no target or cursor changes). There is no owner control to flip it: the
  owner-only command manifest is not expanded, so an operator states it by importing
  a document. **That missing control is a named blocker.**
- It adds no engineering permission, no owner command and no write.

## Alternatives considered

- *`gh api --paginate`.* Rejected: unbounded, and it hides requests from the
  budget.
- *`--include` to read `Link` headers and totals.* Rejected: the owner approved
  four-word shapes with no flag.
- *The `/notifications` API.* Not approved, and not needed: the typed surfaces
  carry the events.
- *Close a runs or releases window on the event time.* Rejected: those lists do
  not sort on it, so a later update to an older item would be silently missed.

## Consequences

- Migrations 30, 31 and 35 are additive: pending state, scan floor and lifecycle floor,
  target facts (`pushed_at`, `relationship`, `archived`, `fork`, `cancel_reason`,
  `origin`), the discovery pass, discovery tombstones (by trigger, so no deletion path can
  forget one) and the per-owner monitoring switch.
- A repository the provider no longer shows is cancelled by the system with a
  `not_found` reason, as the source unmonitors it, but only after a SECOND consecutive
  not-found on the metadata read, a backoff apart. One answer cannot tell a missing
  repository from a private one without access or a moment of provider trouble, and a
  cancellation has no owner control to undo it; a success in between resets the count.
  The row, its events and the owner's Forget control remain, and `/status` counts these.
- Discovery that ran before the import is ADOPTED by it, never a collision: the source's
  mute wins over discovery's default (an unsettled floor a pending runs or releases read already
  had is kept); a surface Ducky has not read takes the source's cursor;
  one it HAS baselined (silently, announcing nothing) takes the EARLIER of the two cursors with
  a strict boundary, so what happened between them is read and told once rather than skipped;
  events are added where unknown, and where an event is known on both sides the source's
  alert/digest settlement fills what Ducky has not settled and never clears one it has. A
  mute the owner already made in Ducky is never undone. Nothing here touches
  authorization.
- A target the poll cycle cannot read (a renamed or transferred repository) or that is
  outside the frozen discovery scope does not occupy one of the 40 slots.
- A multi-page window costs one extra request.
