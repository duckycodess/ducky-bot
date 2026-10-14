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
pnpm probe:openclaw   # records the real OpenClaw surface; exits 2 while the reply half is unrecorded
pnpm probe:watch-reader   # read-only, approved PUBLIC repo only, counts never values; exits 4 on a missing surface or an empty answer (--allow-empty accepts shape-only), 3 on an unapproved target
pnpm probe:gh         # records which --json fields this gh supports; local, repo-less, no network
pnpm probe:github-feed   # drives the GitHub feed against a real allowlisted repo, read-only, mock Discord, in-memory DB
pnpm backup           # consistent SQLite snapshot, no downtime; never includes the credential file
pnpm backup:verify --file <path>   # proves a backup is restorable, without restoring it
pnpm import:assistant --db <db> --file <doc.json>   # validate a migration document (a dry run); --verify compares, --backup <db> --apply writes
pnpm export:rollback-delta --db <db> --out <file>   # private, read-only delta since an import (ADR 0033); counts only on the terminal; exit 5 when incomplete
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
  repository allowlist and widens no job or write path. `gh search prs` is
  allowed in ONE exact argv shape. `gh api` is allowed only as
  `api --method GET <canonical-endpoint>` in the branch-commits shape and the
  seven typed notification-watch shapes in `@ducky/contracts` `github-watch.ts`
  (ADR 0031, owner-approved 2026-10-14); only `watch-reader.ts` builds those.
  There is no `/notifications` endpoint and no other `gh api` form.
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
- **The private-assistant import is offline and mechanical.** It is a CLI, never
  a Discord or phone route, and it applies only against an explicit database,
  document and backup outside the repository, a backup that matches the live
  database table for table, and the shared runtime lock (`runtime_lock`), which
  it cannot take while a live coordinator holds the database. No acknowledgement
  flag stands in for any of these. The owner's capture inbox and repository
  digest appear only in a briefing's DM copy, never a channel copy. Imported
  records live in the correlation
  ledger, whose rows retention never touches; deleting a record leaves an
  identity-only tombstone by trigger.
- **Notification-only watch targets are not engineering watches.**
  `assistant_watch_targets` never references `repos`, never sets `allow_jobs`
  and is never touched by the ordinary watch's allowlist rules. They tell the
  owner (DM and briefing digest) and nothing else, they are observed through a
  typed reader port within a fixed call budget. The shipped reader observes
  nothing unless `DUCKY_ASSISTANT_WATCH_READER_ENABLED` turns on `GhWatchReader`,
  which uses only the typed GET shapes above, one request per unit, charged to
  the same 20-per-tick and 2,400-per-hour budgets.
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
