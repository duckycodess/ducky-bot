# 0005. OpenClaw behind a port with a marked mock and a throwing HTTP guard

**Status:** Accepted

## Context

The conversational layer is meant to be OpenClaw. It is not installed on this
host, and installing it was outside this run's scope, so its routes, auth model
and response shape are unknown.

## Decision

Define a `ConversationProvider` port. Ship two implementations:

- `MockConversationProvider` — the default, whose every reply is prefixed
  `[mock]`.
- `HttpOpenClawProvider` — validates that the gateway URL is loopback or tailnet
  at construction, then **throws** from `reply()` with a pointer to the
  integration note.

No route, header or response shape is invented.

## Alternatives considered

- **Guess the API.** Code that looks finished and fails in production, with a
  test suite that passes against the guess. Worse than an obvious gap.
- **Install OpenClaw anyway.** An environment mutation that was not authorized.
- **Silently degrade to the mock.** The owner could not tell whether a reply came
  from a real assistant. The `[mock]` prefix exists precisely to make that
  visible.

## Consequences

Conversation works locally and is never mistaken for the real thing. The gateway
can never be pointed at a public address. Finishing the integration is a
contained change behind the port — see `docs/integrations/openclaw.md`.

The knock-on effect is on schedules: no provider can read image or PDF bytes, so
those uploads are refused before download rather than previewed from nothing.
