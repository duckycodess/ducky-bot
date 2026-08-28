# 0019. The conversational backend is chosen explicitly, and production fails closed

**Status:** Accepted

## Context

Provider selection was:

```ts
if (!env.OPENCLAW_BASE_URL) return new MockConversationProvider();
```

No profile check. `OPENCLAW_BASE_URL` was not in `.env.example`, so unset was
the default — which means a **production** instance booted on the `[mock]`
provider and answered the owner with canned prose. `/status` reported it as a
warning; nothing refused to start.

That contradicts two rules the project already holds: `PROJECT_CONTEXT.md` rules
out plausible-looking fakes, and profile isolation says production fails closed
rather than borrowing a development stand-in.

## Decision

`DUCKY_CONVERSATION_PROVIDER` names the backend, and the rules depend on the
profile:

| Mode | development | production |
|---|---|---|
| unset | `mock` | **refused at startup** |
| `mock` | allowed, replies prefixed `[mock]` | **refused at startup** |
| `disabled` | allowed | allowed |
| `openclaw` | allowed; needs a private URL | allowed; must initialise |

Resolved **before any filesystem or database work**, because it is a pure
configuration decision and a misconfigured instance should fail on the cheapest
check rather than after a confusing unrelated error.

`DisabledConversationProvider` throws `integration_not_verified` rather than
returning text. It is deliberately not the mock: a mock invents a sentence, and
an owner who asks a question and gets prose back on a production instance has
been misled, not degraded.

## Alternatives considered

- **Keep inferring from the URL.** One less variable, and it is exactly how a
  production instance ended up on a mock.
- **Let production use the mock with a louder warning.** A warning in boot
  output is not read by the person reading the reply.
- **Make `disabled` return a polite sentence.** Then it renders like an answer.
  Throwing keeps it on the same path as every other unavailable integration.

## Consequences

`disabled` is the correct production mode until 2D lands, so production can
still boot. Introducing a required production variable is a breaking
configuration change — and there is no production instance today, so the cost is
zero now and would only grow.

`pnpm probe:openclaw` is committed, refuses to guess a route or an auth model,
and exits 2 with the blocker while OpenClaw is absent. Flipping a provider to
`verified` also opens the 2C attachment gate, so verification must cover the
attachment contract, not only the text one.
