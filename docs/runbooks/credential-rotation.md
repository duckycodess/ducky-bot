# Runbook: rotate executor credentials

Rotation needs **no downtime** because `executor_credentials` holds one row per
key id and two rows can be active at once.

## Rotate

```bash
# 1. Issue a second credential. The secrets print ONCE and are not recoverable.
pnpm executor:issue-credential --executor wsl-laptop

# 2. Point the executor at the new key id and restart it.
#    DUCKY_EXECUTOR_KEY_ID / DUCKY_EXECUTOR_TOKEN / DUCKY_EXECUTOR_HMAC_SECRET
systemctl --user restart ducky-executor

# 3. Confirm the new key is actually being used.
pnpm executor:list-credentials --executor wsl-laptop
#    -> the new key id's last_used should be advancing; the old one's frozen.

# 4. Only then revoke the old key.
pnpm executor:revoke-credential --key-id k1

# 5. Remove the old entry from the credential file.
#    Effective at the next reload (60 s, or SIGHUP).
```

`list-credentials` prints key ids, fingerprints, state and timestamps — and no
secret material.

## Revoke everything for an executor

```bash
pnpm executor:revoke-executor --executor wsl-laptop
```

Immediate: every key belonging to that executor is refused on the next request.

## Emergency

Two independent switches, either sufficient:

1. Mark the row revoked in the database — immediate, checked per request.
2. Remove the entry from the credential file — effective at the next reload.

Use both if a secret is believed to have leaked, then issue a fresh credential.

## Rules

- Never copy a secret into a ticket, a commit, a log or a chat message.
- The credential file must stay `chmod 600` and owned by the coordinator's user;
  it is refused otherwise, which is a feature.
- Losing the printed secrets is not a problem — issue a new credential and
  revoke the old one. They are deliberately unrecoverable.
