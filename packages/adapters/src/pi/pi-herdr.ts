import {
  DUCKY_AGENT_PREFIX, DUCKY_WORKSPACE_LABEL_PREFIX, DuckyError, HERDR_READY_MARKER_WAIT_MS,
  MAX_SLUG_KEY_LEN, isDuckyError,
} from '@ducky/contracts';
import { createHash } from 'node:crypto';
import type { HerdrClient } from '../herdr/herdr.port.js';
import type { AgentInfo } from '../herdr/herdr.types.js';
import { FileResultReader, RESULT_RELATIVE_PATH, type ResultReader } from './result-file.js';
import { FileBriefWriter, briefPointerPrompt, type BriefWriter } from './brief-file.js';
import { FilePhaseReader, type PhaseReader } from './phase-file.js';
import { PI_READY_CONSECUTIVE_OBSERVATIONS, observePiPromptReady } from './pi-ready.js';
import type {
  CancelOutcome, OrchestrationOutcome, OrchestrationSpec, PiOrchestrator, PromptGuard,
  PromptGuardTarget,
} from './pi-orchestrator.port.js';
import type { JobPauseCause } from '@ducky/contracts';

/**
 * What this process knows about one job's turn, kept so `cancel()` can tell a
 * quiet agent from one whose turn is merely not yet visible.
 *
 * The runner races `runJob` against cancellation and then abandons it, so when
 * `cancel()` looks, `runJob` may still be about to dispatch, or a prompt may have
 * been delivered a moment before the agent flips to `working`. An idle reading
 * in either window is not quiet proof, and releasing on it would let a writer
 * start with no lock and no slot.
 */
interface TurnState {
  readonly agentName: string;
  workspaceId: string | undefined;
  /** The pane this turn pinned: the root pane of a fresh start, or the owned agent's first pane. */
  paneId: string | undefined;
  /** `runJob` has not yet returned or thrown, so it may still dispatch. */
  runActive: boolean;
  /** A prompt has been handed to Herdr and was not refused as not-ready. */
  promptSent: boolean;
  /** After the last prompt, the turn was OBSERVED to settle (not merely seen idle). */
  settled: boolean;
  readonly finished: Promise<void>;
  finish(): void;
}

const MAX_TRACKED_TURNS = 64;

/** Raised inside this module when the pre-prompt guard declines; never leaves it. */
class PromptWithheld extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export { RESULT_RELATIVE_PATH };

/** Fits `ducky-pi-<slugKey>` inside herdr's [a-z][a-z0-9_-]{0,31} agent names. */
export function toSlugKey(slug: string): string {
  const base = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '');
  if (base.length <= MAX_SLUG_KEY_LEN) return base || 'repo';
  const digest = createHash('sha256').update(slug).digest('hex').slice(0, 6);
  return `${base.slice(0, MAX_SLUG_KEY_LEN - 7)}-${digest}`;
}

export const agentNameFor = (slugKey: string): string => `${DUCKY_AGENT_PREFIX}${slugKey}`;
export const workspaceLabelFor = (slugKey: string): string =>
  `${DUCKY_WORKSPACE_LABEL_PREFIX}${slugKey}`;

export interface HerdrPiOptions {
  readonly herdr: HerdrClient;
  readonly resultReader?: ResultReader;
  readonly sleep?: (ms: number) => Promise<void>;
  /** True only once `pnpm probe:herdr` has recorded live fixtures. */
  readonly verified?: boolean;
  readonly pollIntervalMs?: number;
  readonly thinkingLevel?: string;
  /** Which agent kind Herdr starts. `pi` is the orchestrator by design. */
  readonly agentKind?: string;
  /**
   * Extra reads of the result file after a turn settles.
   *
   * `agent prompt --wait` returns on an observed lifecycle change, which is not
   * the same instant as the agent's last write reaching the filesystem. One
   * read can therefore miss a result that arrives milliseconds later and
   * report `no_result` for work that actually succeeded.
   */
  readonly resultSettleAttempts?: number;
  readonly resultSettleDelayMs?: number;
  /**
   * How long to keep observing an agent after Herdr reported
   * `agent_prompt_stalled`.
   *
   * Herdr requires a lifecycle change within its own 5-second window after a
   * prompt is submitted, or it gives up waiting and says so. On a large brief
   * that window is genuinely too short: the text HAS been delivered and the
   * agent starts working a moment later. Observed live -- one run flipped to
   * `working` in time and one did not, with the same code and the same brief.
   */
  readonly stallPickupMs?: number;
  /** Writes the brief into the workspace instead of pasting it into the pane. */
  readonly briefWriter?: BriefWriter;
  /** Used only to CLEAR a previous turn's phase; the supervisor does the reading. */
  readonly phaseReader?: PhaseReader;
  /**
   * How long to wait for a freshly started agent to be able to take input.
   *
   * `agent start` is documented as returning once the agent is ready, and
   * usually is -- but observed live, a resumed Pi session was detected while
   * still printing banners and refused a prompt three seconds later with
   * `agent_not_ready`.
   */
  readonly readyWaitMs?: number;
  /**
   * How long to wait for the agent's OWN pane to show its interactive chrome
   * before falling back to Herdr's `interactive_ready`.
   *
   * Smaller than `readyWaitMs` on purpose: the marker appears within a second
   * or two when it appears at all, so a long budget here would only slow down
   * the pathological case, and the fallback is the behaviour that shipped
   * before this existed.
   */
  readonly readyMarkerWaitMs?: number;
  /** Bounded retries of a prompt refused with `agent_not_ready`. */
  readonly readyRetries?: number;
  /**
   * Checked immediately before every prompt attempt. Omitted means no check,
   * which is how the guard stays off by default. See `PromptGuard`.
   */
  readonly beforePrompt?: PromptGuard;
  /**
   * How long `cancel()` waits for an abandoned `runJob` to finish before it
   * declines to call anything stopped. Real time, not `sleep`.
   */
  readonly cancelDrainMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives Pi through Herdr's existing CLI. Pi remains the engineering
 * orchestrator; nothing here replaces it, and no agent is ever spawned outside
 * Herdr's supervision.
 *
 * Ownership is proved three ways before an existing agent is reused or any
 * workspace is closed: the agent name prefix, the workspace label prefix, and
 * an authoritative row recorded by the caller. The live host already has a
 * user workspace labelled exactly "ducky", so a label alone proves nothing.
 */
export class HerdrPiOrchestrator implements PiOrchestrator {
  readonly name = 'herdr-pi';
  readonly verified: boolean;

  private readonly herdr: HerdrClient;
  private readonly results: ResultReader;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly thinkingLevel: string;
  private readonly agentKind: string;
  private readonly resultSettleAttempts: number;
  private readonly resultSettleDelayMs: number;
  private readonly stallPickupMs: number;
  private readonly briefs: BriefWriter;
  private readonly phases: PhaseReader;
  private readonly readyWaitMs: number;
  private readonly readyMarkerWaitMs: number;
  private readonly readyRetries: number;
  private readonly beforePrompt: PromptGuard | undefined;
  private readonly cancelDrainMs: number;
  private readonly turns = new Map<string, TurnState>();

  constructor(opts: HerdrPiOptions) {
    this.herdr = opts.herdr;
    this.results = opts.resultReader ?? new FileResultReader();
    this.sleep = opts.sleep ?? defaultSleep;
    this.verified = opts.verified ?? false;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.thinkingLevel = opts.thinkingLevel ?? 'high';
    this.agentKind = opts.agentKind ?? 'pi';
    this.resultSettleAttempts = opts.resultSettleAttempts ?? 3;
    this.resultSettleDelayMs = opts.resultSettleDelayMs ?? 1_000;
    this.stallPickupMs = opts.stallPickupMs ?? 90_000;
    this.briefs = opts.briefWriter ?? new FileBriefWriter();
    this.phases = opts.phaseReader ?? new FilePhaseReader();
    this.readyWaitMs = opts.readyWaitMs ?? 120_000;
    this.readyMarkerWaitMs = opts.readyMarkerWaitMs ?? HERDR_READY_MARKER_WAIT_MS;
    this.readyRetries = opts.readyRetries ?? 3;
    this.beforePrompt = opts.beforePrompt;
    this.cancelDrainMs = opts.cancelDrainMs ?? 5_000;
  }

  /**
   * Stops waiting on a turn and reports what the agent is actually doing.
   *
   * Herdr exposes no verified way to interrupt a Pi turn without risking a
   * half-written edit, so this deliberately does NOT send keystrokes into a
   * live pane. `terminated: true` therefore means ONE thing: a positive proof
   * that the recorded agent is quiet. Everything else -- working, blocked,
   * unknown, absent, an agent that is not provably ours, a turn that may still be
   * dispatching, a prompt that was never seen to settle -- is `terminated:
   * false`, and the caller fails closed into an orphan reservation that keeps the
   * repository and the slot blocked for the owner. An owned-descendant stop
   * remains unsupported and unverified.
   */
  async cancel(spec: OrchestrationSpec): Promise<CancelOutcome> {
    const agentName = agentNameFor(spec.slugKey);
    const turn = this.turns.get(spec.jobId);
    const workspaceId = turn?.workspaceId ?? spec.recorded?.workspaceId;
    const keep = (agentStatus: CancelOutcome['agentStatus'], detail: string): CancelOutcome => ({
      terminated: false, agentStatus, detail, workspaceId, agentName,
    });

    // `runJob` was abandoned, not stopped. Give it a bounded moment to wind down
    // (the abort signal has already been raised), and never call anything quiet
    // while it might still dispatch a prompt.
    if (turn?.runActive) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        turn.finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.cancelDrainMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    if (turn?.runActive) {
      return keep(
        'unknown',
        'The turn may still be dispatching work to the agent, so nothing was called stopped; ' +
          'the repository stays reserved until you clear it.',
      );
    }
    if (turn?.promptSent && !turn.settled) {
      return keep(
        'unknown',
        'A prompt was handed to the agent and its turn was never observed to settle, so an idle ' +
          'reading may only mean it has not picked the work up yet; the repository stays reserved ' +
          'until you clear it.',
      );
    }

    let agent;
    try {
      agent = await this.herdr.agentGet(agentName);
    } catch {
      return keep('unknown', 'Herdr could not be reached to confirm whether the agent stopped.');
    }

    if (!agent) {
      // Nothing was ever started or recorded for this job, so there is nothing
      // of ours that could be running. Anything that WAS started and is now
      // absent is not proof it stopped: a vanished pane says nothing about a
      // process it may have outlived.
      if (!turn && !spec.recorded) {
        return {
          terminated: true, agentStatus: 'absent', workspaceId, agentName,
          detail: 'No agent was ever started for this job, so nothing is running.',
        };
      }
      return keep(
        'absent',
        'The agent could not be found, which is not proof that it stopped; the repository stays ' +
          'reserved until you clear it.',
      );
    }

    // Positive identity first: the recorded name AND workspace, the pane this
    // turn pinned, and a Ducky-managed workspace. A same-name agent anywhere else
    // is not "the agent" whatever its status says.
    const ours =
      workspaceId !== undefined &&
      this.isRecordedAgent(agent, { workspaceId, agentName, ...(turn?.paneId ? { paneId: turn.paneId } : {}) }) &&
      (await this.workspaceIsOurs(workspaceId));
    if (!ours) {
      return keep(
        agent.agent_status,
        'An agent with that name was found but is not provably the recorded Ducky agent, so it was ' +
          'left untouched and nothing was called stopped.',
      );
    }
    if (agent.agent_status === 'idle' || agent.agent_status === 'done') {
      return {
        terminated: true, agentStatus: agent.agent_status, workspaceId, agentName,
        detail: 'The agent finished its turn and is idle.',
      };
    }
    return keep(
      agent.agent_status,
      `The Pi agent is still ${agent.agent_status}. It was left untouched rather than ` +
        'interrupted mid-edit; the repository stays reserved until you clear it.',
    );
  }

  /**
   * Closes a Ducky workspace once its job succeeded.
   *
   * Ownership is proved again here rather than trusted from the caller: the
   * label must be Ducky-managed and the workspace must be the one recorded for
   * this job. A user's workspace can therefore never be closed, even if a
   * wrong id were somehow passed in. A still-working agent also blocks the
   * close, since finishing a result does not guarantee the pane is idle.
   */
  async cleanup(
    spec: OrchestrationSpec,
    workspaceId: string,
  ): Promise<{ closed: boolean; detail: string }> {
    if (spec.recorded?.workspaceId !== workspaceId) {
      return { closed: false, detail: 'That workspace is not the one recorded for this job.' };
    }
    this.turns.delete(spec.jobId);

    const workspaces = await this.herdr.workspaceList();
    const ws = workspaces.find((w) => w.workspace_id === workspaceId);
    if (!ws) return { closed: true, detail: 'The workspace was already gone.' };
    if (!(ws.label ?? '').startsWith(DUCKY_WORKSPACE_LABEL_PREFIX)) {
      return { closed: false, detail: 'That workspace is not Ducky-managed; it was left alone.' };
    }

    // Cleanup is destructive, so an unproven state must never authorise it.
    let agent;
    try {
      agent = await this.herdr.agentGet(agentNameFor(spec.slugKey));
    } catch {
      return {
        closed: false,
        detail: 'Herdr could not be reached to confirm the agent had stopped; the workspace was kept.',
      };
    }
    if (agent && (agent.agent_status === 'working' || agent.agent_status === 'blocked')) {
      return { closed: false, detail: `The agent is still ${agent.agent_status}; the workspace was kept.` };
    }

    if (spec.mode === 'worktree') {
      try {
        // Deliberately NOT forced. The checkout holds the implementation this
        // job produced and nothing has committed it -- the brief forbids
        // committing -- so a forced removal would delete the work itself.
        await this.herdr.worktreeRemove(workspaceId);
      } catch (err) {
        if (isDuckyError(err) && err.code === 'herdr_worktree_dirty') {
          return {
            closed: false,
            detail:
              'The worktree still has uncommitted changes, so it was kept rather than ' +
              'deleted. Inspect it and clear the job when you are done with it.',
          };
        }
        throw err;
      }
    } else {
      await this.herdr.workspaceClose(workspaceId);
    }
    return { closed: true, detail: 'Workspace closed.' };
  }

  async runJob(spec: OrchestrationSpec): Promise<OrchestrationOutcome> {
    const turn = this.beginTurn(spec);
    try {
      return await this.runJobInner(spec);
    } finally {
      turn.runActive = false;
      turn.finish();
    }
  }

  private beginTurn(spec: OrchestrationSpec): TurnState {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: TurnState = {
      agentName: agentNameFor(spec.slugKey),
      workspaceId: spec.recorded?.workspaceId,
      paneId: undefined,
      runActive: true,
      promptSent: false,
      settled: false,
      finished,
      finish,
    };
    this.turns.delete(spec.jobId);
    this.turns.set(spec.jobId, turn);
    // Bounded: only recent turns can still be cancelled, and the oldest go first.
    while (this.turns.size > MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
    return turn;
  }

  private async runJobInner(spec: OrchestrationSpec): Promise<OrchestrationOutcome> {
    if (!(await this.herdr.available())) return { kind: 'unavailable' };

    const agentName = agentNameFor(spec.slugKey);

    // A failure here is an OUTAGE, not an absent agent. Falling through to
    // fresh creation would risk a second workspace beside a live one.
    let existing;
    try {
      existing = await this.herdr.agentGet(agentName);
    } catch {
      return { kind: 'unavailable' };
    }

    if (existing) {
      const owned = await this.proveOwnership(existing, spec, agentName);
      if (!owned) return { kind: 'conflict', reason: 'foreign_agent_conflict', agentName };
      return this.resumeExisting(existing, spec, agentName, owned.workspacePath);
    }

    return this.startFresh(spec, agentName);
  }

  // --------------------------------------------------------------------------

  /**
   * All three conditions must hold. The recorded row is authoritative: without
   * it we never reuse, never prompt, and never close.
   */
  private async proveOwnership(
    agent: AgentInfo,
    spec: OrchestrationSpec,
    agentName: string,
  ): Promise<{ workspacePath: string } | undefined> {
    if (agent.name !== agentName || !agent.name.startsWith(DUCKY_AGENT_PREFIX)) return undefined;
    const recorded = spec.recorded;
    if (!recorded || recorded.agentName !== agentName) return undefined;
    if (agent.workspace_id && agent.workspace_id !== recorded.workspaceId) return undefined;

    const workspaces = await this.herdr.workspaceList();
    const ws = workspaces.find((w) => w.workspace_id === recorded.workspaceId);
    if (!ws || !(ws.label ?? '').startsWith(DUCKY_WORKSPACE_LABEL_PREFIX)) return undefined;

    return { workspacePath: recorded.workspacePath };
  }

  private async resumeExisting(
    agent: AgentInfo,
    spec: OrchestrationSpec,
    agentName: string,
    workspacePath: string,
  ): Promise<OrchestrationOutcome> {
    const workspaceId = spec.recorded!.workspaceId;
    const turn = this.turns.get(spec.jobId);
    if (turn) {
      turn.workspaceId = workspaceId;
      turn.paneId = agent.pane_id;
    }

    if (agent.agent_status === 'blocked') {
      // Herdr saw an approval or question UI in the pane. Answering it
      // automatically would be exactly the unattended decision the approval
      // gate exists to prevent, so fail closed and let the owner look.
      return { kind: 'orphan', reason: 'orphan_agent_blocked', workspaceId, agentName };
    }

    if (agent.agent_status === 'working') {
      const settled = await this.pollUntilSettled(agentName, spec.recoveryWaitMs, spec.signal);
      if (!settled) {
        return { kind: 'orphan', reason: 'orphan_agent_still_working', workspaceId, agentName };
      }
      if (settled === 'blocked') {
        return { kind: 'orphan', reason: 'orphan_agent_blocked', workspaceId, agentName };
      }
      const recovered = await this.results.read(workspacePath);
      if (recovered) {
        return { kind: 'result', result: recovered, workspaceId, agentName, workspacePath, reused: true };
      }
      return this.noResultOutcome({ workspaceId, agentName, workspacePath, paneId: agent.pane_id });
    }

    // idle or done. If a previous turn already wrote a result and only the
    // report was lost, submit it instead of re-running the work.
    if (spec.recoveryRequired) {
      const recovered = await this.results.read(workspacePath);
      if (recovered) {
        return { kind: 'result', result: recovered, workspaceId, agentName, workspacePath, reused: true };
      }
      // A recovery claim that meets a quiet agent with nothing written is the
      // same wall a pause was reported for (or one whose report was lost). It
      // must NOT send the brief again: that would spend model capacity on the
      // very turn that just produced nothing, with no owner in the loop. The
      // pause hands it to the owner, and resuming clears `recoveryRequired`.
      //
      // Whatever the fresh observation says is what is returned: a pause only
      // on positive identity and idle/done proof, otherwise the unproven
      // `no_result` or the working/blocked orphan. Falling through to a prompt
      // here would send model work without the proof this branch exists for.
      return this.noResultOutcome({ workspaceId, agentName, workspacePath, paneId: agent.pane_id });
    }

    // Pinned to the pane of the owned agent as first observed and proved, not to
    // whatever pane a later lookup by name happens to return.
    return this.promptAndSettle(spec, {
      workspaceId, agentName, workspacePath, reused: true, paneId: agent.pane_id,
    });
  }

  private async startFresh(spec: OrchestrationSpec, agentName: string): Promise<OrchestrationOutcome> {
    const label = workspaceLabelFor(spec.slugKey);

    let workspaceId: string;
    let rootPaneId: string;
    let workspacePath: string;

    if (spec.mode === 'worktree') {
      const wt = await this.herdr.worktreeCreate({
        cwd: spec.repoPath,
        branch: spec.branch,
        base: spec.base,
        // The workspace must be labelled Ducky-managed at CREATION. It is the
        // only evidence `cleanup()` has that the workspace is ours, and Herdr
        // will otherwise name it after the branch.
        label,
      });
      workspaceId = wt.workspaceId;
      rootPaneId = wt.rootPaneId;
      // Herdr checks a linked worktree out under its own directory, so the
      // result file lives there -- not under the source repository.
      workspacePath = wt.path;
    } else {
      const ws = await this.herdr.workspaceCreate(spec.repoPath, label);
      workspaceId = ws.workspaceId;
      rootPaneId = ws.rootPaneId;
      workspacePath = spec.repoPath;
    }

    const turn = this.turns.get(spec.jobId);
    if (turn) {
      turn.workspaceId = workspaceId;
      turn.paneId = rootPaneId;
    }
    await this.herdr.workspaceReportMetadata(workspaceId, { owner: 'ducky', job: spec.publicId });

    // Register ownership BEFORE an agent exists. A crash after this point still
    // leaves durable proof that the workspace is ours, so recovery reattaches
    // instead of treating a live agent as a stranger's.
    await spec.onWorkspaceCreated?.({
      workspaceId,
      agentName,
      label,
      mode: spec.mode,
      workspacePath,
      worktreePath: spec.mode === 'worktree' ? workspacePath : null,
    });

    await this.herdr.agentStart(agentName, this.agentKind, rootPaneId, [
      '--session-id', `ducky-${spec.slugKey}`,
      '--thinking', this.thinkingLevel,
    ]);
    // The agent exists now, so the record should no longer say `creating`.
    await spec.onAgentStarted?.({ workspaceId, agentName });

    // The pane is pinned to the root pane this very call started the agent in, so
    // a same-name agent that appears in another pane cannot be mistaken for it.
    return this.promptAndSettle(spec, {
      workspaceId, agentName, workspacePath, reused: false, paneId: rootPaneId,
    });
  }

  /**
   * Submits the brief, then decides the outcome from what Herdr actually
   * reports -- never from an assumption about what "the prompt returned" means.
   *
   * Four distinguishable endings, and collapsing any of them loses something:
   *
   * - `blocked`: Pi is showing an approval or question UI. The agent is ALIVE.
   *   Reading a missing result file here and reporting `no_result` (which is
   *   what happened before the settled agent was available) throws away the one
   *   fact that matters, and releases a repository whose pane still has a
   *   writer in it.
   * - the call THREW: the wait died, but the agent may not have. Nothing may be
   *   released until that is observed -- see `afterPromptFailure`.
   * - settled with a result: success.
   * - settled without a result: a genuine `no_result`, but only after the
   *   bounded re-read below, because a lifecycle change and a flushed file are
   *   not the same instant.
   */
  private async promptAndSettle(
    spec: OrchestrationSpec,
    at: { workspaceId: string; agentName: string; workspacePath: string; reused: boolean; paneId?: string },
  ): Promise<OrchestrationOutcome> {
    // The brief goes over as a FILE, and only a one-line pointer is pasted.
    // A 3.3 KB brief was measured on this host being left unsent in Pi's input
    // buffer, which stalled the prompt and failed the job without any work
    // starting. If the file cannot be written the job must fail here rather
    // than silently fall back to pasting and hit that again.
    // A resumed job reuses its workspace, so a phase from the PREVIOUS turn is
    // sitting there. Cleared before the brief goes over, or the new turn
    // inherits it and reports `verifying` while it is still planning.
    await this.phases.clear(at.workspacePath);

    const briefPath = await this.briefs.write(at.workspacePath, spec.brief);

    // The one phase this layer can honestly claim: the agent is up and the
    // brief is going over now, so Pi is about to start by planning. Everything
    // finer than this comes from Pi itself, through the phase file.
    spec.onPhase?.('planning');

    let settled: AgentInfo | undefined;
    try {
      settled = await this.submitWhenReady(at, briefPointerPrompt(briefPath), spec);
    } catch (err) {
      if (err instanceof PromptWithheld) return this.withheldOutcome(err, at);
      return this.afterPromptFailure(err, at, spec);
    }

    if (settled?.agent_status === 'blocked') {
      return {
        kind: 'orphan',
        reason: 'orphan_agent_blocked',
        workspaceId: at.workspaceId,
        agentName: at.agentName,
      };
    }

    const result = await this.readResultSettling(at.workspacePath);
    return result
      ? {
          kind: 'result',
          result,
          workspaceId: at.workspaceId,
          agentName: at.agentName,
          workspacePath: at.workspacePath,
          reused: at.reused,
        }
      : this.noResultOutcome(at);
  }

  /**
   * What a turn that settled WITHOUT a valid result means, decided from a fresh
   * observation of the agent rather than from the settle that led here.
   *
   * - `idle`/`done`, with the recorded name AND workspace AND a pane id: proven
   *   quiet, so `quiet_pause` (and only this earns the slot release it carries);
   * - `working`/`blocked`: the agent is alive, so each keeps its orphan outcome;
   * - absent, unknown, an unreadable answer, or an agent that is not provably
   *   ours: not quiet proof, so the unchanged `no_result` failure, which keeps
   *   the repository reserved for the owner.
   *
   * The screen is never read. Whether the agent stopped because of quota,
   * sign-in or anything else is not something Herdr's status can say.
   */
  private async noResultOutcome(
    at: { workspaceId: string; agentName: string; workspacePath: string; paneId?: string },
    cause: JobPauseCause = 'agent_idle_no_result',
    detail?: string,
  ): Promise<OrchestrationOutcome> {
    const base = { workspaceId: at.workspaceId, agentName: at.agentName };
    const noResult = {
      kind: 'no_result' as const,
      ...base,
      workspacePath: at.workspacePath,
      ...(detail === undefined ? {} : { detail }),
    };
    let agent: AgentInfo | undefined;
    try {
      agent = await this.herdr.agentGet(at.agentName);
    } catch {
      return noResult;
    }
    if (!agent || !this.isRecordedAgent(agent, at)) return noResult;
    if (agent.agent_status === 'blocked') {
      return { kind: 'orphan', reason: 'orphan_agent_blocked', ...base };
    }
    if (agent.agent_status === 'working') {
      return { kind: 'orphan', reason: 'orphan_agent_still_working', ...base };
    }
    if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') return noResult;
    if (!(await this.workspaceIsOurs(at.workspaceId))) return noResult;
    return {
      kind: 'quiet_pause',
      cause,
      observed: agent.agent_status,
      ...base,
      workspacePath: at.workspacePath,
    };
  }

  /**
   * Positive identity: the recorded name, the recorded workspace id, and a pane
   * -- the PINNED pane when one was fixed at the start or at the first owned
   * observation, so a same-name replacement elsewhere is not "the agent".
   */
  private isRecordedAgent(
    agent: AgentInfo,
    at: { workspaceId: string; agentName: string; paneId?: string },
  ): boolean {
    return (
      agent.name === at.agentName &&
      agent.name.startsWith(DUCKY_AGENT_PREFIX) &&
      typeof agent.workspace_id === 'string' &&
      agent.workspace_id === at.workspaceId &&
      agent.pane_id.length > 0 &&
      (at.paneId === undefined || agent.pane_id === at.paneId)
    );
  }

  private async workspaceIsOurs(workspaceId: string): Promise<boolean> {
    try {
      const ws = (await this.herdr.workspaceList()).find((w) => w.workspace_id === workspaceId);
      return ws !== undefined && (ws.label ?? '').startsWith(DUCKY_WORKSPACE_LABEL_PREFIX);
    } catch {
      return false;
    }
  }

  /**
   * The wait failed. Establish what the AGENT is doing before letting go of
   * anything.
   *
   * This is the branch that used to be missing. A prompt whose subprocess was
   * killed surfaced as `herdr_unavailable`, which is not an orphan reason, so
   * the coordinator released the repository reservation while a live Pi agent
   * kept writing to the worktree. An unproven state must never authorise a
   * release, so every outcome here except "the agent is provably gone or
   * provably finished" is an orphan.
   */
  private async afterPromptFailure(
    err: unknown,
    at: { workspaceId: string; agentName: string; workspacePath: string; reused: boolean; paneId?: string },
    spec?: OrchestrationSpec,
  ): Promise<OrchestrationOutcome> {
    // A STALL is not a failure of the submission. Herdr delivered the text and
    // then stopped waiting because it saw no lifecycle change within its own
    // 5-second window -- which a large brief routinely exceeds. Observed live:
    // two identical runs, one flipped to `working` in time and one did not.
    // Giving up here would fail a job whose agent is about to start working.
    if (spec !== undefined && isDuckyError(err) && err.code === 'herdr_prompt_stalled') {
      const resumed = await this.awaitStalledTurn(at.agentName, spec, at.workspacePath);
      // Seeing the agent work and then settle (or a result land) IS a settled
      // turn. No pickup observed is not, and stays unsettled.
      const stalledTurn = this.turns.get(spec.jobId);
      if (stalledTurn && (resumed === 'settled' || resumed === 'blocked')) stalledTurn.settled = true;
      if (resumed === 'blocked') {
        return {
          kind: 'orphan',
          reason: 'orphan_agent_blocked',
          workspaceId: at.workspaceId,
          agentName: at.agentName,
        };
      }
      if (resumed === 'still_working') {
        return {
          kind: 'orphan',
          reason: 'orphan_agent_still_working',
          workspaceId: at.workspaceId,
          agentName: at.agentName,
        };
      }
      if (resumed === 'settled') {
        const result = await this.readResultSettling(at.workspacePath);
        return result
          ? {
              kind: 'result',
              result,
              workspaceId: at.workspaceId,
              agentName: at.agentName,
              workspacePath: at.workspacePath,
              reused: at.reused,
            }
          : this.noResultOutcome(at);
      }
      // 'never_started': no pickup was observed within the grace and nothing was
      // written. That is a quiet agent without a result -- possibly one that
      // could not start the turn -- and it is paused for the owner when, and
      // only when, a fresh look proves the agent quiet. Anything else falls
      // through and reports the stall honestly.
    }

    let agent: AgentInfo | undefined;
    try {
      agent = await this.herdr.agentGet(at.agentName);
    } catch {
      // Cannot even ask. Treated exactly as a possibly-live writer, matching
      // `cancel()`, which also refuses to claim a termination it cannot see.
      return {
        kind: 'orphan',
        reason: 'orphan_agent_still_working',
        workspaceId: at.workspaceId,
        agentName: at.agentName,
      };
    }

    if (agent?.agent_status === 'blocked') {
      return {
        kind: 'orphan',
        reason: 'orphan_agent_blocked',
        workspaceId: at.workspaceId,
        agentName: at.agentName,
      };
    }
    if (agent?.agent_status === 'working') {
      return {
        kind: 'orphan',
        reason: 'orphan_agent_still_working',
        workspaceId: at.workspaceId,
        agentName: at.agentName,
      };
    }

    // Absent, idle or done: the agent is not writing. A result it managed to
    // finish before the wait broke is still valid and still the owner's work,
    // so it is submitted rather than discarded.
    const result = await this.readResultSettling(at.workspacePath);
    if (result) {
      return {
        kind: 'result',
        result,
        workspaceId: at.workspaceId,
        agentName: at.agentName,
        workspacePath: at.workspacePath,
        reused: at.reused,
      };
    }
    // A stalled turn that nobody picked up is the one failure that is also a
    // quiet agent without a result. Any other error stays an error: a
    // malformed or unexpected failure must not be relabelled as a pause.
    if (spec !== undefined && isDuckyError(err) && err.code === 'herdr_prompt_stalled') {
      const quiet = await this.noResultOutcome(at);
      if (quiet.kind === 'quiet_pause') return quiet;
    }
    // Nothing running and nothing written: re-raise so the caller reports the
    // real reason (a stall is not an outage) rather than inventing one here.
    throw err;
  }

  /**
   * The pre-prompt guard declined, so NO prompt was sent. The agent is paused
   * only after a fresh look proves it quiet (it was just started or resumed and
   * given nothing, so it normally is); anything unproven keeps the unchanged
   * fail-closed outcome, which retains the repository for the owner.
   */
  private withheldOutcome(
    err: PromptWithheld,
    at: { workspaceId: string; agentName: string; workspacePath: string; paneId?: string },
  ): Promise<OrchestrationOutcome> {
    return this.noResultOutcome(
      at,
      'memory_headroom_unproven',
      'The prompt was withheld before any model work was sent: ' + err.reason,
    );
  }

  /**
   * A fresh look at the agent, returned only when it is BOTH the recorded one
   * and in a state a prompt may be sent to: `idle` or `done`, and not reporting
   * `interactive_ready: false`. The guard calls this before its reads and again
   * after, so it can never permit a prompt into a working, blocked, unknown or
   * not-yet-ready target, whatever the readiness wait did or did not conclude.
   */
  private async proveAgent(
    at: { workspaceId: string; agentName: string; paneId?: string },
  ): Promise<PromptGuardTarget | undefined> {
    let agent: AgentInfo | undefined;
    try {
      agent = await this.herdr.agentGet(at.agentName);
    } catch {
      return undefined;
    }
    if (!agent || !this.isRecordedAgent(agent, at)) return undefined;
    if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') return undefined;
    if (agent.interactive_ready === false) return undefined;
    return { agentName: at.agentName, workspaceId: at.workspaceId, paneId: agent.pane_id };
  }

  private async assertPromptAllowed(
    at: { workspaceId: string; agentName: string; paneId?: string },
  ): Promise<void> {
    if (!this.beforePrompt) return;
    const target = await this.proveAgent(at);
    if (!target) {
      throw new PromptWithheld('the target agent could not be positively identified as the recorded one and ready for input');
    }
    let verdict;
    try {
      verdict = await this.beforePrompt(target, { proveAgent: () => this.proveAgent(at) });
    } catch {
      throw new PromptWithheld('the memory headroom check failed unexpectedly');
    }
    if (!verdict.ok) throw new PromptWithheld(verdict.reason);
  }

  /**
   * Reads the result file, retrying a bounded number of times.
   *
   * Not a poll for work to finish -- the turn has already settled. This closes
   * the gap between the lifecycle change herdr observed and the agent's last
   * write landing on disk.
   */
  private async readResultSettling(workspacePath: string) {
    const attempts = Math.max(1, this.resultSettleAttempts);
    for (let i = 0; i < attempts; i += 1) {
      const result = await this.results.read(workspacePath);
      if (result) return result;
      if (i < attempts - 1) await this.sleep(this.resultSettleDelayMs);
    }
    return undefined;
  }

  /**
   * Submits the prompt, waiting for the agent to be able to receive it.
   *
   * Two guards, both learned from live runs rather than assumed:
   *
   * - before the first attempt, the agent is observed until it reports a
   *   settled status and does not say `interactive_ready: false`;
   * - a refusal with `agent_not_ready` is RETRIED a bounded number of times,
   *   because it is transient. It is never retried for any other reason: a
   *   second prompt to an agent that did receive the first would be a second
   *   writer.
   */
  private async submitWhenReady(
    at: { workspaceId: string; agentName: string; paneId?: string },
    text: string,
    spec: OrchestrationSpec,
  ): Promise<AgentInfo | undefined> {
    const agentName = at.agentName;
    await this.awaitInteractiveReady(agentName, spec);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.readyRetries; attempt += 1) {
      if (spec.signal?.aborted) break;
      // At the last safe boundary, on EVERY attempt: a retry after
      // `agent_not_ready` is a second chance to send model work, and the agent
      // may since have moved into a tighter cgroup.
      await this.assertPromptAllowed(at);
      // Marked BEFORE the call, because the text may reach the agent even if the
      // call is later abandoned or fails: from here a quiet reading proves
      // nothing until the turn is seen to settle.
      const turn = this.turns.get(spec.jobId);
      if (turn) {
        turn.promptSent = true;
        turn.settled = false;
      }
      try {
        const settled = await this.herdr.agentPrompt(agentName, text, spec.promptTimeoutMs, spec.signal);
        if (
          turn &&
          settled &&
          (settled.agent_status === 'idle' || settled.agent_status === 'done' || settled.agent_status === 'blocked')
        ) {
          turn.settled = true;
        }
        return settled;
      } catch (err) {
        if (!(isDuckyError(err) && err.code === 'herdr_agent_not_ready')) throw err;
        // Refused as not ready: the text was NOT accepted.
        if (turn) turn.promptSent = false;
        lastError = err;
        // Not yet promptable. Wait for readiness again and try once more.
        await this.sleep(this.pollIntervalMs);
        await this.awaitInteractiveReady(agentName, spec);
      }
    }
    throw lastError ??
      new DuckyError('herdr_agent_not_ready', 'The agent never became ready for input.');
  }

  /**
   * Observes an agent until it can actually take input, or the budget ends.
   *
   * Two signals, and the order matters because they disagree:
   *
   * - **Herdr's own** `agent_status` / `interactive_ready`. Necessary, not
   *   sufficient: it is documented (integrations/herdr.md) to report a resumed
   *   Pi ready while it is still painting startup banners, and a prompt
   *   submitted in that window is silently dropped.
   * - **The agent's own terminal output**, read with `agent read --source
   *   detection` and classified by `observePiPromptReady`. That is the signal
   *   Herdr's readiness field was standing in for, so it is the one worth
   *   waiting on.
   *
   * The marker is a POSITIVE signal with its own smaller budget. When it
   * appears the wait ends immediately -- the common case, in a second or two.
   * When the budget runs out without it, or the read is unavailable, this falls
   * back to exactly the previous behaviour and lets the prompt attempt report
   * the real problem: a host whose agent chrome we no longer recognise is no
   * worse off than before, and `agent_prompt_stalled` is already handled
   * honestly (bounded observation, never a re-prompt, workspace and reservation
   * retained).
   *
   * Nothing here sleeps for a guessed interval and then assumes readiness.
   */
  private async awaitInteractiveReady(
    agentName: string,
    spec: OrchestrationSpec,
  ): Promise<void> {
    const deadline = Date.now() + this.readyWaitMs;
    const markerDeadline = Date.now() + this.readyMarkerWaitMs;
    let readUnavailable = false;
    let consecutive = 0;

    while (Date.now() < deadline) {
      if (spec.signal?.aborted) return;
      let now: AgentInfo | undefined;
      try {
        now = await this.herdr.agentGet(agentName);
      } catch {
        return; // let the prompt attempt report the real problem
      }
      // Absent, or already working on something: nothing useful to wait for.
      if (!now || now.agent_status === 'working' || now.agent_status === 'blocked') return;

      const herdrSaysReady = now.interactive_ready !== false;

      if (!readUnavailable && Date.now() < markerDeadline) {
        try {
          const observed = observePiPromptReady(
            await this.herdr.agentRead(agentName, { source: 'detection' }),
          );
          // The frame paints over a second or two, so one glimpse of it can be
          // a half-drawn UI. Stability is expressed in observations, never in a
          // sleep-and-assume.
          consecutive = observed.ready ? consecutive + 1 : 0;
          if (consecutive >= PI_READY_CONSECUTIVE_OBSERVATIONS) return;
          // An EMPTY snapshot is not evidence of banners -- it is the absence of
          // an observation, and spending the whole marker budget on it would
          // delay every job on a host where the read answers nothing. A real
          // banner phase is not empty: the recorded one was 190 bytes of
          // update notices.
          if (observed.reason === 'empty') {
            readUnavailable = true;
            continue;
          }
          // Herdr may say ready and the pane disagree. That IS the bug, so the
          // pane wins while there is budget left to keep looking.
          await this.sleep(this.pollIntervalMs);
          continue;
        } catch {
          // Reading the pane is an observation, not a dependency. An older
          // Herdr, a refused command or a dead socket must not block a job.
          readUnavailable = true;
        }
      }

      if (herdrSaysReady) return;
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Keeps watching an agent whose prompt Herdr stopped waiting on.
   *
   * Two stages, because "idle right now" means two different things a few
   * seconds after a prompt: the agent has not picked the work up yet, or it
   * finished a very fast turn. So this first waits a bounded grace for the
   * agent to be seen WORKING (checking for a result file each time, in case the
   * turn was simply quick), and only then waits for it to settle.
   *
   * Never restarts, never re-prompts, never sends a keystroke: a duplicate
   * prompt to an agent that did pick the work up would be a second writer.
   */
  private async awaitStalledTurn(
    agentName: string,
    spec: OrchestrationSpec,
    workspacePath: string,
  ): Promise<'settled' | 'blocked' | 'still_working' | 'never_started' | undefined> {
    const pickupDeadline = Date.now() + this.stallPickupMs;
    let observedWorking = false;

    while (Date.now() < pickupDeadline) {
      if (spec.signal?.aborted) return 'still_working';
      let now: AgentInfo | undefined;
      try {
        now = await this.herdr.agentGet(agentName);
      } catch {
        // Cannot observe: assume the worst rather than release anything.
        return 'still_working';
      }
      if (!now) return 'settled';
      if (now.agent_status === 'blocked') return 'blocked';
      if (now.agent_status === 'working') {
        observedWorking = true;
        break;
      }
      // Idle or done. It may have finished before we ever looked.
      if (await this.results.read(workspacePath)) return 'settled';
      await this.sleep(this.pollIntervalMs);
    }

    if (!observedWorking) return 'never_started';

    const settled = await this.pollUntilSettled(agentName, spec.promptTimeoutMs, spec.signal);
    if (settled === 'blocked') return 'blocked';
    return settled === 'settled' ? 'settled' : 'still_working';
  }

  /** Reattach rather than restart: never kill a writer that may still be live. */
  private async pollUntilSettled(
    agentName: string,
    waitMs: number,
    signal?: AbortSignal | undefined,
  ): Promise<'settled' | 'blocked' | undefined> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return undefined;
      await this.sleep(this.pollIntervalMs);
      const now = await this.herdr.agentGet(agentName);
      if (!now) return 'settled';
      if (now.agent_status === 'blocked') return 'blocked';
      if (now.agent_status === 'idle' || now.agent_status === 'done') return 'settled';
    }
    return undefined;
  }
}
