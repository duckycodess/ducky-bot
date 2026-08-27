# Documentation index

## By task

| I want to… | Read |
|---|---|
| understand the system | [ARCHITECTURE.md](ARCHITECTURE.md) |
| run it locally | [DEVELOPMENT.md](DEVELOPMENT.md) |
| know what actually works today | [CURRENT_STATE.md](CURRENT_STATE.md) |
| understand the security model | [SECURITY.md](SECURITY.md) |
| know what is tested | [TESTING.md](TESTING.md) |
| deploy it later | [DEPLOYMENT.md](DEPLOYMENT.md) |
| add a repository | [runbooks/repo-onboarding.md](runbooks/repo-onboarding.md) |
| rotate executor credentials | [runbooks/credential-rotation.md](runbooks/credential-rotation.md) |
| recover a stuck job | [runbooks/orphan-recovery.md](runbooks/orphan-recovery.md) |
| finish the OpenClaw integration | [integrations/openclaw.md](integrations/openclaw.md) |
| understand the Herdr binding | [integrations/herdr.md](integrations/herdr.md) |
| write the completion report | [COMPLETION_REPORT_TEMPLATE.md](COMPLETION_REPORT_TEMPLATE.md) |

## By subsystem

- **contracts** — schemas, state machine, limits, the owner-only manifest
- **persistence** — SQLite, migrations, repositories
- **adapters** — credentials, GitHub (read-only), Herdr, Pi, OpenClaw, schedule
  extraction, redaction, subprocess
- **coordinator** — authorization, Discord, HTTP, domain services, reconciler
- **executor** — outbound client, workspace resolution, single-writer lock

## Decisions

[decisions/README.md](decisions/README.md) lists the ADRs.

## Authority

Source and tests outrank prose. Where documents disagree, follow the order in
[`AGENTS.md`](../AGENTS.md).
