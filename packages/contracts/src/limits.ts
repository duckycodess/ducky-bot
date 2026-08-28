/** Every bound in the system lives here so a change is visible in one diff. */

// ---- result contract bounds -------------------------------------------------
export const RESULT_MAX_BYTES = 128 * 1024;
export const MAX_SUMMARY = 4000;
export const MAX_CHANGED_FILES = 500;
export const MAX_PATH_LEN = 512;
export const MAX_REVIEW_NOTES = 2000;
export const MAX_VERIFY_COMMANDS = 50;
export const MAX_VERIFY_CMD = 512;
export const MAX_VERIFY_SUMMARY = 1000;
export const MAX_PROPOSED_ACTIONS = 10;
export const MAX_ACTION_DESCRIPTION = 500;
export const MAX_COMMIT_MESSAGE = 2000;
export const MAX_PR_TITLE = 256;
export const MAX_PR_BODY = 5000;
export const MAX_QUESTION = 2000;
export const MAX_ANSWER = 2000;
export const MAX_PROGRESS_MESSAGE = 500;

// ---- discord bounds (assumption H3; enforced defensively) -------------------
export const DISCORD_CONTENT_MAX = 2000;
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESC_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_FIELDS_MAX = 25;
export const EMBED_FOOTER_MAX = 2048;
export const EMBED_TOTAL_MAX = 6000;
export const CUSTOM_ID_MAX = 100;
export const ACTION_ROWS_MAX = 5;
export const BUTTONS_PER_ROW_MAX = 5;
export const TRUNCATION_MARKER = '…[truncated]';

// ---- input bounds -----------------------------------------------------------
export const CAPTURE_MIN = 1;
export const CAPTURE_MAX = 2000;
export const TASK_MAX = 4000;
export const CONTEXT_MAX = 4000;
export const INBOX_PAGE_SIZE = 10;

// ---- job / lifecycle --------------------------------------------------------
export const DEFAULT_MAX_ATTEMPTS = 1;
export const MAX_OWNER_INPUT_ROUNDS = 3;
export const LEASE_TTL_MS = 5 * 60_000;
export const LEASE_HEARTBEAT_MS = 30_000;
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000;
export const JOB_MAX_WALL_CLOCK_MS = 2 * 60 * 60_000;
export const RECOVERY_WAIT_MS = 15 * 60_000;
export const EXECUTOR_OFFLINE_AFTER_MS = 3 * 60_000;

/**
 * How long a dependency wait may last, and how often it may be checked.
 *
 * Every one of these is a CEILING, not a default: an executor proposes a
 * schedule and the coordinator clamps it. There is no configuration that makes
 * a dependency wait unbounded, because the reservation it holds blocks the
 * repository for as long as it lasts.
 */
export const DEPENDENCY_MAX_WAIT_MS = 24 * 60 * 60_000;
export const DEPENDENCY_DEFAULT_WAIT_MS = 6 * 60 * 60_000;
export const DEPENDENCY_MIN_CHECK_INTERVAL_MS = 30_000;
export const DEPENDENCY_DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
export const DEPENDENCY_MAX_CHECKS = 100;
export const DEPENDENCY_DEFAULT_MAX_CHECKS = 24;
/** Exponential, from the first interval, capped. Deterministic: no jitter. */
export const DEPENDENCY_BACKOFF_FACTOR = 2;
export const DEPENDENCY_BACKOFF_MAX_MS = 60 * 60_000;
/** How many dependencies one reconciliation tick will ever check. */
export const DEPENDENCY_CHECK_BATCH = 20;
export const DEPENDENCY_CHECK_TIMEOUT_MS = 15_000;
export const DEPENDENCY_DESCRIPTION_MAX = 500;
export const DEPENDENCY_EXTERNAL_KEY_MAX = 200;
export const DEPENDENCY_DETAIL_MAX = 300;

/** Reservation TTL per job state. `null` means "never expires" (orphan_agent). */
export const RESERVATION_TTL_MS: Record<string, number | null> = {
  queued: 24 * 60 * 60_000,
  waiting_for_executor: 24 * 60 * 60_000,
  running: 24 * 60 * 60_000,
  needs_owner_input: 24 * 60 * 60_000,
  // must outlive the approvals themselves so the normal expiry path runs first
  needs_approval: APPROVAL_TTL_MS + 60 * 60_000,
  // must outlive the longest dependency wait, or the reservation sweep would
  // fail a job that was still legitimately waiting and still on schedule
  waiting_on_dependency: DEPENDENCY_MAX_WAIT_MS + 60 * 60_000,
};

// ---- schedule ---------------------------------------------------------------
export const PENDING_SCHEDULE_TTL_MS = 30 * 60_000;
export const MAX_PENDING_DRAFTS_PER_OWNER = 20;
export const SCHEDULE_MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const SCHEDULE_ATTACHMENT_TIMEOUT_MS = 15_000;
export const SCHEDULE_ATTACHMENTS_PER_HOUR = 20;
export const SCHEDULE_MAX_ENTRIES = 100;
export const BINARY_SNIFF_BYTES = 8192;

// ---- auth -------------------------------------------------------------------
export const CLOCK_SKEW_MS = 120_000;
export const NONCE_TTL_MS = 2 * CLOCK_SKEW_MS;
export const MIN_SECRET_BYTES = 32;
export const CREDENTIAL_RELOAD_MS = 60_000;

// ---- http / rate limits -----------------------------------------------------
export const HTTP_BODY_LIMIT = 256 * 1024;
export const HTTP_REQUEST_TIMEOUT_MS = 40_000;
export const HTTP_KEEPALIVE_TIMEOUT_MS = 30_000;
export const HTTP_CONNECTION_TIMEOUT_MS = 35_000;
export const CLAIM_MAX_WAIT_MS = 25_000;

export const RATE_LIMITS = {
  heartbeat: { max: 120, windowMs: 60_000 },
  claim: { max: 120, windowMs: 60_000 },
  jobHeartbeat: { max: 120, windowMs: 60_000 },
  result: { max: 10, windowMs: 60_000 },
  cancelAck: { max: 10, windowMs: 60_000 },
  unauthenticated: { max: 600, windowMs: 60_000 },
} as const;

export const COMMAND_BUCKETS = {
  capture: { max: 30, windowMs: 60_000 },
  schedule: { max: 10, windowMs: 60_000 },
  jobSubmit: { max: 5, windowMs: 60_000 },
  jobRead: { max: 20, windowMs: 60_000 },
  interaction: { max: 60, windowMs: 60_000 },
  /** /task, /reminder and /briefing. Owner-only, so this is self-protection. */
  assistant: { max: 30, windowMs: 60_000 },
} as const;

// ---- subprocess -------------------------------------------------------------
export const SUBPROCESS_CONCURRENCY = 4;
export const SUBPROCESS_MAX_BUFFER = 4 * 1024 * 1024;
export const GH_TIMEOUT_MS = 20_000;
export const HERDR_TIMEOUT_MS = 30_000;
export const GIT_TIMEOUT_MS = 20_000;

// ---- herdr ------------------------------------------------------------------
/**
 * Extra subprocess budget on top of the timeout handed to `herdr` itself.
 *
 * `herdr agent prompt --wait --timeout <t>` is expected to run for up to `t`.
 * The process that hosts it must therefore outlive `t`, or `execFile` SIGTERMs
 * a healthy wait and the caller sees an outage while a real Pi agent is still
 * writing. The grace covers herdr's own teardown and JSON flush; it is not a
 * second timeout, and it must never be the smaller of the two.
 */
export const HERDR_PROMPT_GRACE_MS = 30_000;
/**
 * Interactive-readiness budget for `herdr agent start`.
 *
 * Herdr's own default is 30 s and its documented ceiling is 300 s. A cold Pi
 * start on this host can exceed 30 s, so the value is sent explicitly rather
 * than inherited, and the subprocess budget is derived from it the same way
 * the prompt's is.
 */
export const HERDR_START_TIMEOUT_MS = 120_000;
/**
 * How long to wait for an agent's OWN pane to show that it can take input.
 *
 * `agent start` returning with `agent_status: idle, interactive_ready: true`
 * does not mean Pi has finished painting its startup banners, and a prompt
 * submitted in that window is silently dropped -- which is the documented cause
 * of every `agent_prompt_stalled` failure on this host. Herdr's own readiness
 * field is the thing that is wrong, so readiness is corroborated by reading the
 * agent's terminal snapshot and looking for its interactive chrome.
 *
 * This is a budget for an OBSERVATION, not a sleep: the marker usually appears
 * within a second or two and the wait ends there. When it never appears the
 * orchestrator falls back to Herdr's own signal rather than refusing the job,
 * so a host whose agent chrome we do not recognise behaves exactly as it did
 * before.
 */
export const HERDR_READY_MARKER_WAIT_MS = 45_000;
/** Lines of terminal snapshot to read when looking for that chrome. */
export const HERDR_READ_SNAPSHOT_LINES = 60;
/** Hard cap on a snapshot read. A pane is untrusted, unbounded output. */
export const HERDR_READ_MAX_BYTES = 64 * 1024;
/**
 * How long a phase report may wait to be coalesced into one heartbeat.
 *
 * A phase that only rode the regular `LEASE_HEARTBEAT_MS` beat could take 30
 * seconds to become visible, which makes the whole engineering-loop display
 * useless on short turns. Small enough to look immediate, large enough that a
 * burst of reports costs one request rather than four.
 */
export const PHASE_REPORT_DEBOUNCE_MS = 2_000;
/** Longest phase-file value we will read; anything larger is not a phase word. */
export const PHASE_FILE_MAX_BYTES = 64;
export const HERDR_WORKSPACE_TTL_MS = 24 * 60 * 60_000;
export const DUCKY_AGENT_PREFIX = 'ducky-pi-';
export const DUCKY_WORKSPACE_LABEL_PREFIX = 'ducky-mgd:';
/** Herdr agent names must match [a-z][a-z0-9_-]{0,31}; the prefix eats 9 chars. */
export const MAX_SLUG_KEY_LEN = 22;

// ---- daily assistant: tasks -------------------------------------------------
export const TASK_TITLE_MIN = 1;
export const TASK_TITLE_MAX = 200;
/** How much of a typed time expression is ever read. Bounds the parser's work. */
export const WHEN_INPUT_MAX = 64;
export const TASK_LIST_PAGE_SIZE = 20;
/** Open tasks only. Done and cancelled rows are history and are not counted. */
export const MAX_OPEN_TASKS_PER_OWNER = 500;

// ---- daily assistant: reminders --------------------------------------------
export const REMINDER_TEXT_MIN = 1;
export const REMINDER_TEXT_MAX = 500;
export const REMINDER_LIST_PAGE_SIZE = 20;
export const MAX_SCHEDULED_REMINDERS_PER_OWNER = 100;

/**
 * Recurrence is a FIXED interval with an explicit occurrence count -- never a
 * cron expression and never open-ended. Both bounds are enforced at input, so
 * no stored reminder can describe an unbounded or a pathologically tight loop.
 */
export const REMINDER_MIN_INTERVAL_MINUTES = 5;
export const REMINDER_MAX_INTERVAL_MINUTES = 365 * 24 * 60;
export const REMINDER_MIN_OCCURRENCES = 2;
export const REMINDER_MAX_OCCURRENCES = 100;
export const REMINDER_DEFAULT_OCCURRENCES = 10;
/** A reminder may not be scheduled further out than this. */
export const REMINDER_MAX_HORIZON_MS = 5 * 365 * 24 * 60 * 60_000;

/**
 * Assistant tick bounds. Each sweep materializes at most this many reminders
 * and delivers at most this many occurrences, so a long outage drains over
 * several ticks instead of one unbounded pass.
 */
export const REMINDER_MATERIALIZE_BATCH = 50;
export const REMINDER_DELIVERY_BATCH = 25;
/**
 * After this many failed delivery attempts an occurrence is abandoned rather
 * than retried forever. Recorded, never silently dropped.
 */
export const REMINDER_MAX_DELIVERY_ATTEMPTS = 8;

// ---- daily assistant: briefing ---------------------------------------------
/**
 * Per section, so a briefing cannot outgrow one Discord embed. Anything beyond
 * it is reported as a count -- the briefing says how many it did not list
 * rather than quietly dropping them.
 */
export const BRIEFING_SECTION_MAX = 10;

// ---- conversation attachments (2C) -----------------------------------------
/**
 * Bytes are only ever fetched for a provider that is BOTH verified and
 * attachment-capable, and only when the operator has opted in. These are the
 * ceilings that apply once all of that is true; the effective cap is the
 * smaller of this and whatever the provider itself declares.
 */
export const CONVERSATION_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const CONVERSATION_ATTACHMENT_TIMEOUT_MS = 20_000;
export const CONVERSATION_ATTACHMENTS_PER_HOUR = 20;
/** One at a time. Several files in one message is refused, never partly read. */
export const CONVERSATION_MAX_ATTACHMENTS_PER_MESSAGE = 1;

/**
 * Conversation continuity, when the operator has enabled it.
 *
 * Every bound here is small on purpose. Stored turns are the owner's own words:
 * the useful amount is "enough that a follow-up question makes sense", and
 * anything past that is a transcript nobody asked for. A turn longer than the
 * cap is stored truncated rather than dropped, so the record never silently
 * omits half of what was said.
 */
export const CONVERSATION_MEMORY_TURNS_DEFAULT = 10;
export const CONVERSATION_MEMORY_TURNS_MAX = 40;
export const CONVERSATION_TURN_TEXT_MAX = 2_000;
/** Hard ceiling per (user, thread), enforced in the same transaction as a write. */
export const CONVERSATION_THREAD_ROW_CAP = 200;

// ---- GitHub watches ---------------------------------------------------------
/** Explicit owner watches are ongoing schedules, never a hidden tight loop. */
export const GITHUB_WATCH_INTERVAL_MIN_MINUTES = 15;
export const GITHUB_WATCH_INTERVAL_MAX_MINUTES = 24 * 60;
export const MAX_GITHUB_WATCHES_PER_OWNER = 20;
export const GITHUB_WATCH_BATCH = 5;
export const GITHUB_WATCH_EVENT_BATCH = 20;
export const GITHUB_WATCH_MAX_PR_CHECKS = 5;
export const GITHUB_WATCH_SUMMARY_MAX = 1200;
export const GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS = 8;

// ---- audit log --------------------------------------------------------------
/** Every free-text audit detail is redacted and then clamped to this. */
export const AUDIT_DETAIL_MAX = 300;
export const AUDIT_SUBJECT_REF_MAX = 128;
/** Rows older than this are pruned by the reconciler, so the table is bounded. */
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const AUDIT_PRUNE_BATCH = 500;
