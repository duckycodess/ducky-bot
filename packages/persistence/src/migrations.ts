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
  {
    version: 20,
    name: 'repo_placements',
    sql: `
-- One repository slug, several hosts that can check it out.
--
-- The slug stays the ONLY thing anyone names. Discord supplies a slug and
-- never a path, the reservation is still keyed on the slug and is therefore
-- still global across every executor, and the executor-specific path is
-- resolved on CLAIM, by the coordinator, from operator-controlled config.
--
-- Config remains authoritative (ADR 0009 applies to authorization; this is the
-- same discipline for placement). These rows mirror it so \`/repo status\` and
-- the diagnostics can report what this instance believes, exactly as the
-- \`repos\` table already mirrors the allowlist.
CREATE TABLE repo_placements (
  repo_slug     TEXT NOT NULL REFERENCES repos(slug) ON DELETE CASCADE,
  executor_id   TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (repo_slug, executor_id)
);

CREATE INDEX ix_repo_placements_executor ON repo_placements(executor_id, enabled);

-- Whether a repository accepts JOBS at all.
--
-- A GitHub mapping added purely so a repository can be WATCHED would otherwise
-- also make it a job target -- and a job target is a directory a real Pi agent
-- gets edit capability in. These are two different permissions and they now
-- have two different flags. Existing rows default to 1, which is exactly what
-- they meant before this column existed.
ALTER TABLE repos ADD COLUMN allow_jobs INTEGER NOT NULL DEFAULT 1;

-- The nullable local path, and the reason it is a SECOND column.
--
-- A watch-only mapping has no checkout on this host, so its path is genuinely
-- absent -- but \`repos.absolute_path\` is NOT NULL, and SQLite can only drop a
-- NOT NULL by rebuilding the table. Rebuilding \`repos\` is not available here:
-- \`jobs\`, \`repo_reservations\` and \`github_watches\` all carry a foreign key to
-- \`repos(slug)\`, and dropping the parent inside the migration transaction
-- fails on those constraints (tried, with \`defer_foreign_keys\` on; it still
-- fails).
--
-- So: \`local_path\` is nullable and is what every reader consults.
-- \`absolute_path\` is retained and DEAD. It still has to be given SOMETHING on
-- insert, because NOT NULL demands one, and a pathless repository gets the
-- empty string there -- but that placeholder never means anything to anyone,
-- because nothing reads the column. A test asserts exactly that: no repository
-- and no service reads \`absolute_path\`. The alternative was a sentinel in a
-- LIVE column, a value that means "no value" in a field readers consult, which
-- is the sort of quiet encoding that gets misread later.
ALTER TABLE repos ADD COLUMN local_path TEXT;

UPDATE repos SET local_path = absolute_path;
`,
  },
  {
    version: 21,
    name: 'briefing_delivery_targets',
    sql: `
-- A briefing can now go to the owner's DM, to their configured briefing
-- channel, or to both -- so the ledger needs to know WHICH, and the
-- idempotency key has to include it.
--
-- Without the target in the key, delivering to a DM would mark the whole slot
-- done and the channel copy would never be sent; with it, the two succeed,
-- fail and retry independently, exactly as the job-notification ledger's
-- (transition, target) pairs already do.
--
-- A REBUILD is safe here and was not safe for \`repos\`: nothing carries a
-- foreign key to \`briefing_deliveries\` (checked), so dropping it breaks no
-- child constraint.
--
-- Existing rows are back-filled as \`owner_dm\`, which is what every row that
-- exists today actually was. An upgrade therefore changes nothing about a
-- briefing already delivered, and does not re-send one.
CREATE TABLE briefing_deliveries_v2 (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('morning','evening')),
  day_key         TEXT NOT NULL,
  target          TEXT NOT NULL CHECK (target IN ('owner_dm','briefing_channel')),
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','delivered','abandoned','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error_at   TEXT,
  delivered_at    TEXT,
  created_at      TEXT NOT NULL
);

INSERT INTO briefing_deliveries_v2
  (id, discord_user_id, kind, day_key, target, due_at, status, attempts,
   last_error_at, delivered_at, created_at)
  SELECT id, discord_user_id, kind, day_key, 'owner_dm', due_at, status, attempts,
         last_error_at, delivered_at, created_at
    FROM briefing_deliveries;

DROP TABLE briefing_deliveries;
ALTER TABLE briefing_deliveries_v2 RENAME TO briefing_deliveries;

CREATE UNIQUE INDEX ux_briefing_deliveries_slot
  ON briefing_deliveries(discord_user_id, kind, day_key, target);
CREATE INDEX ix_briefing_deliveries_pending
  ON briefing_deliveries(status, due_at) WHERE status = 'pending';
`,
  },
  {
    version: 22,
    name: 'task_previews_and_linked_reminders',
    sql: `
-- A pasted list, held between "show me what you read" and "save it".
--
-- DURABLE, unlike the in-memory schedule draft, and for a reason the schedule
-- surface does not have: the phone parses on one request and saves on the
-- next, and a preview that lived only in a process would be lost by a restart
-- between the two taps. The owner's own task text is in here, so the row is
-- deliberately short-lived (TASK_PREVIEW_TTL_MS) and the reconciler sweeps
-- expired ones whether or not retention is configured.
--
-- \`items_json\` is CLEARED the moment the preview settles. A saved preview
-- keeps only the public ids it produced -- which is what makes a double press
-- return the same tasks instead of a second set -- and a discarded one keeps
-- nothing at all. So no copy of what the owner wrote outlives the decision
-- they made about it.
CREATE TABLE task_previews (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('discord','phone')),
  status          TEXT NOT NULL CHECK (status IN ('pending','saved','discarded')),
  item_count      INTEGER NOT NULL CHECK (item_count >= 0),
  items_json      TEXT,
  saved_ids_json  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  settled_at      TEXT,
  -- A pending preview always has its items; a settled one never does.
  CHECK ((status = 'pending') = (items_json IS NOT NULL))
);

CREATE INDEX ix_task_previews_owner ON task_previews(discord_user_id, status, created_at);
CREATE INDEX ix_task_previews_expiry ON task_previews(expires_at);

-- Which TASK a reminder belongs to, recorded rather than inferred.
--
-- The link has to be a column: deriving it from the reminder's text would mean
-- matching strings to decide whether to cancel a notification, and two tasks
-- called "Letters" would then cancel each other's. ON DELETE CASCADE so
-- \`/forget task\` and retention cannot leave a reminder pointing at a task
-- that is gone -- the reminder goes with it, occurrences and all.
--
-- NULL is the normal case and means exactly what it meant before this column
-- existed: a free-standing reminder the owner asked for directly, delivered to
-- their DM.
ALTER TABLE reminders ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;

CREATE INDEX ix_reminders_task ON reminders(task_id, status) WHERE task_id IS NOT NULL;
`,
  },
  {
    version: 23,
    name: 'native_thread_conversations',
    sql: `
-- Native Discord threads as durable conversations (issue #4).
--
-- Four tables, and the reason there are four rather than one wide one is that
-- they have four different lifetimes and four different privacy stories.
--
-- Additive in full: \`conversation_turns\` is untouched, and no legacy row is
-- reinterpreted. A conversation that happened in a parent channel before this
-- migration keeps its old thread_key and is NOT retroactively claimed as the
-- history of a child thread -- the two are different conversations and merging
-- them would replay words from one into the other.
CREATE TABLE conversation_threads (
  -- Discord's own thread id, which is also the conversation's thread_key in
  -- \`conversation_turns\`. One id, so a lookup never has to translate.
  thread_id          TEXT PRIMARY KEY,
  parent_channel_id  TEXT NOT NULL,
  guild_id           TEXT NOT NULL,
  -- The message the thread was started FROM. UNIQUE is the idempotency
  -- guarantee: two concurrent starters for one message cannot both create a
  -- thread, and a retry after a crash finds the existing row instead of
  -- starting a second conversation.
  starter_message_id TEXT NOT NULL UNIQUE,
  started_by         TEXT NOT NULL,
  origin             TEXT NOT NULL CHECK (origin IN ('starter','branch')),
  -- Set only for a branch, and only to the thread the anchor came from. It
  -- records provenance; it is never a path context can be read along.
  branched_from      TEXT,
  created_at         TEXT NOT NULL,
  -- Set when the thread is gone from Discord or deliberately closed. Retention
  -- consults this and nothing else: a LIVE thread keeps its full transcript.
  closed_at          TEXT
);
CREATE INDEX ix_conversation_threads_parent ON conversation_threads(parent_channel_id);
CREATE INDEX ix_conversation_threads_closed ON conversation_threads(closed_at);

-- Who has actually taken part in a thread.
--
-- EXPLICIT participation, written when somebody speaks, and the only thing
-- that can produce a proof for a thread-scoped read. Being able to SEE a
-- thread is not being in it: a reader who never spoke has no row here and
-- therefore no way to have its context replayed to them.
CREATE TABLE conversation_participants (
  thread_id       TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  PRIMARY KEY (thread_id, discord_user_id)
);

-- The bounded model context, kept apart from the transcript on purpose.
--
-- Compaction writes HERE and never deletes a turn. That separation is the
-- whole point: the application keeps everything that was said, the provider is
-- handed a summary plus the recent turns, and the owner can be told truthfully
-- that compacting removed nothing.
CREATE TABLE conversation_checkpoints (
  thread_id     TEXT PRIMARY KEY,
  summary       TEXT NOT NULL,
  -- The rowid of the newest turn the summary covers. Turns after it are the
  -- ones still replayed verbatim.
  through_rowid INTEGER NOT NULL,
  turns_covered INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The provider session identities this instance has caused to exist.
--
-- Ducky cannot delete an OpenClaw session (no supported, probed deletion
-- surface exists -- see ADR 0024), so the honest alternative is to stop using
-- a contaminated one. The epoch is folded into the provider's session key, so
-- bumping it produces a different session rather than clearing the old one.
--
-- One row per (thread_key, user) because a SHARED thread contaminates one
-- provider session PER ACTOR, and forgetting the thread has to address every
-- one of them rather than only the person who asked.
CREATE TABLE conversation_provider_sessions (
  thread_key      TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  epoch           INTEGER NOT NULL DEFAULT 0,
  rotated_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (thread_key, discord_user_id)
);
CREATE INDEX ix_conversation_provider_sessions_user
  ON conversation_provider_sessions(discord_user_id);

-- The Discord message a turn came from, so an ANCHOR can be resolved.
--
-- Nullable, and null for every row written before this and for every
-- assistant turn: a reply Ducky sent has no id at the moment it is recorded,
-- and inventing one would make "that message" ambiguous. A Branch control
-- carries a message id, and the only thing it can resolve to is a turn in the
-- thread the presser holds a participation proof for -- so an anchor cannot be
-- used to reach a conversation somebody is not in.
ALTER TABLE conversation_turns ADD COLUMN message_id TEXT;
CREATE INDEX ix_conversation_turns_message
  ON conversation_turns(thread_key, message_id);
`,
  },
  {
    version: 24,
    name: 'agent_threads',
    sql: `
-- The repository-workflow binding for one Discord thread (issue #7).
--
-- ONE ROW PER (owner, thread), replaced in place. That shape is the whole
-- design, not an optimisation:
--
--   * A thread is a conversation, and a conversation is about one repository
--     at a time. Binding once and rebinding on an explicit change is what lets
--     $ticket and $agentize act without guessing a target -- and guessing a
--     target means pointing a real agent at the wrong working tree.
--   * One row cannot grow. There is no per-message append anywhere here except
--     \`intent_notes\`, which is a JSON array the repository itself truncates,
--     so a long grill costs a bounded amount of storage rather than a
--     transcript.
--   * The CURRENT card lives on the same row, so a restart can find the
--     message it was editing. A thread has at most one workflow command in
--     flight, exactly as it has at most one pending intent proposal.
--
-- \`checkout_root\` is a host filesystem path and is NEVER rendered: Discord
-- supplies a repository name and gets a repository name back, here as
-- everywhere else in this codebase.
CREATE TABLE agent_threads (
  discord_user_id  TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  -- \`owner/name\`, the only repository form the installed contract accepts.
  repository       TEXT,
  checkout_root    TEXT,
  grilling         INTEGER NOT NULL DEFAULT 0,
  grill_started_at TEXT,
  -- The owner's OWN words, bounded and truncated by the repository. Nothing
  -- Ducky generated, and nothing the model said.
  intent_notes     TEXT NOT NULL DEFAULT '[]',
  -- The canonical TicketSpec id for this thread's publication. Minted once and
  -- REUSED on every retry, which is what makes a retry enrich the same issue
  -- instead of opening a second one.
  ticket_uuid      TEXT,
  issue_number     INTEGER,
  issue_url        TEXT,
  run_id           TEXT,
  run_command      TEXT
    CHECK (run_command IS NULL OR run_command IN ('$grill-me','$ticket','$agentize')),
  run_status       TEXT
    CHECK (run_status IS NULL OR run_status IN
      ('scanning','grilling','publishing','published','queued','onboarding','onboarded',
       'needs_input','failed','cancelled')),
  run_detail       TEXT,
  run_ready        INTEGER NOT NULL DEFAULT 0,
  run_queued       INTEGER NOT NULL DEFAULT 0,
  run_started_at   TEXT,
  run_finished_at  TEXT,
  card_channel_id  TEXT,
  card_message_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, thread_key)
);

-- The card controls carry the run id, so pressing one has to find its row.
CREATE INDEX ix_agent_threads_run ON agent_threads(run_id) WHERE run_id IS NOT NULL;
`,
  },
  {
    version: 25,
    name: 'agent_run_queue_state',
    sql: `
-- \`run_queued\` was a BOOLEAN, and a boolean cannot say "I do not know".
--
-- The installed publisher applies \`agent:ready\` and THEN reads it back. A
-- failure after that write -- a read-back error, a network fault, our own
-- subprocess timeout, a coordinator that died mid-call -- leaves a state where
-- the label may well be on the issue and nothing here can tell. The boolean
-- made every one of those read as false, so the card and the Details view both
-- asserted "nothing was queued" about the one label that authorizes an agent
-- to start work. A false negative there is worse than no answer: the owner
-- stops looking.
--
-- Four states, because there are four genuinely different things to say:
--   not_requested -- the owner did not ask. No label was attempted.
--   not_queued    -- the run failed BEFORE any label could be written.
--   queued        -- applied AND verified on the issue by the publisher.
--   unknown       -- the attempt may have landed. Go and look.
--
-- A rebuild rather than an ALTER: the boolean has to go, or the next reader
-- gets two sources of truth and picks the convenient one. Nothing carries a
-- foreign key to agent_threads (checked), so dropping it breaks no child.
--
-- Existing rows map exactly: a true becomes \`queued\`, and a false becomes
-- \`not_requested\` or \`not_queued\` depending on whether the owner had asked.
-- No row is invented into \`unknown\`: that state is a report about a specific
-- failure, and backfilling it would be claiming doubt nobody observed.
CREATE TABLE agent_threads_v2 (
  discord_user_id  TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  repository       TEXT,
  checkout_root    TEXT,
  grilling         INTEGER NOT NULL DEFAULT 0,
  grill_started_at TEXT,
  intent_notes     TEXT NOT NULL DEFAULT '[]',
  ticket_uuid      TEXT,
  issue_number     INTEGER,
  issue_url        TEXT,
  run_id           TEXT,
  run_command      TEXT
    CHECK (run_command IS NULL OR run_command IN ('$grill-me','$ticket','$agentize')),
  run_status       TEXT
    CHECK (run_status IS NULL OR run_status IN
      ('scanning','grilling','publishing','published','queued','onboarding','onboarded',
       'needs_input','failed','cancelled')),
  run_detail       TEXT,
  run_ready        INTEGER NOT NULL DEFAULT 0,
  run_queue_state  TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (run_queue_state IN ('not_requested','not_queued','queued','unknown')),
  run_started_at   TEXT,
  run_finished_at  TEXT,
  card_channel_id  TEXT,
  card_message_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, thread_key)
);

INSERT INTO agent_threads_v2
  (discord_user_id, thread_key, repository, checkout_root, grilling, grill_started_at,
   intent_notes, ticket_uuid, issue_number, issue_url, run_id, run_command, run_status,
   run_detail, run_ready, run_queue_state, run_started_at, run_finished_at,
   card_channel_id, card_message_id, created_at, updated_at)
  SELECT discord_user_id, thread_key, repository, checkout_root, grilling, grill_started_at,
         intent_notes, ticket_uuid, issue_number, issue_url, run_id, run_command, run_status,
         run_detail, run_ready,
         CASE WHEN run_queued = 1 THEN 'queued'
              WHEN run_ready = 1 THEN 'not_queued'
              ELSE 'not_requested' END,
         run_started_at, run_finished_at,
         card_channel_id, card_message_id, created_at, updated_at
    FROM agent_threads;

DROP TABLE agent_threads;
ALTER TABLE agent_threads_v2 RENAME TO agent_threads;

CREATE INDEX ix_agent_threads_run ON agent_threads(run_id) WHERE run_id IS NOT NULL;
`,
  },
  {
    version: 26,
    name: 'agent_published_ticket',
    sql: `
-- The SETTLED ticket this thread last published, kept so the owner can
-- authorize it without retyping it.
--
-- The issue requires a two-step: a bare $ticket creates unqueued GitHub work,
-- and $ticket --ready SEPARATELY authorizes queueing. The second step has to
-- reach the issue the first one made -- same canonical id, same spec, same
-- issue number -- because the installed publisher refuses to change the
-- execution contract of an authorized issue, and because a rebuilt spec is a
-- different ticket wearing the same description.
--
-- This is DELIBERATELY a different slot from \`ticket_uuid\`/\`issue_number\`.
-- Those are the binding for retrying a publication that has NOT succeeded, and
-- conflating the two is exactly the defect migration 23's generation of this
-- work had to fix: a settled ticket left in the retry slot meant the next,
-- different $ticket inherited it and rewrote a published issue.
--
--   ticket_uuid / issue_number -> "this attempt has not landed yet"
--   published_*                -> "this thread has a finished, unqueued ticket"
--
-- The spec is the owner's own words, bounded by the note caps that built it,
-- one row per thread, replaced in place. It is removed with the row by
-- /forget conversation, exactly as the notes are.
ALTER TABLE agent_threads ADD COLUMN published_spec TEXT;
ALTER TABLE agent_threads ADD COLUMN published_issue INTEGER;
ALTER TABLE agent_threads ADD COLUMN published_url TEXT;
-- Whether that publication already carries the exact agent:ready label, so a
-- second authorization is answered rather than attempted.
ALTER TABLE agent_threads ADD COLUMN published_queued INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 27,
    name: 'github_feed',
    sql: `
-- The GitHub feed: actionable events as they are observed, and a daily digest of
-- default-branch commits. A SECOND reader beside \`github_watches\`, with its own
-- identity, because the two answer different questions: a watch is "tell me when
-- this allowlisted repository's snapshot moves", the feed is "tell me the few
-- things I have to decide about, wherever they are".
--
-- NOTHING here references \`repos\`. A selected repository is an owner/repo
-- identity, not an allowlist entry: being watched must never make a repository
-- a job target, and a foreign key to \`repos\` would have forced exactly that.

-- The selected list. \`active\` repositories are observed; \`cancelled\` ones are
-- kept as a TOMBSTONE, because the row is what stops a later reconcile from
-- re-selecting something that was deliberately taken off the list.
CREATE TABLE github_feed_repos (
  repo_key       TEXT PRIMARY KEY,
  display        TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('seed','explicit')),
  state          TEXT NOT NULL CHECK (state IN ('active','cancelled')),
  default_branch TEXT,
  -- Set when the commit walk could not reach its previous head (a force-push or
  -- more new commits than the walk is allowed to read). Disclosed in the next
  -- digest, then cleared.
  commit_gap_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  cancelled_at   TEXT
);

-- One row per (scope, kind) unit of observation. \`scope\` is a repo_key, or the
-- literal '@me' for cross-repository review-request discovery.
--
-- \`baselined_at\` is NULL until a read of THIS kind SUCCEEDED and its history was
-- recorded as already-seen. That is what stops a failed read from becoming an
-- empty baseline: an unreadable repository has no row that says "history seen".
-- Failures and backoff live here too, per kind, so one kind failing delays only
-- itself.
CREATE TABLE github_feed_cursors (
  scope           TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('prs','issues','runs','checks','commits','review_requests')),
  baselined_at    TEXT,
  cursor          TEXT,
  meta            TEXT,
  next_check_at   TEXT NOT NULL,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_success_at TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (scope, kind)
);
CREATE INDEX ix_github_feed_cursors_due ON github_feed_cursors(next_check_at);

-- Every event ever observed, once. \`event_key\` is the identity, and its UNIQUE
-- constraint IS the deduplication: a repeated poll, an overlapping tick and a
-- restart all collide on it. 'baseline' rows are history seen at first watch;
-- they are never delivered, and exist so that history cannot be news later.
CREATE TABLE github_feed_events (
  id              TEXT PRIMARY KEY,
  event_key       TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('pr_opened','issue_opened','review_requested','changes_requested','check_failed')),
  repo_key        TEXT NOT NULL,
  origin          TEXT NOT NULL CHECK (origin IN ('selected','discovery')),
  card_json       TEXT,
  status          TEXT NOT NULL CHECK (status IN ('baseline','pending','delivered','abandoned','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  delivered_at    TEXT,
  delivered_to    TEXT CHECK (delivered_to IS NULL OR delivered_to IN ('github_channel','owner_dm')),
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_github_feed_events_pending
  ON github_feed_events(created_at) WHERE status = 'pending';
CREATE INDEX ix_github_feed_events_settled
  ON github_feed_events(created_at) WHERE status IN ('delivered','abandoned','skipped');

-- Default-branch commits, recorded as they are walked, until a digest consumes
-- them. (repo, sha) is the identity, so a commit is one row however many times
-- it is read, and a direct push is exactly as visible as a merged pull request.
CREATE TABLE github_feed_commits (
  repo_key        TEXT NOT NULL,
  sha             TEXT NOT NULL,
  branch          TEXT NOT NULL,
  headline        TEXT NOT NULL,
  author          TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_target TEXT CHECK (consumed_target IS NULL OR consumed_target IN ('github_channel','owner_dm')),
  PRIMARY KEY (repo_key, sha)
);
CREATE INDEX ix_github_feed_commits_open
  ON github_feed_commits(repo_key, committed_at) WHERE consumed_at IS NULL;
CREATE INDEX ix_github_feed_commits_consumed
  ON github_feed_commits(consumed_at) WHERE consumed_at IS NOT NULL;

-- The daily digest slot ledger. One row per (owner, local day, target): the
-- unique index makes claiming idempotent across ticks, overlapping passes and a
-- restart, exactly as \`briefing_deliveries\` does. A stale slot is \`skipped\`,
-- a record rather than a deletion; the commits it would have carried stay open.
CREATE TABLE github_feed_digests (
  id              TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  day_key         TEXT NOT NULL,
  target          TEXT NOT NULL CHECK (target IN ('github_channel','owner_dm')),
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','delivered','abandoned','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  delivered_at    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_github_feed_digests_slot
  ON github_feed_digests(discord_user_id, day_key, target);
CREATE INDEX ix_github_feed_digests_pending
  ON github_feed_digests(due_at) WHERE status = 'pending';
CREATE INDEX ix_github_feed_digests_settled
  ON github_feed_digests(created_at) WHERE status <> 'pending';
`,
  },
  {
    version: 28,
    name: 'engineering_admission',
    sql: `
-- Ducky-wide engineering admission: at most ONE job may hold an executor
-- attempt (or an unconfirmed stop of one) at a time, across every repository.
--
-- SCOPE, stated exactly: this row lives in ONE coordinator database, so it is
-- global across the repositories and executors that coordinator serves and
-- nowhere else. A second profile (development against production), another
-- coordinator, or the separate agent-flow dispatcher each have their own state
-- and cannot see it. Cross-program admission is NOT provided by this table.
--
-- The single row is structural, not a convention: the primary key is pinned to
-- 1, so a second concurrent holder is a constraint violation and not a bug a
-- predicate has to catch. It is released only on proof the attempt is
-- quiescent; an uncertain stop (lease expiry, orphaned agent) converts it to
-- \`unconfirmed_stop\` and it then outlives the attempt until the same job
-- reclaims it or the owner clears the orphan.
CREATE TABLE engineering_admission (
  slot        INTEGER PRIMARY KEY CHECK (slot = 1),
  job_id      TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  repo_slug   TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('active_attempt','unconfirmed_stop'))
);

-- The instant a claimed attempt must stop. Set at claim and KEPT across a
-- lease-expiry reclaim, so a restart cannot grant a fresh budget; cleared when
-- the attempt ends in a pause or a terminal state.
ALTER TABLE jobs ADD COLUMN attempt_deadline_at TEXT;
`,
  },
  {
    version: 29,
    name: 'pause_delivery',
    sql: `
-- Durable pause delivery (protocol 1). See ADR 0030.
--
-- Whether the claim that is running NOW negotiated the protocol. It is set at
-- claim and read at lease expiry: only a negotiated lease has its expiry charge
-- deferred. 0 is the ordinary path and every row that existed before this
-- migration.
ALTER TABLE jobs ADD COLUMN delivery_protocol INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_protocol IN (0, 1));

-- One structured row per EXPIRED lease, written in the expiry transaction. It
-- holds the original attempt's identity (lease digest, executor, workspace and
-- agent snapshot) and its accounting, so a later bound report can find exactly
-- the attempt it describes without parsing a reason string.
--
--   charge_state 'deferred'    the expiry charged nothing yet; it is charged when
--                              the job is claimed again, or never if a bound
--                              report reconciles it first;
--   charge_state 'charged'     attempts + 1 was applied (ordinary path);
--   charge_state 'not_charged' a bound report reconciled it with no charge.
--
-- A row is only ever 'pending' while the job is still in waiting_for_executor
-- holding its repository, its slot (as an unconfirmed stop) and its workspace.
CREATE TABLE job_lease_expiries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  lease_digest      TEXT NOT NULL,
  executor_id       TEXT NOT NULL,
  workspace_id      TEXT,
  agent_name        TEXT,
  attempts_before   INTEGER NOT NULL,
  delivery_protocol INTEGER NOT NULL CHECK (delivery_protocol IN (0, 1)),
  charge_state      TEXT NOT NULL CHECK (charge_state IN ('deferred','charged','not_charged')),
  disposition       TEXT NOT NULL CHECK (disposition IN (
    'pending','charged','exhausted','cancelled','failed','paused',
    'overtaken_cancelled','overtaken_timed_out'
  )),
  created_at        TEXT NOT NULL,
  settled_at        TEXT,
  UNIQUE (job_id, lease_digest)
);
CREATE INDEX idx_job_lease_expiries_pending ON job_lease_expiries(job_id) WHERE disposition = 'pending';

-- One row per COMMITTED pause report, keyed by the executor's report id. It is
-- what makes delivery idempotent: a repeat of the same report answers the same
-- way after the lease is gone, after an owner resume, after a coordinator
-- restart, and mutates nothing.
CREATE TABLE job_pause_receipts (
  report_id    TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  executor_id  TEXT NOT NULL,
  lease_digest TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_name   TEXT NOT NULL,
  cause        TEXT NOT NULL,
  disposition  TEXT NOT NULL CHECK (disposition IN ('paused','overtaken_cancelled','overtaken_timed_out')),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_job_pause_receipts_job ON job_pause_receipts(job_id);
`,
  },
  {
    version: 30,
    name: 'shared_admission',
    sql: `
-- Shared engineering admission (ADR 0031). The host-local ledger is the
-- cross-program fence; these are the coordinator's durable halves of it.
--
-- The exact identity of the shared hold this job's local slot stands on. Both
-- NULL for a slot taken without a ledger (isolated fixtures only: a runtime
-- refuses to claim without one). The fence is never reused, which is what lets a
-- delayed release of an old generation be harmless.
ALTER TABLE engineering_admission ADD COLUMN shared_ledger_id TEXT;
ALTER TABLE engineering_admission ADD COLUMN shared_fence INTEGER;

-- What this database pinned about the ledger on first use, and the durable
-- identity it presents as a holder. Written once; a ledger that later differs
-- (replaced, restored, re-policied) stops engineering. It is never silently
-- re-pinned, and nothing here is a secret.
CREATE TABLE shared_admission_binding (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL CHECK (length(instance_id) BETWEEN 8 AND 80),
  ledger_id   TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  bound_at    TEXT NOT NULL
);
CREATE TRIGGER shared_admission_binding_fixed_u BEFORE UPDATE ON shared_admission_binding
BEGIN SELECT RAISE(ABORT, 'binding_fixed'); END;
CREATE TRIGGER shared_admission_binding_fixed_d BEFORE DELETE ON shared_admission_binding
BEGIN SELECT RAISE(ABORT, 'binding_fixed'); END;

-- Written in the SAME transaction that deletes a local slot, delivered only
-- after that commit, and retried after a restart. A crash between the two leaves
-- the shared hold in place (conservative: capacity is never created by a crash).
-- Keyed by the exact ledger and fence, so a delayed delivery can only ever name
-- the generation that was released locally, never a newer one.
CREATE TABLE shared_release_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id    TEXT NOT NULL,
  fence        INTEGER NOT NULL,
  job_id       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT,
  UNIQUE (ledger_id, fence)
);
`,
  },
];
