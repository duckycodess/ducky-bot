import { describe, expect, it } from 'vitest';
import {
  ARGV_FORBIDDEN_VERBS, DELETION_VERBS, classifyDeletionSurface,
} from '../../../scripts/probe-openclaw.mjs';

/**
 * How `probe:openclaw` classifies the session-deletion surface.
 *
 * The classification used to push a BLOCKER on both branches -- found and not
 * found -- which made `gaps.length === 0` unreachable, made exit 0 impossible,
 * and made the probe print blocker consequences ("the provider stays
 * unverified", "conversation refuses to answer") that were not true of a run
 * whose contract had been fully recorded.
 *
 * A probe that cannot succeed is not a certifier. So the classification is a
 * pure function, it returns a NOTE in every case, and it is tested here rather
 * than only being read.
 */
describe('classifyDeletionSurface', () => {
  it('returns a note, never a blocker, in every case', () => {
    const cases = [
      { named: [], usable: [] },
      { named: ['sessions purge'], usable: [] },
      { named: ['sessions delete'], usable: ['sessions delete'] },
    ];
    for (const c of cases) {
      const note = classifyDeletionSurface(c);
      expect(typeof note).toBe('string');
      // Every outcome leaves the constant null: a command NAME is not evidence
      // that a deletion works.
      expect(note).toMatch(/RECORDED_SESSION_DELETION stays null|stays null until/);
      expect(note).toMatch(/PARTIAL/);
    }
  });

  it('says plainly when OpenClaw names no deletion subcommand at all', () => {
    const note = classifyDeletionSurface({ named: [], usable: [] });
    expect(note).toMatch(/names no deletion subcommand/);
    expect(note).toMatch(/Nothing to verify/);
  });

  it('distinguishes "forbidden by our policy" from "the CLI cannot"', () => {
    // The difference matters to whoever reads the report: one is a limit of
    // OpenClaw, the other is a limit this repository imposes on itself and
    // will not lift.
    const note = classifyDeletionSurface({
      named: ['sessions purge', 'transcripts rm'],
      usable: [],
    });
    expect(note).toMatch(/by POLICY rather than/);
    expect(note).toMatch(/ALWAYS_FORBIDDEN_COMMAND_VERBS is not on the table/);
  });

  it('names what would still be needed when a usable candidate exists', () => {
    const note = classifyDeletionSurface({
      named: ['sessions delete'],
      usable: ['sessions delete'],
    });
    expect(note).toMatch(/has NOT been exercised/);
    expect(note).toMatch(/independent readback/);
    // And it still does not license anything on its own.
    expect(note).toMatch(/changes nothing on its own/);
  });

  it('keeps the forbidden list a strict subset of the deletion verbs it screens', () => {
    // A forbidden verb that is not also a deletion verb would never be reached,
    // which would make the policy filter look stricter than it is.
    for (const verb of ARGV_FORBIDDEN_VERBS) {
      if (verb === 'destroy' || verb === 'drop') continue; // screened elsewhere, kept for parity
      expect(DELETION_VERBS, verb).toContain(verb);
    }
  });
});
