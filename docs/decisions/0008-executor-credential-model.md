# 0008. Verifier in the database, key material in a runtime store

**Status:** Accepted

## Context

The executor authenticates with a bearer token and signs each request body with
an HMAC key. An earlier draft stored a *hash* of the HMAC key in SQLite, which
is structurally impossible: verifying an HMAC requires the key itself.

That draft also gave each executor a single row with one key id, which cannot
express two credentials being valid at once — so its claimed zero-downtime
rotation could not work either.

## Decision

Plaintext bearer and HMAC material live **only** in a runtime credential store
and in the executor's environment. The database holds, per key id:

- `bearer_verifier` — `sha256` of a ≥256-bit random token (a fast hash is
  correct here: the input is high-entropy, not a password)
- `hmac_key_fingerprint` — half a digest, for rotation audit only; it cannot
  verify a signature
- state and `last_used_at`

`executor_credentials` holds **one row per key id**, so two credentials can be
active simultaneously.

Verification requires **both** an active database row and a matching runtime
entry — two independent revocation surfaces — and consumes the single-use nonce
only *after* the signature verifies, so unauthenticated traffic cannot burn
nonces.

## Alternatives considered

- **Store the HMAC key in SQLite.** A database file backup would then contain
  live signing keys.
- **A shared secret for all executors.** Rotation becomes all-or-nothing.
- **Asymmetric signatures.** A reasonable future option; symmetric HMAC is
  simpler and the coordinator already needs a per-executor secret for the
  bearer.

## Consequences

Rotation is: issue a second key, restart the executor, confirm `last_used_at`
advancing, revoke the old one. No downtime and no migration. A leaked database
file yields no usable credential. A keyring or Key Vault can replace the file
store behind the existing port without touching a call site.
