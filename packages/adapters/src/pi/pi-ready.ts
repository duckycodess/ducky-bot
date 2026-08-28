/**
 * Whether a Pi agent's own terminal output says it can take a prompt.
 *
 * WHY THIS EXISTS. `herdr agent start` returns with `agent_status: idle` and
 * `interactive_ready: true` while Pi is still printing startup banners (update
 * notices, package notices). A prompt submitted in that window is silently
 * dropped: Pi never enters `working`, and `agent prompt --wait` gives up with
 * `agent_prompt_stalled`. That is the documented cause of the majority of
 * production-path failures on this host, and the field Ducky was trusting is
 * the field that is wrong.
 *
 * WHAT THIS IS NOT. It is not a timing heuristic. Nothing here sleeps for a
 * guessed interval and then hopes; the caller polls an OBSERVATION and stops as
 * soon as the observation is positive twice in a row.
 *
 * WHERE THE MARKER COMES FROM, AND WHAT IT CORRECTED. Recorded by
 * `pnpm probe:herdr --with-agent` into
 * `herdr.fixtures/agent-readiness.json`, against a real agent started by the
 * probe (herdr 0.8.0, pi 0.83.0). The first version of this file required TWO
 * features -- a box-rule input frame and the status footer carrying the
 * transfer counters -- because both were present on the long-running idle
 * agents that were sampled first. The probe refused the run: a FRESHLY started
 * Pi never paints that footer, because it has no counters to show yet. Recorded
 * sequence, measured from `agent start` returning:
 *
 *   6.2 s, 7.2 s   0 rule lines   -- still printing banners
 *   8.2 s, 9.3 s   2 rule lines   -- the input frame begins to paint
 *   10.3 s         4 rule lines
 *   11.3 s onward  6 rule lines   -- steady state, 55 consecutive samples
 *   (no status footer at any point)
 *
 * So the discriminator on this host is the INPUT FRAME, and the footer is
 * recorded as corroboration only. The rule-line COUNT is deliberately not a
 * threshold beyond "more than one": how much of the frame is in view depends on
 * the pane's size and on `--lines`, so a bigger number would be an artifact
 * rather than a signal.
 *
 * The snapshot is untrusted terminal output. Nothing here interprets it as
 * anything but a shape: no field is extracted from it, none of it is stored,
 * and none of it reaches a Discord reply or a log line.
 */

/** Box-drawing characters Pi's input frame is built from. */
const RULE_CHARS = '─━╌╍┄┅┈┉‒–—';
const RULE_LINE = new RegExp(`^[${RULE_CHARS}\\s]*[${RULE_CHARS}]{20,}[${RULE_CHARS}\\s]*$`);
/**
 * The transfer counters on a Pi status footer. Present on an agent that has
 * done some work, absent on a fresh one, so it corroborates and never gates.
 */
const STATUS_LINE = /[↑↓]\s*\S/u;

/**
 * How many rule lines count as an input frame.
 *
 * Two, because a single horizontal rule is something ordinary output prints all
 * the time, and because the recorded banner phase showed ZERO.
 */
export const PI_READY_MIN_RULE_LINES = 2;

/**
 * How many consecutive positive observations end the wait.
 *
 * The frame paints over a second or two (2 → 4 → 6 rule lines in the recorded
 * run), so a single glimpse of it can be a half-drawn UI. Requiring the marker
 * twice in a row is a stability requirement expressed in OBSERVATIONS rather
 * than in milliseconds -- the caller looks again, it does not sleep and assume.
 */
export const PI_READY_CONSECUTIVE_OBSERVATIONS = 2;

export type PiReadyReason =
  /** The interactive input frame is present. */
  | 'ready'
  /**
   * Nothing to look at. Treated by the caller as an OBSERVATION IT COULD NOT
   * MAKE rather than as evidence of banners -- a real banner phase is not
   * empty; the recorded one was 190 bytes of update notices.
   */
  | 'empty'
  /** Output, but no input frame -- the banner phase. */
  | 'no_input_frame';

export interface PiReadyObservation {
  readonly ready: boolean;
  readonly reason: PiReadyReason;
  /** Reported so a probe can record how far the frame had painted. */
  readonly ruleLines: number;
  /** Recorded for the fixture. Corroboration only; never required. */
  readonly hasStatusFooter: boolean;
}

/**
 * Classifies one terminal snapshot.
 *
 * Deliberately conservative: an unrecognised snapshot is `ready: false`, and it
 * is the CALLER that decides what to do about a marker that never appears. The
 * orchestrator falls back to Herdr's own signal rather than refusing the job,
 * so a Pi whose chrome we no longer recognise behaves exactly as it did before
 * this existed -- worse than observed readiness, never worse than nothing.
 */
export function observePiPromptReady(snapshot: string): PiReadyObservation {
  const text = snapshot.trim();
  if (text === '') {
    return { ready: false, reason: 'empty', ruleLines: 0, hasStatusFooter: false };
  }

  const lines = text.split(/\r?\n/);
  const ruleLines = lines.filter((l) => l.trim() !== '' && RULE_LINE.test(l.trim())).length;
  // The footer sits below the frame, so only the tail is considered: an arrow
  // in the middle of a diff or a log line is not a status bar.
  const hasStatusFooter = lines.slice(-6).some((l) => STATUS_LINE.test(l));

  if (ruleLines < PI_READY_MIN_RULE_LINES) {
    return { ready: false, reason: 'no_input_frame', ruleLines, hasStatusFooter };
  }
  return { ready: true, reason: 'ready', ruleLines, hasStatusFooter };
}
