import { describe, expect, it } from 'vitest';
import { DEPENDENCY_TYPES, JOB_WORK_PHASES } from '@ducky/contracts';
import { buildOrchestrationBrief } from '../src/pi/brief.js';
import { PHASE_RELATIVE_PATH } from '../src/pi/phase-file.js';
import { RESULT_RELATIVE_PATH } from '../src/pi/result-file.js';

const brief = (over: Partial<Parameters<typeof buildOrchestrationBrief>[0]> = {}) =>
  buildOrchestrationBrief({
    publicId: 'jabcde',
    repoSlug: 'demo',
    task: 'add a thing',
    context: null,
    ownerInputs: [],
    mode: 'worktree',
    resultRelativePath: RESULT_RELATIVE_PATH,
    phaseRelativePath: PHASE_RELATIVE_PATH,
    ...over,
  });

/**
 * The brief is the ONLY thing that tells Pi what shapes exist.
 *
 * Two capabilities were unreachable in practice because the brief never
 * mentioned them: `waiting_on_dependency` (a whole persisted lifecycle state,
 * a resolver and two ceilings, that Pi was never told about) and the phase
 * file (so a live job sat at `preparing` for its whole run).
 */
describe('orchestration brief', () => {
  it('names every verdict the result schema accepts', () => {
    const b = brief();
    for (const verdict of ['implemented', 'needs_owner_input', 'failed', 'waiting_on_dependency']) {
      expect(b, verdict).toContain(verdict);
    }
  });

  it('documents the exact dependency shape, field for field', () => {
    const b = brief();
    for (const key of ['type', 'description', 'externalKey', 'nextCheckInSeconds', 'maxChecks', 'deadlineInSeconds']) {
      expect(b, key).toContain(key);
    }
    for (const t of DEPENDENCY_TYPES) {
      expect(b, t).toContain(t);
    }
  });

  it('says a dependency wait on this host expires rather than resuming', () => {
    // The shipped checker only ever answers `pending`. Letting Pi believe
    // otherwise would make a wait look like progress.
    expect(brief()).toMatch(/runs out its budget|expires/i);
  });

  it('warns that externalKey is not a URL and not a credential', () => {
    expect(brief()).toMatch(/never be a URL/i);
    expect(brief()).toMatch(/never a credential/i);
  });

  it('asks for the phase file, by its real path', () => {
    const b = brief();
    expect(b).toContain(PHASE_RELATIVE_PATH);
    for (const phase of ['implementing', 'reviewing', 'fixing', 'verifying']) {
      expect(b, phase).toContain(phase);
    }
  });

  it('tells Pi to write phases in order, because a jump is refused', () => {
    // Probe A recorded a real agent writing `verifying` immediately, which the
    // phase machine refuses from `planning`.
    expect(brief()).toMatch(/IN THE ORDER/);
    expect(brief()).toMatch(/refused/i);
  });

  it('never names a phase that is not in the machine', () => {
    const b = brief();
    const claimed = ['implementing', 'reviewing', 'fixing', 'verifying'];
    for (const c of claimed) expect(JOB_WORK_PHASES).toContain(c);
    expect(b).toContain('lowercase');
  });

  it('keeps the non-negotiable boundaries verbatim', () => {
    expect(brief()).toContain(
      '- Do NOT commit, push, open or merge a pull request, deploy, or mutate cloud resources.',
    );
    expect(brief()).toContain('- You are the orchestrator. Use exactly ONE implementation writer.');
  });

  it('stays inside the length cap even with maximal owner input', () => {
    const b = brief({
      task: 'x'.repeat(8_000),
      context: 'y'.repeat(8_000),
      ownerInputs: Array.from({ length: 16 }, (_, i) => ({
        round: i, question: 'q'.repeat(200), answer: 'a'.repeat(200),
        createdAt: new Date().toISOString(),
      })),
    });
    expect(b.length).toBeLessThanOrEqual(12_000 + '\n[brief truncated]'.length);
  });

  it('still redacts owner-authored text', () => {
    const b = brief({ task: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please' });
    expect(b).not.toContain('ghp_abcdefghij');
    expect(b).toContain('[REDACTED');
  });
});
