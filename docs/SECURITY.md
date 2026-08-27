# Security model

## Authorization

**Environment configuration is the sole authority.** `OWNER_DISCORD_USER_ID`
and `CHAT_WHITELIST_USER_IDS` are read once at boot into a frozen object.
Nothing on the authorization path reads the database, so a stale or
hand-edited row cannot grant privilege, and removing an id from configuration
revokes it immediately with no migration.

`authorized_user_audit` records who was configured and when. It is an **audit
trail with no power** — a row there granting `owner` to an arbitrary id confers
nothing, and a test proves it.

Startup fails closed if the owner id is missing, malformed, contains a
separator (guarding against an accidental second owner), or appears in the chat
whitelist. **Exactly one owner is structural.**

### The owner-only surface

Captures, inbox, schedules, jobs, approvals, repository status and
configuration are **private personal data**. Every one is owner-only.

`OWNER_ONLY_SURFACE` is a single exported manifest. The router asserts at
construction that its registered commands and interaction kinds equal that
manifest exactly, plus one conversational route — so a new handler cannot
quietly become reachable by a non-owner.

`requireOwner` is the first statement of every privileged service method, not
just the router, and row-owning entities are re-checked against the actor as
well. Command routing is not part of the security argument.

The chat whitelist reaches **conversation only**. The conversational service is
constructed with no reference to any privileged service.

## Executor credentials

The plaintext bearer token and HMAC key **never enter SQLite**.

| Material | Where | Form |
|---|---|---|
| Bearer token | runtime credential store; executor env | plaintext in memory |
| Bearer verifier | `executor_credentials.bearer_verifier` | `sha256` of a ≥256-bit random token |
| HMAC key | runtime credential store; executor env | plaintext in memory |
| Key fingerprint | `executor_credentials.hmac_key_fingerprint` | half a digest; audit only, cannot verify a signature |

A fast hash is correct for the verifier because the input is high-entropy
random material, not a password.

`FileCredentialStore` refuses to load a file that is a symlink, is owned by
another uid, or is readable by group or others. `MemoryCredentialStore` refuses
to construct when `NODE_ENV=production`. Credential objects render as
`[REDACTED]` through `toJSON`, `toString` and `util.inspect`, so a stray log
line or error serialization cannot leak them.

### Verification order

Identity and signature are checked **before** the nonce is consumed, so
unauthenticated traffic cannot burn nonces:

1. Validate the executor and key ids against a strict pattern (both are
   attacker-controlled) before any query.
2. Look up an *active* credential for that `(executor, key)`; the parent
   executor must also be active.
3. Confirm the runtime store holds the same pair — **both** the database row
   and the store must agree, giving two independent revocation surfaces.
4. Constant-time compare the bearer verifier.
5. Enforce a ±120 s timestamp window.
6. Recompute `HMAC-SHA256` over
   `v1\nMETHOD\npath\ntimestamp\nnonce\nsha256(rawBody)` and compare in
   constant time.
7. Only now consume the single-use nonce.

Every identity failure returns a bare `401 {"error":"unauthorized"}` with no
`WWW-Authenticate` hint and nothing that distinguishes an unknown executor from
a bad signature.

### Rotation and revocation

`executor_credentials` holds **one row per key id**, so two credentials can be
active simultaneously and rotation needs no downtime. See
[runbooks/credential-rotation.md](runbooks/credential-rotation.md).

Revocation has two independent switches: mark the row revoked (immediate, per
request) and remove the file entry (effective at the next reload).

### Component signing

`DUCKY_COMPONENT_SIGNING_KEY` is env-only, never stored, and startup fails
closed if it is missing or short — there is no unsigned fallback. It is
**defence in depth**: the primary control for interactions is server-side owner
and row-ownership re-authorization, so compromising this key alone grants
nothing. Binding the actor id into the signature makes a copied component id
useless to anyone else.

## Egress and redaction

`sanitizeOutbound` is the single choke point and is called as the **first
statement of every send method on every transport**, so the guarantee does not
depend on a presenter remembering. It strips ANSI and control characters,
redacts secrets, and enforces Discord's limits locally so an over-long message
is truncated with a visible marker instead of being rejected at delivery.

Never sent to Discord or a log: tokens, authorization headers, Azure
identifiers, raw environment, SSH keys, raw terminal transcripts, local
usernames (`/home/<user>` folds to `~`, the account name to `Tj`), or
unnecessary absolute paths.

Component ids are the one outbound field that **cannot** be redacted — doing so
would corrupt the signature and break every control. They are validated
structurally instead: only the exact signed shape this codebase emits passes,
over a character set that cannot express a secret. Anything else is dropped
rather than sent, so an id cannot become a channel for text that skipped the
redactor.

The orchestration prompt is redacted and control-stripped before it becomes an
argv element, and the executor logs it only as `<prompt:sha256:…>`. The HTTP
server runs with request logging disabled and never logs a raw URL, query
string, header set or body.

## Untrusted input

- **Attachments.** Only `/schedule`, owner only, one file. The metadata check
  runs *before any network request*: https only, an exact CDN host match (never
  a suffix match), a size cap, and a content-type allowlist. Redirects are
  refused outright, nothing is ever decompressed, and a counting stream aborts
  mid-download if the reported size was a lie. A NUL byte in the head rejects
  anything that claimed to be text. Bytes are written to a 0600 file in a 0700
  directory that is removed on success and on failure alike, and a startup
  sweeper clears anything a crash left behind. Raw bytes never reach the
  database, Discord, or a log.
- **Image and PDF uploads are refused** while no verified provider can read
  them, rather than producing an invented preview.
- **Subprocesses.** `runArgv` uses `execFile` with an argv array, a mandatory
  timeout and a capped buffer. There is no shell mode; a shell string or a
  non-array throws. A global concurrency pool bounds host load.
- **Result payloads.** Size-capped, strictly parsed, path-checked and
  deep-sanitized *before* anything is persisted. A result claiming
  `implemented` without an independent passing review and passing verification
  is downgraded — the executor cannot mark its own homework.

## The approval gate

Every consequential action becomes one approval row, decided individually and
exactly once. **There is no bulk-approve control anywhere.** In Phase 1 an
approved action is recorded and deliberately not performed: the performer
throws, and no GitHub writer exists. The read-only `gh` adapter uses a frozen
argv table containing no write verb, asserted by a test.

Read-only inspection needs no approval.

## Rate limiting

Per-executor budgets on every API route, one in-flight long poll per executor,
a server-side wait cap, per-user Discord command buckets, an hourly attachment
budget, a subprocess concurrency cap and a job wall-clock bound.

Because the Discord surfaces are already owner-only, these are **accident
containment and self-protection, not an authorization control**. They are
in-process, so they are exact for the single-coordinator design and would need
shared state if it were ever scaled out.

## Known residual risk

- The credential file is the trust root on the coordinator host. Mitigated by
  permission checks, per-executor keys, rotation and immediate revocation; a
  keyring or Key Vault can be swapped in behind the existing port.
- Pi has no sandbox. The executor is a trusted host by design.
- Prompt injection from repository content cannot be prevented at this layer.
