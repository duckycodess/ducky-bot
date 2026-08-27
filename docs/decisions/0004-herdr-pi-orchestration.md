# 0004. Herdr/Pi as the sole orchestration path, with a file result contract

**Status:** Accepted

## Context

Herdr already manages workspaces, panes and agent lifecycles on the development
host, and Pi is already the engineering orchestrator there. The temptation is to
build a second, Ducky-shaped orchestrator beside them.

## Decision

Drive the existing tools through Herdr's CLI: create a workspace or worktree,
start `ducky-pi-<slug>`, prompt it with a brief that states the boundaries, and
read a single structured `result.json` back.

Pi remains the orchestrator. Ducky does not spawn agents outside Herdr's
supervision, and it does not become a competing local AI framework.

Discovery comes before creation, and reuse requires a three-way ownership proof
— agent-name prefix, workspace-label prefix, and a row in `herdr_workspaces`,
the last authoritative.

Everything sits behind a `PiOrchestrator` port, with a deterministic mock as the
default for tests and token-less runs.

## Alternatives considered

- **Spawn Pi directly.** Loses Herdr's lifecycle states and leaves orphans with
  nothing tracking them.
- **A bespoke orchestrator.** Duplicates Pi badly and splits the user's
  workflow.
- **Streaming output instead of a result file.** Terminal scrape is lossy and
  would put raw transcript on the path to Discord. A file is atomic, re-readable
  after a crash, and validated once.

## Consequences

Ducky inherits Herdr's states and its unique-agent-name rule, which becomes the
third single-writer guard. A crashed executor can recover by reading a result
that was already written, rather than re-running the work.

The label check alone would have been unsafe: this host already has a **user**
workspace labelled exactly `ducky`.

Mutating commands could not be exercised while planning, so a probe records live
responses and a contract test parses them with the production schemas. `agent
start` and `agent prompt` remain unexercised, so the orchestrator reports itself
`experimental`.
