# Architecture decision records

One record per decision that is long-lived, contract-shaping, or hard to
reverse. Trivial implementation choices do not get one.

| ADR | Decision |
|---|---|
| [0001](0001-monorepo-package-boundaries.md) | pnpm workspace with five packages |
| [0002](0002-node-sqlite-and-hand-rolled-migrations.md) | Built-in `node:sqlite` with hand-written migrations |
| [0003](0003-outbound-only-executor.md) | The executor polls outbound and never listens |
| [0004](0004-herdr-pi-orchestration.md) | Herdr/Pi as the sole orchestration path, with a file result contract |
| [0005](0005-openclaw-adapter-with-mock.md) | OpenClaw behind a port with a marked mock and a throwing HTTP guard |
| [0006](0006-approval-gate-deferred-performer.md) | Per-action approvals with a deferred performer |
| [0007](0007-redaction-at-transport-boundary.md) | Redaction at the transport boundary; no secret in the database |
| [0008](0008-executor-credential-model.md) | Verifier in the database, key material in a runtime store |
| [0009](0009-env-config-sole-authorization-authority.md) | Environment config is the only authorization authority |
| [0010](0010-per-repo-reservations.md) | Per-repository reservations as the single-writer boundary |
| [0011](0011-capability-honest-schedule-extraction.md) | Capability-honest schedule extraction |
| [0012](0012-opt-in-shared-job-visibility.md) | Opt-in shared job visibility through a projection |
| [0013](0013-bounded-reminder-recurrence-and-catch-up.md) | Bounded reminder recurrence, and a collapsing catch-up after an outage |
| [0014](0014-single-owner-timezone-as-a-projection.md) | One configured owner timezone, applied as a projection |
| [0015](0015-provider-agnostic-conversation-attachments.md) | Provider-agnostic conversation attachments, refused before download |
| [0016](0016-work-phases-dependency-waits-and-audit.md) | Work phases beside the state machine, bounded dependency waits, and a structured audit log |

## Format

Status · Context · Decision · Alternatives considered · Consequences ·
Follow-up.
