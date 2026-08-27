# 0002. Built-in `node:sqlite` with hand-written migrations

**Status:** Accepted

## Context

One coordinator, one owner, modest data, running on a small VM. It needs
durability across restarts, real transactions, and no operational surface of its
own.

## Decision

Use the built-in `node:sqlite` module, and hand-write migrations as versioned
SQL in TypeScript, applied at boot inside `BEGIN IMMEDIATE`.

Verified on this host before committing to it: WAL, foreign keys, partial unique
indexes and `BEFORE UPDATE` triggers all behave as needed (SQLite 3.51.3).

## Alternatives considered

- **`better-sqlite3`.** Excellent, but a native module means a build toolchain
  on the VM and a rebuild on every Node upgrade — for no capability this system
  needs.
- **Postgres.** A second service to run, back up and secure, for a single-user
  workload that fits comfortably in a file.
- **An ORM or a migration framework.** More configuration surface than the
  handful of tables justify, and it would obscure the constraints that carry
  real invariants — the partial unique index and the immutability trigger are
  load-bearing and should be plainly visible.

## Consequences

No native build step; `pnpm install` is enough. Migrations are forward-only and
readable. Backups are a file copy or `db.backup()`. Concurrency is one writer,
which matches the design. Moving to Postgres later would mean rewriting the
repositories, which is acceptable at this scale.
