# Herdr and Pi integration

Herdr is the workspace and process layer; Pi is the engineering orchestrator;
Claude is the implementation worker. Ducky drives them through Herdr's existing
CLI. It does **not** replace Pi with another local framework, and it never
spawns an agent outside Herdr's supervision.

## Verified on this host

`pnpm probe:herdr` creates a throwaway git repository, exercises the mutating
commands, records redacted responses into
`packages/adapters/src/herdr/herdr.fixtures/`, and removes everything it made —
including on failure. `herdr-contract.test.ts` then parses those fixtures with
the **production** schemas.

Recorded and passing:

| Command | Notes |
|---|---|
| `agent list` | `name`, `agent`, `agent_status`, `cwd`, `pane_id`, `workspace_id` |
| `workspace list` | `workspace_id`, `label`, `agent_status` |
| `workspace create` | `.result.workspace.workspace_id`, `.result.root_pane.pane_id` |
| `workspace report-metadata` | **succeeds with an empty body** — exit code only |
| `pane split` | `.result.pane.pane_id` |
| `worktree create` | `.result.worktree.path`, also `.result.workspace.worktree.checkout_path` |

Two things the probe corrected, which is precisely why it exists:

- `report-metadata` returns nothing at all on success, so it needs an
  exit-code-only call path rather than a JSON parse.
- A linked worktree is checked out under **Herdr's own** worktrees directory,
  not inside the source repository. The result file must be read from the
  reported checkout path; falling back to the repository root would read the
  wrong tree.

`herdr api schema --json` publishes the server's own JSON-Schema for all 90
socket methods. It is now the primary source for response shapes and field
optionality — a sample response tells you what one server happened to send,
the schema tells you what it may send. Two fields were wrong in our schemas
because they were inferred from samples: `AgentInfo.agent` and `AgentInfo.name`
are both nullable.

## Verified by the agent probe

`pnpm probe:herdr --with-agent` additionally exercises `agent start`,
`agent prompt` and `agent get`, which launch a real Pi agent. Recorded:

| Command | Notes |
|---|---|
| `agent start` | `{ agent, argv }`; returned in ~6 s with `agent_status: idle`, `interactive_ready: true` |
| `agent prompt` | `{ agent }` carrying the **settled** agent; a probe turn settled `done` |
| `agent get` | bare `agent_info`; a missing target is exit 1 with `agent_not_found` on stderr |

The probe also confirmed a non-UUID `--session-id` is accepted, that the result
file lands in the Herdr checkout, and that Pi will write `.ducky/phase` when the
brief asks it to.

## What the live probes corrected

Five behaviours that unit tests could not have caught, each found by running
the real thing:

1. **`worktree remove` refuses a dirty checkout** with
   `dirty_worktree_requires_force`. Every finished job leaves at least an
   untracked `.ducky/result.json`, so this is the NORMAL outcome of cleaning up
   after real work. Ducky does **not** force: that checkout holds the
   implementation and nothing has committed it, so forcing would delete the
   work. The workspace is kept and says so.
2. **`worktree create` needs `--label`.** Without it Herdr names the workspace
   after the branch (`ducky-job-<id>`), which does not start with `ducky-mgd:`
   — so the ownership proof in `cleanup()` could never pass and every worktree
   job leaked its workspace and checkout. The mock had been synthesising a
   `ducky-mgd:` label of its own, which is why no test failed.
3. **`agent prompt --wait` can return `agent_prompt_stalled`** on a perfectly
   healthy agent: Herdr requires a lifecycle change within its own 5-second
   window. Treated as a signal to keep observing, never as a failure, and never
   as a reason to re-prompt (that would be a second writer).
4. **`agent start` returning does not guarantee promptability.** A resumed Pi
   session was detected while still printing banners and refused a prompt three
   seconds later with `agent_not_ready`. Readiness is now observed before the
   first prompt, and that code is retried a bounded number of times.
5. **A large brief does not survive a bracketed paste.** Measured: 1.5 KB / 30
   lines submitted fine; 3.3 KB / 66 lines was left sitting UNSENT in Pi's input
   buffer. The brief is therefore written to `.ducky/brief.md` and only a
   one-line pointer is pasted — which also means no part of the brief can be
   reinterpreted as key presses.

Cleanup ordering is load-bearing: a linked worktree's bookkeeping lives in the
SOURCE repository's `.git`, so `worktree remove` must run **before** the source
is deleted. Deleting the source first strands the checkout permanently; two
such orphans were found on this host and had to be removed by hand.

## What the probes refuse to do

Both probes were tightened after review, because a certifier that cannot fail is
not a certifier.

`pnpm probe:live-job`:

- targets `example-sandbox` and will not be redirected. `PROBE_REPO_SLUG` used to
  accept any allowlisted slug, which meant one stray variable pointed a real Pi
  agent with edit capability at a real repository. The run is now authorised by a
  **committed `.ducky-disposable` marker** in the target repository — a slug is a
  label somebody typed, a marker is the repository asserting its own
  disposability;
- runs the loop inside `try/finally`, so the ExecutorLoop is stopped and the
  server and database are closed on every path. An exception used to escape and
  leave a polling executor running against an abandoned database — and could
  close SQLite underneath an in-flight turn;
- bounds shutdown, and **refuses to close the transport, server or database
  while the executor loop is still running** — closing SQLite under a live loop
  risks corrupting whatever it is mid-write on, so everything is left open, said
  out loud, and taken down together by process exit;
- refuses to read evidence at all when the loop did not stop, because a report
  taken mid-flight could describe a state that never existed as a whole;
- accepts only two environment knobs, and bounds both: `PROBE_REPO_SLUG` still
  needs a **committed** `.ducky-disposable` marker in the target repository, and
  `PROBE_TIMEOUT_MS` is validated and clamped to
  `[60s, JOB_MAX_WALL_CLOCK_MS + 5m]` — a non-numeric value is refused outright,
  because `NaN` used to make the watch loop skip entirely and the probe read
  evidence from a job that had not started. `PROBE_TASK` is not a knob at all;
- **asserts** its evidence rather than printing it: final state `completed`,
  verdict `implemented`, an independent passing review, verification with real
  commands, changed files, the `planning`/`implementing` phases, and the
  `worktree create` / `agent start` / `agent prompt` calls. Missing evidence
  exits 4; leftover state exits 5.

`pnpm probe:herdr`:

- derives the child-process timeout from the wait each command asks for. It
  capped the child at 60 s while asking `agent start` for 120 s and
  `agent prompt` for 300 s, so both were killed before they could succeed;
- fails on missing evidence. A run that recorded no result file and no phase file
  used to print the problem and exit 0, and the success path called
  `process.exit(0)` over the top of the exit code the leftover check had just
  set.

## Known intermittent: a "ready" agent that is not ready

Characterised over repeated production-path runs on this host. Of the runs
attempted after the orchestration fixes landed, **two reached `completed` with an
accepted `implemented` result and three failed this way** — and only one of the
two was checked against the full evidence gate, because the gate was added after
the first. So the failure is the more common outcome, not the exception:

`agent start` returns with `agent_status: idle` and `interactive_ready: true`
while Pi is **still painting its startup banners** (update notices, package
notices). A prompt submitted in that window is silently dropped: Pi never enters
`working`, and `agent prompt --wait` gives up with `agent_prompt_stalled`.

Ruled out: session accumulation. `--session-id ducky-<slugKey>` produces a
SEPARATE timestamped session file per run (eight observed), so nothing grows
across runs and a resumed session is not the cause. The pane content is what
identifies it — banners and no prompt.

Ducky's behaviour in this case is correct and deliberate, which is why it is
documented rather than patched over:

- the stall is not treated as an outage (it has its own error code);
- the agent is observed for a bounded window in case it starts late;
- it is **never re-prompted** — a second prompt to an agent that did receive the
  first would be a second writer;
- the workspace and the repository reservation are both retained, so the owner
  can look;
- `pnpm probe:live-job` exits non-zero rather than certifying.

**No timing heuristic has been added.** Sleeping after `agent start` and hoping
would be a guess dressed as a fix, and Herdr's own readiness signal is the thing
that is wrong here. A real fix needs a Herdr-side readiness predicate that
accounts for an agent's own startup output.

Until there is one: a production-path run is **not reliably reproducible on this
host**, one observed success is **not** a certified integration,
`HerdrPiOrchestrator.verified` stays `false`, `/status` reports `experimental`,
and `DUCKY_HERDR_VERIFIED` is unset.

## Verified status

`HerdrPiOrchestrator.verified` is still `false` and `/status` still reports
`experimental`. `DUCKY_HERDR_VERIFIED=1` remains a deliberate operator act —
nothing in the code sets it, and this run did not set it.

## Ownership rules

Reuse or cleanup requires **all three**, and the third is authoritative:

1. the agent name starts with `ducky-pi-`;
2. the workspace label starts with `ducky-mgd:`;
3. the workspace id is recorded in `herdr_workspaces`.

This is not paranoia. The live host already has a **user** workspace labelled
exactly `ducky`, so a label check alone would have matched a human's session.
When ownership cannot be proven, Ducky reuses nothing, closes nothing, prompts
nothing, and reports `foreign_agent_conflict`.

`workspace close` and `worktree remove` only ever run against ids recorded in
`herdr_workspaces` with no live reservation.

## No caller pane

A systemd executor has no `HERDR_PANE_ID`. The CLI reaches its server over a
socket, so workspace-scoped commands work without caller context and `--current`
is never used. If no Herdr server is reachable the job fails with
`herdr_unavailable` — never a silent fallback to some other execution path.

## Agent naming

`ducky-pi-<slugKey>`, where the repository slug is normalized and hash-suffixed
if needed, so the name always satisfies Herdr's `[a-z][a-z0-9_-]{0,31}` rule.
Herdr enforces that live agent names are unique, which is the third of the four
single-writer guards.

## The brief handed to Pi

Redacted, control-stripped and length-capped, and it states the boundaries
verbatim: one implementation writer, an independent review, real verification
commands, **no commit, push, PR, merge, deploy or cloud mutation**, and the exact
result-file contract. The result file is the only channel back.
