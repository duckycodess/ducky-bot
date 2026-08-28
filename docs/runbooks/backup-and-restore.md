# Runbook: backup, verify, restore

Ducky's whole state is one SQLite file per profile plus one credential file.
They are backed up **separately and deliberately**, because only one of them is
a secret.

## Take a backup

```bash
pnpm backup                            # development profile → ./data/backups
pnpm backup --profile production
pnpm backup --out /var/backups/ducky
pnpm backup --keep 7                   # ALSO report what is beyond the last 7
```

The coordinator keeps running. `node:sqlite` exposes SQLite's online backup API,
which copies pages under a read lock and retries the ones that change
underneath it — so the copy is consistent without downtime.

**Do not use `cp` on a running instance.** The database is in WAL mode: copying
the `.db` alone can miss committed transactions still living in the `-wal`, and a
backup that silently drops the last hour is worse than none.

The copy is written `0600`. It holds the owner's captures, tasks, reminders,
schedules, job history and — if continuity is enabled — conversation turns.

### What is NOT in it

The **executor credential file**. That is the trust root: a backup carrying it
would put a bearer token wherever the backup goes. Back it up separately, to a
different place, and treat it like the secret it is:

```bash
install -m 0600 config/executor-credentials.dev.json /some/other/place/
```

Rotating credentials is a different procedure again — see
[credential-rotation.md](credential-rotation.md).

## Verify it

```bash
pnpm backup:verify --file ./data/backups/ducky-development-<stamp>.db
```

A backup nobody has opened is a hope. The verifier opens the copy read-only,
runs SQLite's own `integrity_check`, confirms `schema_migrations` carries a
version **this build understands**, and counts rows so an empty-but-valid file
cannot pass as a good one.

| Exit | Meaning |
|---|---|
| 0 | opens, passes integrity, known schema |
| 2 | no such file |
| 3 | not a usable Ducky database — the reason is printed |

A backup **older** than the current build is normal: it says how many migrations
would be applied on restore. A backup **newer** than the build is a problem, and
it says so — restoring a database written by a newer schema into an older binary
is how a "successful" restore silently loses a column.

## Restore

Restoring is the one procedure here with downtime, and it is deliberately manual:
nothing in this repository overwrites a live database.

1. **Stop the coordinator for that profile.**
   `systemctl stop ducky-coordinator@<profile>` — or Ctrl-C the dev process.
2. **Verify the backup you are about to restore**, before you move anything:
   `pnpm backup:verify --file <backup>`.
3. **Move the current database aside rather than deleting it.** If the restore is
   wrong, the file you just replaced is the only other copy:
   ```bash
   mv /var/lib/ducky/ducky-production.db /var/lib/ducky/ducky-production.db.before-restore
   mv /var/lib/ducky/ducky-production.db-wal /var/lib/ducky/ducky-production.db-wal.before-restore 2>/dev/null || true
   mv /var/lib/ducky/ducky-production.db-shm /var/lib/ducky/ducky-production.db-shm.before-restore 2>/dev/null || true
   ```
   The `-wal` and `-shm` must go too. Leaving a stale WAL beside a restored
   database is a corruption you will discover later.
4. **Copy the backup into place and fix its ownership and mode.**
   ```bash
   install -m 0600 -o ducky -g ducky <backup> /var/lib/ducky/ducky-production.db
   ```
5. **Apply pending migrations**, if the backup predates the build:
   `pnpm migrate --dry` then `pnpm migrate --apply`.
6. **Start the coordinator** and read the boot diagnostics. `migrations` and
   `database` must both be `ok`.
7. **Check `/readyz`.** It reports `notReady` codes and, as context,
   `retentionRanHoursAgo`.

### After a restore, expect these

- **Jobs that were running are not running.** The executor lease has expired; the
  reconciler will fail or recover them, and a repository may need `/job cleanup`.
- **Notifications between the backup and now are gone**, and the ones in the
  restored ledger may be re-delivered — the ledger is keyed per transition and
  target, so nothing is double-sent from the RESTORED state, but state after the
  backup no longer exists.
- **Herdr workspaces on disk may outlive their rows.** The reconciler sweeps a
  stale workspace after `HERDR_WORKSPACE_TTL_MS`; anything it cannot prove
  ownership of is left alone, on purpose.

## Rotation

`--keep N` **reports** which copies are beyond the newest N. It deletes nothing.
Unattended rotation is how the only good copy disappears, and a script cannot
know which copy that is. Delete them yourself, or point `--out` at a directory
your own backup system manages.

## What backup does not cover

- **Discord history.** Messages Ducky posted into a shared channel live in
  Discord. Nothing here backs them up or deletes them.
- **The workspaces themselves.** A job's checkout under `~/.herdr/worktrees` is
  work in progress, not state Ducky owns.
- **`.env` files.** They are configuration you wrote, and they contain secrets.
  Treat them like the credential file.
