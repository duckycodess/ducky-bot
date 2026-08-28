export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Forward-only, transactional, versioned. Kept as TypeScript rather than .sql
 * assets so the compiled package has no runtime file lookups.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE repos (
  slug                          TEXT PRIMARY KEY,
  absolute_path                 TEXT NOT NULL,
  default_branch                TEXT,
  github_owner                  TEXT,
  github_repo                   TEXT,
  allow_worktree                INTEGER NOT NULL DEFAULT 1,
  allow_bootstrap               INTEGER NOT NULL DEFAULT 0,
  bootstrap_allowed_entries_json TEXT NOT NULL DEFAULT '[".git"]',
  enabled                       INTEGER NOT NULL DEFAULT 1,
  created_at                    TEXT NOT NULL
);

-- Audit only. NEVER consulted on the authorization path; env config is the
-- sole authority (see docs/SECURITY.md).
CREATE TABLE authorized_user_audit (
  discord_user_id TEXT PRIMARY KEY,
  role            TEXT NOT NULL CHECK (role IN ('owner','chat')),
  source          TEXT NOT NULL DEFAULT 'config',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE TABLE captures (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open','done','archived')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- The ONLY table that ever holds schedule content, and only after the owner
-- has explicitly confirmed a preview. Drafts live in memory only.
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  starts_at       TEXT NOT NULL,
  ends_at         TEXT,
  location        TEXT,
  notes           TEXT,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('text','file')),
  confirmed_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE jobs (
  id                    TEXT PRIMARY KEY,
  public_id             TEXT NOT NULL UNIQUE,
  discord_user_id       TEXT NOT NULL,
  repo_slug             TEXT NOT NULL REFERENCES repos(slug),
  task                  TEXT NOT NULL,
  context               TEXT,
  bootstrap             INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL,
  cancel_requested      INTEGER NOT NULL DEFAULT 0,
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 1,
  owner_input_rounds    INTEGER NOT NULL DEFAULT 0,
  max_owner_input_rounds INTEGER NOT NULL DEFAULT 3,
  recovery_required     INTEGER NOT NULL DEFAULT 0,
  lease_id              TEXT,
  lease_expires_at      TEXT,
  executor_id           TEXT,
  retained_workspace_id TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT
);

-- Primary single-writer guarantee: one row per repo for the WHOLE nonterminal
-- lifetime of a job (running, needs_owner_input, needs_approval).
-- expires_at NULL means "never expires" (orphan_agent, owner-cleared only).
CREATE TABLE repo_reservations (
  repo_slug   TEXT PRIMARY KEY REFERENCES repos(slug),
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  acquired_at TEXT NOT NULL,
  expires_at  TEXT,
  reason      TEXT NOT NULL CHECK (reason IN ('active_job','orphan_agent'))
);

CREATE TABLE job_transitions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES jobs(id),
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE job_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  message_redacted TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (job_id, seq)
);

CREATE TABLE job_owner_inputs (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  round            INTEGER NOT NULL,
  question_redacted TEXT NOT NULL,
  answer           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (job_id, round)
);

-- One row per executor turn: a job that pauses for an owner answer and then
-- runs again produces a second result. Keyed by (job_id, lease_id) so a retry
-- of the same turn is idempotent while a later turn is a new record.
CREATE TABLE job_results (
  id                   TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL REFERENCES jobs(id),
  lease_id             TEXT NOT NULL,
  result_sha256        TEXT NOT NULL,
  verdict              TEXT NOT NULL,
  summary_redacted     TEXT NOT NULL,
  review_json          TEXT NOT NULL,
  verification_json    TEXT NOT NULL,
  changed_files_json   TEXT NOT NULL,
  proposed_actions_json TEXT NOT NULL,
  result_snapshot_json TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE (job_id, lease_id)
);

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  action_index    INTEGER NOT NULL,
  action_kind     TEXT NOT NULL,
  description     TEXT NOT NULL,
  details_json    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired')),
  expires_at      TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TEXT,
  decision_reason TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (job_id, action_index)
);

-- Identity only. All per-key material lives in executor_credentials.
CREATE TABLE executors (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active','revoked')),
  version      TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- One row per key id, so two credentials can be active at once and rotation
-- needs no downtime. Holds NO secret material: bearer_verifier is sha256 of a
-- >=256-bit random bearer, fingerprint is an audit aid that cannot verify a
-- signature. Plaintext bearer/HMAC keys live only in the runtime store.
CREATE TABLE executor_credentials (
  key_id               TEXT PRIMARY KEY,
  executor_id          TEXT NOT NULL REFERENCES executors(id) ON DELETE CASCADE,
  bearer_verifier      TEXT NOT NULL,
  hmac_key_fingerprint TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('active','revoked')),
  created_at           TEXT NOT NULL,
  last_used_at         TEXT,
  revoked_at           TEXT,
  UNIQUE (executor_id, bearer_verifier)
);

CREATE TABLE executor_nonces (
  nonce       TEXT PRIMARY KEY,
  executor_id TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Authoritative record of what Ducky created in Herdr. A label alone is NOT
-- proof of ownership: the live host already has a user workspace labelled
-- exactly "ducky".
CREATE TABLE herdr_workspaces (
  workspace_id TEXT PRIMARY KEY,
  repo_slug    TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  label        TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('worktree','direct')),
  agent_name   TEXT NOT NULL,
  worktree_path TEXT,
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);
`,
  },
  {
    version: 2,
    name: 'indexes',
    sql: `
CREATE INDEX ix_captures_owner_status ON captures(discord_user_id, status, created_at DESC);
CREATE INDEX ix_jobs_state ON jobs(state, created_at);
CREATE INDEX ix_jobs_repo ON jobs(repo_slug, state);
CREATE INDEX ix_job_events_job ON job_events(job_id, seq);
CREATE INDEX ix_approvals_job_state ON approvals(job_id, state);
CREATE INDEX ix_job_results_job ON job_results(job_id, created_at DESC);
CREATE INDEX ix_exec_creds ON executor_credentials(executor_id, state);
CREATE INDEX ix_nonces_expiry ON executor_nonces(expires_at);
CREATE INDEX ix_herdr_ws_job ON herdr_workspaces(job_id) WHERE closed_at IS NULL;
CREATE INDEX ix_schedules_owner ON schedules(discord_user_id, starts_at);

-- Secondary invariant behind the reservation: even if the claim predicate were
-- wrong, two rows can never sit in 'running' for one repo.
CREATE UNIQUE INDEX ux_jobs_one_running_per_repo ON jobs(repo_slug) WHERE state = 'running';
`,
  },
  {
    version: 3,
    name: 'workspace_registration_state',
    sql: `
-- A workspace is registered BEFORE its agent starts, so a crash in between
-- still leaves proof that it is Ducky-owned.
ALTER TABLE herdr_workspaces ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('creating','active','closed'));
ALTER TABLE herdr_workspaces ADD COLUMN workspace_path TEXT;
ALTER TABLE herdr_workspaces ADD COLUMN updated_at TEXT;
CREATE INDEX ix_herdr_ws_agent ON herdr_workspaces(agent_name) WHERE closed_at IS NULL;
`,
  },
  {
    version: 4,
    name: 'result_immutability',
    sql: `
-- The accepted result snapshot is the record of truth; approvals are derived.
-- Even a future bug cannot mutate it.
CREATE TRIGGER trg_job_results_immutable
BEFORE UPDATE ON job_results
BEGIN
  SELECT RAISE(ABORT, 'job_results rows are immutable');
END;
`,
  },
  {
    version: 5,
    name: 'job_notifications',
    sql: `
-- Delivery ledger for owner-facing job lifecycle notifications. One row per
-- job_transitions id that has been successfully sent; a transition with no
-- row here is still pending (or was skipped on purpose, which also counts as
-- delivered). The primary key on transition_id is what makes delivery
-- idempotent -- a retried sweep cannot double-send.
CREATE TABLE job_notifications (
  transition_id INTEGER PRIMARY KEY REFERENCES job_transitions(id),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  delivered_at  TEXT NOT NULL
);

-- Baseline every transition that already existed before this feature shipped
-- as delivered. Without this, the very first sweep after upgrading an
-- existing deployment would treat the whole job_transitions history as
-- pending and DM the owner once per historical transition. Only transitions
-- recorded from this point forward are left pending for the notifier.
INSERT INTO job_notifications (transition_id, job_id, delivered_at)
SELECT id, job_id, created_at FROM job_transitions;
`,
  },
  {
    version: 6,
    name: 'shared_job_visibility',
    sql: `
-- Where a job was submitted from, when that was a CONFIGURED shared channel.
-- NULL for a DM, an unconfigured channel, or any job created before this
-- migration. Recorded only when the channel was shared at submit time, and
-- re-checked against live configuration before anything is ever sent to it,
-- so a channel removed from configuration stops receiving updates for jobs
-- that were already running in it.
ALTER TABLE jobs ADD COLUMN origin_shared_channel_id TEXT;

-- Delivery ledger, now keyed per TARGET rather than per transition.
--
-- One transition can owe a message to two different places -- the owner's DM
-- and the originating shared channel -- and those can fail independently. A
-- single row per transition could only record "sent" or "not sent" for both
-- at once, so a shared-channel outage would either re-send the owner's DM on
-- every retry or strand the channel message forever. The composite primary
-- key is what makes each target idempotent on its own: a retried sweep
-- cannot double-send either one, and a failure of one never blocks or
-- duplicates the other.
CREATE TABLE job_notification_deliveries (
  transition_id INTEGER NOT NULL REFERENCES job_transitions(id),
  target        TEXT NOT NULL CHECK (target IN ('owner_dm','shared_channel')),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  delivered_at  TEXT NOT NULL,
  PRIMARY KEY (transition_id, target)
);

CREATE INDEX idx_job_notification_deliveries_job ON job_notification_deliveries (job_id);

-- Carry the existing ledger forward. Every transition previously recorded as
-- delivered was an owner DM, because that was the only target that existed.
-- Transitions NOT listed there were still pending and stay pending.
INSERT INTO job_notification_deliveries (transition_id, target, job_id, delivered_at)
SELECT transition_id, 'owner_dm', job_id, delivered_at FROM job_notifications;

-- No baseline row is needed for the NEW target. origin_shared_channel_id was
-- only just added, so it is NULL for every job that already exists, and a job
-- with no originating shared channel has no shared target at all -- the
-- pending query reports it as already satisfied rather than manufacturing one.
-- The first sweep after this upgrade therefore cannot replay any history into
-- a channel, without writing a row per historical transition to say so.

-- Fully superseded: every row was copied above and nothing reads it any more.
DROP TABLE job_notifications;
`,
  },
  {
    version: 7,
    name: 'daily_assistant',
    sql: `
-- A task is a COMMITMENT and is a different record from a capture, which is an
-- unsorted thought. Owner-only in full: there is no projection of this table
-- and no shared route can reach it.
--
-- due_at is an ISO-8601 UTC instant like every other timestamp in this schema.
-- due_all_day records that the owner gave a DATE with no time of day, so the
-- readback can show a date instead of inventing a 00:00 that was never typed.
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  public_id       TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  due_at          TEXT,
  due_all_day     INTEGER NOT NULL DEFAULT 0,
  priority        TEXT NOT NULL CHECK (priority IN ('low','normal','high')),
  status          TEXT NOT NULL CHECK (status IN ('open','done','cancelled')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT
);

CREATE INDEX ix_tasks_owner_status ON tasks(discord_user_id, status, due_at);
CREATE INDEX ix_tasks_owner_due ON tasks(discord_user_id, due_at) WHERE status = 'open';

-- A reminder is a SCHEDULE, not a delivery. next_fire_at is the only cursor
-- the tick reads, and advancing it is what makes a repeated tick idempotent:
-- once an occurrence is materialized the cursor has already moved past it, so
-- a second tick in the same second finds nothing due.
--
-- Recurrence is deliberately narrow. interval_minutes is a fixed interval and
-- max_occurrences is a hard count, both bounded at input, so no row here can
-- describe an unbounded schedule. There is no cron column to grow one.
CREATE TABLE reminders (
  id               TEXT PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,
  discord_user_id  TEXT NOT NULL,
  text             TEXT NOT NULL,
  recurrence_kind  TEXT NOT NULL CHECK (recurrence_kind IN ('once','interval')),
  interval_minutes INTEGER,
  max_occurrences  INTEGER NOT NULL CHECK (max_occurrences >= 1),
  fired_count      INTEGER NOT NULL DEFAULT 0,
  next_fire_at     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('scheduled','completed','cancelled')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  first_fire_at    TEXT NOT NULL,
  last_fired_at    TEXT,
  closed_at        TEXT,
  -- A one-shot has no interval and fires once; an interval reminder must have
  -- one. Enforced by the schema so no code path can write a half-specified
  -- recurrence.
  CHECK (
    (recurrence_kind = 'once'     AND interval_minutes IS NULL AND max_occurrences = 1)
    OR
    (recurrence_kind = 'interval' AND interval_minutes IS NOT NULL AND interval_minutes > 0)
  ),
  -- A scheduled reminder always has a cursor; a finished one never does.
  CHECK ((status = 'scheduled') = (next_fire_at IS NOT NULL))
);

CREATE INDEX ix_reminders_due ON reminders(next_fire_at) WHERE status = 'scheduled';
CREATE INDEX ix_reminders_owner ON reminders(discord_user_id, status, next_fire_at);

-- The durable delivery ledger, the same shape as job_notification_deliveries:
-- a row exists once an occurrence is DUE, and carries delivered_at once it has
-- actually been sent. Nothing is ever sent without a row, and a row can only
-- be created once per (reminder, occurrence_no) -- that unique key is what
-- makes a retried or overlapping tick unable to double-deliver.
--
-- missed_count records how many earlier occurrences of a repeating reminder
-- were collapsed into this one after an outage. It is never silently zero: a
-- catch-up that skipped four occurrences says so in the message.
CREATE TABLE reminder_occurrences (
  id             TEXT PRIMARY KEY,
  reminder_id    TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  occurrence_no  INTEGER NOT NULL,
  scheduled_for  TEXT NOT NULL,
  missed_count   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  delivered_at   TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  -- Set when delivery has failed too many times to keep retrying. An
  -- abandoned occurrence stays in the ledger as a record; it is not deleted
  -- and it is not re-queued.
  abandoned_at   TEXT,
  UNIQUE (reminder_id, occurrence_no)
);

CREATE INDEX ix_reminder_occurrences_pending
  ON reminder_occurrences(scheduled_for)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL;
`,
  },
  {
    version: 8,
    name: 'lifecycle_dependencies_audit',
    sql: `
-- The engineering work phase of a RUNNING job.
--
-- A second dimension beside jobs.state, not a replacement for it. The state
-- says who owns the job and what may touch it; the phase says what the agent
-- is doing. Keeping them apart is what lets fine-grained progress land without
-- touching ux_jobs_one_running_per_repo, the lease-expiry sweep, the claim
-- predicate or the cancel path -- all of which are keyed on state = 'running'.
--
-- NULL means "no work in progress", which is every job that is not currently
-- leased. Every existing row starts NULL, which is correct for all of them.
ALTER TABLE jobs ADD COLUMN work_phase TEXT
  CHECK (work_phase IS NULL OR work_phase IN
    ('preparing','planning','implementing','reviewing','fixing','verifying'));

-- What a job is blocked on, when it reports waiting_on_dependency.
--
-- The row is the schedule: next_check_at is the cursor a bounded reconciliation
-- reads, checks_made/max_checks and deadline_at are the two independent
-- ceilings, and there is deliberately no way to express "check forever".
CREATE TABLE job_dependencies (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  type          TEXT NOT NULL CHECK (type IN
                  ('ci_run','external_service','package_publish','upstream_change','human_action','other')),
  description   TEXT NOT NULL,
  external_key  TEXT,
  state         TEXT NOT NULL CHECK (state IN ('waiting','ready','failed','expired','cancelled')),
  next_check_at TEXT,
  checks_made   INTEGER NOT NULL DEFAULT 0,
  max_checks    INTEGER NOT NULL CHECK (max_checks >= 1),
  deadline_at   TEXT NOT NULL,
  last_check_at TEXT,
  last_status   TEXT CHECK (last_status IS NULL OR last_status IN ('pending','ready','failed')),
  last_detail   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  resolved_at   TEXT,
  -- A waiting dependency always has a cursor; a resolved one never does. This
  -- is what makes "is anything still being checked?" a schema fact rather than
  -- something the resolver has to be trusted to keep true.
  CHECK ((state = 'waiting') = (next_check_at IS NOT NULL))
);

-- At most ONE open dependency per job. A job cannot be waiting on two things
-- at once, because it has one state and one reservation.
CREATE UNIQUE INDEX ux_job_dependencies_one_open
  ON job_dependencies(job_id) WHERE state = 'waiting';

CREATE INDEX ix_job_dependencies_due
  ON job_dependencies(next_check_at) WHERE state = 'waiting';

-- A structured record of what happened, and NOTHING ELSE.
--
-- It is never read to decide anything: authorization is frozen environment
-- configuration and the job state machine is the jobs table. A row here grants
-- nothing and blocks nothing, exactly as authorized_user_audit does not.
--
-- It holds no secret, no raw authentication material, no terminal output and
-- no environment. actor_ref is a role reference or a non-secret executor id
-- -- never a Discord user id, never a bearer token, never a signature. Every
-- free-text detail is redacted and clamped before it is written.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner','executor','system','reconciler')),
  actor_ref    TEXT,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN
                 ('job','approval','executor','dependency')),
  subject_ref  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail       TEXT
);

CREATE INDEX ix_audit_log_at ON audit_log(at);
CREATE INDEX ix_audit_log_subject ON audit_log(subject_kind, subject_ref, id);
`,
  },
  {
    version: 9,
    name: 'approved_action_execution_ledger',
    sql: `
-- One execution slot per approved proposal. Approval is a decision; execution
-- is a separate, explicit owner action. A row in 'running' is deliberately
-- never retried automatically after a crash, because an external command may
-- have succeeded just before the process died and repeating it could publish
-- twice.
CREATE TABLE approval_executions (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id),
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  state       TEXT NOT NULL CHECK (state IN ('running','succeeded','failed')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  error       TEXT
);

CREATE INDEX ix_approval_executions_job ON approval_executions(job_id);
`,
  },
  {
    version: 10,
    name: 'github_repository_watches',
    sql: `
-- Owner-configured, read-only GitHub observations. A watch has an explicit
-- interval and is checked only by the existing coordinator loop; it is not a
-- hidden per-watch timer or an autonomous write workflow.
CREATE TABLE github_watches (
  id               TEXT PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,
  discord_user_id  TEXT NOT NULL,
  repo_slug        TEXT NOT NULL REFERENCES repos(slug),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 15 AND interval_minutes <= 1440),
  next_check_at    TEXT,
  state            TEXT NOT NULL CHECK (state IN ('active','cancelled')),
  snapshot_hash    TEXT,
  snapshot_json    TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  cancelled_at     TEXT,
  CHECK ((state = 'active') = (next_check_at IS NOT NULL))
);

CREATE UNIQUE INDEX ux_github_watches_owner_repo
  ON github_watches(discord_user_id, repo_slug) WHERE state = 'active';
CREATE INDEX ix_github_watches_due
  ON github_watches(next_check_at) WHERE state = 'active';

-- Meaningful normalized changes waiting for owner-DM delivery. The fingerprint
-- is unique per watch, so a repeated observation cannot create duplicate
-- notifications even if the observation and delivery sweeps overlap.
CREATE TABLE github_watch_events (
  id              TEXT PRIMARY KEY,
  watch_id        TEXT NOT NULL REFERENCES github_watches(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL,
  summary         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  abandoned_at    TEXT,
  UNIQUE (watch_id, fingerprint)
);

CREATE INDEX ix_github_watch_events_pending
  ON github_watch_events(created_at)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL;
`,
  },
  {
    version: 11,
    name: 'query_indexes',
    sql: `
-- Indexes for three queries confirmed by EXPLAIN QUERY PLAN to be full table
-- scans on the live development database:
--
--   SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id        -> SCAN
--   SELECT * FROM jobs WHERE discord_user_id = ? ORDER BY created_at  -> SCAN + temp b-tree
--   SELECT * FROM jobs WHERE origin_shared_channel_id = ? ...         -> SCAN + temp b-tree
--
-- job_transitions had NO index at all, and it is both the owner's job history
-- and the source the notification sweep reads on every reconcile tick, so it
-- grows for the life of the instance.
CREATE INDEX IF NOT EXISTS ix_job_transitions_job ON job_transitions(job_id, id);
CREATE INDEX IF NOT EXISTS ix_jobs_owner_created ON jobs(discord_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_origin_channel
  ON jobs(origin_shared_channel_id, created_at DESC)
  WHERE origin_shared_channel_id IS NOT NULL;

-- Reservations are keyed by repo_slug, but the reverse lookup ("which repo does
-- this job hold?") runs on every cancellation and every reconcile pass.
CREATE INDEX IF NOT EXISTS ix_repo_reservations_job ON repo_reservations(job_id);

-- The only table with no expiry and no index on its age column.
CREATE INDEX IF NOT EXISTS ix_idempotency_created ON idempotency_keys(created_at);
`,
  },
  {
    version: 12,
    name: 'retention',
    sql: `
-- Retention's own run log. Counts only: a deletion record exists to say that
-- data went, not to keep a copy of it.
CREATE TABLE retention_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  trigger      TEXT NOT NULL CHECK (trigger IN ('scheduled','manual')),
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','partial','failed')),
  counts_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_retention_runs_started ON retention_runs(started_at);

-- Age indexes for the columns each policy selects on. Without these every
-- pass is a full scan of the table it is trying to bound.
--
-- Each is PARTIAL where the policy is: retention only ever looks at finished
-- things, so an index over live rows would be dead weight and would let a
-- careless query match one.
CREATE INDEX ix_jobs_terminal_finished ON jobs(finished_at)
  WHERE state IN ('completed','failed','cancelled') AND finished_at IS NOT NULL;
CREATE INDEX ix_captures_closed ON captures(updated_at)
  WHERE status IN ('done','archived');
CREATE INDEX ix_tasks_closed_at ON tasks(closed_at)
  WHERE closed_at IS NOT NULL;
CREATE INDEX ix_reminders_closed_at ON reminders(closed_at)
  WHERE closed_at IS NOT NULL;
CREATE INDEX ix_schedules_confirmed ON schedules(starts_at)
  WHERE confirmed_at IS NOT NULL;
CREATE INDEX ix_github_watch_events_settled ON github_watch_events(created_at)
  WHERE delivered_at IS NOT NULL OR abandoned_at IS NOT NULL;
CREATE INDEX ix_github_watches_cancelled ON github_watches(cancelled_at)
  WHERE cancelled_at IS NOT NULL;
CREATE INDEX ix_herdr_ws_closed_at ON herdr_workspaces(closed_at)
  WHERE closed_at IS NOT NULL;
CREATE INDEX ix_reminder_occurrences_settled ON reminder_occurrences(created_at)
  WHERE delivered_at IS NOT NULL OR abandoned_at IS NOT NULL;
`,
  },
  {
    version: 13,
    name: 'audit_subject_kinds',
    sql: `
-- Widens \`audit_log.subject_kind\` for the security and retention events.
--
-- This migration exists because of a silent failure, and the failure mode is
-- worth recording. \`AuditLogRepo.record\` deliberately NEVER THROWS -- a job
-- rolled back because bookkeeping failed would be worse than one that ran and
-- was not written down. The consequence is that a value the TypeScript enum
-- allows and this CHECK constraint does not is dropped without a sound: the
-- audit log simply loses the row. Three new subject kinds hit exactly that.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Rows are copied
-- verbatim; nothing is reinterpreted.
CREATE TABLE audit_log_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner','executor','system','reconciler')),
  actor_ref    TEXT,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN
                 ('job','approval','executor','dependency','credential','retention','route')),
  subject_ref  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail       TEXT
);

INSERT INTO audit_log_v2 (id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail)
  SELECT id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail
    FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v2 RENAME TO audit_log;

CREATE INDEX ix_audit_log_at ON audit_log(at);
CREATE INDEX ix_audit_log_subject ON audit_log(subject_kind, subject_ref, id);
`,
  },
  {
    version: 14,
    name: 'schedule_retention_index',
    sql: `
-- Indexes the column retention actually selects schedules on.
--
-- Migration 12 indexed \`starts_at\`, which was the wrong column for the wrong
-- query: \`starts_at\` is bare WALL-CLOCK text in the owner's zone (ADR 0014),
-- so comparing it to a UTC cutoff in SQL is not a valid comparison at all. The
-- selection now filters on \`confirmed_at\`, which is a stored UTC instant, and
-- the owner-zone test on \`starts_at\` happens in TypeScript where the zone is
-- known.
--
-- The old index is dropped rather than left behind: it supports no query, and a
-- stale index on a text column that looks like a timestamp is an invitation to
-- write exactly the comparison that was just removed.
DROP INDEX IF EXISTS ix_schedules_confirmed;
CREATE INDEX IF NOT EXISTS ix_schedules_confirmed_at ON schedules(confirmed_at)
  WHERE confirmed_at IS NOT NULL;
`,
  },
  {
    version: 15,
    name: 'audit_subject_kinds_v3',
    sql: `
-- Two more subject kinds, for the approval/provider/configuration events.
--
-- Same reason as migration 13, and the same hazard: \`AuditLogRepo.record\` never
-- throws, so a subject kind the enum allows and this constraint does not is
-- dropped silently. \`schema.test.ts\` asserts the enums and this constraint agree,
-- which is what makes adding one here non-optional rather than easy to forget.
CREATE TABLE audit_log_v3 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner','executor','system','reconciler')),
  actor_ref    TEXT,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN
                 ('job','approval','executor','dependency','credential','retention','route',
                  'config','provider')),
  subject_ref  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail       TEXT
);

INSERT INTO audit_log_v3 (id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail)
  SELECT id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail
    FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v3 RENAME TO audit_log;

CREATE INDEX ix_audit_log_at ON audit_log(at);
CREATE INDEX ix_audit_log_subject ON audit_log(subject_kind, subject_ref, id);
`,
  },
  {
    version: 16,
    name: 'conversation_turns',
    sql: `
-- Bounded conversation continuity, and the first table that stores anything
-- the owner SAID rather than something they filed.
--
-- Until now "conversation retention" was answered by "nothing is stored", which
-- was true and also meant Ducky could not answer a follow-up question. This
-- table exists so it can -- and it is written so the honest answer stays
-- available: the feature is OFF unless an operator enables it, every row is
-- scoped to one (user, thread), and /forget conversation deletes rather than
-- explaining that there is nothing to delete.
--
-- The role column is closed to the two participants. There is deliberately no
-- system role: a stored prompt preamble would be configuration masquerading
-- as history, and nothing may inject text into this table that the owner or
-- Ducky did not actually say.
CREATE TABLE conversation_turns (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  -- The Discord channel the message arrived in. Isolation is by (user, thread),
  -- so one person's DM history can never be read into another's, and a channel
  -- conversation can never be read into a DM.
  thread_key      TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- The only read path: the most recent turns of one thread, for one user.
CREATE INDEX ix_conversation_turns_thread
  ON conversation_turns(discord_user_id, thread_key, created_at, id);
-- Retention selects on age alone.
CREATE INDEX ix_conversation_turns_age ON conversation_turns(created_at);
`,
  },
  {
    version: 17,
    name: 'audit_subject_kinds_v4',
    sql: `
-- One more subject kind: conversation, for the deletion of stored turns.
--
-- Third time this table has been widened, and the reason it keeps needing a
-- migration is the reason it is worth doing: AuditLogRepo.record never throws,
-- so a subject kind the enum allows and this constraint does not is dropped
-- SILENTLY. schema.test.ts asserts the enums and this constraint agree.
CREATE TABLE audit_log_v4 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner','executor','system','reconciler')),
  actor_ref    TEXT,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN
                 ('job','approval','executor','dependency','credential','retention','route',
                  'config','provider','conversation')),
  subject_ref  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail       TEXT
);

INSERT INTO audit_log_v4 (id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail)
  SELECT id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail
    FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v4 RENAME TO audit_log;

CREATE INDEX ix_audit_log_at ON audit_log(at);
CREATE INDEX ix_audit_log_subject ON audit_log(subject_kind, subject_ref, id);
`,
  },
  {
    version: 18,
    name: 'briefing_deliveries',
    sql: `
-- The outbox for PROACTIVE briefings.
--
-- Same shape as reminder_occurrences, and for the same reason: a durable row
-- exists from the moment a briefing is due, a unique key makes recording a
-- delivery idempotent, and a restart mid-outage loses nothing. What it is NOT
-- is a second scheduler -- the pass rides the existing coordinator interval.
--
-- (discord_user_id, kind, day_key) is the identity of a briefing: ONE morning
-- briefing per civil day per person, whatever happens. A repeated tick, two
-- overlapping passes and a restart all collide on this index rather than
-- sending twice.
CREATE TABLE briefing_deliveries (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('morning','evening')),
  -- The owner's own civil day, YYYY-MM-DD in DUCKY_OWNER_TIMEZONE. A date key
  -- rather than an instant, because "today's briefing" is a civil-day concept
  -- and the zone is a projection (ADR 0014).
  day_key         TEXT NOT NULL,
  -- When it became due, as a real UTC instant.
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','delivered','abandoned','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error_at   TEXT,
  delivered_at    TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_briefing_deliveries_slot
  ON briefing_deliveries(discord_user_id, kind, day_key);
CREATE INDEX ix_briefing_deliveries_pending
  ON briefing_deliveries(status, due_at) WHERE status = 'pending';
`,
  },
  {
    version: 19,
    name: 'audit_subject_kinds_v5',
    sql: `
-- One more subject kind: record, for a per-record deletion the owner asked for.
--
-- Per-record /forget was briefly filed under the conversation subject, which is
-- the wrong kind of wrong: an audit trail that misdescribes what was removed is
-- worse than a coarse one. AuditLogRepo.record never throws, so a kind the enum
-- allows and this constraint does not is dropped SILENTLY -- which is why every
-- widening gets a migration and schema.test.ts asserts the two agree.
CREATE TABLE audit_log_v5 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner','executor','system','reconciler')),
  actor_ref    TEXT,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN
                 ('job','approval','executor','dependency','credential','retention','route',
                  'config','provider','conversation','record')),
  subject_ref  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail       TEXT
);

INSERT INTO audit_log_v5 (id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail)
  SELECT id, at, event, actor_kind, actor_ref, subject_kind, subject_ref, outcome, detail
    FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v5 RENAME TO audit_log;

CREATE INDEX ix_audit_log_at ON audit_log(at);
CREATE INDEX ix_audit_log_subject ON audit_log(subject_kind, subject_ref, id);
`,
  },
];
