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
];
