# Testing

`pnpm test` runs everything with Vitest. No test touches the network, a real
Discord gateway, a cloud API, or performs a git write.

## What each suite guarantees

**contracts** — the state machine accepts exactly the intended edges; result
payloads are strictly typed, so `question` is required only for
`needs_owner_input` and actions only accompany `implemented`; repository-relative
paths reject absolute, traversal, UNC, drive, home and NUL forms.

**persistence** — migrations are forward-only and idempotent; foreign keys hold;
only one job per repository can be `running`; only one reservation can exist per
repository, and the guarded upsert refuses to move it to another job; a recorded
result snapshot cannot be mutated; a duplicate nonce is a replay; no column can
hold a plaintext secret; there is no table that could store a schedule before
confirmation.

**adapters** — redaction vectors for every token shape, plus path folding and
idempotence; `runArgv` refuses shell strings, non-array argv and metacharacter
commands, and does not interpret metacharacters inside arguments; the OpenClaw
gateway guard accepts loopback and tailnet and rejects everything else; the
`gh` table is frozen and contains no write verb; the schedule extractor never
guesses; attachment policy rejects binaries, bad hosts and oversize files.

**adapters / herdr contract** — the production schemas parse **recorded live
responses** from `pnpm probe:herdr`. Until fixtures exist the cases skip and the
orchestrator stays experimental: passing mocks is not evidence.

**adapters / pi-herdr** — recovery behaviour: a working agent is reattached, not
restarted; a blocked agent is never answered automatically; an unprovable agent
is not touched at all; a finished turn's result is submitted rather than re-run;
a worktree job reads its result from the checkout path Herdr reported.

**coordinator** — the owner-only matrix at the service layer with the router
bypassed; the registered surface equals the manifest; a forged audit row grants
nothing; claim atomicity and idempotency; reservations spanning every
nonterminal state; cancellation from each state, including `cancel-ack
{terminated:false}` leaving the job running; result idempotency by payload hash
with a conflicting payload rejected; approvals decided individually and never
executed; schedule previews leaving **every** table untouched until confirmation;
transport sanitization with a fake client that never sees a raw secret;
`discord.js` imported by exactly one module; executor auth including rotation
and the nonce-not-burned-on-failure property; rate limits.

**executor** — fail-closed workspace resolution: bootstrap refuses any directory
holding something unexpected, with commits, dirty, stashed or mid-operation;
worktree mode verifies the base ref before Herdr is called; a dirty main working
tree is left untouched; the writer lock admits one holder and reclaims a stale
one; the package has no server dependency and creates no listener.

**end to end** — a real HTTP server and the real signing client, with only the
orchestrator mocked: submission → claim → result → completion; a proposed action
routed to an approval that is recorded and not executed; a pause for an owner
answer and continuation under the same reservation; a rejected workspace that
never reaches the orchestrator; a revoked credential and a wrong signing secret
both refused.

## Adding tests

Assert the guarantee, not the implementation. Prefer driving a service directly
over going through the router when the point is authorization. When something
cannot be verified on this host, make the test say so rather than mocking it
into looking verified.
