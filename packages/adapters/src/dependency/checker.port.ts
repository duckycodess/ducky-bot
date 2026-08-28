import {
  DEPENDENCY_TYPES,
  type DependencyCheckInput, type DependencyCheckOutcome, type DependencyType,
} from '@ducky/contracts';

/**
 * Answers "is this thing ready yet?" for one dependency.
 *
 * A port, injected, and bounded by its caller: the resolver decides when to
 * call it, how many times, and gives up on its own schedule. A checker cannot
 * extend its own budget, cannot reschedule itself, and is never told anything
 * about the job beyond the dependency record -- no repository path, no task
 * text, no credentials.
 *
 * `verified` follows the same rule as every other integration in this
 * codebase: it is true only when the thing it talks to has actually been
 * exercised on this host. An unverified checker is still allowed to answer
 * `pending`; what it must never do is answer `ready`.
 */
export interface DependencyChecker {
  readonly name: string;
  readonly verified: boolean;
  /** The types this checker claims to be able to answer for. */
  readonly supports: readonly DependencyType[];
  check(input: DependencyCheckInput): Promise<DependencyCheckOutcome>;
}

/**
 * The DEFAULT, and the only checker that ships.
 *
 * It answers `pending` and nothing else, for every type, forever -- which is
 * the honest answer when nothing on this host can observe a CI run, a package
 * registry or another repository. It never reports `ready`, so no job can be
 * resumed on the strength of a check that did not happen.
 *
 * The consequence is deliberate and is the whole point: a dependency wait on a
 * default install runs out its bounded check budget and then goes to the
 * OWNER, who is asked to decide. That is a real, useful outcome -- "I held
 * your repository, I could not confirm this, over to you" -- and it is not the
 * same as pretending to have checked.
 */
export class UnavailableDependencyChecker implements DependencyChecker {
  readonly name = 'none';
  readonly verified = false;
  readonly supports: readonly DependencyType[] = [];

  async check(_input: DependencyCheckInput): Promise<DependencyCheckOutcome> {
    return {
      status: 'pending',
      detail: 'No dependency checker is configured, so this could not be checked automatically.',
    };
  }
}

export interface ScriptedOutcome extends DependencyCheckOutcome {
  /** Repeat this outcome this many times before moving on. Default 1. */
  readonly times?: number;
}

/**
 * A test double with a scripted sequence of answers.
 *
 * Lives beside the other adapter mocks rather than in a test file because the
 * resolver's whole contract -- resume on ready, fail on failed, give up on a
 * budget -- is only observable through a checker, and both the coordinator
 * tests and any future integration test need the same one.
 *
 * It records every call, so a test can assert that the resolver checked
 * exactly as often as its bounds allow and no more.
 */
export class ScriptedDependencyChecker implements DependencyChecker {
  readonly name = 'scripted';
  readonly supports: readonly DependencyType[] = DEPENDENCY_TYPES;
  readonly calls: DependencyCheckInput[] = [];

  #queue: DependencyCheckOutcome[];

  constructor(
    script: readonly ScriptedOutcome[] = [],
    /** Answered once the script runs out. */
    private readonly fallback: DependencyCheckOutcome = { status: 'pending' },
    readonly verified = true,
  ) {
    this.#queue = script.flatMap(({ times, ...outcome }) =>
      Array.from({ length: times ?? 1 }, () => outcome),
    );
  }

  /** Set to make `check` reject, so failure isolation can be exercised. */
  throwOnCheck: Error | undefined;

  async check(input: DependencyCheckInput): Promise<DependencyCheckOutcome> {
    this.calls.push(input);
    if (this.throwOnCheck) throw this.throwOnCheck;
    return this.#queue.shift() ?? this.fallback;
  }
}
