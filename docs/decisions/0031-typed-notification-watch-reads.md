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
  event time cannot close the window. A window closes on an item CREATED STRICTLY
  BEFORE both the cursor and the creation time of the oldest item that was still
  unsettled (a running workflow, a draft release) when the last window closed;
  strictly, because items created in one second can span a page boundary and the one
  that matters may sit on the next page. The engine persists that floor (`scan_floor`)
  and it has **no age cutoff**: it is recomputed from what each window actually
  observed, and only settlement, publication or an item's absence from a window that
  reached its creation time releases it. A floor deeper than the page cap blocks as
  `window_exceeded` with the cursor, the floor and the held events kept; it never
  expires or resets. A draft with no usable creation time cannot be placed in a window
  and blocks (`draft_untrackable`) instead of being skipped. A draft's cursor cap is the
  start of the second it was read in (less a millisecond), because the provider stamps
  whole seconds and a publication in the read's own second must still be later.
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

### The first observation of runs and releases

A NEW null-cursor runs or releases checkpoint is not baselined by one page. It reads the
whole bounded inventory, one request per unit, and re-reads the last page like any other
multi-page window.

- **A frozen boundary, not the newest time seen.** Before its first request the pass
  takes `floorToSecond(now) - 1ms` and stores it in the scan JSON (`baseline.boundaryMs`;
  no schema change). Every such baseline, one page or many, commits EXACTLY that boundary
  with a strict boundary flag. Committing the newest stamp would swallow a transition that
  happened while later pages were still being read: an old run that settled between the
  page-one read and its own page's read carries a stamp newer than anything it would have
  been judged against. The one millisecond keeps events stamped in the first second (the
  provider stamps whole seconds) on the announced side.
- **Nothing before the boundary is delivered.** The baseline itself delivers nothing. The
  following ordinary pass reads from the boundary, so only what moved after it is announced,
  once, by identity. A run that was already running at the boundary announces no
  `ci_started` (a run announces a start only if it was created after the cursor); it still
  announces its conclusion.
- **The next pass can reach what moved.** The creation floor committed with the baseline
  covers every unsettled item AND every item that moved after the boundary (a run's last
  update, a release's publication), so an older-created item that settled or published
  before its page was read is inside the next window. It is recomputed normally afterwards.
- **The boundary survives every retry.** It is written BEFORE the first request, so a
  failure of that request (the repository metadata read included) cannot re-anchor the
  retry later. A transient failure keeps the whole scan. A drift restart keeps only the
  original boundary and the creation floor so far and drops page, last page, total, CI
  state, cap and queue. A marker beside a real cursor, or a null-cursor read with progress
  but no marker (written by earlier code), resets positional progress and starts over.
  Importing a source cursor into an unbaselined checkpoint clears any half-read position.
- **Capacity, honestly.** `hasMore` is judged by page cardinality, so a full tenth page
  cannot be told from a longer list: **at most 99 runs (or releases) can be proven**; a
  branch with 100 or more is refused as `window_exceeded` with the cursor still null. A
  runs total from the provider never ends a window (a stale total would hide items) but
  refuses early: a total of 100 or more is refused on page one for one call instead of
  nine more. A refused surface leaves the CI state unset and `observes()` false, so native
  coverage is kept and the other surfaces still work. **There is no recovery control for
  `window_exceeded`**: it persists until the situation changes and `unblockObservable`
  runs, and it re-blocks if the list is still too deep.

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
  a passed gate. The other residuals are named, not hidden: (1) the one above; (2) the
  first-observation residual is REPLACED by a bounded refusal, not closed: a mature
  branch with 100 or more runs (or releases) refuses its first inventory, so that surface
  is not observed at all until that changes; (3) a run re-run long after it settled is
  outside the tracked floor, and a floor that falls deeper than the page cap blocks that
  surface; (4) a pull request with more than 100 reviews cannot be read whole and blocks;
  (5) imported and preexisting targets that were baselined shallowly before this change
  keep the floors they already lost, and a source cursor carries no unsettled inventory;
  (6) the boundary is a LOCAL clock time: skew beyond the one-second floor can still drop
  a transition or announce a few events of history, which is an evidence blocker, not a
  lossless claim; (7) release creation-versus-publication ordering is not certified live,
  and the probe's runs and releases answers were empty, so those schemas rest on the
  documented shape. **Costs:** a first observation is up to ten pages plus a re-read per
  surface (eleven requests, not one), and a deep steady-state floor costs its depth plus
  one request per 15-minute pass, all inside the existing 20-per-tick and 2,400-per-hour
  budgets. Each remains a required parity blocker until the owner accepts or a stronger
  scheme exists.
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
  only (no target or cursor changes). The owner flips it with `/watch monitoring`
  (explicit on or off), and resuming is refused while a native path overlapped a target
  during the pause (ADR 0032): the control exists, the cross-path reconciliation does
  not, and that stays a named blocker.
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
  mute wins over discovery's default (an unsettled floor a COMMITTED runs or releases read
  already had is kept; a half-read baseline is dropped and its boundary with it); a surface Ducky has not read takes the source's cursor;
  one it HAS baselined (silently, announcing nothing) takes the EARLIER of the two cursors with
  a strict boundary, so what happened between them is read and told once rather than skipped;
  events are added where unknown, and where an event is known on both sides the source's
  alert/digest settlement fills what Ducky has not settled and never clears one it has. A
  mute the owner already made in Ducky is never undone. Nothing here touches
  authorization.
- A target the poll cycle cannot read (a renamed or transferred repository) or that is
  outside the frozen discovery scope does not occupy one of the 40 slots.
- A multi-page window costs one extra request.
