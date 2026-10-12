# ADR 0025 — An owner-authenticated capture page, on the tailnet only

**Status:** accepted
**Extends** [ADR 0008](0008-executor-credential-model.md) (the executor's
credential model) by adding a SECOND, different credential beside it, and
[ADR 0009](0009-env-config-sole-authorization-authority.md), which still
decides who the owner is.

## The problem

Deadlines arrive on a phone. They arrive as a pasted block from a group chat,
in a lift, with one hand — and the only ways into Ducky were a Discord slash
command (twelve taps and a keyboard that fights multi-line text) or a message
typed into a channel. The owner asked for a home-screen shortcut that opens a
box they can paste into.

Three things that look like answers and are not:

- **A native app.** A second build, a second release path, a store account, and
  nothing in it that a web page cannot do.
- **A public endpoint.** The coordinator's HTTP surface is the executor's only
  inbound door and it has never been on the internet. `tailscale funnel` would
  put it there through a different hole, and the private-URL guard would not
  see it happen.
- **Reusing the executor credential.** It is an HMAC key in a file on a host
  the owner controls, issued and revoked by a CLI, and signed per request. A
  phone is a person typing something they can remember. Sharing one credential
  means either a passcode strong enough to be an HMAC key (nobody types that)
  or a machine credential weak enough to memorise (nobody should have that).

## The decision

A small page at `/app`, on the **existing** Fastify listener, reachable only
over the tailnet, behind the owner's own **human** credential. Off by default.

### One listener, two credentials, no overlap

| | Executor | Phone |
|---|---|---|
| Who it authenticates | a machine | a person |
| Material | bearer token + HMAC key in a file | a passcode the owner remembers |
| Stored as | verifier + key fingerprint in SQLite | scrypt verifier in env config |
| Presented as | signature over the raw body, per request | signed session cookie + CSRF token |
| Issued by | `pnpm executor:issue-credential` | `pnpm phone:passcode` |
| Routes | `/api/v1/executor/*` | `/app*` |

Neither opens the other's door, and a test asserts both directions.

### It refuses to start rather than serve unsafely

Three conditions, all checked at boot with the other pure configuration checks
— the cheapest place to fail, and long before a phone first taps the shortcut:

1. `DUCKY_PHONE_CAPTURE_ENABLED` must be set. Default off: an instance that
   never asked for a web surface never grows one.
2. A profile-scoped verifier must exist. Production never inherits the
   development one, exactly like every other secret.
3. `DUCKY_HTTP_HOST` must be loopback, RFC1918, `100.64.0.0/10` or
   `fd7a:115c:a1e0::/48` — the ranges `isPrivateBindHost` accepts, which is a
   closed list with no entry for a public address and no way to add one through
   configuration. `0.0.0.0` is refused explicitly: it is not an address, it is
   "every interface", which is precisely the accident this prevents.

When it is off, the routes are **not registered at all** — not registered and
answering 404 from a handler, but absent.

### What the session actually is

A stateless signed token: version, expiry, nonce, HMAC. No session table to
grow, leak or clean up. The signing key is derived from the stored verifier, so
there is one secret to deploy rather than two and changing the passcode
invalidates every live session by construction.

The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/app`, with a bounded
`Max-Age`. `Secure` is set **only when the request actually arrived over TLS**:
a tailnet address is reached over plain HTTP inside an encrypted overlay, and a
cookie marked `Secure` there is silently never stored — the page would ask for
the passcode on every tap and the owner would conclude it is broken. The CSRF
token covers what `SameSite` cannot: the browser sends a cookie automatically,
but a cross-site page cannot read the page that holds the token and so cannot
set the header.

### The same three choices as Discord, and one draft

Save, Edit and Discard. Edit is not a client-side convenience: it sends the
corrected text back with the preview id, so the correction is **re-parsed into
the same preview row** exactly as the Discord modal does. Two consequences,
both deliberate:

- a few rounds of correction leave ONE draft holding the owner's text, not a
  trail of abandoned ones waiting out their TTL;
- an edit cannot introduce a deadline the parser would never have produced,
  because it goes through the identical parse.

A preview that expired while the owner was editing falls back to a fresh one
rather than refusing: nothing was saved either way, the text in the box is what
they just typed, and "your draft expired" is a dead end on a phone.

Every rendered preview's buttons close over the id they were built with, and a
late reply from a superseded read is dropped — a phone is a device people
double-tap on a bad connection, and a shared mutable id read at click time is
how Save ends up acting on a different list from the one on screen.

### It is a transport, not a second assistant

Every route calls the same `TaskCaptureService` the Discord path calls. There
is no second parser, no second validation, no second set of bounds, and no
second place a task can be written from. That is the whole reason a web surface
is a small change here rather than a parallel implementation of the assistant.

## Alternatives considered

- **A Discord slash command with a long text option.** Rejected: multi-line
  paste into a slash option on a phone is the thing the owner was escaping.
- **Session rows in SQLite.** Rejected: a table of live credentials to protect,
  for a feature whose whole session state is "this person typed the passcode at
  time T".
- **Basic auth.** Rejected: the browser re-sends the credential on every
  request and there is no sign-out worth the name.
- **A second port.** Rejected: one process, one port, one thing to put on the
  tailnet.

## Consequences

- Binding the listener to a tailnet address exposes the **executor** routes to
  that tailnet as well. They keep their own authentication, unchanged; nothing
  about this surface relaxes them.
- The passcode is a human secret and is therefore the weakest credential in the
  system. It is scrypt-hashed with expensive parameters, compared in constant
  time, rate limited at ten attempts per five minutes, and it reaches a
  tailnet-only listener in the first place.
- The page is served inline with no third-party request: no CDN, no font, no
  analytics, and nothing fetched from anywhere the page could be changed from.
- If the owner ever wants this from outside the tailnet, that is a new decision
  and a new ADR. It is not a configuration value.

## Follow-up

The manual flow — connect Tailscale, open the saved shortcut, paste, edit,
save once — needs a real phone and a real tailnet. Neither exists on this host,
so it is recorded as unverified rather than claimed; see `docs/CURRENT_STATE.md`.
