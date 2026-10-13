import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_CARD_DETAIL_MAX, GRILL_SESSION_TTL_MS, QUEUE_STATE_LABEL, STALE_RUN_AFTER_MS,
  DuckyError, isTicketRepository, newPublicAgentRunId, newUuid, parseSkillCommand,
  preflightTicketSpec,
  type AgentCardStatus, type ParsedSkillCommand, type QueueState, type SkillCommand,
  type TicketSpec,
} from '@ducky/contracts';
import type { ConversationProvider, FrontDoorInspection, FrontDoorPort } from '@ducky/adapters';
import type { AgentThreadRow, Store } from '@ducky/persistence';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { ComponentSigner } from '../security/component-signing.js';
import type { DiscordTransport } from '../discord/transport.js';
import type { IncomingContext } from '../discord/transport.js';
import { channelTarget, dmTarget, type OutboundMessage, type SendTarget } from '../discord/message.js';
import type { OwnerClock } from './owner-clock.js';
import * as cards from '../discord/agent-presenters.js';

/**
 * One repository the owner configured that the workflow can address.
 *
 * `repository` is `owner/name` and is the ONLY form that ever reaches Discord.
 * `checkoutRoot` is a host path, kept so a follow-up helper call reaches the
 * same checkout, and never rendered.
 */
export interface WorkflowRepository {
  readonly slug: string;
  readonly repository: string;
  readonly checkoutRoot: string | null;
}

export interface SkillBridgeConfig {
  readonly enabled: boolean;
  /**
   * Absolute path to the INSTALLED upstream grilling skill.
   *
   * Read at call time and handed to the conversation provider as instructions
   * for that turn. Never copied into this repository and never stored: the
   * skill belongs to the user's own installation, and a copy here would be a
   * second thing to keep in step with it.
   */
  readonly grillSkillPath?: string | undefined;
}

/** The maximum the grill skill may contribute to one prompt. */
const GRILL_SKILL_MAX_BYTES = 32 * 1024;

export interface SkillBridgeDeps {
  readonly store: Store;
  readonly authz: Authorizer;
  readonly signer: ComponentSigner;
  readonly frontDoor: FrontDoorPort;
  readonly transport: DiscordTransport;
  readonly conversation: ConversationProvider;
  readonly clock: OwnerClock;
  readonly config: SkillBridgeConfig;
  /** The configured repositories that have a GitHub identity. Frozen config. */
  readonly repositories: () => readonly WorkflowRepository[];
  /** Fire-and-forget. A record is never worth failing a command. */
  readonly audit?: (info: {
    command: SkillCommand;
    outcome: 'ok' | 'refused' | 'failed';
    status: AgentCardStatus;
  }) => void;
}

/**
 * The owner-only bridge from a Discord thread to the installed repository
 * workflow.
 *
 * WHAT IT DOES NOT DO, because that is the shorter and more important list:
 *
 * - It does not create GitHub issues, apply labels, or touch a Beads graph.
 *   The installed publisher owns all three, and Ducky has no second path to
 *   any of them -- a test asserts this module names no `gh` surface.
 * - It does not start, stop or restart a worker, a service or a dispatcher.
 *   Queueing is the exact `agent:ready` label and nothing more, and the card
 *   says so in words.
 * - It does not submit a Ducky executor job. `JobsService` is not a
 *   dependency here; the two paths are separate and neither can reach the
 *   other.
 * - It does not generate requirements. Every acceptance criterion in a
 *   published ticket is a line the owner typed in this thread.
 */
export class SkillBridgeService {
  /**
   * One abort handle per thread with a live run.
   *
   * It reaches the READ-ONLY helper calls only -- `inspect` and `validate`.
   * `ticket` and `agentize` are deliberately NOT abortable: killing the
   * publisher mid-flight could leave a GitHub issue created and its canonical
   * read-back unverified, which is a worse outcome than a cancel that arrives
   * a few seconds late. This is the same judgement the job path already makes
   * about interrupting a working agent: stop waiting, then report honestly
   * what the thing we could not interrupt actually did.
   */
  readonly #aborts = new Map<string, AbortController>();

  constructor(private readonly deps: SkillBridgeDeps) {}

  get enabled(): boolean {
    return this.deps.config.enabled && this.deps.frontDoor.availability().usable;
  }

  /** One line for `/status` and the boot diagnostics. */
  describe(): string {
    if (!this.deps.config.enabled) return 'off — $grill-me, $ticket and $agentize are inert';
    const availability = this.deps.frontDoor.availability();
    if (!availability.usable) return `unavailable — ${availability.detail}`;
    return availability.mutationEnabled
      ? 'on — grill, ticket and agentize through the installed helper'
      : 'on, reads only — publishing and onboarding are not enabled';
  }

  /**
   * Handles one owner message, or declines to.
   *
   * `undefined` means "this is not a workflow message" and the caller falls
   * through to its ordinary handling. It is the answer for every message from
   * anybody but the owner, which is what keeps an authorized friend on
   * general chat even in a channel where they can see the owner's cards.
   */
  async handle(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
  ): Promise<OutboundMessage | undefined> {
    /**
     * Owner-only, and a non-owner is answered with SILENCE here rather than a
     * refusal: their message is ordinary conversation and goes where ordinary
     * conversation goes. `requireOwner` is still called again at the top of
     * every command below, so a routing mistake cannot reach a helper.
     */
    if (!this.deps.authz.isOwner(actor)) return undefined;

    /**
     * Recover an abandoned run before deciding anything else.
     *
     * A coordinator killed mid-call leaves a run that never finished, and the
     * single-writer gate would then refuse every later command in this thread
     * -- one crash, one permanently unusable thread. Swept HERE, on use,
     * rather than on a timer: there is one place that decides, it decides
     * from the row's own start time, and it costs one read on a path that
     * already reads the row. The same shape the intent proposals use.
     */
    await this.expireAbandonedRun(actor, event);

    const parsed = parseSkillCommand(event.text);
    if (!parsed) return this.continueGrill(actor, event);

    if (!this.deps.config.enabled) {
      return cards.unavailable(
        'The repository workflow is not enabled on this instance. Nothing was read or created.',
      );
    }
    const availability = this.deps.frontDoor.availability();
    if (!availability.usable) return cards.unavailable(availability.detail);

    switch (parsed.command) {
      case '$grill-me':
        return this.grill(actor, event, parsed);
      case '$ticket':
        return this.ticket(actor, event, parsed);
      case '$agentize':
        return this.agentize(actor, event, parsed);
    }
  }

  // ---- $grill-me -----------------------------------------------------------

  /**
   * Opens an interview about the bound repository.
   *
   * Conversation-only, exactly as the installed skill is. The repository is
   * READ -- `inspect` without `--network` -- and nothing else happens: no
   * issue, no label, no worker, and no Ducky job.
   */
  private async grill(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
    parsed: ParsedSkillCommand,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireOwner(actor);

    /**
     * Refused BEFORE anything is read or any card exists.
     *
     * A grill is a conversation with a model. Without a verified provider
     * there is no interview to conduct, and Ducky generates no prose of its
     * own -- so the honest answer is to say so rather than to print questions
     * from a fixed list and call it grilling.
     */
    if (!this.deps.conversation.verified) {
      return cards.unavailable(
        `Grilling needs a verified assistant provider and this instance has ${
          this.deps.conversation.name
        }. Nothing was read.`,
      );
    }

    /**
     * The INSTALLED skill, or no grill at all. Checked here, before a card
     * exists and before the repository is read.
     *
     * The acceptance criterion is that `$grill-me` loads the installed
     * upstream skill. An interview Ducky improvised because the file was
     * missing is not that skill, and it is the worse of the two failures: the
     * owner believes they are being grilled by the method they chose, and
     * they are not. So this refuses and names what is wrong.
     */
    const skill = this.grillSkill();
    if (!skill.ok) return cards.unavailable(skill.reason);

    const target = this.resolveTarget(actor, event.threadKey, parsed.args);
    if ('ask' in target) return target.ask;

    const run = this.startRun(actor, event, '$grill-me', 'scanning', parsed.ready);
    if (!run) {
      const live = this.deps.store.agentThreads.liveRun(actor.discordUserId, event.threadKey);
      return live ? this.busy(live) : cards.unavailable('That could not be started. Try again.');
    }
    await this.showCard(actor, event, run);

    let found: FrontDoorInspection;
    try {
      // Local read only. `--network` would reach GitHub, and fact-finding for
      // a conversation does not need it. Abortable, because it is read-only.
      found = await this.deps.frontDoor.inspect({
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        repository: target.repo.repository,
        ...(this.signalFor(actor, event.threadKey)
          ? { signal: this.signalFor(actor, event.threadKey)! }
          : {}),
      });
    } catch (err) {
      return this.failRun(actor, event, run, err);
    }
    if (!this.stillLive(actor, event.threadKey, run.runId)) {
      this.releaseRun(actor, event.threadKey);
      return this.stoppedReply();
    }

    const row = this.deps.store.agentThreads.setGrilling(
      actor.discordUserId, event.threadKey, true, this.now(),
    );
    const scanned = this.deps.store.agentThreads.updateRun(
      actor.discordUserId, event.threadKey, run.runId,
      { status: 'grilling', detail: describeScan(found) },
      this.now(),
    ) ?? row;
    await this.showCard(actor, event, scanned);

    // The owner's own opening words, if they typed any, are the first thing
    // the interview is about -- and the first thing `$ticket` will read back.
    if (target.intent !== '') {
      this.deps.store.agentThreads.appendNote(
        actor.discordUserId, event.threadKey, target.intent, this.now(),
      );
    }
    /**
     * A grill is CONVERSATIONAL from here on, so the run is released and
     * marked finished: the card has done its job, the interview continues as
     * messages, and the thread must be free for the `$ticket` that follows.
     * There is no step left for a Cancel to stop, and leaving the run open
     * would block the command the grill exists to lead to.
     */
    this.deps.store.agentThreads.updateRun(
      actor.discordUserId, event.threadKey, run.runId,
      { status: 'grilling', finished: true },
      this.now(),
    );
    this.releaseRun(actor, event.threadKey);
    return this.grillTurn(
      actor, event, scanned, target.intent || 'Start the interview.', skill, found,
    );
  }

  /**
   * A plain reply while a grill is active.
   *
   * This is what makes "plain replies continue the active interview" true, and
   * it runs BEFORE the ordinary conversation-silence rule so a coding channel
   * does not swallow the owner's own answers.
   */
  private async continueGrill(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
  ): Promise<OutboundMessage | undefined> {
    if (!this.deps.config.enabled) return undefined;
    const row = this.deps.store.agentThreads.get(actor.discordUserId, event.threadKey);
    if (!row?.grilling) return undefined;

    // A grill that has been idle this long is over. Expiring it here rather
    // than on a timer means there is one place that decides, and it decides
    // from the row itself.
    const startedMs = Date.parse(row.grillStartedAt ?? row.updatedAt);
    if (Number.isFinite(startedMs) && this.deps.clock.nowMs() - startedMs > GRILL_SESSION_TTL_MS) {
      this.deps.store.agentThreads.setGrilling(
        actor.discordUserId, event.threadKey, false, this.now(),
      );
      return undefined;
    }
    if (event.text.trim() === '') return undefined;

    /**
     * The same gate the opening turn passes, re-checked every turn.
     *
     * The owner edits their own skills, so a file that was readable when the
     * interview opened may not be now. Continuing under an improvised method
     * would be the same lie, arrived at more slowly -- so the interview CLOSES
     * and says why.
     */
    const skill = this.grillSkill();
    if (!skill.ok) {
      this.deps.store.agentThreads.setGrilling(
        actor.discordUserId, event.threadKey, false, this.now(),
      );
      return cards.unavailable(`${skill.reason} The grill is closed.`);
    }

    this.deps.store.agentThreads.appendNote(
      actor.discordUserId, event.threadKey, event.text, this.now(),
    );
    return this.grillTurn(actor, event, row, event.text, skill);
  }

  /**
   * One interview turn, conducted by the provider under the INSTALLED skill's
   * own instructions.
   *
   * The skill text is passed IN rather than read here, so there is exactly one
   * place that decides whether a usable skill exists and exactly one answer
   * when it does not. A turn cannot happen without one.
   */
  private async grillTurn(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
    row: AgentThreadRow,
    text: string,
    skill: UsableSkill,
    found?: FrontDoorInspection,
  ): Promise<OutboundMessage> {
    const instructions = [
      skill.text,
      `The repository under discussion is ${row.repository ?? 'not yet chosen'}.`,
      ...(found ? [`Repository facts observed just now: ${describeScan(found)}.`] : []),
      'This is a conversation only. Do not claim to have created an issue, applied a label, ' +
        'started a worker or changed any file. The owner creates work with $ticket.',
    ];

    try {
      const reply = await this.deps.conversation.reply({
        userId: actor.discordUserId,
        text,
        threadKey: event.threadKey,
        instructions,
      });
      return { content: reply.mock ? `[mock] ${reply.text}` : reply.text, ephemeral: false };
    } catch {
      // The provider refused or failed. The grill stays open -- the owner can
      // try again -- and nothing is claimed about what was understood.
      return {
        content: 'The assistant could not answer that turn. The grill is still open; try again.',
        ephemeral: false,
      };
    }
  }

  /**
   * The installed skill text, or the reason there is none.
   *
   * Read fresh on every turn rather than cached: the user owns that file and
   * may edit it, and a cached copy is exactly the drift this design exists to
   * avoid.
   *
   * There is no fallback. Every failure here REFUSES, because the only
   * alternative is handing the model something that is not the owner's chosen
   * method and letting it improvise -- which reads, to the person being
   * interviewed, exactly like the real thing.
   */
  private grillSkill(): LoadedSkill {
    const file = this.deps.config.grillSkillPath;
    if (!file || !path.isAbsolute(file)) {
      return {
        ok: false,
        reason:
          'The installed grilling skill is not configured on this instance, so there is no ' +
          'interview method to load. Nothing was read.',
      };
    }
    const first = readSkillFile(file);
    if (!first.ok) return first;

    /**
     * One hop through the installed skill's OWN redirect.
     *
     * `grill-me/SKILL.md` as installed is a pointer whose entire body is
     * `Call the Skill tool with "grilling"` -- the method lives in a sibling
     * directory. An operator configuring the obvious path would otherwise
     * hand the model a pointer and get an invented interview, which is the
     * failure this whole function exists to prevent. So the redirect is
     * followed, ONCE: a second hop would be a loop waiting to happen, and a
     * pointer to a pointer is not an installation anybody meant.
     */
    const redirect = redirectTarget(first.text);
    if (redirect === undefined) return first;

    const sibling = path.join(path.dirname(path.dirname(file)), redirect, 'SKILL.md');
    const second = readSkillFile(sibling);
    if (!second.ok) return second;
    // A pointer to another pointer is not a method.
    return redirectTarget(second.text) === undefined
      ? second
      : {
          ok: false,
          reason:
            'The installed grilling skill points at another pointer rather than at a method. ' +
            'Nothing was read.',
        };
  }

  // ---- $ticket -------------------------------------------------------------

  /**
   * Turns the thread's settled intent into a canonical TicketSpec and hands it
   * to the installed publisher.
   *
   * The spec is built from the owner's OWN lines -- the argument text and the
   * grill notes -- plus facts the scan observed. Nothing is invented: an
   * acceptance criterion that nobody typed would be a requirement Ducky made
   * up, and a ticket is a contract.
   */
  private async ticket(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
    parsed: ParsedSkillCommand,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireOwner(actor);

    const target = this.resolveTarget(actor, event.threadKey, parsed.args);
    if ('ask' in target) return target.ask;

    const run = this.startRun(actor, event, '$ticket', 'scanning', parsed.ready);
    if (!run) {
      const live = this.deps.store.agentThreads.liveRun(actor.discordUserId, event.threadKey);
      return live ? this.busy(live) : cards.unavailable('That could not be started. Try again.');
    }
    await this.showCard(actor, event, run);

    let found: FrontDoorInspection;
    try {
      // `--network` here, and not for the grill: publication has to know the
      // repository really exists and whether it is registered, because
      // queueing is refused without an enabled registration.
      found = await this.deps.frontDoor.inspect({
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        repository: target.repo.repository,
        network: true,
        ...(this.signalFor(actor, event.threadKey)
          ? { signal: this.signalFor(actor, event.threadKey)! }
          : {}),
      });
    } catch (err) {
      // Before any publish attempt: no label can exist, so this is a true
      // negative rather than an unknown.
      return this.failRun(actor, event, run, err, { queueState: 'not_queued' });
    }
    if (!this.stillLive(actor, event.threadKey, run.runId)) {
      this.releaseRun(actor, event.threadKey);
      return this.stoppedReply();
    }

    // The repository token, when one was typed, has already been removed: it
    // is addressing, not a statement about what the work is.
    const notes = this.settledIntent(actor, event.threadKey, target.intent);

    /**
     * The SECOND half of the owner's two-step.
     *
     * A bare `$ticket` creates unqueued GitHub work; `$ticket --ready`
     * separately authorizes it. When the owner has said nothing new -- no
     * argument text, no grill notes since -- `--ready` means "queue the
     * ticket this thread just published", and it reaches the original
     * canonical id, the original spec and the original issue.
     *
     * Order matters: notes are checked FIRST, so anything newly settled is a
     * new ticket rather than an authorization of an old one. Silently queueing
     * fresh intent onto a published issue would rewrite a contract somebody
     * may already be acting on.
     */
    if (notes.length === 0) {
      const settled = this.settledTicket(actor, event.threadKey, target.repo.repository);
      if (settled && parsed.ready) {
        /**
         * The scan's completion policy goes with it.
         *
         * The single-step path tells the owner what queueing can END in --
         * whether the dispatcher may merge the resulting pull request -- at
         * the moment they queue. The two-step reaches the same place by a
         * different route, so it has to carry the same warning: a policy
         * stated on only one path is one the owner learns about by accident.
         */
        return this.authorizeSettled(
          actor, event, run, target, settled, found.completionPolicy,
        );
      }
      if (settled) {
        // A bare `$ticket` NEVER authorizes. It points at the step that does.
        return this.endRun(
          actor, event, run, 'published',
          'This thread already has an unqueued ticket.',
          {
            content:
              `This thread already published \`${settled.repository}\`#${settled.issueNumber}, ` +
              'and it is not queued. Send `$ticket --ready` on its own to authorize it, or ' +
              'describe different work to make a new ticket.' +
              (settled.issueUrl ? `\n${settled.issueUrl}` : ''),
            ephemeral: false,
          },
          'not_requested',
          { issueNumber: settled.issueNumber, issueUrl: settled.issueUrl },
        );
      }
    }
    if (notes.length === 0) {
      const asked = this.deps.store.agentThreads.updateRun(
        actor.discordUserId, event.threadKey, run.runId,
        {
          status: 'needs_input',
          detail: 'No settled intent in this thread yet.',
          finished: true,
        },
        this.now(),
      ) ?? run;
      await this.showCard(actor, event, asked);
      return {
        content:
          'Nothing in this thread says what the work is yet. Say it in the command, as in ' +
          '`$ticket add a health endpoint`, or run `$grill-me` first. Nothing was created.',
        ephemeral: false,
      };
    }

    const spec = this.buildSpec(actor, event.threadKey, target.repo.repository, notes, found);
    const problem = preflightTicketSpec(spec);
    if (problem) {
      return this.failRun(
        actor, event, run, new DuckyError('invalid_input', problem),
        { queueState: 'not_queued' },
      );
    }

    // No new detail: what the scan found still reads true, and `updateRun`
    // treats an omitted detail as unchanged.
    const publishing = this.deps.store.agentThreads.updateRun(
      actor.discordUserId, event.threadKey, run.runId,
      { status: 'publishing' },
      this.now(),
    ) ?? run;
    await this.showCard(actor, event, publishing);

    /**
     * The INSTALLED validator decides, not the preflight above.
     *
     * A spec Ducky believes is fine but the canonical schema refuses must stop
     * here, with the schema's own reason -- otherwise the two would drift and
     * Ducky's opinion would be the one nobody was checking.
     */
    try {
      const validated = await this.deps.frontDoor.validate(
        spec,
        this.signalFor(actor, event.threadKey),
      );
      if (!validated.ok) {
        return this.failRun(
          actor, event, publishing,
          new DuckyError('invalid_input', validated.error ?? 'the canonical schema refused it'),
          { queueState: 'not_queued' },
        );
      }
    } catch (err) {
      return this.failRun(actor, event, publishing, err, { queueState: 'not_queued' });
    }
    /**
     * The LAST point at which cancelling still prevents something.
     *
     * Everything above is read-only and abortable. `publish` is neither:
     * killing it could leave a GitHub issue created and its canonical
     * read-back unverified, which is worse than a cancel landing a few
     * seconds late. So the decision is made here, once, before the
     * irreversible call.
     */
    if (!this.stillLive(actor, event.threadKey, run.runId)) {
      this.releaseRun(actor, event.threadKey);
      return this.stoppedReply();
    }

    if (!this.deps.frontDoor.availability().mutationEnabled) {
      return this.failRun(
        actor, event, publishing,
        new DuckyError(
          'not_enabled_in_phase1',
          'the ticket is valid, but publishing is not enabled on this instance, so no issue was created',
        ),
        { queueState: 'not_queued' },
      );
    }

    const row = this.deps.store.agentThreads.get(actor.discordUserId, event.threadKey);
    try {
      const published = await this.deps.frontDoor.publish({
        spec,
        // Never derived from text. This boolean came from a bare `--ready`
        // token the owner typed in this message.
        ready: parsed.ready,
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        // Reusing the issue number is what makes a retry enrich rather than
        // duplicate. The canonical id does the same job on the helper's side.
        ...(row?.issueNumber ? { issue: row.issueNumber } : {}),
        /**
         * Classification labels the OWNER named, and never one Ducky chose.
         *
         * The helper applies them and reads them back; the adapter refuses
         * `agent:*` before a spawn, so a classification can never become the
         * label that authorizes implementation.
         */
        ...(parsed.labels.length > 0 ? { labels: parsed.labels } : {}),
      });

      if (!published.ok) {
        /**
         * The publisher ran and refused. Whether a label landed depends on
         * how far it got, and its answer cannot tell us: the helper applies
         * `agent:ready` and THEN verifies it, and its failure path resets
         * `queued` to false either way. So a run that ASKED to queue reports
         * `unknown`, and one that did not asked for no label at all.
         */
        return this.failRun(
          actor, event, publishing,
          new DuckyError('invalid_input', published.error ?? 'the publisher refused it'),
          {
            queueState: parsed.ready ? 'unknown' : 'not_requested',
            ...(published.issue === undefined ? {} : { issueNumber: published.issue }),
            ...(published.url === undefined ? {} : { issueUrl: published.url }),
          },
        );
      }

      /**
       * Recorded FIRST, and keyed on this run.
       *
       * The issue exists whatever happened to the run while the publisher
       * worked, and the thread needs its number so a retry enriches rather
       * than opening a second one. Keying on the run is what stops a late
       * answer attaching its issue to whatever the thread is doing now.
       */
      this.deps.store.agentThreads.setPublication(
        actor.discordUserId, event.threadKey, run.runId,
        { issueNumber: published.issue ?? null, issueUrl: published.url ?? null },
        this.now(),
      );

      /**
       * The window this whole mechanism exists for: the owner cancelled while
       * the publisher was running, and the publisher finished anyway.
       *
       * Both halves of the honest answer matter. The card stays CANCELLED --
       * rewriting it to "queued" would report a success for work the owner
       * stopped. And the owner is told what the publisher had already done,
       * with the URL, because silence about an issue that now exists is the
       * other half of the same lie.
       */
      if (!this.stillLive(actor, event.threadKey, run.runId)) {
        this.releaseRun(actor, event.threadKey);
        return cards.publishedAfterCancel(
          published.url,
          parsed.ready && published.queued && published.queueVerified,
        );
      }
      /**
       * `queued` requires BOTH that the owner asked and that the helper
       * verified the exact label on the issue. Neither alone is enough, and
       * neither is evidence that a worker started -- the card's own copy says
       * that, and Ducky never observes a worker at all.
       */
      const queueState = queueStateFrom(parsed.ready, published);
      const status: AgentCardStatus = queueState === 'queued' ? 'queued' : 'published';
      const detail = publicationDetail(published, parsed.ready, found.completionPolicy);
      // A label the owner asked for that did not land is a failure, not a
      // detail: the publisher verifies its own read-back, and reporting the
      // ticket as published while a requested classification is missing would
      // be a partial success dressed as a whole one.
      if (parsed.labels.length > 0 && !published.classificationVerified) {
        // The publication itself succeeded, so what is known about the QUEUE
        // is what the publisher reported -- not a blanket negative.
        return this.failRun(
          actor, event, publishing,
          new DuckyError(
            'invalid_input',
            'the issue exists but a classification label you asked for was not verified on it',
          ),
          {
            queueState: queueStateFrom(parsed.ready, published),
            ...(published.issue === undefined ? {} : { issueNumber: published.issue }),
            ...(published.url === undefined ? {} : { issueUrl: published.url }),
          },
        );
      }
      const done = this.deps.store.agentThreads.updateRun(
        actor.discordUserId, event.threadKey, run.runId,
        { status, detail, queueState, finished: true },
        this.now(),
      );
      // A published ticket settles the thread's intent, so the notes do not
      // leak into the NEXT ticket as if they had been said about it.
      this.deps.store.agentThreads.clearNotes(actor.discordUserId, event.threadKey, this.now());
      /**
       * And the publication BINDING goes with them.
       *
       * The canonical id and the issue number exist so a RETRY enriches the
       * same issue instead of opening a second one. Once a publication has
       * succeeded there is nothing left to retry, and keeping them meant the
       * next -- DIFFERENT -- `$ticket` in this thread inherited them and
       * rewrote the previous issue with an unrelated contract. A silent
       * destructive edit to work somebody may already be acting on is the
       * worst thing this surface could do, and it is worth the cost: to
       * authorize an issue after publishing it, send `$ticket --ready` with
       * the description, which is one message rather than a lost ticket.
       */
      this.deps.store.agentThreads.clearPublicationBinding(
        actor.discordUserId, event.threadKey, run.runId, this.now(),
      );
      /**
       * ...and the ticket moves into the SETTLED slot instead.
       *
       * That is what makes the owner's two-step work. The retry binding is
       * gone, so the next different `$ticket` cannot rewrite this issue; the
       * settled contract is kept, so a no-argument `$ticket --ready` can
       * authorize THIS issue with the exact spec the publisher accepted.
       *
       * A spec too large to keep is not stored, and the authorize step then
       * says it cannot reach the settled ticket -- the one thing it must not
       * do is send a truncated contract.
       */
      const storedSettled = this.deps.store.agentThreads.recordPublishedTicket(
        actor.discordUserId, event.threadKey, run.runId,
        {
          specJson: JSON.stringify(spec),
          issueNumber: published.issue ?? null,
          issueUrl: published.url ?? null,
          queued: queueState === 'queued',
        },
        this.now(),
      );
      if (!storedSettled) {
        // Nothing half-stored: a stale settled ticket would be worse than
        // none, because a later `--ready` would authorize the wrong contract.
        this.deps.store.agentThreads.clearPublishedTicket(
          actor.discordUserId, event.threadKey, this.now(),
        );
      }
      this.deps.store.agentThreads.setGrilling(
        actor.discordUserId, event.threadKey, false, this.now(),
      );
      this.deps.audit?.({ command: '$ticket', outcome: 'ok', status });
      this.releaseRun(actor, event.threadKey);
      if (done) await this.showCard(actor, event, done, { fresh: true });
      return cards.publicationReply(status, published.url ?? undefined);
    } catch (err) {
      /**
       * The helper never answered -- a subprocess timeout, a kill, a crash in
       * the bridge itself. This is the case the review called out most
       * sharply: there is NO result to read, so after `--ready` the only
       * honest thing to say about the label is that nobody knows.
       */
      return this.failRun(actor, event, publishing, err, {
        queueState: parsed.ready ? 'unknown' : 'not_requested',
      });
    }
  }


  // ---- the settled ticket, and authorizing it ------------------------------

  /**
   * The finished, UNQUEUED ticket this thread published, if there is one.
   *
   * Returns nothing once it has been queued, once the stored contract cannot
   * be parsed, and when there is no issue to act on -- in each case there is
   * nothing a no-argument `--ready` could honestly do.
   */
  private settledTicket(
    actor: ActorContext,
    threadKey: string,
    /**
     * The repository this command is addressing.
     *
     * A settled ticket belongs to the repository it was published in. After a
     * rebind the thread is about something else, and authorizing the previous
     * repository's issue from here would queue work nobody asked to queue --
     * the installed publisher would refuse the mismatched checkout anyway, but
     * refusing locally means the owner gets a sentence rather than a
     * subprocess error.
     */
    repository: string,
  ): {
    spec: TicketSpec;
    issueNumber: number;
    issueUrl: string | null;
    repository: string;
    alreadyQueued: boolean;
  } | undefined {
    const row = this.deps.store.agentThreads.get(actor.discordUserId, threadKey);
    if (!row?.publishedSpec || row.publishedIssue === null) return undefined;
    let spec: TicketSpec;
    try {
      spec = JSON.parse(row.publishedSpec) as TicketSpec;
    } catch {
      // A contract that cannot be read is not one to re-send.
      return undefined;
    }
    if (typeof spec?.id !== 'string' || typeof spec?.repository !== 'string') return undefined;
    if (spec.repository.toLowerCase() !== repository.toLowerCase()) return undefined;
    return {
      spec,
      issueNumber: row.publishedIssue,
      issueUrl: row.publishedUrl,
      repository: spec.repository,
      alreadyQueued: row.publishedQueued,
    };
  }

  /**
   * Authorizes the ticket this thread already published.
   *
   * The ORIGINAL spec goes back to the installed publisher, byte for byte,
   * with `--ready` and the original issue number. That is not an optimisation:
   * the publisher refuses to change the execution contract of an authorized
   * issue, so a spec rebuilt from a description would be rejected -- and if it
   * were not, it would be a different ticket wearing the same words.
   *
   * Nothing is minted and nothing is created. The canonical id is the one the
   * first publication used.
   */
  private async authorizeSettled(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
    run: AgentThreadRow & { runId: string },
    target: { repo: WorkflowRepository },
    settled: {
      spec: TicketSpec;
      issueNumber: number;
      issueUrl: string | null;
      repository: string;
      alreadyQueued: boolean;
    },
    /** The registration's completion policy, as the scan just observed it. */
    completionPolicy: string | undefined,
  ): Promise<OutboundMessage> {
    if (settled.alreadyQueued) {
      // Answered, not attempted. Re-applying a label that is already verified
      // would be a GitHub write with nothing to gain.
      return this.endRun(
        actor, event, run, 'queued',
        `Already authorized. ${QUEUE_STATE_LABEL.queued}`,
        {
          content:
            `Already authorized. \`${settled.repository}\`#${settled.issueNumber} carries a ` +
            'verified agent:ready, so nothing was changed. That authorizes implementation and ' +
            'is still not evidence that a worker started.' +
            (settled.issueUrl ? `\n${settled.issueUrl}` : ''),
          ephemeral: false,
        },
        'queued',
        { issueNumber: settled.issueNumber, issueUrl: settled.issueUrl },
      );
    }

    const publishing = this.deps.store.agentThreads.updateRun(
      actor.discordUserId, event.threadKey, run.runId,
      { status: 'publishing', detail: 'Authorizing the ticket this thread published.' },
      this.now(),
    ) ?? run;
    await this.showCard(actor, event, publishing);

    // The installed validator still decides, on the way back in as on the way
    // out: a contract that no longer validates must not be re-sent.
    try {
      const validated = await this.deps.frontDoor.validate(
        settled.spec,
        this.signalFor(actor, event.threadKey),
      );
      if (!validated.ok) {
        return this.failRun(
          actor, event, publishing,
          new DuckyError('invalid_input', validated.error ?? 'the canonical schema refused it'),
          { queueState: 'not_queued' },
        );
      }
    } catch (err) {
      return this.failRun(actor, event, publishing, err, { queueState: 'not_queued' });
    }
    if (!this.stillLive(actor, event.threadKey, run.runId)) {
      this.releaseRun(actor, event.threadKey);
      return this.stoppedReply();
    }

    try {
      const published = await this.deps.frontDoor.publish({
        spec: settled.spec,
        ready: true,
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        issue: settled.issueNumber,
      });

      if (!published.ok) {
        /**
         * The settled ticket is NOT forgotten here. The authorization failed,
         * the issue is still unqueued as far as anyone can tell, and the owner
         * must be able to try the same authorization again.
         */
        return this.failRun(
          actor, event, publishing,
          new DuckyError('invalid_input', published.error ?? 'the publisher refused it'),
          {
            queueState: 'unknown',
            issueNumber: settled.issueNumber,
            ...(published.url === undefined ? {} : { issueUrl: published.url }),
          },
        );
      }

      const queueState = queueStateFrom(true, published);
      if (queueState === 'queued') {
        this.deps.store.agentThreads.markPublishedQueued(
          actor.discordUserId, event.threadKey, this.now(),
        );
      }
      const url = published.url ?? settled.issueUrl ?? undefined;
      const detail =
        queueState === 'queued'
          ? `Authorized the ticket this thread published. ${QUEUE_STATE_LABEL.queued} ` +
            // The same sentence the single-step path ends on, from the same
            // observed registration.
            mergePolicyNote(completionPolicy)
          : `Authorization did NOT complete. ${QUEUE_STATE_LABEL.unknown}`;
      return this.endRun(
        actor, event, run,
        queueState === 'queued' ? 'queued' : 'published',
        detail.slice(0, AGENT_CARD_DETAIL_MAX),
        cards.publicationReply(queueState === 'queued' ? 'queued' : 'published', url),
        queueState,
        // The issue this run authorized, so its card carries the same
        // View issue control the single-step card does.
        { issueNumber: settled.issueNumber, issueUrl: url ?? settled.issueUrl },
      );
    } catch (err) {
      return this.failRun(actor, event, publishing, err, {
        queueState: 'unknown',
        issueNumber: settled.issueNumber,
        ...(settled.issueUrl === null ? {} : { issueUrl: settled.issueUrl }),
      });
    }
  }

  /**
   * Closes a run with a terminal status, a card and a reply.
   *
   * One place, so every terminal path releases the run, refreshes the card and
   * records the same audit row rather than three of them drifting.
   */
  private async endRun(
    actor: ActorContext,
    event: { threadKey: string; context?: IncomingContext },
    run: AgentThreadRow & { runId: string },
    status: AgentCardStatus,
    detail: string,
    reply: OutboundMessage,
    queueState: QueueState = 'not_requested',
    /**
     * The issue THIS run acted on, when it acted on one.
     *
     * A run that authorizes or reports on an already-published ticket has an
     * issue to link, and the card's "View issue" control is an explicit
     * acceptance criterion -- but `startRun` clears the per-run issue so a
     * later card cannot inherit a stale one. So a run that genuinely has an
     * issue has to say so, here, rather than relying on a value that outlived
     * somebody else's run.
     */
    publication?: { issueNumber: number; issueUrl: string | null },
  ): Promise<OutboundMessage> {
    if (publication) {
      this.deps.store.agentThreads.setPublication(
        actor.discordUserId, event.threadKey, run.runId,
        { issueNumber: publication.issueNumber, issueUrl: publication.issueUrl },
        this.now(),
      );
    }
    /**
     * The snapshot is taken AFTER the publication above and BEFORE the
     * binding is released below, so the card renders with the issue and the
     * link while the stored binding ends up empty. The single-step path has
     * always worked this way; doing it anywhere else would mean a card that
     * shows a link and a row that invites the next ticket to rewrite that
     * issue.
     */
    const done = this.deps.store.agentThreads.updateRun(
      actor.discordUserId, event.threadKey, run.runId,
      { status, detail, queueState, finished: true },
      this.now(),
    );
    if (publication) {
      // "This attempt has not landed yet" is no longer true of this issue.
      this.deps.store.agentThreads.clearPublicationBinding(
        actor.discordUserId, event.threadKey, run.runId, this.now(),
      );
    }
    this.deps.audit?.({ command: run.runCommand ?? '$ticket', outcome: 'ok', status });
    this.releaseRun(actor, event.threadKey);
    if (done) await this.showCard(actor, event, done, { fresh: true });
    return reply;
  }

  // ---- $agentize -----------------------------------------------------------

  /**
   * Onboards or upgrades a repository through the installed helper.
   *
   * The helper preserves human instructions, hooks, disabled registrations and
   * running work, and refuses to mutate a checkout a worker owns. Ducky adds
   * no preservation logic of its own -- it would be a second opinion about
   * somebody else's contract -- and starts nothing afterwards.
   */
  private async agentize(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
    parsed: ParsedSkillCommand,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireOwner(actor);

    const target = this.resolveTarget(actor, event.threadKey, parsed.args);
    if ('ask' in target) return target.ask;

    if (!this.deps.frontDoor.availability().mutationEnabled) {
      return cards.unavailable(
        'Onboarding is not enabled on this instance. Nothing was read, changed or registered.',
      );
    }

    const run = this.startRun(actor, event, '$agentize', 'onboarding', false);
    if (!run) {
      const live = this.deps.store.agentThreads.liveRun(actor.discordUserId, event.threadKey);
      return live ? this.busy(live) : cards.unavailable('That could not be started. Try again.');
    }
    await this.showCard(actor, event, run);

    try {
      const onboarded = await this.deps.frontDoor.agentize({
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        repository: target.repo.repository,
      });
      if (!onboarded.ok) {
        // Onboarding never applies agent:ready, so there is no queue to be
        // uncertain about.
        return this.failRun(
          actor, event, run,
          new DuckyError('invalid_input', onboarded.error ?? 'onboarding did not complete'),
          { queueState: 'not_requested' },
        );
      }
      if (!this.stillLive(actor, event.threadKey, run.runId)) {
        this.releaseRun(actor, event.threadKey);
        return {
          content:
            'You cancelled this, and the onboarding helper had already finished. The repository ' +
            'contract and any registration it made still stand. No label authorizes work and no ' +
            'service was started.',
          ephemeral: false,
        };
      }
      const detail = onboardingDetail(onboarded.changed, onboarded.registered, onboarded.dispatcher);
      const done = this.deps.store.agentThreads.updateRun(
        actor.discordUserId, event.threadKey, run.runId,
        { status: 'onboarded', detail, finished: true },
        this.now(),
      );
      this.deps.audit?.({ command: '$agentize', outcome: 'ok', status: 'onboarded' });
      this.releaseRun(actor, event.threadKey);
      if (done) await this.showCard(actor, event, done, { fresh: true });
      return {
        content:
          `Onboarded \`${onboarded.repository ?? target.repo.repository}\`. ` +
          'No label authorizes work and no service was started. Create work with `$ticket`.',
        ephemeral: false,
      };
    } catch (err) {
      return this.failRun(actor, event, run, err, { queueState: 'not_requested' });
    }
  }

  // ---- controls ------------------------------------------------------------

  /** The Details control. Owner-scoped, and it reads nothing it did not store. */
  details(actor: ActorContext, runId: string): OutboundMessage {
    this.deps.authz.requireOwner(actor);
    const row = this.deps.store.agentThreads.byRunId(actor.discordUserId, runId);
    if (!row?.runStatus || !row.runCommand) {
      return { content: 'That control is no longer valid.', ephemeral: true };
    }
    return cards.agentDetails(row);
  }

  /**
   * The Cancel control.
   *
   * It stops the NEXT step and says exactly that. A helper call already in
   * flight is a subprocess making GitHub round trips, and claiming to have
   * stopped one would be a claim Ducky cannot support -- the same honesty the
   * job-cancellation path already applies to a working agent.
   */
  cancel(actor: ActorContext, runId: string): OutboundMessage {
    this.deps.authz.requireOwner(actor);
    const row = this.deps.store.agentThreads.byRunId(actor.discordUserId, runId);
    if (!row?.runStatus || !row.runCommand) {
      return { content: 'That control is no longer valid.', ephemeral: true };
    }

    /**
     * A finished run whose INTERVIEW is still open.
     *
     * A grill stops being a run as soon as its scan is done -- there is no
     * further step to cancel and holding the thread would block the `$ticket`
     * the grill exists to lead to. But the interview it opened is still
     * running, and Cancel on that card has to mean something, so it means
     * "close the interview".
     */
    if (row.runFinishedAt !== null) {
      if (row.grilling && row.runCommand === '$grill-me') {
        this.deps.store.agentThreads.setGrilling(
          actor.discordUserId, row.threadKey, false, this.now(),
        );
        this.deps.audit?.({ command: row.runCommand, outcome: 'refused', status: 'cancelled' });
        return {
          content:
            'Closed the interview. Your notes are kept, so `$ticket` can still use them; ' +
            'nothing was created.',
          ephemeral: true,
        };
      }
      return { content: 'That run has already finished. Nothing was changed.', ephemeral: true };
    }

    /**
     * Abort the read-only helper call, if one is in flight.
     *
     * `runArgv` kills the child on abort, so `inspect` and `validate` stop
     * immediately. `ticket` and `agentize` are never given this signal, on
     * purpose: killing the publisher could leave an issue created and its
     * read-back unverified. The marker below is what stops the NEXT step, and
     * it is what makes a late answer report honestly instead of succeeding.
     */
    this.#aborts.get(this.#key(actor, row.threadKey))?.abort();

    const cancelled = this.deps.store.agentThreads.updateRun(
      actor.discordUserId, row.threadKey, runId,
      { status: 'cancelled', detail: 'Cancelled by you.', finished: true },
      this.now(),
    );
    if (!cancelled) {
      // It reached a terminal state between the read above and this write.
      return { content: 'That run has already finished. Nothing was changed.', ephemeral: true };
    }
    this.deps.store.agentThreads.setGrilling(
      actor.discordUserId, row.threadKey, false, this.now(),
    );
    this.deps.audit?.({ command: row.runCommand, outcome: 'refused', status: 'cancelled' });
    return {
      content:
        'Cancelled. No further step runs for this request. A read already in flight is stopped; ' +
        'a publication already in flight is NOT interrupted, and if it completes you will be ' +
        'told what it created.',
      ephemeral: true,
    };
  }

  // ---- repository binding --------------------------------------------------

  /**
   * Which repository this thread is about.
   *
   * Explicit beats bound, bound beats a single candidate, and anything else
   * ASKS. A guess here points a real agent at the wrong working tree, which is
   * the same reasoning that made the repository part of the old coding
   * grammar rather than something inferred.
   */
  private resolveTarget(
    actor: ActorContext,
    threadKey: string,
    args: string,
  ): { repo: WorkflowRepository; intent: string } | { ask: OutboundMessage } {
    const configured = this.deps.repositories();
    if (configured.length === 0) {
      return {
        ask: cards.unavailable(
          'No configured repository has a GitHub identity, so there is nothing to work on.',
        ),
      };
    }

    const addressed = this.addressedIn(args, configured);
    if (addressed) {
      this.deps.store.agentThreads.bindRepository(
        actor.discordUserId, threadKey,
        addressed.repo.repository, addressed.repo.checkoutRoot, this.now(),
      );
      return { repo: addressed.repo, intent: addressed.rest };
    }

    const row = this.deps.store.agentThreads.get(actor.discordUserId, threadKey);
    if (row?.repository) {
      const bound = configured.find((r) => r.repository === row.repository);
      // A binding to a repository that is no longer configured is not honoured:
      // configuration is the authority and a stored row is a convenience.
      if (bound) return { repo: bound, intent: args };
    }

    if (configured.length === 1) {
      const only = configured[0]!;
      this.deps.store.agentThreads.bindRepository(
        actor.discordUserId, threadKey, only.repository, only.checkoutRoot, this.now(),
      );
      return { repo: only, intent: args };
    }

    return { ask: cards.chooseRepository(configured.map((r) => r.repository)) };
  }

  /**
   * A repository ADDRESSED by the command, as opposed to mentioned by it.
   *
   * Two rules, and both exist because the first version had neither:
   *
   * 1. **`owner/name` only.** A bare slug is a word. `demo`, `widgets` and
   *    `folio` are things people say in sentences, and matching one anywhere
   *    in the prose silently rebound the thread -- so "fix the widgets
   *    rendering" retargeted the whole workflow at `acme/widgets`.
   * 2. **Leading position only.** Addressing is something you do at the start
   *    of a command, not something a sentence happens to contain. A repository
   *    named three clauses in is being talked about.
   *
   * Anything else is not a target, and the caller then uses the binding or
   * ASKS. Guessing here points a real agent at the wrong working tree, which
   * is the same reasoning that made the repository part of the old coding
   * grammar rather than something inferred.
   */
  private addressedIn(
    args: string,
    configured: readonly WorkflowRepository[],
  ): { repo: WorkflowRepository; rest: string } | undefined {
    const match = /^(\S+)([\s\S]*)$/.exec(args.trimStart());
    if (!match) return undefined;
    const token = match[1]!;
    if (!isTicketRepository(token)) return undefined;
    const repo = configured.find((r) => r.repository.toLowerCase() === token.toLowerCase());
    // A well-formed `owner/name` that is not configured is still not a target.
    // The caller asks, and the reply names only what IS configured.
    if (!repo) return undefined;
    // The target is addressing, not part of what the work IS: left in, it
    // would become the first words of the ticket's goal and title.
    return { repo, rest: (match[2] ?? '').trim() };
  }

  // ---- spec synthesis ------------------------------------------------------

  /**
   * The owner's settled intent: what they typed on the command, then what they
   * said during the grill.
   *
   * Every line is the owner's own. Ducky contributes structure, never content.
   */
  private settledIntent(actor: ActorContext, threadKey: string, args: string): string[] {
    const row = this.deps.store.agentThreads.get(actor.discordUserId, threadKey);
    const notes = [...(row?.intentNotes ?? [])];
    const trimmed = args.trim();
    if (trimmed !== '' && !notes.includes(trimmed)) notes.push(trimmed);
    return notes.filter((n) => n.trim() !== '');
  }

  private buildSpec(
    actor: ActorContext,
    threadKey: string,
    repository: string,
    notes: readonly string[],
    found: FrontDoorInspection,
  ): TicketSpec {
    /**
     * One canonical id per thread, minted once and REUSED.
     *
     * That is what makes a retry after a lost response enrich the same issue
     * instead of opening a second one -- the helper matches on it, and the
     * thread row is where it survives a restart.
     */
    const existing = this.deps.store.agentThreads.get(actor.discordUserId, threadKey);
    const id = existing?.ticketUuid ?? newUuid();
    if (!existing?.ticketUuid) {
      this.deps.store.agentThreads.setTicketUuid(actor.discordUserId, threadKey, id, this.now());
    }

    const first = notes[0]!;
    return {
      schema: 'ticket-spec/v1',
      id,
      repository,
      title: titleFrom(first),
      goal: first,
      context: notes.slice(1),
      scope: [first],
      non_goals: [],
      // Every criterion is a line the owner typed. There is deliberately no
      // rule here that adds one they did not.
      acceptance_criteria: [...notes],
      constraints: [],
      dependencies: [],
      references: found.hasWorkflowContract
        ? [{ kind: 'file' as const, value: '.agent/workflow.json', verified: true }]
        : [],
      verification: ['Verify each acceptance criterion against the repository checks.'],
      risks: [],
      open_questions: [],
      source: {
        mode: 'conversation',
        summary: 'Settled in a Discord thread with the owner.',
        decisions: [...notes],
      },
    };
  }

  // ---- cards ---------------------------------------------------------------

  /**
   * Opens a card for this run and REPLACES whatever the thread held.
   *
   * The returned type narrows `runId` to a string: a run that has just been
   * started always has one, and every subsequent update is keyed on it, so
   * threading an optional through five call sites would only hide that.
   */
  private startRun(
    actor: ActorContext,
    event: { threadKey: string; context?: IncomingContext },
    command: SkillCommand,
    status: AgentCardStatus,
    ready: boolean,
  ): (AgentThreadRow & { runId: string }) | undefined {
    const runId = newPublicAgentRunId();
    const row = this.deps.store.agentThreads.startRun(
      actor.discordUserId,
      event.threadKey,
      { runId, command, status, ready, detail: null },
      this.now(),
    );
    if (!row) return undefined;
    /**
     * The abort handle for this run's READ-ONLY helper calls.
     *
     * Registered only after the row exists, so a refused start never leaves a
     * controller behind. `startRun` is the single-writer gate, so there is at
     * most one entry per thread at any time.
     */
    this.#aborts.set(this.#key(actor, event.threadKey), new AbortController());
    return { ...row, runId };
  }

  /**
   * Ends a run that outlived its budget, and shows the owner what is unknown.
   *
   * The outcome is deliberately NOT guessed. A `$ticket --ready` that vanished
   * mid-publish may have applied the label, so the queue state becomes
   * `unknown` and the card says to go and look. Claiming either "queued" or
   * "nothing happened" would be inventing a fact about somebody's repository.
   */
  private async expireAbandonedRun(
    actor: ActorContext,
    event: { threadKey: string; context?: IncomingContext },
  ): Promise<void> {
    const live = this.deps.store.agentThreads.liveRun(actor.discordUserId, event.threadKey);
    if (!live) return;

    /**
     * The detail is composed BEFORE the sweep, because only the row that is
     * about to end knows whether queueing had been asked for -- and a run
     * that asked leaves a label nobody can account for.
     */
    const detail =
      'Abandoned: the coordinator stopped while this run was in flight. ' +
      'Whatever the helper had already done still stands.' +
      (live.runReady ? ` ${QUEUE_STATE_LABEL.unknown}` : '');

    const cutoff = new Date(this.deps.clock.nowMs() - STALE_RUN_AFTER_MS).toISOString();
    const expired = this.deps.store.agentThreads.expireStaleRun(
      actor.discordUserId,
      event.threadKey,
      cutoff,
      detail,
      this.now(),
    );
    if (!expired) return;
    // The in-memory abort handle did not survive the restart either.
    this.releaseRun(actor, event.threadKey);
    this.deps.audit?.({
      command: expired.runCommand ?? '$ticket',
      outcome: 'failed',
      status: 'failed',
    });
    await this.showCard(actor, event, expired, { fresh: true });
  }

  /**
   * The honest answer when a thread is already busy.
   *
   * Refusing beats queueing: a queued workflow command would publish
   * something the owner had stopped thinking about by the time it ran, which
   * is the same reason there is one pending intent proposal per thread and
   * not a list of them.
   */
  private busy(live: AgentThreadRow): OutboundMessage {
    return cards.unavailable(
      `A \`${live.runCommand ?? 'workflow'}\` run is already in flight in this thread ` +
        `(\`${live.runId ?? ''}\`). Let it finish, or press Cancel on its card. Nothing was started.`,
    );
  }

  #key(actor: ActorContext, threadKey: string): string {
    return `${actor.discordUserId}:${threadKey}`;
  }

  /**
   * Whether this run may still take its next step.
   *
   * Re-read from the DATABASE, not from a flag in memory: the cancel control
   * arrives on a different interaction, and the row is the only thing both
   * sides share. Checked after every `await`, because every `await` is a
   * window in which the owner can press Cancel or the run can be superseded.
   */
  private stillLive(actor: ActorContext, threadKey: string, runId: string): boolean {
    return this.deps.store.agentThreads.runIsLive(actor.discordUserId, threadKey, runId);
  }

  /** The abort signal for this run's read-only helper calls, if it has one. */
  private signalFor(actor: ActorContext, threadKey: string): AbortSignal | undefined {
    return this.#aborts.get(this.#key(actor, threadKey))?.signal;
  }

  /** Called on every terminal path, so a controller never outlives its run. */
  private releaseRun(actor: ActorContext, threadKey: string): void {
    this.#aborts.delete(this.#key(actor, threadKey));
  }

  /**
   * What to say when a step finds its run already stopped.
   *
   * Deliberately NOT a card edit: the card already says `cancelled`, and
   * moving it would undo the thing the owner asked for.
   */
  private stoppedReply(): OutboundMessage {
    return {
      content: 'Stopped. That run was cancelled or replaced, so nothing further was done.',
      ephemeral: false,
    };
  }

  /**
   * Shows the card: one message, EDITED as the run moves.
   *
   * A fresh message is sent only for a terminal state, which is the
   * notification the ticket asks for -- an edit in scrollback is easy to miss,
   * and "your ticket is queued" is worth a ping.
   */
  private async showCard(
    actor: ActorContext,
    event: { threadKey: string; context?: IncomingContext },
    row: AgentThreadRow,
    options: { fresh?: boolean } = {},
  ): Promise<void> {
    const target = this.cardTarget(actor, event.context);
    const message = cards.agentCard(row, this.cardControls(actor, row));
    try {
      if (!options.fresh && row.cardMessageId) {
        const edited = await this.deps.transport.updateCard(target, row.cardMessageId, message);
        if (edited) return;
        // The card is gone -- the owner may have deleted it. A fresh one is a
        // duplicate at worst; a swallowed update is a card that lies.
      }
      const messageId = await this.deps.transport.sendCard(target, message);
      if (messageId && row.runId) {
        this.deps.store.agentThreads.setCard(
          actor.discordUserId, row.threadKey, row.runId,
          { channelId: targetId(target), messageId },
          this.now(),
        );
      }
    } catch {
      /* a card is a view; losing one must never fail the command */
    }
  }

  /**
   * Where a card goes.
   *
   * A guild channel gets it; anything else -- a DM, a missing context, an
   * event the transport did not populate -- falls back to the owner's DM.
   * Failing closed to private is the same rule every other surface here
   * applies.
   */
  private cardTarget(actor: ActorContext, context: IncomingContext | undefined): SendTarget {
    if (context?.guildId !== undefined && context.channelId !== undefined) {
      return channelTarget(context.channelId);
    }
    return dmTarget(actor.discordUserId);
  }

  /**
   * Real controls, signed and bound to the owner.
   *
   * Details and Cancel are signed custom ids verified on the way back in.
   * "View issue" is a LINK: it carries no id, so it cannot act, and the
   * sanitizer admits only an exact https GitHub URL.
   */
  private cardControls(actor: ActorContext, row: AgentThreadRow): cards.AgentCardControls {
    if (!row.runId) return {};
    const sign = (kind: 'agent_details' | 'agent_cancel'): string =>
      this.deps.signer.sign({
        kind,
        entityId: row.runId!,
        actorUserId: actor.discordUserId,
      });
    /**
     * Cancel appears while there is something it can actually do: a live run
     * with a step left, or an open interview this card started. A control
     * that cannot act is worse than no control.
     */
    const cancellable =
      row.runFinishedAt === null || (row.grilling && row.runCommand === '$grill-me');
    return {
      detailsId: sign('agent_details'),
      ...(cancellable ? { cancelId: sign('agent_cancel') } : {}),
      ...(row.issueUrl ? { issueUrl: row.issueUrl } : {}),
    };
  }

  /**
   * Records a failure on the card and answers the owner.
   *
   * Nothing is ever reported as queued or started after a failure, and the
   * reason is the structured one the helper gave -- never its raw output.
   */
  private async failRun(
    actor: ActorContext,
    event: { threadKey: string; context?: IncomingContext },
    row: AgentThreadRow,
    err: unknown,
    /**
     * What is KNOWN about the queue after this failure, and the issue the
     * publisher may already have created.
     *
     * `queueState` is required of every caller rather than defaulted,
     * because the default used to be "not queued" and that is a claim: a
     * publisher that wrote `agent:ready` and then failed to read it back
     * leaves a label that may well be on the issue, and saying otherwise
     * sends the owner away from an authorized ticket.
     */
    outcome: {
      queueState: QueueState;
      issueNumber?: number | undefined;
      issueUrl?: string | undefined;
    } = { queueState: 'not_queued' },
  ): Promise<OutboundMessage> {
    const reason = failureReason(err);
    /**
     * A run the owner already cancelled stays cancelled.
     *
     * `updateRun` refuses a terminal run, so this returns undefined and the
     * card is left alone -- which is right: an abort the owner CAUSED must
     * not be reported back to them as a failure of the thing they stopped.
     */
    if (row.runId && !this.stillLive(actor, event.threadKey, row.runId)) {
      this.releaseRun(actor, event.threadKey);
      return this.stoppedReply();
    }
    /**
     * MINOR 7: an issue the failed attempt DID create is remembered.
     *
     * The publisher reports a partial result -- it created the issue and then
     * something later went wrong -- and without recording the number the
     * retry opened a second issue for the same work.
     */
    if (row.runId && (outcome.issueNumber !== undefined || outcome.issueUrl !== undefined)) {
      this.deps.store.agentThreads.setPublication(
        actor.discordUserId, event.threadKey, row.runId,
        { issueNumber: outcome.issueNumber ?? null, issueUrl: outcome.issueUrl ?? null },
        this.now(),
      );
    }
    const failed = row.runId
      ? this.deps.store.agentThreads.updateRun(
          actor.discordUserId, event.threadKey, row.runId,
          {
            status: 'failed',
            detail: `${reason}${
              outcome.queueState === 'unknown' ? ` ${QUEUE_STATE_LABEL.unknown}` : ''
            }`,
            queueState: outcome.queueState,
            finished: true,
          },
          this.now(),
        )
      : undefined;
    this.releaseRun(actor, event.threadKey);
    this.deps.audit?.({
      command: row.runCommand ?? '$ticket',
      outcome: 'failed',
      status: 'failed',
    });
    if (failed) await this.showCard(actor, event, failed, { fresh: true });

    /**
     * The sentence the review found wrong, now derived from what is known.
     *
     * "Nothing was queued and nothing was started" is true only when the run
     * stopped before any label could be written. After an attempt it is a
     * false negative, so the unknown case says so and tells the owner to go
     * and look -- there is no honest way to answer it from here.
     */
    const queueLine =
      outcome.queueState === 'unknown'
        ? 'The agent:ready label may have been applied before the failure and could NOT be ' +
          'confirmed. Open the issue and check for agent:ready before assuming either way. ' +
          'Nothing was started; Ducky never starts a worker.'
        : 'Nothing was queued and nothing was started.';

    return {
      content:
        `That did not complete: ${reason}. ${queueLine}` +
        (outcome.issueUrl ? `\n${outcome.issueUrl}` : ''),
      ephemeral: false,
    };
  }

  private now(): string {
    return this.deps.clock.nowIso();
  }
}

/**
 * A loaded interview method, or the honest reason there is not one.
 *
 * A union rather than an optional string, so there is no "empty means
 * missing" value a caller could pass straight to the model.
 */
export interface UsableSkill {
  readonly ok: true;
  readonly text: string;
}

export type LoadedSkill = UsableSkill | { readonly ok: false; readonly reason: string };

/**
 * Reads one installed SKILL.md, with every refusal spelled out.
 *
 * Oversized REFUSES rather than truncating: half a method is not a method,
 * and the previous behaviour -- silently sending nothing at all -- was the
 * worst of the three possible answers.
 */
function readSkillFile(file: string): LoadedSkill {
  let text: string;
  try {
    const size = statSync(file).size;
    if (size > GRILL_SKILL_MAX_BYTES) {
      return {
        ok: false,
        reason:
          'The installed grilling skill is too large to load, so it was not sent. ' +
          'Nothing was read.',
      };
    }
    text = readFileSync(file, 'utf8');
  } catch {
    // The path, and the reason the filesystem gave, are both host detail and
    // neither belongs in a Discord message.
    return {
      ok: false,
      reason:
        'The installed grilling skill could not be read on this host. Nothing was read.',
    };
  }
  if (text.trim() === '') {
    return {
      ok: false,
      reason: 'The installed grilling skill is empty, so there is no method to load.',
    };
  }
  return { ok: true, text };
}

/** The YAML front matter an installed skill carries, stripped. */
const withoutFrontMatter = (text: string): string =>
  text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/**
 * The skill a pointer redirects to, when the file is only a pointer.
 *
 * Matched against the WHOLE body, so a method that happens to mention the
 * phrase in passing is not mistaken for a redirect: a pointer says this and
 * nothing else.
 */
function redirectTarget(text: string): string | undefined {
  const body = withoutFrontMatter(text).trim();
  const match = /^Call the Skill tool with ["`\u2018\u201c]([a-z0-9][a-z0-9-]{0,63})["`\u2019\u201d]\.?$/i
    .exec(body);
  return match?.[1];
}

/**
 * What is known about the label after a publisher run that ANSWERED.
 *
 * `queued` needs both halves: the owner asked, and the publisher applied the
 * label and read it back. An answer that says it asked but did not verify is
 * not a negative -- the write happens before the read -- so it is `unknown`.
 */
function queueStateFrom(
  ready: boolean,
  published: { queued: boolean; queueVerified: boolean },
): QueueState {
  if (!ready) return 'not_requested';
  if (published.queued && published.queueVerified) return 'queued';
  return 'unknown';
}

const targetId = (target: SendTarget): string =>
  target.kind === 'channel' ? target.channelId : target.userId;

/**
 * A one-line title from the owner's first line.
 *
 * Trimmed to one line and bounded, because the canonical contract refuses a
 * multi-line title. Nothing is rephrased: a generated title would be the one
 * part of a ticket nobody wrote.
 */
function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/** Counts and flags only. The scan's file list never reaches a message. */
function describeScan(found: FrontDoorInspection): string {
  const parts = [
    `${found.signalCount} workflow signal(s)`,
    found.hasWorkflowContract ? 'workflow contract present' : 'no workflow contract',
    found.registrationEnabled
      ? 'registered and enabled'
      : found.registered
        ? 'registered but not enabled'
        : 'not registered',
  ];
  if (found.dirty) parts.push('uncommitted changes present');
  if (found.activeJobs > 0) parts.push(`${found.activeJobs} active worker checkout(s)`);
  return parts.join(', ').slice(0, AGENT_CARD_DETAIL_MAX);
}

function publicationDetail(
  published: {
    issue?: number | undefined;
    created: boolean;
    queued: boolean;
    alreadyAuthorized: boolean;
    classificationLabels: readonly string[];
  },
  ready: boolean,
  completionPolicy: string | undefined,
): string {
  const parts = [
    published.created ? 'Issue created.' : 'Existing issue enriched.',
    ready
      ? published.queued
        ? 'The exact agent:ready label is applied and verified.'
        : 'Queueing was requested and did NOT complete.'
      : 'Not queued: creating the issue does not authorize implementation.',
  ];
  if (!ready && published.alreadyAuthorized) {
    parts.push('This issue already carried agent:ready before this run.');
  }
  if (published.classificationLabels.length > 0) {
    parts.push(
      `Classified ${published.classificationLabels.join(', ')}, verified on the issue. ` +
        'A classification authorizes nothing.',
    );
  }
  /**
   * What queueing can END in, stated at the moment it is queued.
   *
   * The dispatcher's registration decides this and Ducky cannot change it, so
   * the only honest thing to do is say which one the owner just queued into.
   * A ticket's prose cannot enforce a merge policy, and an owner who believes
   * it can is the failure this line exists to prevent.
   */
  if (ready && published.queued) parts.push(mergePolicyNote(completionPolicy));
  return parts.join(' ').slice(0, AGENT_CARD_DETAIL_MAX);
}

/**
 * What queueing can END in, in one sentence, from the registration itself.
 *
 * Shared by both routes to a queued ticket -- the single-step `$ticket
 * --ready <description>` and the two-step authorization -- because a warning
 * that exists on one path and not the other is one the owner meets by
 * accident. Ducky cannot change the policy; it can only say which one it just
 * queued into.
 */
function mergePolicyNote(completionPolicy: string | undefined): string {
  return completionPolicy === 'pr_only'
    ? 'This repository is registered pr_only: the dispatcher stops at a pull request and merges nothing.'
    : 'This repository is NOT registered pr_only, so the dispatcher may merge the resulting ' +
      'pull request automatically once its worker signs off. Ducky cannot change that.';
}

function onboardingDetail(
  changed: readonly string[],
  registered: boolean,
  dispatcher: string | undefined,
): string {
  const parts = [
    changed.length === 0 ? 'No file needed changing.' : `Changed: ${changed.slice(0, 6).join(', ')}.`,
    registered ? 'Registered with the dispatcher.' : 'Not registered.',
  ];
  // An OBSERVATION of the dispatcher, never a claim that Ducky started it.
  if (dispatcher) parts.push(`Dispatcher observed ${dispatcher}.`);
  parts.push('No service was started or restarted.');
  return parts.join(' ').slice(0, AGENT_CARD_DETAIL_MAX);
}

/**
 * A short reason, from a structured error only.
 *
 * `DuckyError.ownerMessage` is already owner-facing; anything else is reduced
 * to a fixed phrase rather than having its message surfaced, because an
 * arbitrary `Error` can carry a path or a command line.
 */
function failureReason(err: unknown): string {
  if (err && typeof err === 'object' && 'ownerMessage' in err) {
    return String((err as { ownerMessage: unknown }).ownerMessage).slice(0, AGENT_CARD_DETAIL_MAX);
  }
  return 'the workflow helper did not complete';
}
