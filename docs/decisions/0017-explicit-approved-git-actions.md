# 0017. Explicit, opt-in execution of approved Git actions

**Status:** Accepted

## Context

Phase 1 intentionally stopped every proposed action at the approval record.
That kept the boundary safe, but it also meant an approved local commit could
never be carried out. Phase 2 needs a real path without turning an approval
button into an unattended shell.

The coordinator also runs in a different topology from the WSL executor in the
intended deployment. A local performer must therefore be opt-in and must not
pretend that a cloud coordinator can access a WSL workspace.

## Decision

Approval and execution are two separate owner actions:

1. the executor submits an immutable, validated proposal;
2. the owner approves that individual action;
3. the owner explicitly invokes `/job execute id:<approval-id>`.

Before execution, Ducky re-checks owner ownership, approval state and expiry,
compares the approval with the immutable result snapshot, and claims one row in
`approval_executions`. A `running` attempt is not retried automatically after a
crash: an external command may have succeeded immediately before the crash, so
repeating it would be less safe than asking the owner to inspect and propose
again.

The enabled development performer supports only:

- a local commit of the exact approved repository-relative files;
- a non-force push to the configured `origin` and approved branch;
- a pull request with the approved title, body, base and head.

It uses `runArgv` only, checks the allowlisted workspace and GitHub origin, and
sets non-interactive GitHub/Git credentials behavior. Force, hook bypass,
merge, issue, deployment, Azure and other high-risk actions remain refused or
recorded-only. The profile-specific enable flag is off by default.

## Consequences

The local path is testable without making a real external write. Production
must first add an executor-routed action protocol; enabling the local flag on a
coordinator that cannot see the executor's filesystem is refused by the
workspace checks rather than guessed around.
