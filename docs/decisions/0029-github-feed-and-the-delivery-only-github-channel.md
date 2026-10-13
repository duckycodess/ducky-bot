# ADR 0029 — The GitHub feed, and a channel that only ever receives

**Status:** accepted
**Extends** [ADR 0012](0012-opt-in-shared-job-visibility.md) and
[ADR 0023](0023-channel-roles-and-persistent-replies.md); supersedes nothing.

## Context

`GitHubWatchService` reports that an allowlisted repository's snapshot changed,
to the owner's DM. The owner wants something different: the few GitHub events
they must decide about (a review request, requested changes, a failed check, a
new issue or pull request), as they happen, in a server channel, plus one
digest of default-branch commits per day instead of a stream of them. That
brings three problems the watch never had: a channel other people read, history
that must not flood, and reads that `gh <noun> <verb> --json` cannot express.

## Decision

A second, bounded reader, `GitHubFeedService`, beside the watch. Same port
(`GitHubReader`), same transport, same coordinator interval, no model provider.

**Identity and history.** Every event has a stable key under a UNIQUE
constraint (repository and number; a review's own id; a check's pull request,
head commit, name and completion time; a workflow run's id and rerun attempt).
The first successful read of each (repository, kind) records what exists as
`baseline` and announces none of it; a read that fails records nothing, so an
unreachable repository can never become an empty baseline. Events are also
dated by a GitHub-supplied watermark, so an old item that merely rolls into a
bounded window is recorded, not announced.

**Selection is not allowlisting.** The selected list is its own table, keyed by
`owner/repo`, seeded from the enabled, GitHub-mapped allowlist entries and
extended by `DUCKY_GITHUB_FEED_REPOS`. Nothing references `repos`, nothing
writes `allow_jobs`, and a cancelled seed is a tombstone that reconciling does
not undo.

**Routing is decided at send time, from a fresh read.** A card reaches the
channel only if the channel is configured, the repository is selected, and a
`repoView` read in the last five minutes says it is public. Everything else,
including a failed or silent read, goes to the owner's DM. Visibility is never
stored. Digest sections follow the same rule per section; one that is private
at send time is delivered to the DM in the same pass instead.

**The `github` role is delivery only.** It is a channel role (profile-scoped
like the rest) but inverts ADR 0023's "private channel" assumption: other people
may read it, so an owner command reply there is ephemeral, nothing typed there is
read, and no write intent, pasted list, `$grill-me`/`$ticket`/`$agentize` or model
turn can start from it. Visibility is still not authorization.

**Two reads get an exact argv shape.** Commits come from
`gh api --method GET repos/{owner}/{repo}/commits?sha=<branch>&per_page=30&page=N`
(there is no `--json` form), and review requests from
`gh search prs user-review-requested:@me --state open --sort updated --order desc --limit 25 --json ...`.
Each is built from validated parts and re-checked from scratch by an
argv-shape predicate in the central command policy, so a verb match alone clears
nothing. `api` stays on the forbidden-verb list for every other table.

**Review requests have episodes.** The search has no request timestamp. While a
pull request keeps appearing it is one request; absent from a read that was not
full, it has ended, and its next appearance is a renewed request with a new key.
A full window cannot prove an end, so nothing is concluded from it, and
`/status` says coverage is bounded.

**Checks.** Actions runs are read from `gh run list`; checks that are not
Actions-backed (external CI statuses, app check runs) from `gh pr checks` for
the five newest open pull requests. A check carrying a `workflow`, or linking to
an Actions run, is left to the run path so nothing is announced twice.

## Alternatives considered

- *Extend the watch's snapshot diff.* Rejected: a diff of a snapshot cannot give
  an event an identity, and "something changed" is exactly the noise being
  removed.
- *Merged pull requests as the commit source.* Rejected: a direct push to the
  default branch would never appear.
- *A date filter instead of a seen-set for commits.* Rejected: a merge commit
  can bring in commits dated before the previous head.
- *One shared channel for everything.* Rejected: a private repository's title
  would be published to everyone who can read it.
- *`api` allowed generally.* Rejected: one exact shape instead.
- *Stored visibility on the card.* Rejected: a repository can turn private
  between observation and delivery.

## Consequences

- Review-request coverage is the 25 most recently updated requests. A request
  that ends and is renewed while the window is full cannot be told from one that
  was pushed out; `/status` reports the window as full.
- External-check coverage is the five newest open pull requests per pass; an
  older pull request's external checks are not watched. A commit status reports a
  placeholder time, so it is treated as undated: its identity is the pull
  request, head, name and failure episode, and it is announced only on a
  provable transition or a new head, never for history met for the first time.
  A pass in which any pull request's checks cannot be read keeps the old
  watermark.
- Actions failures on pull request branches are covered by the run path; a
  check-run failure that is not a workflow run is covered by the checks path.
- Daily digest timing depends on the coordinator interval; the digest waits up to
  30 minutes for a post-slot read of every selected repository, then sends what
  it has and names any repository it could not read (in the DM only). Unsent
  commits are retired 14 days after they were observed.
- Retention keeps what stops history looking new: baseline rows, review-request
  keys, the newest 100 consumed commits per repository, the selected list and the
  cursors.

## Follow-up

- A live observation of a NEW pull request, a failing external check and a
  non-empty review-request result needs events that do not exist on the
  development repository; nothing here opens a pull request to manufacture one.
- Real Discord delivery to a configured github channel is unverified on this host.
