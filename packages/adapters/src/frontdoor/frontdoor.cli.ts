import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DuckyError, FRONTDOOR_MAX_OUTPUT_BYTES, FRONTDOOR_PUBLISH_TIMEOUT_MS,
  FRONTDOOR_READ_TIMEOUT_MS, checkCommandAllowed, type CommandClass, type TicketSpec,
} from '@ducky/contracts';
import { runArgv } from '../process/run.js';
import type {
  FrontDoorAvailability, FrontDoorInspection, FrontDoorOnboarding, FrontDoorPort,
  FrontDoorPublication, FrontDoorValidation,
} from './frontdoor.port.js';

/**
 * The logical binary name the command policy classifies.
 *
 * The REAL spawn is `<interpreter> <absolute workflow.py> <verb> …`, and the
 * script path is host configuration. Classifying on the verb under a logical
 * name keeps the frozen policy table independent of where one machine put the
 * file, while the forbidden-verb and forbidden-flag scans still run over the
 * whole constructed argv below.
 */
export const FRONTDOOR_POLICY_BIN = 'agent-workflow';

/**
 * Every operation this adapter can construct, and the only ones.
 *
 * A frozen table, exactly like `GH_OPERATIONS` and the Herdr argv table: the
 * table decides what can be built at all, and `checkCommandAllowed` decides
 * whether what was built may run.
 */
const OPERATIONS = Object.freeze({
  inspect: { verb: 'inspect', cls: 'read_only', timeoutMs: FRONTDOOR_READ_TIMEOUT_MS },
  validate: { verb: 'validate', cls: 'read_only', timeoutMs: FRONTDOOR_READ_TIMEOUT_MS },
  ticket: { verb: 'ticket', cls: 'external_mutation', timeoutMs: FRONTDOOR_PUBLISH_TIMEOUT_MS },
  agentize: { verb: 'agentize', cls: 'external_mutation', timeoutMs: FRONTDOOR_PUBLISH_TIMEOUT_MS },
} as const satisfies Record<string, { verb: string; cls: CommandClass; timeoutMs: number }>);

export interface FrontDoorCliOptions {
  /** Absolute path to the installed `workflow.py`. */
  readonly program: string;
  /** The interpreter. A bare name or an absolute path; never a shell string. */
  readonly interpreter?: string;
  /**
   * Whether publication and onboarding may run at all.
   *
   * OFF by default and separately configured, on exactly the terms the
   * approved-action performer uses: an external mutation is an operator
   * decision, not something a feature flag for "the bridge" sweeps in. With it
   * off, `$ticket` validates and renders and `$agentize` prepares nothing --
   * both say so plainly rather than half-running.
   */
  readonly mutationEnabled?: boolean;
  readonly run?: typeof runArgv;
}

/**
 * Drives the installed front door through `runArgv`.
 *
 * Properties that are not negotiable, and are each enforced here rather than
 * by convention:
 *
 * - **argv only.** No shell, no interpolation, mandatory timeout, bounded
 *   buffer. The one place a caller-supplied string reaches the argv is a
 *   repository name and a classification label, and both are validated against
 *   a character class first.
 * - **the policy decides.** Every spawn asserts `checkCommandAllowed` with the
 *   caller's own ceiling, so a read path physically cannot run the publisher.
 * - **nothing raw escapes.** stdout is parsed into the port's typed shapes and
 *   dropped. stderr is never returned, never logged and never stored: it is
 *   where paths and `gh` diagnostics live.
 */
export class FrontDoorCli implements FrontDoorPort {
  readonly name = 'agent-workflow';
  readonly #program: string;
  readonly #interpreter: string;
  readonly #mutationEnabled: boolean;
  readonly #run: typeof runArgv;

  constructor(opts: FrontDoorCliOptions) {
    this.#program = opts.program;
    this.#interpreter = opts.interpreter ?? 'python3';
    this.#mutationEnabled = opts.mutationEnabled ?? false;
    this.#run = opts.run ?? runArgv;
  }

  availability(): FrontDoorAvailability {
    if (this.#program.trim() === '') {
      return {
        usable: false,
        reason: 'not_configured',
        detail: 'The workflow helper is not configured on this instance.',
        mutationEnabled: false,
      };
    }
    if (!path.isAbsolute(this.#program)) {
      return {
        usable: false,
        reason: 'not_configured',
        detail: 'The workflow helper path must be absolute.',
        mutationEnabled: false,
      };
    }
    if (!existsSync(this.#program)) {
      return {
        usable: false,
        reason: 'missing_program',
        detail: 'The workflow helper is not installed on this host.',
        mutationEnabled: false,
      };
    }
    return {
      usable: true,
      detail: this.#mutationEnabled
        ? 'Available. Publishing and onboarding are enabled.'
        : 'Available for reads only. Publishing and onboarding are not enabled on this instance.',
      mutationEnabled: this.#mutationEnabled,
    };
  }

  async inspect(input: {
    path?: string;
    repository?: string;
    network?: boolean;
  }): Promise<FrontDoorInspection> {
    const argv: string[] = [OPERATIONS.inspect.verb, input.path ?? '.'];
    if (input.repository) argv.push('--repository', assertRepository(input.repository));
    if (input.network) argv.push('--network');

    const raw = await this.#invoke('inspect', argv);
    const data = parseJson(raw);
    const registration = data['registration'];
    const active = Array.isArray(data['active_jobs']) ? data['active_jobs'].length : 0;
    return {
      root: str(data['root']) ?? (input.path ?? '.'),
      repository: str(data['repository']),
      repositoryError: str(data['repository_error']),
      dirty: data['dirty'] === true,
      registered: isRecord(registration),
      registrationEnabled: isRecord(registration) && registration['enabled'] === true,
      activeJobs: active,
      signalCount: Array.isArray(data['signals']) ? data['signals'].length : 0,
      hasWorkflowContract: isRecord(data['workflow']),
      beads: data['beads'] === true,
    };
  }

  async validate(spec: TicketSpec): Promise<FrontDoorValidation> {
    return this.#withSpecFile(spec, async (file) => {
      const raw = await this.#invoke('validate', [OPERATIONS.validate.verb, '--spec', file]);
      const data = parseJson(raw);
      return {
        ok: data['ok'] === true,
        id: str(data['id']),
        error: str(data['error']),
      };
    });
  }

  async publish(input: {
    spec: TicketSpec;
    ready: boolean;
    path?: string;
    issue?: number;
    labels?: readonly string[];
  }): Promise<FrontDoorPublication> {
    this.#assertMutationEnabled();
    return this.#withSpecFile(input.spec, async (file) => {
      const argv: string[] = [OPERATIONS.ticket.verb, '--spec', file];
      // `--ready` is only ever appended from an explicit boolean the owner
      // typed. There is no code path that derives it from text.
      if (input.ready) argv.push('--ready');
      if (input.path) argv.push('--path', input.path);
      if (input.issue !== undefined) argv.push('--issue', String(assertIssueNumber(input.issue)));
      for (const label of input.labels ?? []) argv.push('--label', assertLabel(label));

      const raw = await this.#invoke('ticket', argv);
      const data = parseJson(raw);
      return {
        ok: data['ok'] === true,
        repository: str(data['repository']) ?? input.spec.repository,
        issue: num(data['issue']),
        url: str(data['url']),
        created: data['created'] === true,
        queued: data['queued'] === true,
        queueVerified: data['queue_verified'] === true,
        // Carried through untouched. The helper is the only thing that could
        // ever know, and today it always says false.
        started: data['started'] === true,
        alreadyAuthorized: data['already_authorized'] === true,
        classificationLabels: strings(data['classification_labels']),
        classificationVerified: data['classification_verified'] === true,
        error: str(data['error']),
      };
    });
  }

  async agentize(input: {
    path?: string;
    repository?: string;
    localOnly?: boolean;
  }): Promise<FrontDoorOnboarding> {
    this.#assertMutationEnabled();
    const argv: string[] = [OPERATIONS.agentize.verb];
    if (input.path) argv.push('--path', input.path);
    if (input.repository) argv.push('--repository', assertRepository(input.repository));
    if (input.localOnly) argv.push('--local-only');

    const raw = await this.#invoke('agentize', argv);
    const data = parseJson(raw);
    return {
      ok: data['ok'] === true,
      repository: str(data['repository']),
      root: str(data['root']) ?? (input.path ?? '.'),
      changed: strings(data['changed']),
      registered: data['registered'] === true,
      labelsCreated: strings(data['labels_created']),
      dispatcher: describeDispatcher(data['dispatcher']),
      error: str(data['error']),
    };
  }

  // ---------------------------------------------------------------------------

  #assertMutationEnabled(): void {
    if (!this.#mutationEnabled) {
      throw new DuckyError(
        'not_enabled_in_phase1',
        'Publishing and onboarding are not enabled on this instance. Nothing was created.',
      );
    }
  }

  /**
   * One spawn, with every control applied in order.
   *
   * The policy check runs on the LOGICAL argv (verb first) so the frozen table
   * can match, and the forbidden-verb scan additionally runs over the REAL
   * argv -- interpreter, script path and all -- so nothing can be smuggled in
   * through a configured path.
   */
  async #invoke(op: keyof typeof OPERATIONS, argv: readonly string[]): Promise<string> {
    const operation = OPERATIONS[op];
    const refusal = checkCommandAllowed(FRONTDOOR_POLICY_BIN, argv, operation.cls);
    if (refusal) throw new DuckyError('not_enabled_in_phase1', refusal.detail);

    const real = [this.#program, ...argv];
    const realRefusal = checkCommandAllowed(FRONTDOOR_POLICY_BIN, real, operation.cls);
    if (realRefusal && realRefusal.reason === 'forbidden_verb') {
      throw new DuckyError('not_enabled_in_phase1', realRefusal.detail);
    }

    const availability = this.availability();
    if (!availability.usable) {
      throw new DuckyError('integration_not_verified', availability.detail);
    }

    const result = await this.#run(this.#interpreter, real, {
      timeoutMs: operation.timeoutMs,
      maxBuffer: FRONTDOOR_MAX_OUTPUT_BYTES,
      env: {
        ...process.env,
        // The helper shells out to `gh`. A prompt would hang until the
        // subprocess timeout and look like an outage.
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    /**
     * A non-zero exit is NOT an exception here, because the helper reports its
     * own failures as JSON on stdout with `ok: false` and exits 1. Losing that
     * structured reason and replacing it with "the helper failed" would throw
     * away the only useful thing the owner could act on.
     *
     * A non-zero exit with UNPARSEABLE stdout is a different matter and does
     * throw -- and the message says only that, never stderr.
     */
    if (result.stdout.trim() === '') {
      throw new DuckyError(
        'integration_not_verified',
        result.code === 0
          ? 'The workflow helper returned nothing.'
          : 'The workflow helper failed before it could report a reason.',
      );
    }
    return result.stdout;
  }

  /**
   * Writes the spec to a private temporary file and removes it afterwards.
   *
   * The helper takes `--spec <file>` and the spec is the owner's own words
   * about their repository. It goes to a `0600` file in a `0700` directory
   * that is removed on success, failure and throw alike -- never into the
   * repository, and never into SQLite.
   */
  async #withSpecFile<T>(spec: TicketSpec, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(tmpdir(), 'ducky-spec-'), { encoding: 'utf8' });
    const file = path.join(dir, 'ticket-spec.json');
    try {
      writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
      return await fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---- parsing ---------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The text itself is NOT included. A helper that printed a traceback would
    // otherwise put a host path into an owner-facing error.
    throw new DuckyError(
      'integration_not_verified',
      'The workflow helper answered in a shape Ducky does not recognise.',
    );
  }
  if (!isRecord(parsed)) {
    throw new DuckyError(
      'integration_not_verified',
      'The workflow helper answered in a shape Ducky does not recognise.',
    );
  }
  return parsed;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

const strings = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];

/**
 * The dispatcher's own reported state, flattened to one short word.
 *
 * Whatever shape the helper reports, only a bounded description crosses the
 * boundary -- and it is an OBSERVATION. Ducky never claims the dispatcher
 * started anything.
 */
function describeDispatcher(v: unknown): string | undefined {
  if (typeof v === 'string') return v.slice(0, 60);
  if (isRecord(v)) {
    const running = v['running'];
    if (typeof running === 'boolean') return running ? 'running' : 'not running';
  }
  return undefined;
}

// ---- argv validation -------------------------------------------------------

const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
/** GitHub label names, narrowed. `agent:*` is the dispatcher's and is refused. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,48}$/;

function assertRepository(value: string): string {
  if (!REPOSITORY_RE.test(value)) {
    throw new DuckyError('invalid_input', 'That is not an `owner/name` repository.');
  }
  return value;
}

/**
 * Classification labels only.
 *
 * `agent:*` is reserved for the dispatcher and `agent:ready` is the exact
 * label that authorizes implementation. Ducky never passes one: queueing goes
 * through `--ready`, which the helper applies and then verifies, so there is
 * no path here that could apply an authorization label as if it were a
 * classification.
 */
function assertLabel(value: string): string {
  if (!LABEL_RE.test(value) || value.toLowerCase().startsWith('agent:')) {
    throw new DuckyError('invalid_input', 'That classification label is not allowed.');
  }
  return value;
}

function assertIssueNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    throw new DuckyError('invalid_input', 'That is not an issue number.');
  }
  return value;
}
