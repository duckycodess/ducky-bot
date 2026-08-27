# Runbook: add a repository

Discord only ever supplies a **slug**. The mapping to an absolute path lives in
operator-controlled configuration, so no message can point a job at an arbitrary
directory.

## Add it

Edit `config/repos.json`:

```json
{
  "slug": "my-service",
  "absolutePath": "/srv/checkouts/my-service",
  "defaultBranch": "main",
  "github": { "owner": "my-org", "repo": "my-service" },
  "allowWorktree": true,
  "allowBootstrap": false,
  "bootstrapAllowedEntries": [".git"],
  "enabled": true
}
```

| Field | Meaning |
|---|---|
| `slug` | `[a-z0-9][a-z0-9-]{0,63}`; what you type in Discord |
| `absolutePath` | must exist, be a directory, and not resolve elsewhere through a symlink |
| `defaultBranch` | verified to exist **before** Herdr is called; `null` falls back to `origin/HEAD` then `HEAD` |
| `github` | enables `/repo status`; read-only, and `null` disables it |
| `allowWorktree` | normal jobs run in an isolated worktree |
| `allowBootstrap` | permits direct greenfield work — see below |
| `bootstrapAllowedEntries` | what may exist in a bootstrap directory |
| `enabled` | `false` refuses new jobs without deleting history |

Restart the coordinator. `/repo status <slug>` confirms it is live.

## Normal repositories

A repository with commits runs in a worktree branched from the verified base
ref, so the main working tree is never touched and your uncommitted work is
safe.

## Greenfield repositories

`allowBootstrap: true` plus `bootstrap:true` on the job lets work happen
directly in the directory, because there is no baseline to branch from.

This is **fail-closed**. Bootstrap refuses a directory that:

- contains anything outside `bootstrapAllowedEntries` — a stray dotfile or
  `node_modules` is enough;
- already has commits;
- has uncommitted or staged changes, or a stash;
- is mid-merge, mid-rebase, mid-cherry-pick or mid-bisect;
- has additional git worktrees.

So a bootstrap job can never overwrite or discard work that is already there. If
you want more separation, point `absolutePath` at a dedicated empty directory.

Once the repository has its first commit, set `allowBootstrap: false`.

## Removing one

Set `enabled: false` and restart. Existing job history is preserved; new
submissions are refused.
