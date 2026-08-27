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
];
