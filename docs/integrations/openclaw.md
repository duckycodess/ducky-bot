# OpenClaw integration

## Status: not installed, API unverified — and now explicit about it

Re-confirmed this run: `openclaw` is not on `PATH`, not in the global npm tree
(`@earendil-works/pi-coding-agent`, `@railway/cli`, `corepack`, `npm`, `pnpm`,
`tsx`, `typescript`, `vercel`), and no configuration directory exists at
`~/.openclaw`, `~/.config/openclaw`, `~/.local/share/openclaw` or
`/etc/openclaw`. A read-only registry query reports `openclaw@2026.7.1-2`, bin
`openclaw`, engines accepting Node 24.15.0.

### Provider modes

`DUCKY_CONVERSATION_PROVIDER` now decides, explicitly:

| Mode | development | production |
|---|---|---|
| unset | `mock` | **refused at startup** |
| `mock` | allowed, every reply prefixed `[mock]` | **refused at startup** |
| `disabled` | allowed | allowed — the honest choice today |
| `openclaw` | allowed; needs a private `OPENCLAW_BASE_URL`, fails per request | **refused at startup** while no contract is recorded |

This replaced `if (!OPENCLAW_BASE_URL) return mock`, which had **no profile
check at all** — so a production instance with the variable unset (the default;
it was not even in `.env.example`) silently answered the owner from a canned
mock. The mode is resolved before any filesystem or database work, so a
misconfigured instance fails on the cheapest possible check.

### The initialisation contract

`RECORDED_CONTRACT_VERSION` in `openclaw.contract.ts` is `null`, and
`HttpOpenClawProvider.initializable()` reports not-initializable because of it.
Production selecting `openclaw` is refused at startup as a result — a private URL
proves the address is not public, not that anything there speaks a contract we
have recorded.

It is a **source constant, not an environment variable**, on purpose: an operator
can set a variable but cannot conjure a recorded request/response shape, and
`verified` has to mean "a contract was recorded" or it means nothing. The check
is non-networked: reachability at boot would not prove the API either, and a
gateway that is merely down should not block a correctly configured instance.

Development may still select `openclaw` and find out per request. That is a local
box choosing to experiment, not an instance answering the owner.

`DisabledConversationProvider` refuses with `integration_not_verified` rather
than returning prose. It is deliberately not the mock: a mock invents a
sentence, and on a production instance the owner asking a question and getting
prose back is the failure mode, not the fallback.

The registry describes it as a *multi-channel AI gateway with extensible
messaging integrations*. That is the extent of what can be established without
installing it, and installing it has not been approved.

## What ships instead

- `ConversationProvider` — the port the coordinator depends on.
- `MockConversationProvider` — the default. It answers, and **every reply is
  prefixed `[mock]`** so a canned answer can never pass for a real one.
- `HttpOpenClawProvider` — a guard, not an implementation. It validates the
  gateway URL at construction and then **throws** from `reply()`. Guessing at
  routes and a response shape would have produced code that looks finished and
  fails in production; failing loudly is the honest option.
- Both providers declare `capabilities.attachments` as
  `NO_ATTACHMENT_CAPABILITY`, and both throw a distinct
  capability refusal if an attachment somehow reaches them.

The private-URL guard is already enforced: loopback, `100.64.0.0/10` and
`.ts.net` are accepted, everything else is refused at construction and again at
startup.

## Finishing the integration

0. Run `pnpm probe:openclaw`. With OpenClaw absent it exits 2 and prints the
   blocker rather than recording anything; it never guesses a route, a body or
   an auth model. It captures configuration KEY NAMES and the auth header NAME
   only — a recorded fixture containing a token would be worse than no fixture.
1. Install it deliberately (`npm i -g openclaw`) — a host-wide environment
   mutation that needs its own approval. **Not done in this run.**
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
7. **Only then** consider attachments. Flipping `verified` to `true` also opens
   the 2C attachment gate, so verification must cover the attachment contract
   and not only the text one: which MIME types the gateway really accepts, its
   own size ceiling, and how bytes are transferred. Fill those into
   `capabilities.attachments` from what was probed, not from what is
   convenient — the coordinator takes the smaller cap and the intersection of
   the type lists, so an over-claim here is the one that matters.

## Consequence for conversation attachments (2C)

The 2C pipeline is built and closed. An attachment on a conversation message is
refused **before download** because `attachmentsUsable` requires the provider to
be both `verified` and attachment-capable, and neither shipped provider is
either. `/status` reports `unavailable (mock is unverified)`.

No attachment byte has ever been fetched on this host, and none is sent
anywhere. See
[decisions/0015](../decisions/0015-provider-agnostic-conversation-attachments.md).

## Consequence for schedules

The deterministic extractor reads text and CSV only and reports
`supportsBinary: false`. Because no provider can read image or PDF bytes,
`/schedule` refuses those uploads **before downloading them** rather than
showing an invented preview — and no image or PDF decoder ships at all, which
keeps that entire parsing surface out of Phase 1.

Enabling binary extraction requires both a provider that reports
`supportsBinary: true` and `SCHEDULE_BINARY_EXTRACTION_ENABLED=true`.
