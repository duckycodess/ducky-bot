import { DuckyError, HERDR_TIMEOUT_MS } from '@ducky/contracts';
import { runArgv } from '../process/run.js';
import { redact } from '../redaction/redact.js';
import type { HerdrClient } from './herdr.port.js';
import {
  AgentInfoSchema, AgentListResultSchema, EnvelopeSchema, PaneSplitResultSchema,
  WorkspaceCreateResultSchema, WorkspaceListResultSchema, WorktreeCreateResultSchema,
  type AgentInfo, type WorkspaceSummary,
} from './herdr.types.js';

export interface HerdrCliOptions {
  readonly bin?: string;
  readonly timeoutMs?: number;
  /** Records every argv for the probe script and for tests. */
  readonly onInvoke?: (argv: readonly string[]) => void;
}

/**
 * Thin wrapper over the installed `herdr` binary. Never uses `--current`: the
 * executor runs under systemd with no caller pane, and herdr reaches its server
 * over a socket regardless.
 */
/** Herdr's wording for "that target does not exist", as opposed to an outage. */
const NOT_FOUND = /\b(not[ _-]?found|no such|unknown (agent|pane|workspace)|does not exist)\b/i;

class HerdrNotFoundError extends DuckyError {
  constructor(detail: string) {
    super('not_found', detail);
  }
}

const isNotFound = (err: unknown): boolean => err instanceof HerdrNotFoundError;

function herdrError(raw: unknown, argv: readonly string[]): DuckyError {
  const text = redact(typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')).slice(0, 200);
  if (NOT_FOUND.test(text)) return new HerdrNotFoundError(text);
  return new DuckyError('herdr_unavailable', `Herdr command failed (${argv[0]}): ${text}`);
}

export class HerdrCli implements HerdrClient {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly onInvoke: ((argv: readonly string[]) => void) | undefined;

  constructor(opts: HerdrCliOptions = {}) {
    this.bin = opts.bin ?? 'herdr';
    this.timeoutMs = opts.timeoutMs ?? HERDR_TIMEOUT_MS;
    this.onInvoke = opts.onInvoke;
  }

  /** Runs a command that reports success only through its exit code. */
  private async callVoid(argv: readonly string[]): Promise<void> {
    this.onInvoke?.(argv);
    const res = await runArgv(this.bin, argv, { timeoutMs: this.timeoutMs });
    if (res.code !== 0) {
      throw new DuckyError(
        'herdr_unavailable',
        `Herdr command failed: ${redact(res.stderr || res.stdout).slice(0, 200)}`,
      );
    }
  }

  private async call(argv: readonly string[], signal?: AbortSignal): Promise<unknown> {
    this.onInvoke?.(argv);
    const res = await runArgv(this.bin, argv, {
      timeoutMs: this.timeoutMs,
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

  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    agentArgs: readonly string[],
  ): Promise<AgentInfo> {
    const argv = ['agent', 'start', name, '--kind', kind, '--pane', paneId];
    if (agentArgs.length > 0) argv.push('--', ...agentArgs);
    const raw = await this.call(argv);
    const obj = raw as Record<string, unknown>;
    return AgentInfoSchema.parse(obj['agent'] ?? obj);
  }

  /**
   * `--wait` blocks until the turn settles. The signal is passed down so a
   * cancellation stops us waiting immediately instead of holding on for the
   * whole timeout; the agent itself is deliberately left alone.
   */
  async agentPrompt(
    target: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      ['agent', 'prompt', target, text, '--wait', '--timeout', String(timeoutMs)],
      signal,
    );
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
  async worktreeCreate(input: { cwd: string; branch: string; base: string }): Promise<{
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
        '--no-focus',
      ]),
    );
    const workspaceId = r.workspace?.workspace_id;
    const rootPaneId = r.root_pane?.pane_id;
    const checkoutPath = r.worktree?.path ?? r.workspace?.worktree?.checkout_path;
    if (!workspaceId || !rootPaneId || !checkoutPath) {
      throw new DuckyError(
        'herdr_unavailable',
        'Herdr did not return a workspace, pane and checkout path for the new worktree.',
      );
    }
    return { workspaceId, rootPaneId, path: checkoutPath };
  }

  async worktreeRemove(workspaceId: string): Promise<void> {
    await this.call(['worktree', 'remove', '--workspace', workspaceId]);
  }
}
