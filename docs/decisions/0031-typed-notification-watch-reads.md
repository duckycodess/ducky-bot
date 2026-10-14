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
  anything else, or a runs total that shrank, restarts the pass with backoff;
  what was found stays held, because it is real and deduplicates by identity. A
  window that fitted one page is one consistent answer and is not re-read.
- A window past its page cap (3 commit pages, 50 pull and issue pages, 10 runs,
  releases or review pages) is **blocked as `window_exceeded`** with the cursor and
  the held events untouched. It is a counted, visible blocker, not a partial scan.

### Late reviews at the cursor

When the items at the cursor were processed by a Ducky pass
(`boundary_known`), a pull request touched exactly at the cursor is listed again,
its reviews are read again, and a review at the cursor is told from an announced
one by its id. A baseline or a source cursor stays strict.

## What this ADR deliberately does not claim

- **Completeness is proven only as far as these reads allow.** The residuals are
  named, not hidden: (1) a deletion and insertions that cancel out between the
  first read of a page and its re-read look like a pure shift; (2) a draft release
  or an in-flight run that sat BEYOND the first page when a target was first seen
  is not tracked, because the first sight reads one page; (3) a run re-run long
  after it settled, a run unsettled for more than a day and a draft untouched for
  more than thirty days are outside the tracked floor; (4) a pull request with more
  than 100 reviews cannot be read whole and blocks. Each remains a required
  parity blocker until the owner accepts or a stronger scheme exists.
- **No live certification of completeness or latency.** `pnpm
  probe:watch-reader` recorded that each approved surface (except discovery)
  answers and parses against the public probe repository. That is not evidence of
  completeness, latency, quota behaviour under the source's real selection, or
  runtime eligibility (issue 8), all of which remain required operational checks.
- **Discovery is specified here but not enabled.** Its shape is pinned, its
  reader method refuses unless frozen configuration enables it, and this build
  does not enable it. Persisted discovery, the source's recency-limited poll cycle
  and the eligibility filters are tracked in `docs/CURRENT_STATE.md` and
  `openspec/changes/dcstro-full-parity-migration/tasks.md` as unfinished.
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

- Migration 30 adds `pending_state`, `scan_floor` and target facts (`pushed_at`,
  `relationship`, `archived`, `fork`, `cancel_reason`). Additive only.
- A repository the provider no longer shows is cancelled by the system with a
  `not_found` reason, as the source unmonitors it; the row, its events and the
  owner's Forget control remain.
- A multi-page window costs one extra request.
