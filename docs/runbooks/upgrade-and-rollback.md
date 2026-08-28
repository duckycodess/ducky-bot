# Runbook: upgrade and rollback

Ducky's migrations are **forward-only**. There is no `down` step, and adding one
would be a lie: several migrations rebuild a table to widen a CHECK constraint,
and "undoing" that would silently drop rows the newer schema accepted.

So rollback is not "run the down migrations". It is **restore the backup you took
before upgrading**, which is why step 1 is taking one.

## Upgrade

1. **Back up, and verify the backup.** Not "take a backup" — verify it. An
   unverified backup is the rollback plan you find out about afterwards.
   ```bash
   pnpm backup --profile production --out /var/backups/ducky
   pnpm backup:verify --file /var/backups/ducky/ducky-production-<stamp>.db
   ```
   Note the schema version it prints. That number is what you can roll back to.
2. **Read what is pending**, before changing anything:
   ```bash
   git log --oneline HEAD..origin/main
   pnpm migrate --dry
   ```
   `--dry` lists migrations and applies nothing.
3. **Update the code and build.**
   ```bash
   git pull --ff-only
   pnpm install
   pnpm build
   pnpm typecheck && pnpm test
   ```
   The suite runs against temporary databases and touches nothing live.
4. **Stop the coordinator for that profile.** Migrations run at boot, but a
   restart is a cleaner moment than a live process discovering a new schema.
   ```bash
   systemctl stop ducky-coordinator@production
   ```
5. **Apply migrations deliberately**, so a failure happens while you are
   watching rather than inside a service start:
   ```bash
   pnpm migrate --apply
   ```
6. **Start, and read the boot diagnostics.** `migrations` and `database` must be
   `ok`; the profile line must name the profile you meant.
   ```bash
   systemctl start ducky-coordinator@production
   journalctl -u ducky-coordinator@production -n 50
   ```
7. **Check `/readyz`** over loopback. Then `/status` in Discord, and confirm the
   provider lines say what you expect — particularly `conversation`,
   `orchestrator` and `chat memory`.
8. **Only then** the executor, if it also changed:
   `systemctl --user restart ducky-executor@production`.

### If a command surface changed

Registering slash commands is a **separate, deliberate write to Discord**. It
never happens at boot and it is not part of an upgrade unless you say so:

```bash
pnpm register-commands                                  # dry run, prints the payload
pnpm register-commands --apply --profile production     # the actual write
```

## Rollback

Rollback has two halves, and skipping the second is how a rollback becomes a
corruption.

1. **Stop the coordinator.**
2. **Check out the previous revision and rebuild.**
   ```bash
   git log --oneline -5
   git checkout <previous revision>
   pnpm install && pnpm build
   ```
3. **Decide whether the database has to go back too.** Run:
   ```bash
   pnpm backup:verify --file /var/backups/ducky/<the backup from before the upgrade>
   ```
   It prints the backup's schema version and this build's. Then:
   - **The live database is at the same version the old build knows** — no
     restore needed. Start it.
   - **The live database is AHEAD of the old build** — you must restore the
     backup. An older binary against a newer schema is exactly the case
     `verify-backup` refuses to call usable, and running it anyway means a
     column the code does not know about is quietly ignored on every write.
4. **Restore, if step 3 said so.** Follow
   [backup-and-restore.md](backup-and-restore.md) — move the current file aside
   rather than deleting it, take the `-wal` and `-shm` with it.
5. **Start, read the diagnostics, check `/readyz`.**
6. **Expect what a restore always means:** jobs that were running are not,
   notifications after the backup are gone, and a repository may need
   `/job cleanup`. All three are listed in the restore runbook.

## What rollback does NOT undo

- **Slash commands already registered** with Discord. Re-register from the old
  revision if the surface changed: `pnpm register-commands --apply --profile …`.
- **Messages already delivered** — a DM or a shared-channel projection is gone
  from Ducky's control the moment it is sent.
- **Anything an approved action did.** A commit is a commit and a push is a push;
  the execution ledger records that it happened, and undoing it is a git
  operation somebody performs by hand.
- **OpenClaw or Herdr state.** Neither is Ducky's to roll back.

## The one rule

**Never edit a migration that has already been applied anywhere.** Add a new one.
A changed migration is a schema that two databases disagree about while both
claim the same version — and `verify-backup` cannot catch that, because the
version number still matches.
