# 0015. Provider-agnostic conversation attachments, refused before download

**Status:** Accepted

## Context

Milestone 2C adds the ability to send Ducky a file in conversation. The
pipeline had to be built now, but the provider that would actually read those
bytes does not exist on this host: OpenClaw is not installed, its API is
unverified, and `HttpOpenClawProvider` throws rather than guessing
([ADR 0005](0005-openclaw-adapter-with-mock.md)).

That is an uncomfortable position to build a byte pipeline in, and it is
exactly the position that makes the design decisions matter. Two questions the
roadmap marked as unresolved had to be answered first:

- **Where content is sent.** Passing a file to a provider sends the owner's
  personal data off the host. Which providers are acceptable, and does the
  owner confirm per upload, per provider, or once in configuration?
- **Transfer shape.** Inline base64 or a temp file path? DCStro used a path
  because its CLI read from disk. A provider-agnostic port must not assume
  either, and the answer shapes the port.

There is also a quieter question the milestone forced: an attachment is not the
same kind of thing as a sentence, so it should not necessarily inherit the same
authorization.

## Decision

### The port carries metadata plus a bounded read, and nothing else

`ConversationAttachment` is **not** a path and **not** a base64 string. Either
would bake one adapter's transport into the contract: a path assumes the
provider runs on this host and can read our temp directory; base64 assumes it
wants the payload inlined in a request body. Both are adapter decisions.

So the port offers `metadata` (filename, normalized content type, byte length)
and `read(maxBytes?)`. An adapter that needs a file writes one; an adapter that
needs base64 encodes one. Neither is owed anything by the coordinator.

### Lifetime is explicit, and belongs to the caller

`dispose` lives on `ManagedConversationAttachment`, which the router holds. The
provider is handed the narrower `ConversationAttachment`, so it is
*structurally* unable to extend, free or keep alive the resource. The router
disposes in a `finally` — success, provider error, or a throw from anywhere in
between — and dispose poisons the handle, so a provider that stashed a
reference and reads afterwards gets a thrown error rather than the owner's
bytes.

### Capability is declared, and checked before any byte is fetched

`ConversationProvider.capabilities.attachments` is a required field: a new
provider must state its position rather than default into one. Bytes are
fetched only when **all three** hold:

1. the operator has opted in (`CONVERSATION_ATTACHMENTS_ENABLED`, default off),
2. the provider reports itself `verified`, and
3. the provider declares attachment support.

`verified` is not negotiable and is what makes this honest today. Both shipped
providers advertise `NO_ATTACHMENT_CAPABILITY` and both throw if an attachment
somehow reaches them, so on this host the refusal happens on metadata alone and
**no attachment byte is ever downloaded**.

The effective limits are the *intersection*: the smaller of the two size caps
and the overlap of the two type lists. Neither side can talk the other past its
own limit.

### Attachments are owner-only; plain chat is not

Plain conversation keeps its Phase 1 authorization exactly — the chat whitelist
may talk. An attachment is owner-only, for two independent reasons:

- **It is personal data leaving the host.** A file is a much larger and much
  less deliberate disclosure than a sentence someone chose to type, and it goes
  to an external provider.
- **Fetching one is an action taken on someone else's say-so.** A whitelist
  user would otherwise make the coordinator issue an HTTPS request to a URL
  they chose, spend the owner's bandwidth, and consume the owner's provider
  budget.

Shared channels do not enter into it: conversation is not a
`SHARED_READABLE_ROUTES` entry, and a message event carries no channel context,
so there is no branch for a shared channel to take.

### One attachment, and a narrow type list

Several attachments in one message are refused concisely, before anything is
inspected further — never partly read, never with one silently picked.

Accepted types are `image/png`, `image/jpeg`, `image/webp` and a small set that
survives the same generic byte path: `text/plain`, `text/csv`, `text/markdown`,
`application/json`. **PDF is deliberately absent**: it is a different parsing
surface, the roadmap flags it as open, and accepting it would imply a document
capability nothing here has.

Accepting a type is not a claim that anything can *read* it. No vision or
extraction capability is claimed anywhere in this batch; the bytes are handed
to a provider that declared it accepts that exact type, and what it does with
them is its own contract to verify.

### The metadata policy is shared, not copied

`assertAttachmentMeta` in `@ducky/adapters` is the single implementation of
type / size / HTTPS / exact-host, used by both the schedule surface and the
conversation one. A second surface must not be able to ship a *weaker* set of
checks than the first. Only the allowlists, the ceiling and the rejection
wording differ.

## Alternatives considered

**A path on the port.** Rejected: it assumes co-location and hands the provider
a filesystem reference whose lifetime it does not own. It is also the shape
that makes "the provider kept the handle" a silent success rather than a loud
failure.

**Base64 on the port.** Rejected: it forces the whole payload into memory in
one encoding for every provider, including ones that would rather stream, and
it is a transport choice masquerading as a contract.

**Per-upload owner confirmation.** Rejected as the primary control. It trains
the owner to click through a prompt they see constantly, and it does not
constrain *which* provider receives the bytes. Configuration answers the "which
providers are acceptable" half properly, and the `verified` requirement is the
part that actually holds today.

**Letting the chat whitelist send attachments.** Rejected — see above. If a
genuine need appears, the safe shape is a separate, explicitly configured
allowance, not an inherited one.

**Deriving capability from a config flag alone.** Rejected. A flag the operator
sets says what they want; it does not say what the provider can do. Both are
required, and so is `verified`.

## Consequences

- On this host the feature is **unreachable**, and that is the correct state.
  `/status` and the startup diagnostics say why — "unavailable (mock is
  unverified)" — rather than presenting it as broken.
- No live attachment byte has been fetched on this host. The download path is
  covered against an injected `fetch` with a test-only provider that supplies
  the one thing the host lacks: a verified, capable endpoint.
- Enabling `CONVERSATION_ATTACHMENTS_ENABLED` alone changes nothing. It becomes
  meaningful only once 2D produces a verified provider that declares attachment
  support.
- Bytes live in exactly two places: a `0600` file inside a `0700` directory
  removed on every path, and whatever the provider does with what `read`
  returned. Nothing reaches SQLite, a log line, or Discord. The startup sweep
  covers the conversation prefix as well as the schedule one.
- The rate-limit charge lands before the metadata check, so a stream of
  rejected files still costs budget. Only the owner can reach that line, so it
  is accident containment rather than an authorization control.

## Follow-up

**Retention of derived text** stays open and moves to 2E with the rest of the
retention questions: nothing is derived yet, because nothing can read the
bytes. **PDF and other document types** stay open, and depend on a provider
that can honestly claim to parse them.
