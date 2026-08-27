# 0001. pnpm workspace with five packages

**Status:** Accepted

## Context

Two processes share a great deal: schemas, the state machine, redaction,
subprocess handling. Duplicating those would let the coordinator and the
executor drift apart on exactly the contracts that must not drift.

## Decision

One pnpm workspace, five packages, dependencies flowing one way:

```
contracts ← persistence
contracts ← adapters
contracts, persistence, adapters ← coordinator
contracts, adapters ← executor
```

`contracts` carries zod only. `persistence` never imports an adapter. The
executor never imports `persistence` — it has no database and no listener.

## Alternatives considered

- **One package.** Nothing would stop the executor importing the coordinator's
  database code, and the "no listener" property would rely on discipline.
- **Separate repositories.** A shared contract across repositories needs
  publishing and version negotiation for a two-process system with one owner.

## Consequences

The dependency graph enforces properties that would otherwise be conventions.
`tsc --build` gives incremental project references. Tests live in each package's
`test/` and are typechecked separately, so test-only helpers cannot leak into
shipped code.
