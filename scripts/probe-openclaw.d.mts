/**
 * Types for the pure, testable helpers in `probe-openclaw.mjs`.
 *
 * The probe itself stays plain JavaScript: it is a script an operator runs, it
 * shells out to a CLI, and giving it a build step would put a compile between
 * somebody and the evidence they are trying to record. But the part that
 * CLASSIFIES what was recorded is a decision rather than a side effect, it was
 * wrong once in a way that made the probe unable to succeed, and a decision
 * that can be wrong should be unit-tested.
 *
 * So only the exported helpers are declared here. Nothing else in the script is
 * importable, and `main` is guarded by an invoked-directly check so importing
 * this module never starts a probe.
 */

/** Subcommand names that would, in principle, remove something. */
export declare const DELETION_VERBS: readonly string[];

/**
 * Verbs this repository refuses to construct in any argv, mirroring
 * `ALWAYS_FORBIDDEN_COMMAND_VERBS` in `@ducky/contracts`.
 */
export declare const ARGV_FORBIDDEN_VERBS: readonly string[];

/**
 * What the recorded deletion surface means, as a NOTE rather than a blocker.
 *
 * Returns prose for the probe's report. It never decides the exit code, and
 * every outcome leaves `RECORDED_SESSION_DELETION` null.
 */
export declare function classifyDeletionSurface(input: {
  readonly named: readonly string[];
  readonly usable: readonly string[];
}): string;
