# Runbook: recover a stuck job

## What happens on its own

A lease expires when an executor stops reporting — a crash, a reboot, a closed
laptop. The reconciler then moves the job back to `waiting_for_executor`,
**keeps the repository reservation**, and flags it for recovery. On the next
claim the executor inspects the agent it recorded and either reattaches to it or
submits a result that was already written.

Nothing is re-run behind your back, and no second writer is ever started beside
a workspace that may still have uncommitted changes.

An executor that negotiated durable pause delivery may hold a quiet-pause report
the coordinator never received. For such a lease the expiry is **not charged**:
the job waits as `waiting_for_executor` with its repository, engineering slot and
workspace kept, and only the original executor can finish it (by delivering its
report, which pauses the job for you with the attempt budget intact, or by its
ordinary recovery claim). No timer fails it. If that executor is gone for good,
`/job cancel` ends the job and converts its holds to an orphan, and `/job
cleanup` clears them after you have looked.

## When a repository stays blocked

`/jobs` shows a job as `failed` with `orphan_agent_still_working`,
`orphan_agent_blocked` or `orphan_prompt_unsettled` (a prompt was submitted and
the turn was never seen to settle -- or nothing durable records that it did, which
is the same to Ducky -- so the agent may still start), and new jobs for
that repository stay `queued`.

That is deliberate. A Pi agent may still be running, so the reservation is
converted to `orphan_agent` — which **never expires** — instead of being
released.

A held orphan also holds the **engineering slot** (decision 0030): while it is
held, no other engineering job is claimed, in any repository. `/job cleanup`
releases the slot together with the reservation. A lease that expired while a
workspace was open is treated the same way after its attempts run out. The slot
is local to this coordinator database; agent-flow and the other profile have
their own state and are not affected.

A timed-out attempt (the 60 minute default) is reported with the phase it
reached. If a fresh look positively matched the recorded agent (name, workspace,
pane, a Ducky workspace) and showed it idle or done, and its turn had been seen to
settle, the repository and slot are released on their own. Anything else (still
working, blocked, unknown, **gone**, a same-name agent that is not provably
the recorded one, or a prompt whose turn was never seen to settle) interrupted
nothing and you will find it here as an orphan: a vanished agent is not proof that
its process stopped.

### Look first

```bash
herdr agent list          # is ducky-pi-<slug> still there, and in what state?
herdr workspace list      # the retained workspace is labelled ducky-mgd:<slug>
```

`/job status <id>` reports the retained workspace id. Attach to the pane and see
what the agent is doing before deciding.

### Then clear it

```
/job cleanup id:<publicId>
```

Releases the reservation only if the agent is gone or idle. If it is genuinely
stuck and you have confirmed the work is finished with, repeat with
`force:true` — the forced release is recorded as an event.

Workspaces are **retained**, never destroyed, on failure and cancellation, so
uncommitted work stays inspectable. Remove one yourself once you are done:

```bash
herdr workspace close <workspace_id>
```

## Other stuck states

| Symptom | Cause | Action |
|---|---|---|
| `needs_owner_input` for a long time | waiting on you | `/job answer id:<id> answer:<text>` |
| `failed` / `owner_input_expired` | no answer within 24 h | resubmit; the workspace was kept |
| `completed` / `approvals_expired_reservation` | actions lapsed | resubmit if still wanted |
| `running` with cancellation pending | the executor saw the request and is confirming what the agent is doing | it resolves within a heartbeat; if the agent is still working the job fails to an orphan reservation you clear with `/job cleanup` |
| `failed` / `foreign_agent_conflict` | an agent holds the name but is not provably ours | inspect it; Ducky touched nothing |

## Health

`/status` shows the live provider table. `GET /healthz` and `/readyz` cover
liveness and database readiness.
