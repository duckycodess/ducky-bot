# OpenClaw integration

## Status: not installed, API unverified

OpenClaw is not present on this host — not on `PATH`, not in the global package
list, and no configuration directory exists. The package is published on npm as
`openclaw`, described as a *multi-channel AI gateway with extensible messaging
integrations*, with a bin of the same name and an engines range that accepts
this Node version.

That is the extent of what could be established without installing it, which was
outside the scope of this run.

## What ships instead

- `ConversationProvider` — the port the coordinator depends on.
- `MockConversationProvider` — the default. It answers, and **every reply is
  prefixed `[mock]`** so a canned answer can never pass for a real one.
- `HttpOpenClawProvider` — a guard, not an implementation. It validates the
  gateway URL at construction and then **throws** from `reply()`. Guessing at
  routes and a response shape would have produced code that looks finished and
  fails in production; failing loudly is the honest option.

The private-URL guard is already enforced: loopback, `100.64.0.0/10` and
`.ts.net` are accepted, everything else is refused at construction and again at
startup.

## Finishing the integration

1. Install it deliberately (`npm i -g openclaw`) — an environment mutation that
   needs its own approval.
2. Probe the real surface: `openclaw --help`, the subcommand help, and whatever
   HTTP routes it exposes when bound to loopback.
3. Record what the request and response actually look like, the auth model, and
   whether replies stream.
4. Implement `HttpOpenClawProvider.reply()` against that, with a zod schema for
   the response.
5. Add a contract test over recorded responses, exactly as `herdr-contract.test.ts`
   does.
6. Set `OPENCLAW_BASE_URL` to a loopback or tailnet address. A public URL is
   refused.

## Consequence for schedules

The deterministic extractor reads text and CSV only and reports
`supportsBinary: false`. Because no provider can read image or PDF bytes,
`/schedule` refuses those uploads **before downloading them** rather than
showing an invented preview — and no image or PDF decoder ships at all, which
keeps that entire parsing surface out of Phase 1.

Enabling binary extraction requires both a provider that reports
`supportsBinary: true` and `SCHEDULE_BINARY_EXTRACTION_ENABLED=true`.
