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

## Not verified

`agent start` and `agent prompt` were **not exercised**: doing so launches a
real Pi agent and consumes real model capacity. Their argv shapes come from the
`herdr` CLI help and the skill file shipped with the binary.

Consequently `HerdrPiOrchestrator.verified` is `false` and `/status` reports
`experimental`. Set `DUCKY_HERDR_VERIFIED=1` only after those two commands have
been exercised for real.

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
