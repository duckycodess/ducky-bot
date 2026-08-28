import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  JOB_WORK_PHASES, PHASE_FILE_MAX_BYTES, canTransitionWorkPhase, type JobWorkPhase,
} from '@ducky/contracts';

export const PHASE_RELATIVE_PATH = path.join('.ducky', 'phase');

/**
 * Reads the phase Pi reports about itself.
 *
 * Herdr can only tell us `idle | working | blocked | done | unknown`. It cannot
 * tell us whether a working agent is implementing, reviewing or verifying --
 * and inferring that from a terminal scrape would be a guess dressed up as an
 * observation. So the engineering phase comes from Pi, in a file the brief asks
 * it to write, and this reader is the only thing that consumes it.
 *
 * Everything here fails CLOSED to "no phase". An absent, empty, oversized,
 * unparseable or unrecognised file yields `undefined`, so the job keeps the
 * phase it already had rather than acquiring a made-up one.
 */
export interface PhaseReader {
  read(workspacePath: string): Promise<JobWorkPhase | undefined>;
  /**
   * Removes any phase left by a previous turn.
   *
   * Called before the brief is handed over. Without it a RESUMED job -- an
   * answered question, a retry, a recovered workspace -- reads the phase the
   * last turn happened to finish on and reports it as the current one, so a job
   * that has only just started planning claims to be verifying. The file is
   * Pi's own report about the turn in progress, so a turn that has not written
   * one yet must have no phase at all rather than an inherited one.
   */
  clear(workspacePath: string): Promise<void>;
}

export class FilePhaseReader implements PhaseReader {
  async clear(workspacePath: string): Promise<void> {
    try {
      await rm(path.join(workspacePath, PHASE_RELATIVE_PATH), { force: true });
    } catch {
      // Best effort. A stale phase is a cosmetic wrong answer; failing the turn
      // over it would be worse than showing one.
    }
  }

  async read(workspacePath: string): Promise<JobWorkPhase | undefined> {
    const file = path.join(workspacePath, PHASE_RELATIVE_PATH);
    try {
      // Checked before reading: a large file is not a one-word phase, and
      // reading it would be pointless work on the job's critical path.
      const info = await stat(file);
      if (!info.isFile() || info.size > PHASE_FILE_MAX_BYTES) return undefined;
    } catch {
      return undefined;
    }

    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    return parsePhase(raw);
  }
}

/** Accepts exactly one known phase word, case-insensitively, and nothing else. */
export function parsePhase(raw: string): JobWorkPhase | undefined {
  const word = raw.trim().toLowerCase();
  return (JOB_WORK_PHASES as readonly string[]).includes(word)
    ? (word as JobWorkPhase)
    : undefined;
}

/**
 * Whether a freshly-read phase is worth reporting.
 *
 * The coordinator owns the phase machine and REFUSES an illegal edge, and a
 * refused report fails the whole heartbeat -- which would cost a lease
 * renewal. So the executor asks the same shared predicate first and simply
 * stays quiet about a phase that could not be accepted anyway. The authority
 * is still the coordinator; this only avoids knowingly sending a doomed report.
 */
export function shouldReportPhase(
  current: JobWorkPhase | null,
  next: JobWorkPhase | undefined,
): next is JobWorkPhase {
  if (next === undefined) return false;
  if (current === next) return false;
  return canTransitionWorkPhase(current, next);
}
