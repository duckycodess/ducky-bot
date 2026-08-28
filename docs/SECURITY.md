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

## Shared visibility is not authorization

`DUCKY_SHARED_CHANNEL_IDS` (profile-scoped, default empty) lists channels in
which job *status* may be shown to people other than the owner. It answers
"may this be seen here?" and never "may this person do this?".

Nothing about it widens what anyone can do:

- Every write stays owner-only, re-checked in the router and again in every
  service method.
- Every owner-only reply stays ephemeral.
- No signed control is ever emitted into a shared channel, and the router
  asserts at construction that no interaction kind is shared-readable.

So a mis-listed channel widens what is **visible** and can never widen what is
**possible**.

What a shared reader may see is a fixed `SharedJobProjection`: public job id,
allowlisted repository slug, coarse state, safe timestamps, sanitized result
summary and verdict, and next-step copy. Task text, context, the owner's
Discord id, questions, answers, job events, transitions, raw executor output,
workspace ids and paths, executor and lease ids, and approval action details
are never present.

That is enforced structurally rather than by a redaction pass:
`SharedJobsService` builds the projection field by field from named sources
and never calls the owner-facing `list`/`detail`; it takes no `ActorContext`,
so there is no identity to escalate; and `shared-presenters.ts` accepts
`SharedJobProjection` and nothing else, making a richer object a type error.
A field added to `JobRow` is invisible on the shared surface until somebody
deliberately shares it.

Every ambiguous case fails closed to private: no channel context, a DM
(identified by the absence of a guild id, so a configured id can never match a
private conversation), an unconfigured channel, or an incompletely wired
router.

A job records the channel it was submitted from, but that stored id confers
nothing on its own — it is re-checked against live configuration before every
send, so unlisting a channel silences it immediately, including for jobs
already running in it. Configuration is the sole authority here exactly as it
is for authorization.

**Residual risk.** Channel membership is enforced by Discord's own channel
permissions, not by Ducky. An operator who lists a public channel exposes the
projection to everyone in it. Shared messages also persist in Discord's
history, unlike an ephemeral reply; retention for that history is an open
decision recorded in [ROADMAP.md](ROADMAP.md).

## Profile isolation

The development and production bots are separate identities, not a flag on one
identity. Each profile reads only its own `DISCORD_<PROFILE>_*` variables, and
`resolveDiscordProfile` never consults the other set — so a production instance
cannot be started with the development token even if both are present in the
environment.

Every secret is profile-scoped and resolved for the selected profile only:
the Discord token and application id, the **component signing key**, and the
**executor credential file**. Production reads none of the unscoped or
development variables and fails closed without its own.

That matters in both directions. A shared executor credential file would let a
development executor claim production jobs; a shared component signing key
would make a signed control minted by one bot verify on the other. A
single-profile development box may still use the unscoped names.

`register-commands --apply` requires an explicit `--profile`: which bot to
write to is not something to infer from an ambient default.

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

- **Attachments.** Two surfaces, `/schedule` and conversation, both **owner
  only** and both **one file at a time**. They share one metadata policy
  (`assertAttachmentMeta`) rather than each carrying a copy, so a surface
  cannot ship weaker checks than the other. The check runs *before any network
  request*: https only, an exact CDN host match (never a suffix match), a size
  cap, and a content-type allowlist. Redirects are refused outright, nothing is
  ever decompressed, and a counting stream aborts mid-download if the reported
  size was a lie. On the schedule surface a NUL byte in the head rejects
  anything that claimed to be text. Bytes are written to a 0600 file in a 0700
  directory that is removed on success and on failure alike, and a startup
  sweeper clears anything a crash left behind, for every surface's prefix. Raw
  bytes never reach the database, Discord, or a log.
- **Conversation attachments are owner-only even though plain chat is not.**
  The chat whitelist may talk; it may not send files. A file is personal data
  leaving the host to an external provider, and fetching one is an action taken
  on somebody else's say-so — it makes the coordinator issue an HTTPS request
  to a URL they chose and spends the owner's bandwidth and provider budget. The
  whitelist gets the same refusal it gets on every other privileged surface.
  See [decisions/0015](decisions/0015-provider-agnostic-conversation-attachments.md).
- **A capability refusal happens before any download.** Conversation bytes are
  fetched only when the operator has opted in, the provider reports itself
  `verified`, and it declares attachment support. `verified` is not negotiable:
  an unexercised API is not sent the owner's personal files on the strength of
  a flag it wrote itself. No provider on this host qualifies, so the path is
  closed and nothing is fetched.
- **The attachment handle has an explicit lifetime the coordinator owns.** The
  provider is handed a type with no `dispose`, so it cannot keep the bytes
  alive; the router disposes in a `finally` and the handle is poisoned, so a
  retained reference reads an error rather than the file.
- **Image and PDF uploads are refused for schedule extraction** while no
  verified provider can read them, rather than producing an invented preview.
  Conversation accepting an image type is *not* a claim that anything can read
  it: the bytes are forwarded to a provider that declared it accepts that type,
  and no vision or extraction capability is claimed anywhere.
- **Subprocesses.** `runArgv` uses `execFile` with an argv array, a mandatory
  timeout and a capped buffer. There is no shell mode; a shell string or a
  non-array throws. A global concurrency pool bounds host load.
- **Command policy.** Every `gh`, `git` and `herdr` operation is classified
  `read_only` / `local_mutation` / `external_mutation` / `high_risk` in one
  central table, with the ceiling at `local_mutation` in this phase. Two
  independent gates: the frozen argv table decides what can be *constructed*,
  `checkCommandAllowed` decides whether what was constructed may *run*. An
  unclassified command is refused rather than allowed by default, and
  `FORBIDDEN_COMMAND_VERBS` (`push`, `reset`, `clean`, `rm`, `exec`, `auth`, …)
  is checked first and independently of the table. There is no arbitrary shell
  and no high-risk verb reachable from anywhere.
- **Dependency checks.** A checker is told the dependency record and nothing
  else -- no repository path, no task text, no credentials. It cannot extend
  its own budget or reschedule itself; the resolver bounds every pass, every
  check count and every deadline. The shipped checker only ever answers
  `pending`, and a `ready` from an unverified checker is downgraded rather than
  believed, so no job resumes on a check that did not happen.
- **Workspace registrations.** The executor is authenticated, but its
  *content* is still validated: the agent name and label must match the Ducky
  prefixes for the claimed repository, and the path must be absolute,
  normalized and inside the repository — or, for a worktree, under a
  Herdr-managed worktrees directory. The record is what a later cleanup acts
  on, so a malformed one is refused before it is persisted.
- **Result payloads.** Size-capped, strictly parsed, path-checked and
  deep-sanitized *before* anything is persisted. A result claiming
  `implemented` without an independent passing review and passing verification
  is downgraded — the executor cannot mark its own homework.

## The audit log

`audit_log` is a structured RECORD and **never an authority**. Nothing reads it
to decide anything -- authorization is frozen environment configuration and the
lifecycle is the `jobs` table -- and a test asserts that no repository which
decides anything selects from it. A forged row confers nothing, exactly as
`authorized_user_audit` does not.

It holds no secret, no raw authentication material, no terminal output and no
environment. Every free-text detail is constructed from fixed strings and
already-redacted values, then clamped. The owner is recorded as the role
`owner` rather than a Discord user id: there is exactly one owner, so the id
adds nothing an auditor could use and would be unnecessary personal data in a
long-lived table. Executor ids are kept -- not secret, genuinely identifying.
Lease ids, which are capabilities rather than identifiers, are never recorded.

Writing an audit row never throws: a job rolled back because bookkeeping failed
would be worse than one that ran correctly and was not written down. Retention
is bounded and the reconciler prunes past the window.

## The approval gate

Every consequential action becomes one approval row, decided individually and
exactly once. **There is no bulk-approve control anywhere.** Approval and
execution are separate: an owner must explicitly invoke `/job execute` after
approving one action. The execution ledger claims that approval once and does
not automatically retry an interrupted external command. A disabled-by-default
local performer supports commit, push and PR in a same-filesystem development
topology; issues, deployments, Azure mutations and high-risk commands remain
recorded-only. The command policy classifies every argv and rejects force or
hook-bypass flags.

Read-only inspection needs no approval.

## Rate limiting

Per-executor budgets on every API route, one in-flight long poll per executor,
a server-side wait cap, per-user Discord command buckets, a separate hourly
attachment budget per surface (schedule and conversation), a subprocess
concurrency cap and a job wall-clock bound.

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
