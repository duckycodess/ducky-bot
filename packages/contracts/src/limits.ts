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

/**
 * `ownerOnly` says whether a bucket can be charged by anyone but the owner.
 *
 * It is declared rather than assumed, because the assumption stopped being
 * true. Every bucket was owner-only once, and the audit sink relied on that to
 * record a rate limit as the OWNER's without being told who hit it. Issue #4
 * gave a conversation participant two controls and a thread, so `interaction`
 * and `threadCreate` are now reachable by the configured chat user -- and an
 * audit row attributing their rate limit to the owner would be a false record.
 *
 * A new bucket therefore has to state its position. None of this is an
 * authorization control: authorization has already happened by the time a
 * bucket is charged, and a limit contains accidents.
 */
export const COMMAND_BUCKETS = {
  capture: { max: 30, windowMs: 60_000, ownerOnly: true },
  schedule: { max: 10, windowMs: 60_000, ownerOnly: true },
  jobSubmit: { max: 5, windowMs: 60_000, ownerOnly: true },
  jobRead: { max: 20, windowMs: 60_000, ownerOnly: true },
  /**
   * Every component press. NOT owner-only any more: the conversational
   * controls (Branch, Compact) share it with every owner control.
   */
  interaction: { max: 60, windowMs: 60_000, ownerOnly: false },
  /** /task, /reminder and /briefing. Owner-only, so this is self-protection. */
  assistant: { max: 30, windowMs: 60_000, ownerOnly: true },
  /**
   * Opening a native conversation thread.
   *
   * The only bucket here that guards a WRITE INTO SOMEBODY ELSE'S SYSTEM
   * rather than this one's own work: every thread is an object created in the
   * owner's guild. Discord rate-limits thread creation itself, and being
   * refused by it is a worse outcome than refusing ourselves -- a 429 arrives
   * after the request, costs the bot's shared rate budget, and affects every
   * other call the client is making.
   *
   * Small on purpose. Ten top-level messages a minute in one conversation
   * channel is already unusual; a hundred is a loop, a raid or a
   * misconfiguration, and none of those should be allowed to carpet a channel
   * with threads before anybody notices.
   *
   * NOT owner-only: a configured chat user's message opens a thread exactly as
   * the owner's does, which is the whole point of a shared conversation.
   */
  threadCreate: { max: 10, windowMs: 60_000, ownerOnly: false },
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

// ---- daily assistant: bulk capture and linked reminders --------------------
/**
 * A bulk preview is durable, so it survives the restart that an in-memory
 * draft does not -- which is the whole reason the phone can parse on one
 * request and save on the next. It is still SHORT-lived: it holds the owner's
 * own task text before they have agreed to keep it.
 */
export const TASK_PREVIEW_TTL_MS = 30 * 60_000;
/** Pending previews per owner. A queue of drafts would be a trap, not a feature. */
export const MAX_PENDING_TASK_PREVIEWS_PER_OWNER = 5;
/**
 * How long a SETTLED preview (saved or discarded) is kept.
 *
 * It carries no item text by then -- saving clears it -- only the public ids
 * it produced, which is what makes a double press idempotent instead of a
 * second set of tasks.
 */
export const TASK_PREVIEW_SETTLED_TTL_MS = 24 * 60 * 60_000;
/** Expired previews removed per reconcile pass, so a sweep is never long. */
export const TASK_PREVIEW_SWEEP_BATCH = 100;

/**
 * The default reminders a DEADLINE earns, as offsets before it.
 *
 * Two for a timed deadline, because a day's notice and an hour's notice answer
 * different questions. An offset already in the past is skipped rather than
 * fired immediately: a task saved an hour before it is due must not produce an
 * instant "due in 24 hours" message.
 */
export const TASK_REMINDER_OFFSETS_MS = [24 * 60 * 60_000, 60 * 60_000] as const;
/**
 * When a DATE-ONLY deadline is announced: 08:00 on the day itself, in the
 * owner's zone. A date carries no time, so there is no offset to subtract --
 * and midnight would be a notification nobody reads.
 */
export const TASK_ALL_DAY_REMINDER_HOUR = 8;
/** How long Snooze postpones a notification. The task's own deadline never moves. */
export const TASK_SNOOZE_MINUTES = 60;
/** Cards attached to one bulk save. Discord allows five action rows at most. */
export const TASK_CARDS_PER_MESSAGE = 4;

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

// ---- proactive briefings ----------------------------------------------------
/**
 * How many briefing deliveries one pass will attempt, and how hard it tries.
 *
 * Deliberately tiny: at most two briefings a day exist, so a batch bigger than
 * this is a sign something is wrong rather than a throughput win.
 */
export const BRIEFING_DELIVERY_BATCH = 5;
export const BRIEFING_MAX_DELIVERY_ATTEMPTS = 5;
/**
 * How late a briefing may be delivered before it is dropped as stale.
 *
 * A reminder is never dropped for being late -- it names a commitment. A
 * briefing is a summary OF A DAY, and yesterday's morning briefing delivered
 * this afternoon is worse than none: it describes a day that has already
 * happened. So this one has a staleness window, and the row is kept as a
 * skipped record rather than deleted.
 */
export const BRIEFING_STALE_AFTER_MS = 6 * 60 * 60_000;

// ---- GitHub watches ---------------------------------------------------------
/** Explicit owner watches are ongoing schedules, never a hidden tight loop. */
/**
 * How much of the wider surface one observation records.
 *
 * Every one of these is a slice, not a page cursor: a watch is a summary of what
 * changed, not a mirror of the repository. The `gh` calls are bounded by
 * `--limit` as well, so a large repository costs the same as a small one.
 */
export const GITHUB_WATCH_MAX_RUNS = 10;
export const GITHUB_WATCH_MAX_ISSUES = 20;
/** How many follow-up proposals one observation may enqueue. */
export const GITHUB_WATCH_MAX_FOLLOWUPS = 3;

export const GITHUB_WATCH_INTERVAL_MIN_MINUTES = 15;
export const GITHUB_WATCH_INTERVAL_MAX_MINUTES = 24 * 60;
export const MAX_GITHUB_WATCHES_PER_OWNER = 20;
export const GITHUB_WATCH_BATCH = 5;
export const GITHUB_WATCH_EVENT_BATCH = 20;
export const GITHUB_WATCH_MAX_PR_CHECKS = 5;
export const GITHUB_WATCH_SUMMARY_MAX = 1200;
export const GITHUB_WATCH_MAX_DELIVERY_ATTEMPTS = 8;

// ---- the installed workflow front door (issue #7) ---------------------------
/**
 * Budgets for the installed Agent Flow helper. Every one is a CEILING handed
 * to `runArgv`, which has a mandatory timeout: there is no unbounded helper
 * call anywhere.
 *
 * `inspect` reads a tree and may touch GitHub; `ticket` and `agentize` make
 * real network round trips through `gh` and are given more room, but still a
 * fixed amount. A helper that hangs must fail the command, not the process.
 */
export const FRONTDOOR_READ_TIMEOUT_MS = 60_000;
export const FRONTDOOR_PUBLISH_TIMEOUT_MS = 180_000;
/**
 * Hard cap on helper stdout. The helper answers with small JSON documents;
 * anything larger is a malfunction, and an unbounded read of a subprocess is
 * how a log file becomes a Discord message.
 */
export const FRONTDOOR_MAX_OUTPUT_BYTES = 512 * 1024;
/** How long a thread's grill stays active without a message. */
export const GRILL_SESSION_TTL_MS = 12 * 60 * 60_000;
/**
 * How long a workflow run may be in flight before it is treated as abandoned.
 *
 * A coordinator killed mid-call leaves `run_finished_at` NULL forever, and the
 * single-writer gate then refuses every later command in that thread -- one
 * crash would make the thread permanently unusable. This is the ceiling that
 * ends such a run.
 *
 * Comfortably above `FRONTDOOR_PUBLISH_TIMEOUT_MS` (180 s) and derived from
 * it, because a run that is merely slow must never be swept: the whole point
 * of the gate is that two publication sequences cannot overlap, and expiring a
 * live one would hand that guarantee back.
 */
export const STALE_RUN_AFTER_MS = 10 * FRONTDOOR_PUBLISH_TIMEOUT_MS;
/** How many of the owner's own settled-intent lines a Details view shows. */
export const AGENT_CARD_INTENT_LINES_MAX = 10;
/** Every free-text card field is clamped to this, after it is derived. */
export const AGENT_CARD_DETAIL_MAX = 1_200;

// ---- github feed (actionable events + the daily commit digest) --------------
//
// Every number here exists so that neither a busy repository nor a slow GitHub
// can turn a background observation into an unbounded loop.

/** Observation units (one repository and one kind of read) attempted per tick. */
export const GITHUB_FEED_UNIT_BATCH = 12;
/** List sizes asked of `gh`: the response is bounded before it is parsed. */
export const GITHUB_FEED_LIST_LIMIT = 20;
/** Cross-repository review requests fetched per discovery pass. */
export const GITHUB_FEED_MAX_REVIEW_REQUESTS = 25;
/**
 * Open pull requests whose own checks are read per pass, newest first. One
 * `gh pr checks` call each, so this is the bound on the extra requests; older
 * pull requests' external checks are NOT covered, and the docs say so.
 */
export const GITHUB_FEED_MAX_PR_CHECKS = 5;
/** Commits per page, and pages walked newest-first before coverage is called truncated. */
export const GITHUB_FEED_COMMIT_PAGE_SIZE = 30;
export const GITHUB_FEED_COMMIT_MAX_PAGES = 3;
/** Alerts delivered per tick. */
export const GITHUB_FEED_EVENT_BATCH = 10;
/** Commit lines shown in one repository's digest section, before a visible "and N more". */
export const GITHUB_FEED_DIGEST_MAX_LINES = 12;
/** Repository sections in one digest message, which is one Discord message of at most 10 embeds. */
export const GITHUB_FEED_DIGEST_MAX_SECTIONS = 8;
/** Characters the digest embeds may spend, kept under Discord's 6000 so nothing is clipped silently. */
export const GITHUB_FEED_DIGEST_CHAR_BUDGET = 5200;
/** Repositories the selected list may ever hold. */
export const GITHUB_FEED_MAX_SELECTED = 50;
/** Delivery attempts before an alert is abandoned as a record. */
export const GITHUB_FEED_MAX_DELIVERY_ATTEMPTS = 8;
/** Polling interval bounds, in minutes. */
export const GITHUB_FEED_INTERVAL_MIN_MINUTES = 5;
export const GITHUB_FEED_INTERVAL_MAX_MINUTES = 24 * 60;
export const GITHUB_FEED_INTERVAL_DEFAULT_MINUTES = 15;
/** A failing unit backs off exponentially from its interval, to this ceiling. */
export const GITHUB_FEED_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/**
 * How late a daily digest may be and still be sent.
 *
 * Past this the day it describes has gone, exactly as a stale briefing's has:
 * the row is kept as a `skipped` record rather than delivered or dropped. The
 * commits themselves are NOT lost; they stay unconsumed for the next digest.
 */
export const GITHUB_DIGEST_STALE_AFTER_MS = 20 * 60 * 60_000;
/**
 * How long past the slot the digest waits for a post-slot commit sweep of every
 * selected repository, so a commit pushed at 08:58 is not left to tomorrow just
 * because the poll that would have seen it ran at 09:05.
 */
export const GITHUB_DIGEST_SWEEP_GRACE_MS = 30 * 60_000;
/** Commits never consumed by a digest are dropped from the buffer after this. */
export const GITHUB_FEED_COMMIT_BUFFER_MAX_AGE_DAYS = 14;
/** Clamps on stored card text, applied before anything reaches the database. */
export const GITHUB_FEED_TITLE_MAX = 180;
export const GITHUB_FEED_DETAIL_MAX = 240;
/** A link button's href. Kept equal to the sanitizer's own bound so a stored link can never be dropped for length. */
export const GITHUB_LINK_URL_MAX = 300;

// ---- audit log --------------------------------------------------------------
/** Every free-text audit detail is redacted and then clamped to this. */
export const AUDIT_DETAIL_MAX = 300;
export const AUDIT_SUBJECT_REF_MAX = 128;
/** Rows older than this are pruned by the reconciler, so the table is bounded. */
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const AUDIT_PRUNE_BATCH = 500;

/**
 * The embed colours Ducky uses, and the only ones it may use.
 *
 * Named by MEANING rather than by shade, so a presenter says what a message is
 * and not what it should look like. Restrained on purpose: a personal assistant
 * that colour-codes everything reads as an alert system.
 *
 * Model text can never reach this. A colour is chosen by the presenter from
 * this table; nothing derives one from a reply, and `sanitizeOutbound` drops
 * any value that is not a plain integer in range.
 */
export const DUCKY_COLORS = Object.freeze({
  /** Ducky itself: conversation and assistant replies. A muted amber. */
  brand: 0xd9_a5_4b,
  /** Neutral information: status, listings, repository reads. */
  neutral: 0x5a_6b_7a,
  /** Something finished as intended. */
  success: 0x4c_8f_63,
  /** Something needs the owner: a question, an approval, an expiry. */
  attention: 0xc2_8a_3a,
  /** Something failed. Used sparingly, and never for a refusal by design. */
  failure: 0xa8_4a_4a,
});
export type DuckyColor = (typeof DUCKY_COLORS)[keyof typeof DUCKY_COLORS];

/** Discord accepts a 24-bit integer. Anything else is dropped, not clamped. */
export const EMBED_COLOR_MAX = 0xff_ff_ff;
export const isValidEmbedColor = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= EMBED_COLOR_MAX;

// ---- native thread conversations (issue #4) ---------------------------------
/**
 * Discord's own ceiling for a thread name. Ducky builds the name itself from a
 * fixed prefix and a sanitized excerpt, so this is a clamp on OUR output rather
 * than a guess about the API.
 */
export const THREAD_NAME_MAX = 100;
/**
 * How much of the starter message may appear in the thread name.
 *
 * The name is visible to everyone who can see the parent channel, including
 * people who cannot read the thread's later turns, so it is deliberately a
 * short excerpt rather than the whole first message.
 */
export const THREAD_NAME_EXCERPT_MAX = 60;
/** Seven days, in minutes. The longest auto-archive Discord offers. */
export const THREAD_AUTO_ARCHIVE_MINUTES = 10_080;

/**
 * How many BYTES of prompt context one turn may carry.
 *
 * A byte budget, not a token budget, and that distinction is the honest part:
 * no provider on this host reports a token limit, and inventing a token count
 * from a character count would be a measurement nobody made. Bytes are what
 * can actually be counted here, so bytes are what is bounded.
 *
 * The default is deliberately conservative. A turn whose context cannot be
 * brought under it is REFUSED rather than silently truncated, because a model
 * answering from half a conversation it was not told it was missing is worse
 * than a clear refusal.
 */
export const CONVERSATION_CONTEXT_BUDGET_BYTES_DEFAULT = 24_000;
export const CONVERSATION_CONTEXT_BUDGET_BYTES_MIN = 2_000;
export const CONVERSATION_CONTEXT_BUDGET_BYTES_MAX = 400_000;
/** A compact checkpoint is a summary. Past this it is a transcript again. */
export const CONVERSATION_CHECKPOINT_TEXT_MAX = 4_000;
/**
 * How many recent turns a compaction keeps verbatim beside the checkpoint.
 *
 * Small on purpose: the checkpoint carries the durable decisions, and the
 * recent turns carry the thing being talked about right now.
 */
export const CONVERSATION_COMPACT_KEEP_TURNS = 10;
/**
 * How many turns one thread-scoped read will ever return.
 *
 * The stored transcript is unbounded while the thread lives, so every read of
 * it has to be bounded somewhere; this is that bound. It is far above the
 * replay window and the compaction keep-count, so nothing a prompt needs is
 * ever cut off by it.
 */
export const CONVERSATION_THREAD_READ_MAX = 2_000;
/** How much of an explicitly selected reply anchor is carried into context. */
export const CONVERSATION_ANCHOR_TEXT_MAX = 600;

// ---- private-assistant migration (ADR 0030) --------------------------------
//
// Every bound here is a public, generic, fixed number. None is derived from the
// owner's private inventory, and none is read from an imported document: a
// document can be refused for exceeding one, never raise one.

/** The largest interchange document, in categories' record counts. */
export const ASSISTANT_IMPORT_MAX_TASKS = 5_000;
export const ASSISTANT_IMPORT_MAX_REMINDERS = 20_000;
export const ASSISTANT_IMPORT_MAX_CAPTURES = 5_000;
export const ASSISTANT_IMPORT_MAX_BRIEFING_DELIVERIES = 400;
export const ASSISTANT_IMPORT_MAX_WATCH_EVENTS = 20_000;
export const ASSISTANT_IMPORT_MAX_EVENTS_PER_TARGET = 2_000;
/** Offset lists are short on purpose; a per-task policy is a few reminders. */
export const ASSISTANT_REMINDER_POLICY_MAX_OFFSETS = 8;
export const ASSISTANT_REMINDER_OFFSET_MAX_MINUTES = 365 * 24 * 60;

/** Indefinite weekly rules are bounded in COUNT and in what one read may ask for. */
export const SCHEDULE_RULES_MAX = 300;
export const SCHEDULE_EXCEPTIONS_MAX = 1_000;
export const SCHEDULE_WINDOW_MAX_DAYS = 93;
/** Distinct from the confirmed-row cap: one list shows at most this many lines. */
export const SCHEDULE_LIST_LIMIT_MAX = 200;

/**
 * Notification-only watch targets.
 *
 * `ASSISTANT_WATCH_MAX_TARGETS` is a fixed hard ceiling, deliberately round and
 * well above any real inventory, and it is NOT the 20-watch ordinary add limit
 * (`MAX_GITHUB_WATCHES_PER_OWNER`) nor the 64-entry configured-repository cap.
 *
 * The call budgets are what bound throughput, not the ceiling: every
 * subprocess read an observation makes is charged against both. They leave
 * headroom below a typical 5000/hour authenticated quota for the feed and for
 * jobs. At the roughly 14 calls one snapshot observation cost, 1000 targets
 * would need over five hours of this budget per sweep; typed incremental reads
 * carry persisted progress instead, and no full-sweep latency is promised.
 */
export const ASSISTANT_WATCH_MAX_TARGETS = 1_000;
export const ASSISTANT_WATCH_CALLS_PER_TICK = 20;
export const ASSISTANT_WATCH_CALLS_PER_HOUR = 2_400;
/** How often a healthy surface is re-read, so a quiet one costs little. */
export const ASSISTANT_WATCH_INTERVAL_MINUTES = 15;
export const ASSISTANT_WATCH_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** Pages one read may span before it is blocked as unbounded; one page is one unit of work. */
export const ASSISTANT_WATCH_MAX_PAGES = 50;
/** Open pull requests whose reviews one pulls page reads, so a unit's cost is bounded. */
export const ASSISTANT_WATCH_PAGE_SIZE = 10;
export const ASSISTANT_WATCH_EVENT_BATCH = 10;
export const ASSISTANT_WATCH_ALERT_MAX_ATTEMPTS = 5;
/** Digested and abandoned events older than this are pruned; settlement is kept. */
export const ASSISTANT_WATCH_EVENT_KEEP_DAYS = 30;
export const ASSISTANT_DIGEST_MAX_REPOS = 12;
export const ASSISTANT_DIGEST_MAX_LINES_PER_REPO = 4;

/** The shared runtime lock: a holder is live while its heartbeat is this fresh. */
export const RUNTIME_LOCK_STALE_MS = 3 * 60_000;
