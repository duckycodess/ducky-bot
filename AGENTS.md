# Working in this repository

## Verified commands

```bash
pnpm install
pnpm typecheck        # tsc --build --force && tsc -p tsconfig.test.json
pnpm test             # vitest run
pnpm build            # tsc --build
pnpm migrate --dry    # list pending migrations
pnpm probe:herdr      # record live Herdr responses (creates and cleans up a temp repo)
```

Scripts load `.env` then `.env.<profile>` with Node's native
`--env-file-if-exists`; Node reads nothing implicitly. `pnpm dev:coordinator`
is the development profile, `pnpm dev:coordinator:prod` the production one.

## Authority order

1. Source, tests, migrations, configuration
2. `docs/CURRENT_STATE.md`
3. `docs/ARCHITECTURE.md` and the ADRs in `docs/decisions/`
4. `PROJECT_CONTEXT.md`

Report contradictions rather than picking whichever reads best.

## Constraints

- **Never widen the owner-only surface.** `OWNER_ONLY_SURFACE` in
  `@ducky/contracts` is the manifest; the router asserts against it at
  construction. Conversation is the only non-privileged route.
- **Authorization never reads the database.** Frozen env config is the sole
  authority; `authorized_user_audit` is an audit trail with no power.
- **No secret ever reaches SQLite or a log.** The database holds a bearer
  verifier and a key fingerprint; plaintext lives only in the runtime
  credential store and the executor's environment.
- **Subprocesses go through `runArgv` only** — `execFile`, argv array, no
  shell, mandatory timeout.
- **All Discord output goes through `sanitizeOutbound`**, called inside the
  transport so it cannot be bypassed by a new presenter.
- **`discord.js` is imported by exactly one module**, asserted by a test.
- **The executor never listens**, asserted by a test.
- **Profiles share no secret.** Token, application id, guild, component signing
  key and executor credential file are all per profile. Production reads none
  of the unscoped or development variables.
- Nothing in Phase 1 commits, pushes, deploys, or mutates a cloud resource.

## Validation expectations

Run the narrowest relevant tests first, then `pnpm typecheck` and the full
suite before reporting completion. Never claim a check passed without running
it. If an integration could not be verified on this host, say so explicitly
instead of implying coverage — see `docs/COMPLETION_REPORT_TEMPLATE.md`.
