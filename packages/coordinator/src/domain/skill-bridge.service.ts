import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_CARD_DETAIL_MAX, GRILL_SESSION_TTL_MS,
  DuckyError, isTicketRepository, newPublicAgentRunId, newUuid, parseSkillCommand,
  preflightTicketSpec,
  type AgentCardStatus, type ParsedSkillCommand, type SkillCommand, type TicketSpec,
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

    const target = this.resolveTarget(actor, event.threadKey, parsed.args);
    if ('ask' in target) return target.ask;

    const run = this.startRun(actor, event, '$grill-me', 'scanning', parsed.ready);
    await this.showCard(actor, event, run);

    let found: FrontDoorInspection;
    try {
      // Local read only. `--network` would reach GitHub, and fact-finding for
      // a conversation does not need it.
      found = await this.deps.frontDoor.inspect({
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        repository: target.repo.repository,
      });
    } catch (err) {
      return this.failRun(actor, event, run, err);
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
    if (parsed.args !== '') {
      this.deps.store.agentThreads.appendNote(
        actor.discordUserId, event.threadKey, parsed.args, this.now(),
      );
    }
    return this.grillTurn(actor, event, scanned, parsed.args || 'Start the interview.', found);
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

    this.deps.store.agentThreads.appendNote(
      actor.discordUserId, event.threadKey, event.text, this.now(),
    );
    return this.grillTurn(actor, event, row, event.text);
  }

  /**
   * One interview turn, conducted by the provider under the INSTALLED skill's
   * own instructions.
   *
   * The instructions are read from the configured private path at call time.
   * Nothing is copied into this repository, and if the file is missing the
   * turn still happens -- under a short honest fallback that says what is
   * absent rather than inventing the upstream method.
   */
  private async grillTurn(
    actor: ActorContext,
    event: { threadKey: string; text: string; context?: IncomingContext },
    row: AgentThreadRow,
    text: string,
    found?: FrontDoorInspection,
  ): Promise<OutboundMessage> {
    const instructions = [
      ...this.grillSkill(),
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
   * The installed skill text, bounded, or nothing.
   *
   * Read fresh on every turn rather than cached: the user owns that file and
   * may edit it, and a cached copy is the drift this design exists to avoid.
   */
  private grillSkill(): string[] {
    const file = this.deps.config.grillSkillPath;
    if (!file || !path.isAbsolute(file)) {
      return [
        'The installed grilling skill is not configured on this host, so its own method is not ' +
          'available. Say so, then interview the owner one decision at a time.',
      ];
    }
    try {
      if (statSync(file).size > GRILL_SKILL_MAX_BYTES) return [];
      return [readFileSync(file, 'utf8').slice(0, GRILL_SKILL_MAX_BYTES)];
    } catch {
      return [
        'The installed grilling skill could not be read on this host. Say so, then interview ' +
          'the owner one decision at a time.',
      ];
    }
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
      });
    } catch (err) {
      return this.failRun(actor, event, run, err);
    }

    const notes = this.settledIntent(actor, event.threadKey, parsed.args);
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
    if (problem) return this.failRun(actor, event, run, new DuckyError('invalid_input', problem));

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
      const validated = await this.deps.frontDoor.validate(spec);
      if (!validated.ok) {
        return this.failRun(
          actor, event, publishing,
          new DuckyError('invalid_input', validated.error ?? 'the canonical schema refused it'),
        );
      }
    } catch (err) {
      return this.failRun(actor, event, publishing, err);
    }

    if (!this.deps.frontDoor.availability().mutationEnabled) {
      return this.failRun(
        actor, event, publishing,
        new DuckyError(
          'not_enabled_in_phase1',
          'the ticket is valid, but publishing is not enabled on this instance, so no issue was created',
        ),
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
        return this.failRun(
          actor, event, publishing,
          new DuckyError('invalid_input', published.error ?? 'the publisher refused it'),
          published.url ?? undefined,
        );
      }

      this.deps.store.agentThreads.setPublication(
        actor.discordUserId, event.threadKey,
        { issueNumber: published.issue ?? null, issueUrl: published.url ?? null },
        this.now(),
      );
      /**
       * `queued` requires BOTH that the owner asked and that the helper
       * verified the exact label on the issue. Neither alone is enough, and
       * neither is evidence that a worker started -- the card's own copy says
       * that, and Ducky never observes a worker at all.
       */
      const status: AgentCardStatus =
        parsed.ready && published.queued && published.queueVerified ? 'queued' : 'published';
      const detail = publicationDetail(published, parsed.ready, found.completionPolicy);
      // A label the owner asked for that did not land is a failure, not a
      // detail: the publisher verifies its own read-back, and reporting the
      // ticket as published while a requested classification is missing would
      // be a partial success dressed as a whole one.
      if (parsed.labels.length > 0 && !published.classificationVerified) {
        return this.failRun(
          actor, event, publishing,
          new DuckyError(
            'invalid_input',
            'the issue exists but a classification label you asked for was not verified on it',
          ),
          published.url ?? undefined,
        );
      }
      const done = this.deps.store.agentThreads.updateRun(
        actor.discordUserId, event.threadKey, run.runId,
        { status, detail, queued: status === 'queued', finished: true },
        this.now(),
      );
      // A published ticket settles the thread's intent, so the notes do not
      // leak into the NEXT ticket as if they had been said about it.
      this.deps.store.agentThreads.clearNotes(actor.discordUserId, event.threadKey, this.now());
      this.deps.store.agentThreads.setGrilling(
        actor.discordUserId, event.threadKey, false, this.now(),
      );
      this.deps.audit?.({ command: '$ticket', outcome: 'ok', status });
      if (done) await this.showCard(actor, event, done, { fresh: true });
      return cards.publicationReply(status, published.url ?? undefined);
    } catch (err) {
      return this.failRun(actor, event, publishing, err);
    }
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
    await this.showCard(actor, event, run);

    try {
      const onboarded = await this.deps.frontDoor.agentize({
        ...(target.repo.checkoutRoot ? { path: target.repo.checkoutRoot } : {}),
        repository: target.repo.repository,
      });
      if (!onboarded.ok) {
        return this.failRun(
          actor, event, run,
          new DuckyError('invalid_input', onboarded.error ?? 'onboarding did not complete'),
        );
      }
      const detail = onboardingDetail(onboarded.changed, onboarded.registered, onboarded.dispatcher);
      const done = this.deps.store.agentThreads.updateRun(
        actor.discordUserId, event.threadKey, run.runId,
        { status: 'onboarded', detail, finished: true },
        this.now(),
      );
      this.deps.audit?.({ command: '$agentize', outcome: 'ok', status: 'onboarded' });
      if (done) await this.showCard(actor, event, done, { fresh: true });
      return {
        content:
          `Onboarded \`${onboarded.repository ?? target.repo.repository}\`. ` +
          'No label authorizes work and no service was started. Create work with `$ticket`.',
        ephemeral: false,
      };
    } catch (err) {
      return this.failRun(actor, event, run, err);
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
    if (row.runFinishedAt !== null) {
      return { content: 'That run has already finished. Nothing was changed.', ephemeral: true };
    }
    this.deps.store.agentThreads.updateRun(
      actor.discordUserId, row.threadKey, runId,
      { status: 'cancelled', detail: 'Cancelled by you.', finished: true },
      this.now(),
    );
    this.deps.store.agentThreads.setGrilling(
      actor.discordUserId, row.threadKey, false, this.now(),
    );
    this.deps.audit?.({ command: row.runCommand, outcome: 'refused', status: 'cancelled' });
    return {
      content:
        'Cancelled. No further step runs for this request. A publication already in flight is ' +
        'not interrupted, and anything the installed publisher had already created still exists.',
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
  ): { repo: WorkflowRepository } | { ask: OutboundMessage } {
    const configured = this.deps.repositories();
    if (configured.length === 0) {
      return {
        ask: cards.unavailable(
          'No configured repository has a GitHub identity, so there is nothing to work on.',
        ),
      };
    }

    const named = this.namedIn(args, configured);
    if (named) {
      this.deps.store.agentThreads.bindRepository(
        actor.discordUserId, threadKey, named.repository, named.checkoutRoot, this.now(),
      );
      return { repo: named };
    }

    const row = this.deps.store.agentThreads.get(actor.discordUserId, threadKey);
    if (row?.repository) {
      const bound = configured.find((r) => r.repository === row.repository);
      // A binding to a repository that is no longer configured is not honoured:
      // configuration is the authority and a stored row is a convenience.
      if (bound) return { repo: bound };
    }

    if (configured.length === 1) {
      const only = configured[0]!;
      this.deps.store.agentThreads.bindRepository(
        actor.discordUserId, threadKey, only.repository, only.checkoutRoot, this.now(),
      );
      return { repo: only };
    }

    return { ask: cards.chooseRepository(configured.map((r) => r.repository)) };
  }

  /**
   * A repository named in the command's own argument text.
   *
   * Either the full `owner/name` or the configured slug. Matching is exact:
   * a near miss asks rather than resolving to the closest thing, because the
   * closest thing is still the wrong working tree.
   */
  private namedIn(
    args: string,
    configured: readonly WorkflowRepository[],
  ): WorkflowRepository | undefined {
    for (const token of args.split(/\s+/).filter(Boolean).slice(0, 8)) {
      const lowered = token.toLowerCase();
      if (isTicketRepository(token)) {
        const match = configured.find((r) => r.repository.toLowerCase() === lowered);
        if (match) return match;
      }
      const bySlug = configured.find((r) => r.slug === lowered);
      if (bySlug) return bySlug;
    }
    return undefined;
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
  ): AgentThreadRow & { runId: string } {
    const runId = newPublicAgentRunId();
    const row = this.deps.store.agentThreads.startRun(
      actor.discordUserId,
      event.threadKey,
      { runId, command, status, ready, detail: null },
      this.now(),
    );
    return { ...row, runId };
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
    return {
      detailsId: sign('agent_details'),
      ...(row.runFinishedAt === null ? { cancelId: sign('agent_cancel') } : {}),
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
    partialUrl?: string,
  ): Promise<OutboundMessage> {
    const reason = failureReason(err);
    const failed = row.runId
      ? this.deps.store.agentThreads.updateRun(
          actor.discordUserId, event.threadKey, row.runId,
          { status: 'failed', detail: reason, queued: false, finished: true },
          this.now(),
        )
      : undefined;
    this.deps.audit?.({
      command: row.runCommand ?? '$ticket',
      outcome: 'failed',
      status: 'failed',
    });
    if (failed) await this.showCard(actor, event, failed, { fresh: true });
    return {
      content:
        `That did not complete: ${reason}. Nothing was queued and nothing was started.` +
        (partialUrl ? `\n${partialUrl}` : ''),
      ephemeral: false,
    };
  }

  private now(): string {
    return this.deps.clock.nowIso();
  }
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
  if (ready && published.queued) {
    parts.push(
      completionPolicy === 'pr_only'
        ? 'This repository is registered pr_only: the dispatcher stops at a pull request and merges nothing.'
        : 'This repository is NOT registered pr_only, so the dispatcher may merge the resulting ' +
          'pull request automatically once its worker signs off. Ducky cannot change that.',
    );
  }
  return parts.join(' ').slice(0, AGENT_CARD_DETAIL_MAX);
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
