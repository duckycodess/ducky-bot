import { homedir } from 'node:os';
import {
  DuckyError, HERDR_PROMPT_GRACE_MS, HERDR_READ_MAX_BYTES, HERDR_READ_SNAPSHOT_LINES,
  HERDR_START_TIMEOUT_MS, HERDR_TIMEOUT_MS,
  checkCommandAllowed,
} from '@ducky/contracts';
import { runArgv } from '../process/run.js';
import { redact } from '../redaction/redact.js';
import { expandHerdrPath } from './paths.js';
import type { HerdrClient } from './herdr.port.js';
import {
  AgentInfoSchema, AgentListResultSchema, AgentPromptResultSchema, AgentStartResultSchema,
  EnvelopeSchema, HERDR_DIRTY_WORKTREE_CODES, HERDR_NOT_FOUND_CODES, HERDR_NOT_READY_CODES,
  HERDR_STALLED_CODES, HerdrErrorEnvelopeSchema,
  PaneSplitResultSchema, WorkspaceCreateResultSchema, WorkspaceListResultSchema,
  WorktreeCreateResultSchema,
  type AgentInfo, type AgentReadSource, type WorkspaceSummary,
} from './herdr.types.js';

export interface HerdrCliOptions {
  readonly bin?: string;
  /** Subprocess budget for ordinary, non-blocking commands. */
  readonly timeoutMs?: number;
  /** Added to a blocking wait's own timeout to get the subprocess budget. */
  readonly promptGraceMs?: number;
  /** Interactive-readiness budget sent to `agent start --timeout`. */
  readonly startTimeoutMs?: number;
  /** Overridable so the expansion can be tested without touching the real home. */
  readonly homeDir?: string;
  /** Records every argv for the probe script and for tests. */
  readonly onInvoke?: (argv: readonly string[]) => void;
}

/**
 * Fallback wording match, used ONLY when no machine code could be parsed --
 * a syntax error (exit 2) or a non-JSON failure. The `code` field is the
 * primary signal; see `classify`.
 */
const NOT_FOUND = /\b(not[ _-]?found|no such|unknown (agent|pane|workspace)|does not exist)\b/i;

class HerdrNotFoundError extends DuckyError {
  constructor(detail: string) {
    super('not_found', detail);
  }
}

const isNotFound = (err: unknown): boolean => err instanceof HerdrNotFoundError;

/** Herdr's machine code for a failure, when it emitted a parseable envelope. */
function herdrErrorCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const env = HerdrErrorEnvelopeSchema.safeParse(parsed);
  return env.success ? env.data.error.code : undefined;
}

/**
 * Turns a failed herdr invocation into the right DuckyError.
 *
 * Three outcomes with genuinely different consequences, so they are three
 * different codes rather than one:
 *
 * - `not_found` -- the target is absent. The caller may safely create.
 * - `herdr_prompt_stalled` -- the server and the agent are both fine, the wait
 *   simply did not settle. Treating it as an outage would release a repository
 *   whose pane may still hold a live writer.
 * - `herdr_unavailable` -- everything else, which is the only one that means
 *   "Herdr itself cannot be reached".
 */
function herdrError(raw: unknown, argv: readonly string[]): DuckyError {
  const code = herdrErrorCode(raw);
  const text = redact(typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')).slice(0, 200);

  if (code !== undefined) {
    if (HERDR_NOT_FOUND_CODES.includes(code)) return new HerdrNotFoundError(text);
    if (HERDR_STALLED_CODES.includes(code)) {
      return new DuckyError(
        'herdr_prompt_stalled',
        `Herdr saw no activity from the agent after the prompt was submitted (${code}).`,
      );
    }
    if (HERDR_NOT_READY_CODES.includes(code)) {
      return new DuckyError(
        'herdr_agent_not_ready',
        'The agent is not accepting input yet.',
      );
    }
    if (HERDR_DIRTY_WORKTREE_CODES.includes(code)) {
      return new DuckyError(
        'herdr_worktree_dirty',
        'The worktree still holds uncommitted changes, so it was not removed.',
      );
    }
    return new DuckyError('herdr_unavailable', `Herdr command failed (${argv[0]}): ${code}`);
  }

  // No parseable envelope: a syntax error, a dead socket, or a truncated
  // stream. Fall back to the wording, then to an outage.
  if (NOT_FOUND.test(text)) return new HerdrNotFoundError(text);
  return new DuckyError('herdr_unavailable', `Herdr command failed (${argv[0]}): ${text}`);
}

/**
 * Thin wrapper over the installed `herdr` binary. Never uses `--current`: the
 * executor runs under systemd with no caller pane, and herdr reaches its server
 * over a socket regardless.
 */
export class HerdrCli implements HerdrClient {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly promptGraceMs: number;
  private readonly startTimeoutMs: number;
  private readonly homeDir: string;
  private readonly onInvoke: ((argv: readonly string[]) => void) | undefined;

  constructor(opts: HerdrCliOptions = {}) {
    this.bin = opts.bin ?? 'herdr';
    this.timeoutMs = opts.timeoutMs ?? HERDR_TIMEOUT_MS;
    this.promptGraceMs = opts.promptGraceMs ?? HERDR_PROMPT_GRACE_MS;
    this.startTimeoutMs = opts.startTimeoutMs ?? HERDR_START_TIMEOUT_MS;
    this.homeDir = opts.homeDir ?? homedir();
    this.onInvoke = opts.onInvoke;
  }

  /**
   * The second gate, and the one this adapter was missing.
   *
   * The frozen argv construction in the methods below decides what CAN be
   * built; the central policy decides whether what was built may RUN. `gh` and
   * the executor's `git` helper have consulted it since it existed, but every
   * herdr invocation went straight to a subprocess -- so the documented claim
   * that "every gh, git and herdr operation is classified" was only true of two
   * of the three, and `agent get`, `workspace close` and `worktree remove` were
   * not classified at all.
   *
   * A consequence worth stating: `--force` is a forbidden flag, so
   * `worktreeRemove(..., { force: true })` is refused HERE, before a
   * subprocess, rather than deleting a checkout that still holds uncommitted
   * work. Nothing in the running system passes it.
   *
   * Free text (an `agent prompt` body) is one argv element, so it cannot be
   * read as a verb; a single-word prompt that happened to equal a forbidden
   * verb would be refused, which is the safe direction.
   */
  private assertAllowed(argv: readonly string[]): void {
    const refusal = checkCommandAllowed('herdr', argv);
    if (refusal) throw new DuckyError('not_enabled_in_phase1', refusal.detail);
  }

  /** Runs a command that reports success only through its exit code. */
  private async callVoid(argv: readonly string[]): Promise<void> {
    this.assertAllowed(argv);
    this.onInvoke?.(argv);
    const res = await runArgv(this.bin, argv, { timeoutMs: this.timeoutMs });
    if (res.code !== 0) {
      throw new DuckyError(
        'herdr_unavailable',
        `Herdr command failed: ${redact(res.stderr || res.stdout).slice(0, 200)}`,
      );
    }
  }

  /**
   * Runs a command whose answer is PLAIN TEXT rather than a JSON envelope.
   *
   * Recorded on this host: `herdr agent read` writes the terminal snapshot
   * straight to stdout and exits 0. Sending it through `call()` would fail the
   * JSON parse and be reported as an outage, which is exactly the mistake
   * `workspace report-metadata` (empty body, exit code only) taught earlier.
   *
   * The output is truncated because a pane is unbounded, untrusted text.
   */
  private async callText(argv: readonly string[], maxBytes: number): Promise<string> {
    this.assertAllowed(argv);
    this.onInvoke?.(argv);
    const res = await runArgv(this.bin, argv, { timeoutMs: this.timeoutMs });
    if (res.code !== 0) {
      throw herdrError(res.stderr || res.stdout, argv);
    }
    return res.stdout.slice(0, maxBytes);
  }

  /**
   * @param subprocessTimeoutMs Budget for the CHILD PROCESS, which is not the
   * same thing as the `--timeout` handed to herdr inside `argv`. A blocking
   * `agent prompt --wait --timeout 2h` must be hosted by a process allowed to
   * live longer than two hours: using the default 30 s here SIGTERMs a healthy
   * wait, the caller reads an outage, and the repository is released while a
   * real Pi agent is still writing to it.
   */
  private async call(
    argv: readonly string[],
    signal?: AbortSignal,
    subprocessTimeoutMs?: number,
  ): Promise<unknown> {
    this.assertAllowed(argv);
    this.onInvoke?.(argv);
    const res = await runArgv(this.bin, argv, {
      timeoutMs: subprocessTimeoutMs ?? this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (res.code !== 0) {
      throw herdrError(res.stderr || res.stdout, argv);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new DuckyError('herdr_unavailable', 'Herdr returned a non-JSON response.');
    }
    const env = EnvelopeSchema.parse(parsed);
    if (env.error !== undefined) {
      throw herdrError(env.error, argv);
    }
    return env.result;
  }

  async available(): Promise<boolean> {
    try {
      await this.agentList();
      return true;
    } catch {
      return false;
    }
  }

  async agentList(): Promise<AgentInfo[]> {
    return AgentListResultSchema.parse(await this.call(['agent', 'list'])).agents;
  }

  /**
   * `undefined` means Herdr answered and there is NO such agent.
   *
   * A socket failure, a dead server or an unparseable response is an outage
   * and throws `herdr_unavailable` instead. Collapsing the two would let a
   * transient outage look like an absent agent, and the caller would then
   * create a second workspace beside a live one, or "clean up" without ever
   * having proved what was running.
   */
  async agentGet(target: string): Promise<AgentInfo | undefined> {
    let raw: unknown;
    try {
      raw = await this.call(['agent', 'get', target]);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const obj = raw as Record<string, unknown>;
    const parsed = AgentInfoSchema.safeParse(obj['agent'] ?? obj);
    if (!parsed.success) {
      throw new DuckyError('herdr_unavailable', 'Herdr returned an unreadable agent record.');
    }
    return parsed.data;
  }

  /**
   * Reads an agent's terminal snapshot. Text, never JSON; see `callText`.
   *
   * A missing agent is an EMPTY snapshot rather than a throw: the only caller
   * is readiness observation, and "I could not look" must not be louder than
   * the prompt attempt that follows it and reports the real problem.
   */
  async agentRead(
    target: string,
    opts: { source?: AgentReadSource; lines?: number } = {},
  ): Promise<string> {
    const argv = [
      'agent', 'read', target,
      '--source', opts.source ?? 'detection',
      '--lines', String(opts.lines ?? HERDR_READ_SNAPSHOT_LINES),
      '--format', 'text',
    ];
    try {
      return await this.callText(argv, HERDR_READ_MAX_BYTES);
    } catch (err) {
      if (isNotFound(err)) return '';
      throw err;
    }
  }

  /**
   * Starts a supported agent in an EXISTING pane that is already at its
   * interactive shell prompt. Herdr never creates layout here.
   *
   * The readiness `--timeout` is sent explicitly rather than inherited: herdr's
   * own default is 30 s, and a cold Pi start on a loaded host can exceed that.
   * The subprocess budget is derived from it so the child always outlives the
   * wait it was asked to perform.
   */
  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    agentArgs: readonly string[],
  ): Promise<AgentInfo> {
    const argv = [
      'agent', 'start', name,
      '--kind', kind,
      '--pane', paneId,
      '--timeout', String(this.startTimeoutMs),
    ];
    if (agentArgs.length > 0) argv.push('--', ...agentArgs);
    const raw = await this.call(argv, undefined, this.startTimeoutMs + this.promptGraceMs);
    const obj = raw as Record<string, unknown>;
    const parsed = AgentStartResultSchema.safeParse(obj);
    if (parsed.success) return parsed.data.agent;
    return AgentInfoSchema.parse(obj['agent'] ?? obj);
  }

  /**
   * `--wait` blocks until the turn settles. The signal is passed down so a
   * cancellation stops us waiting immediately instead of holding on for the
   * whole timeout; the agent itself is deliberately left alone.
   *
   * Returns the SETTLED agent herdr reports, which is how the caller tells a
   * finished turn from one that stopped at an approval prompt. `undefined`
   * only when herdr answered without an agent record -- the caller then has to
   * observe the agent itself rather than assume anything.
   */
  async agentPrompt(
    target: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentInfo | undefined> {
    const raw = await this.call(
      ['agent', 'prompt', target, text, '--wait', '--timeout', String(timeoutMs)],
      signal,
      // The child must outlive the wait it is hosting, or a healthy long turn
      // is killed and misread as an outage.
      timeoutMs + this.promptGraceMs,
    );
    const parsed = AgentPromptResultSchema.safeParse(raw);
    return parsed.success ? parsed.data.agent : undefined;
  }

  async workspaceList(): Promise<WorkspaceSummary[]> {
    return WorkspaceListResultSchema.parse(await this.call(['workspace', 'list'])).workspaces;
  }

  async workspaceCreate(cwd: string, label: string): Promise<{ workspaceId: string; rootPaneId: string }> {
    const r = WorkspaceCreateResultSchema.parse(
      await this.call(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']),
    );
    const rootPaneId = r.root_pane?.pane_id;
    if (!rootPaneId) {
      throw new DuckyError('herdr_unavailable', 'Herdr did not return a root pane for the workspace.');
    }
    return { workspaceId: r.workspace.workspace_id, rootPaneId };
  }

  /** Verified on this host: succeeds with an empty response body. */
  async workspaceReportMetadata(workspaceId: string, tokens: Record<string, string>): Promise<void> {
    const argv = ['workspace', 'report-metadata', workspaceId, '--source', 'ducky'];
    for (const [k, v] of Object.entries(tokens)) argv.push('--token', `${k}=${v}`);
    await this.callVoid(argv);
  }

  async workspaceClose(workspaceId: string): Promise<void> {
    await this.call(['workspace', 'close', workspaceId]);
  }

  async paneSplit(paneId: string, cwd: string): Promise<string> {
    const r = PaneSplitResultSchema.parse(
      await this.call(['pane', 'split', paneId, '--direction', 'right', '--cwd', cwd, '--no-focus']),
    );
    return r.pane.pane_id;
  }

  /**
   * Creates a linked worktree. Herdr checks it out under its own worktrees
   * directory, NOT inside the source repository, so the checkout path must be
   * read from the response -- falling back to the repository root would make
   * the job read its result from the wrong tree.
   */
  async worktreeCreate(input: {
    cwd: string;
    branch: string;
    base: string;
    label: string;
  }): Promise<{
    workspaceId: string;
    rootPaneId: string;
    path: string;
  }> {
    const r = WorktreeCreateResultSchema.parse(
      await this.call([
        'worktree', 'create',
        '--cwd', input.cwd,
        '--branch', input.branch,
        '--base', input.base,
        // WITHOUT this, Herdr labels the workspace after the branch
        // (`ducky-job-<id>`), which does NOT start with the Ducky-managed
        // prefix -- so `cleanup()`'s ownership proof could never pass and every
        // worktree job leaked its workspace and its checkout. Found by the
        // production-path probe, not by any unit test.
        '--label', input.label,
        '--no-focus',
      ]),
    );
    const workspaceId = r.workspace?.workspace_id;
    const rootPaneId = r.root_pane?.pane_id;
    const reported = r.worktree?.path ?? r.workspace?.worktree?.checkout_path;
    if (!workspaceId || !rootPaneId || !reported) {
      throw new DuckyError(
        'herdr_unavailable',
        'Herdr did not return a workspace, pane and checkout path for the new worktree.',
      );
    }
    // Herdr reports `~/.herdr/worktrees/...`; the coordinator requires an
    // absolute normalized path, so expand it here rather than let a real
    // worktree job be rejected at registration.
    return { workspaceId, rootPaneId, path: expandHerdrPath(reported, this.homeDir) };
  }

  /**
   * Removes a linked worktree checkout.
   *
   * `force` stays on the signature because the mock uses it to model Herdr's
   * real `dirty_worktree_requires_force` refusal, and because a test asserts
   * that job cleanup never passes it. It is NOT a usable option through this
   * adapter: `--force` is a forbidden flag in the central command policy, so
   * `assertAllowed` refuses the argv before a subprocess exists.
   *
   * That is the intended outcome. A finished job's checkout always contains at
   * least an untracked `.ducky/result.json`, and usually the implementation
   * itself, which nothing has committed -- the brief forbids committing.
   * Forcing there would delete the owner's work. The probe scripts, which
   * operate on a disposable temp repository, build their own argv and say so.
   */
  async worktreeRemove(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
    const argv = ['worktree', 'remove', '--workspace', workspaceId];
    if (opts.force === true) argv.push('--force');
    await this.call(argv);
  }
}
