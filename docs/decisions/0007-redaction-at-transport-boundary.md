# 0007. Redaction at the transport boundary; no secret in the database

**Status:** Accepted

## Context

Text reaches Discord from many places: presenters, error paths, executor
progress, result summaries. An earlier design put redaction in the presenters,
which only holds while every future presenter remembers.

## Decision

`sanitizeOutbound` is called as the **first statement of every send and edit
method on every transport**, real and mock. Presenters may also sanitize — it is
idempotent — but the guarantee does not depend on them.

It strips ANSI and control characters, redacts secret shapes, folds `/home/<user>`
to `~` and the account name to `Tj`, and enforces Discord's own limits locally
so an over-long message is truncated with a visible marker rather than rejected
at delivery.

Separately, no table stores a secret, and structured logs never carry a raw URL,
header set, body, or task text — the orchestration prompt is logged only as
`<prompt:sha256:…>`.

## Alternatives considered

- **Redact in presenters.** One forgotten call is a leak.
- **Redact in the Discord client wrapper only.** The mock transport would then
  behave differently, so tests would not exercise the real path.
- **Trust the executor.** Its identity is authenticated; its *content* is not,
  since it relays model output about untrusted repositories.

## Consequences

A new presenter cannot leak by omission. Tests drive every public transport
method with a poisoned payload through a fake client and assert the raw values
never arrive. `discord.js` is imported by exactly one module, also asserted.
