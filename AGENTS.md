# Working in this repository

## Verified commands

```bash
pnpm install
pnpm typecheck        # tsc --build --force && tsc -p tsconfig.test.json
pnpm test             # vitest run
pnpm build            # tsc --build
pnpm migrate --dry    # list pending migrations
pnpm probe:herdr      # record live Herdr responses (creates and cleans up a temp repo)
pnpm probe:herdr --with-agent   # ALSO starts a real Pi agent; opt-in, costs model capacity
pnpm probe:live-job   # production-path live job against the allowlisted disposable repo
pnpm probe:openclaw   # records the OpenClaw surface; exit 0 only when the whole contract incl. a reply is recorded, 2 when any half is unrecorded or the binary is absent (it exited 0 on the original dev host; not run on the remote account, where openclaw is absent)
pnpm probe:gh         # records which --json fields this gh supports; local, repo-less, no network
pnpm probe:github-feed   # drives the GitHub feed against a real allowlisted repo, read-only, mock Discord, in-memory DB
pnpm backup           # consistent SQLite snapshot, no downtime; never includes the credential file
pnpm backup:verify --file <path>   # proves a backup is restorable, without restoring it
pnpm shared-admission init|inspect|release --path <ledger> ...   # the host-local shared admission ledger (ADR 0031); `init` creates a NEW ledger and refuses to overwrite one, `release` needs the exact holder and an attestation
pnpm register-commands --list      # the commands this build DEFINES; contacts nothing
pnpm phone:passcode                # prints a scrypt verifier for the phone page; reads stdin, contacts nothing
```

The two agent probes start a **real Pi agent**. `probe:live-job` refuses to run
unless the target repository carries a committed `.ducky-disposable` marker, is
clean with no `ducky/*` branches, and the database has no non-terminal job and no
held repository reservation — a reservation blocks every claim, so a run against
one measures nothing. It asserts its evidence and exits non-zero when any is
missing (4) or when teardown left something behind (5); `probe:herdr` exits 3 the
same way. `PROBE_TASK` cannot be overridden and `PROBE_TIMEOUT_MS` is clamped;
a non-numeric value is refused. **A probe that cannot fail is not a certifier**, so never soften those
exits to keep a run green.

Scripts load `.env` then `.env.<profile>` with Node's native
`--env-file-if-exists`; Node reads nothing implicitly. `pnpm dev:coordinator`
is the development profile, `pnpm dev:coordinator:prod` the production one.

## Authority order

1. Source, tests, migrations, configuration
2. `docs/CURRENT_STATE.md`
3. `docs/ARCHITECTURE.md` and the ADRs in `docs/decisions/`
4. `PROJECT_CONTEXT.md` and `docs/ROADMAP.md`

Report contradictions rather than picking whichever reads best.

## Constraints

- **Never widen the owner-only surface.** `OWNER_ONLY_COMMANDS` in
  `@ducky/contracts` is the manifest; the router asserts against it at
  construction. Non-owner routes are conversation, participant-scoped
  Branch/Compact controls in `CONVERSATIONAL_INTERACTION_KINDS`, and the
  two shared-channel reads in `SHARED_READABLE_ROUTES`. Conversational and
  owner-only control manifests remain disjoint; shared reads stay narrowed
  views of commands already on the owner manifest.
- **Model access for anyone but the owner is off by default.**
  `DUCKY_ADDITIONAL_USER_AI_ENABLED` is frozen into the `Authorizer`, and
  `Authorizer.mayConverse` is the one question every model-reaching path asks,
  including Branch and Compact. The whitelist names who may be offered chat; it
  never authorizes it.
- **The engineering slot is local to one coordinator database; the shared
  ledger is the cross-program fence above it, and it is source, not installed
  proof.** The slot still covers one database. The host-local shared admission
  ledger (ADR 0031) is what makes Ducky's two profiles and the Agent Flow
  dispatcher exclude each other, and only once its companion is installed in the
  live dispatcher, a ledger exists and a controlled second admission was
  refused -- none of which has happened. Never describe the slot alone as
  cross-program safety, and never describe the ledger as live. Engineering is off
  unless `DUCKY_ENGINEERING_ENABLED` AND the separate, default-off
  `DUCKY_SHARED_ADMISSION_ELIGIBLE` say otherwise; a ledger file, a participant
  row or a candidate patch is not eligibility. A confirmed shared hold never
  expires by time, PID or an absent local record, a release needs the exact
  ledger, fence and holder after a local commit, and a slot with an unconfirmed
  stop is released only by quiescence or an owner's `/job cleanup`.
- **Shared visibility is never authorization.** A configured shared channel
  says where information may be shown, never who may act. Non-owner output
  goes through `SharedJobsService` and `shared-presenters.ts`, which accept
  only `SharedJobProjection`; never reuse the owner-facing `jobs.list` /
  `jobs.detail` or a redaction pass over `JobRow`. Every ambiguous case (no
  context, a DM, an unconfigured channel, an unwired router) fails closed to
  private.
- **The `github` channel role is delivery only.** Other people may read it, so
  an owner reply there is always ephemeral, nothing typed there is read, and
  only a public repository on the feed's selected list is ever posted to it:
  private, unselected or unverifiable visibility goes to the owner's DM, and
  visibility is read fresh at send time, never stored. Selection is not the
  repository allowlist and widens no job or write path. `gh api` and
  `gh search prs` are each allowed in ONE exact argv shape only.
- **Authorization never reads the database.** Frozen env config is the sole
  authority; `authorized_user_audit` is an audit trail with no power.
- **No secret ever reaches SQLite or a log.** The database holds a bearer
  verifier and a key fingerprint; plaintext lives only in the runtime
  credential store and the executor's environment.
- **Subprocesses go through `runArgv` only** — `execFile`, argv array, no
  shell, mandatory timeout.
- **All Discord output goes through `sanitizeOutbound`**, called inside the
  transport so it cannot be bypassed by a new presenter.
- **The phone capture page is tailnet-only and off by default.** It refuses to
  start without a profile-scoped human credential or on a bind address that is
  not loopback, RFC1918, `100.64.0.0/10` or `fd7a:115c:a1e0::/48`; with the
  flag unset its routes are never registered. It is a transport in front of the
  same owner-only service Discord uses -- never a second write path -- and the
  owner's passcode is never the executor's machine credential. Nothing here
  enables Tailscale Funnel.
- **`discord.js` is imported by exactly one module**, asserted by a test.
- **The executor never listens**, asserted by a test.
- **Profiles share no secret.** Token, application id, guild, component signing
  key and executor credential file are all per profile. Production reads none
  of the unscoped or development variables.
- Nothing in Phase 1 commits, pushes, deploys, or mutates a cloud resource.
- **No wipe-all deletion path, at any layer.** `FORGET_TARGETS` cannot express
  one and `RETENTION_FORBIDDEN_TABLES` names what retention may never touch;
  both are asserted by tests that scan the source. Retention only ever removes
  records that are already finished, and a job that is still live in any sense
  is skipped whole and counted.
- **Deletion is audited by count, never by content.** A record of a deletion
  that quoted what it deleted would defeat the deletion.

## Validation expectations

Run the narrowest relevant tests first, then `pnpm typecheck` and the full
suite before reporting completion. Never claim a check passed without running
it. If an integration could not be verified on this host, say so explicitly
instead of implying coverage — see `docs/COMPLETION_REPORT_TEMPLATE.md`.
