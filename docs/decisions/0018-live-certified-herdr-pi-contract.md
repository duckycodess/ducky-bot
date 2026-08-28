# 0018. The Herdr/Pi contract is what the live CLI does, not what its help says

> **Scope note.** This ADR records a CONTRACT established by running the real
> CLI. It does not certify the integration: see the Consequences section, and
> `docs/CURRENT_STATE.md` for what has and has not been reproduced.

**Status:** Accepted

## Context

`agent start` and `agent prompt` had never been exercised: doing so launches a
real Pi agent. Their argv shapes came from the CLI help and the shipped skill
file, and every test drove them through `MockHerdr`.

Running them found five defects, and the reason none of them had a failing test
is the same in every case: **each mock was more helpful than the real thing.**

1. **A 30-second cap killed every real turn.** `agentPrompt` passed
   `--timeout 7200000` into herdr's argv, but spawned the child with
   `HERDR_TIMEOUT_MS` (30 s). `execFile` SIGTERMed a healthy wait, the empty
   output classified as `herdr_unavailable`, the writer lock was released, the
   reservation was released — and the Pi agent kept writing. `MockHerdr`
   recorded the timeout and never spawned, so nothing could see it.
2. **`worktree create` without `--label`** makes Herdr name the workspace after
   the branch (`ducky-job-<id>`), which does not start with `ducky-mgd:` — so
   `cleanup()`'s ownership proof could never pass and every worktree job leaked
   its workspace and checkout. The mock synthesised a `ducky-mgd:` label of its
   own regardless of what it was given.
3. **`agent prompt --wait` can answer `agent_prompt_stalled`** on a healthy
   agent: Herdr wants a lifecycle change within its own 5-second window.
4. **`agent start` returning does not mean promptable.** A resumed Pi session
   was detected while still printing banners and refused a prompt three seconds
   later with `agent_not_ready`.
5. **A large brief does not survive a bracketed paste.** 1.5 KB / 30 lines
   submitted; 3.3 KB / 66 lines sat unsent in Pi's input buffer.

## Decision

- **Subprocess budgets are derived per call**, always strictly greater than the
  wait they host. A regression test asserts the options `runArgv` received,
  because that is the layer where this was invisible.
- **Classify on Herdr's machine `code`**, with the old prose match kept only as
  a fallback for a response with no parseable envelope. `not_found`,
  `herdr_prompt_stalled`, `herdr_agent_not_ready` and `herdr_worktree_dirty` are
  four distinct outcomes with four different correct responses; collapsing any
  of them into "Herdr is down" releases a repository that still has a writer.
- **A prompt failure is not a turn outcome.** The agent is re-observed, and
  anything that cannot be proved quiescent is an ORPHAN — which now also retains
  the host writer lock, matching the cancellation branch.
- **`agent prompt` returns the settled agent**, so `blocked` is distinguishable
  from finished. It used to return `void`, so a Pi approval prompt looked like a
  turn that produced no result.
- **A stall means keep observing, never re-prompt.** A duplicate prompt to an
  agent that did receive the first would be a second writer.
- **The brief travels as a file.** `.ducky/brief.md`, `0600` in a `0700`
  directory; only a one-line pointer is pasted. A knock-on benefit: no part of
  the brief can be reinterpreted as key presses.
- **Cleanup does not force.** A finished job's checkout holds the
  implementation and nothing has committed it, so `worktree remove` is called
  without `--force` and a refusal is reported as "kept" rather than thrown. The
  probe forces only its own temp checkout.
- **Cleanup order is part of the contract.** A linked worktree's bookkeeping
  lives in the source repository's `.git`, so removal must precede deletion of
  the source. Two permanently stranded checkouts on this host are what that
  costs when it is done in the wrong order.

## Alternatives considered

- **Force the worktree removal.** Cleaner teardown, and it deletes the work the
  job was asked to do. Rejected outright.
- **Raise `HERDR_TIMEOUT_MS` globally.** Would have fixed the symptom while
  leaving every ordinary command with a two-hour budget.
- **Re-prompt on a stall.** The obvious retry, and the one that creates a second
  writer on the repository.
- **Keep pasting the brief and just shorten it.** The brief is the only place
  the boundaries are stated; shortening it to fit a terminal is the wrong thing
  to optimise.

## Consequences

The production path has been **observed** working end to end once:
`preparing → planning → implementing → reviewing → fixing → verifying →
completed` in 271 seconds, with an independent passing review and real
verification exit codes.

One observed success is not a certified integration, and the distinction is the
point of this ADR rather than a caveat on it. Other runs failed with
`agent_prompt_stalled` — `agent start` reports `interactive_ready: true` while Pi
is still painting its startup banners — so the end-to-end path is intermittent
and repeatability is **not** established. Each decision above is justified by the
contract it pins down, not by that one run.

`HerdrPiOrchestrator.verified` remains `false`. `DUCKY_HERDR_VERIFIED=1` is a
deliberate operator act and nothing in the code sets it.

**A completed worktree job now keeps its workspace**, because the work in it is
uncommitted. The reservation is released so nothing is blocked, but the owner
clears the workspace, or the reconciler sweeps it after
`HERDR_WORKSPACE_TTL_MS`.

And a standing rule for this repository: **a mock must mirror the real thing,
not improve on it.** Every one of these five defects was hidden by a mock that
was more accommodating than the CLI.
