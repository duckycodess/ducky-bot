# 0009. Environment config is the only authorization authority

**Status:** Accepted

## Context

An earlier design seeded owner and whitelist rows into the database at boot and
consulted them when authorizing. That leaves privilege in mutable storage: a
stale row, a bad migration or a hand edit could grant access, and removing
someone from configuration would not revoke them.

## Decision

`OWNER_DISCORD_USER_ID` and `CHAT_WHITELIST_USER_IDS` are read once at boot into
a frozen object. **Nothing on the authorization path reads the database.**

Startup fails closed if the owner is missing, malformed, contains a separator
(an accidental second owner), or appears in the whitelist — so exactly one owner
is structural rather than conventional.

`authorized_user_audit` still records who was configured and when, explicitly as
an **audit trail with no power**. A test inserts an `owner` row for a stranger
and asserts it grants nothing.

`requireOwner` is the first statement of every privileged service method, not
merely the router, and row-owning entities are re-checked against the actor.

## Alternatives considered

- **Roles in the database.** The problem above.
- **Router-only checks.** A routing bug becomes privilege escalation.
- **A permissions framework.** Vastly more surface than one owner needs.

## Consequences

Changing configuration revokes immediately, with no migration and no cleanup
task. The authorization path has no I/O and no failure mode. Multi-user support
would need a real design, which is deferred deliberately.
