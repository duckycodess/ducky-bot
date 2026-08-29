import {
  FORGET_TARGETS, isForgetEntityTarget, isForgetTarget, type ForgetEntityTarget,
  CONVERSATIONAL_ROUTE, CONVERSATION_MAX_ATTACHMENTS_PER_MESSAGE,
  DuckyError, JobAnswerInputSchema, JobSubmitInputSchema,
  OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS, SHARED_READABLE_ROUTES,
  isBriefingKind, isDuckyError, isSharedReadableRoute, isTaskListFilter,
  type CaptureState, type OwnerOnlyCommand, type OwnerOnlyInteractionKind,
  type ReminderListFilter, type TaskListFilter,
} from '@ducky/contracts';
import type { ConversationAttachment, ConversationProvider } from '@ducky/adapters';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { ComponentSigner } from '../security/component-signing.js';
import type { CapturesService } from '../domain/captures.service.js';
import type { SchedulesService } from '../domain/schedules.service.js';
import type { JobsService } from '../domain/jobs.service.js';
import type { ApprovalsService } from '../domain/approvals.service.js';
import type { GitHubService } from '../domain/github.service.js';
import type { GitHubWatchService } from '../domain/github-watches.service.js';
import type { ForgetService } from '../domain/forget.service.js';
import type { ConversationMemoryService } from '../domain/conversation-memory.service.js';
import type { IntentsService } from '../domain/intents.service.js';
import type { SharedJobsService } from '../domain/shared-jobs.service.js';
import type { TasksService } from '../domain/tasks.service.js';
import type { RemindersService } from '../domain/reminders.service.js';
import type { BriefingService } from '../domain/briefing.service.js';
import { SharedChannelPolicy } from '../domain/shared-visibility.js';
import { ChannelRolePolicy } from '../domain/channel-roles.js';
import type { OutboundMessage, OutboundRow } from './message.js';
import type { Incoming, IncomingAttachment, IncomingContext } from './transport.js';
import {
  TOO_MANY_ATTACHMENTS_MESSAGE, attachmentAvailability, conversationAttachmentsUsable,
  downloadConversationAttachment, type ConversationAttachmentConfig,
} from './conversation-attachments.js';
import { CommandBuckets } from './command-buckets.js';
import * as present from './presenters.js';
import * as shared from './shared-presenters.js';
import * as assistant from './assistant-presenters.js';

export interface RouterDeps {
  readonly authz: Authorizer;
  readonly signer: ComponentSigner;
  readonly captures: CapturesService;
  readonly schedules: SchedulesService;
  readonly jobs: JobsService;
  readonly approvals: ApprovalsService;
  readonly github: GitHubService;
  readonly githubWatches: GitHubWatchService;
  /**
   * The daily assistant. Owner-only in full: none of these is reachable from
   * `handleSharedRead`, and no shared route names any of their commands.
   */
  readonly tasks: TasksService;
  readonly reminders: RemindersService;
  readonly briefing: BriefingService;
  readonly conversation: ConversationProvider;
  /**
   * The owner's deletion controls. OMITTING IT DISABLES `/forget` entirely,
   * which is the safe direction for a command that removes data.
   */
  readonly forget?: ForgetService;
  /**
   * Bounded conversation continuity. OMITTING IT DISABLES IT ENTIRELY, which is
   * the same fail-closed posture `forget` and the attachment config take: an
   * unwired router stores nothing and replays nothing.
   */
  readonly memory?: ConversationMemoryService;
  /**
   * Deterministic natural-language intents on the conversation route. OMITTING
   * IT means every message goes straight to the provider, exactly as before.
   */
  readonly intents?: IntentsService;
  /**
   * Notified when a provider refuses or fails at the boundary. Fire-and-forget:
   * the owner's reply must not depend on the audit log being writable.
   */
  readonly onProviderFailure?: (info: { provider: string; code: string }) => void;
  readonly status: () => present.ProviderStatus;
  readonly buckets?: CommandBuckets;
  /**
   * Shared-channel visibility. BOTH must be supplied for any shared read to
   * happen; omitting either leaves every request on the private, owner-only
   * path. Failing closed is deliberate -- an incompletely wired router must
   * lose visibility, never publish.
   */
  readonly sharedPolicy?: SharedChannelPolicy;
  /** The owner's private assistant channels. Presentation only. */
  readonly channelRoles?: ChannelRolePolicy;
  readonly sharedJobs?: SharedJobsService;
  /** Supplied by the transport so /schedule can accept a text attachment. */
  readonly readAttachment?: (a: IncomingAttachment) => Promise<string>;
  /**
   * Conversation-attachment configuration. OMITTING IT DISABLES THE PATH
   * ENTIRELY: an unwired router refuses every attachment and downloads
   * nothing, which is the same fail-closed posture the shared-visibility
   * wiring takes.
   */
  readonly conversationAttachments?: ConversationAttachmentConfig;
  /**
   * Charged once per accepted attachment, before the download. Injected so
   * the budget is shared with the schedule surface rather than duplicated.
   */
  readonly chargeConversationAttachment?: (userId: string) => void;
}

type CommandHandler = (actor: ActorContext, e: Extract<Incoming, { kind: 'command' }>) => Promise<OutboundMessage>;
type ComponentHandler = (actor: ActorContext, entityId: string, values?: Record<string, string>) => Promise<OutboundMessage>;

/**
 * Routes Discord events.
 *
 * Every command and every component kind here is owner-only and re-checked in
 * the service layer as well. The registered sets are asserted against
 * OWNER_ONLY_COMMANDS / OWNER_ONLY_INTERACTION_KINDS at construction, so a new
 * handler cannot quietly become reachable by a non-owner, and the only
 * non-privileged path is plain conversation.
 */
export class DuckyRouter {
  private readonly commands = new Map<string, CommandHandler>();
  private readonly components = new Map<string, ComponentHandler>();
  private readonly buckets: CommandBuckets;
  private readonly sharedPolicy: SharedChannelPolicy;
  private readonly channelRoles: ChannelRolePolicy;

  constructor(private readonly deps: RouterDeps) {
    this.buckets = deps.buckets ?? new CommandBuckets();
    // An empty policy answers false to everything, so an unwired router is a
    // fully private one. `handleSharedRead` additionally requires
    // `deps.sharedJobs`, so both halves must be present for anything to be
    // shared.
    this.sharedPolicy = deps.sharedPolicy ?? new SharedChannelPolicy();
    this.channelRoles = deps.channelRoles ?? new ChannelRolePolicy();
    this.registerCommands();
    this.registerComponents();
    this.assertSurfaceMatchesManifest();
  }

  registeredCommands(): string[] {
    return [...this.commands.keys()].sort();
  }

  registeredComponentKinds(): string[] {
    return [...this.components.keys()].sort();
  }

  /** Fails at construction if the surface drifts from the manifest. */
  private assertSurfaceMatchesManifest(): void {
    const cmds = new Set(this.commands.keys());
    for (const c of OWNER_ONLY_COMMANDS) {
      if (!cmds.delete(c)) throw new Error(`owner-only command not registered: ${c}`);
    }
    if (cmds.size > 0) {
      throw new Error(`command outside OWNER_ONLY_COMMANDS: ${[...cmds].join(', ')}`);
    }
    const kinds = new Set(this.components.keys());
    for (const k of OWNER_ONLY_INTERACTION_KINDS) {
      if (!kinds.delete(k)) throw new Error(`owner-only interaction not registered: ${k}`);
    }
    if (kinds.size > 0) {
      throw new Error(`interaction outside OWNER_ONLY_INTERACTION_KINDS: ${[...kinds].join(', ')}`);
    }
    this.assertSharedSurfaceIsReadOnly();
  }

  /**
   * The shared surface may only ever name commands that exist, and may never
   * name an interaction kind.
   *
   * Every registered command is already asserted to be in
   * OWNER_ONLY_COMMANDS above, so a shared route naming a registered command
   * is by construction a *narrowed view* of an owner-only command rather than
   * a new, unlisted surface. Interaction kinds are excluded outright: a
   * component is a signed control, and no control belongs in a channel other
   * people can read.
   */
  private assertSharedSurfaceIsReadOnly(): void {
    for (const route of SHARED_READABLE_ROUTES) {
      if (!this.commands.has(route.command)) {
        throw new Error(`shared route names an unregistered command: ${route.command}`);
      }
      if (this.components.has(route.command)) {
        throw new Error(`shared route names an interaction kind: ${route.command}`);
      }
    }
    for (const kind of OWNER_ONLY_INTERACTION_KINDS) {
      if (isSharedReadableRoute(kind)) {
        throw new Error(`interaction kind is shared-readable: ${kind}`);
      }
    }
  }

  async handle(event: Incoming): Promise<OutboundMessage | undefined> {
    const actor = this.deps.authz.actor(event.userId);
    try {
      let reply: OutboundMessage | undefined;
      switch (event.kind) {
        case 'command':
          reply = await this.handleCommand(actor, event);
          break;
        case 'component':
          reply = await this.handleComponent(actor, event.customId, event.values);
          break;
        case 'message':
          reply = await this.handleMessage(actor, event);
          break;
      }
      return this.persistInRoleChannel(actor, event, reply);
    } catch (err) {
      // A refusal is not owner output, so it is NOT made persistent: an error
      // reply keeps whatever visibility its own presenter chose.
      return errorReply(err);
    }
  }

  /**
   * Whether conversation is deliberately silent in this channel.
   *
   * Only ever true when a `gpt` channel IS configured and this is a different
   * GUILD channel. A DM has no guild and is never silenced; an instance with
   * no `gpt` role configured silences nothing.
   */
  private isSilencedConversationChannel(context: IncomingContext | undefined): boolean {
    const gpt = this.channelRoles.channelFor('gpt');
    if (gpt === undefined) return false;
    // A DM, or an event with no context, is not a guild channel.
    if (!context || context.guildId === undefined) return false;
    return context.channelId !== gpt;
  }

  /**
   * The ONE place a reply may become persistent, and it can only ever remove
   * ephemerality -- never add it.
   *
   * Doing this at the boundary rather than in each of thirty presenters is
   * deliberate. A presenter chooses ephemerality for a REASON -- this is
   * personal data, this is a signed control -- and thirty places each deciding
   * again is thirty chances to get it wrong for a channel none of them knows
   * about. Here there is one rule and one place to read it.
   *
   * Every condition must hold:
   *
   * - the actor is the OWNER. A non-owner's reply is a refusal or ordinary
   *   conversation, and neither becomes persistent because somebody configured
   *   a channel;
   * - the request arrived in a configured ROLE channel, which requires a guild
   *   id, so a DM can never reach this;
   * - the reply is not already persistent.
   *
   * A shared channel cannot reach this either: a channel that is both is
   * refused at boot, so the two sets are disjoint by construction.
   *
   * **Controls persist too.** A signed control in scrollback is bound to the
   * owner and refuses a different presser, so this is disclosure rather than
   * privilege escalation -- and disclosure inside a channel the owner
   * designated private is what they asked for. The one exception is documented
   * on `PERSISTENCE_EXEMPT_INTERACTIONS` below.
   */
  private persistInRoleChannel(
    actor: ActorContext,
    event: Incoming,
    reply: OutboundMessage | undefined,
  ): OutboundMessage | undefined {
    if (!reply || reply.ephemeral === false) return reply;
    if (actor.discordUserId !== this.deps.authz.ownerId) return reply;

    const context = event.kind === 'component' ? undefined : event.context;
    if (!this.channelRoles.isRoleChannel(context)) return reply;
    if (this.isPersistenceExempt(event)) return reply;

    return { ...reply, ephemeral: false };
  }

  /**
   * The one thing that stays ephemeral in a role channel, and why.
   *
   * `/forget` is two-step: the command shows what will go and returns a signed
   * control that DELETES when pressed. That control is exempt not because the
   * signature is weak -- it refuses anybody but the owner, like every other --
   * but because a durable one-press delete sitting in scrollback is a different
   * class of object from a task list. The owner scrolls back through their own
   * channel; a stale confirm button is a hazard to them, not to a reader.
   *
   * This is the "structurally required by an existing safety invariant"
   * exception, and it is documented rather than silent: the reply says it is
   * ephemeral and why. See ADR 0023.
   */
  private isPersistenceExempt(event: Incoming): boolean {
    if (event.kind === 'command') return event.name === 'forget';
    return false;
  }

  private async handleCommand(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'command' }>,
  ): Promise<OutboundMessage> {
    const handler = this.commands.get(event.name);
    // Unknown commands are refused before any authorization detail leaks.
    if (!handler) return { content: 'Unknown command.', ephemeral: true };

    // A configured shared channel serves the shared projection for the two
    // read routes -- to EVERYONE there, the owner included. Giving the owner
    // the private view here instead would put task text, questions and signed
    // controls into a channel other people can read, which is precisely the
    // accident this branch exists to prevent. The owner reads the private
    // view in a DM.
    if (this.sharedPolicy.isSharedRequest(event.context)) {
      const projected = await this.handleSharedRead(actor, event);
      if (projected) return projected;
    }

    // Owner-only at the router AND again inside every service method.
    this.deps.authz.requireOwner(actor);
    return handler(actor, event);
  }

  /**
   * The shared-channel read path.
   *
   * Returns undefined for anything that is not a shared-readable route, which
   * falls through to the normal owner-only path: a non-owner is refused
   * exactly as they are anywhere else, and the owner keeps full control from
   * the channel with an ephemeral reply. That is what keeps writes owner-only
   * while still letting the owner submit a job from the channel it should be
   * reported in.
   *
   * It never calls `jobs.list` or `jobs.detail`. The projection service is
   * the only thing it can reach, so there is no code path from here to a
   * private field.
   *
   * Both reads are scoped to THIS channel. `isSharedRequest` has already
   * established that `context.channelId` is a configured shared channel, and
   * that same id is what the projection service scopes by -- so a channel can
   * only ever show the jobs submitted in it, never one from a DM or from
   * another shared channel.
   */
  private async handleSharedRead(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'command' }>,
  ): Promise<OutboundMessage | undefined> {
    const sharedJobs = this.deps.sharedJobs;
    if (!sharedJobs) return undefined;
    if (!isSharedReadableRoute(event.name, event.subcommand)) return undefined;

    // `isSharedRequest` returned true, so this is present and configured.
    // Re-checked rather than asserted: a missing id must fall through to the
    // private owner-only path, never read across every channel.
    const channelId = event.context?.channelId;
    if (channelId === undefined) return undefined;

    // Rate limited like any other read, keyed by the requesting user, so a
    // shared channel cannot be used to hammer the database.
    this.buckets.check('jobRead', actor.discordUserId);

    if (event.name === 'jobs') return shared.sharedJobsList(sharedJobs.list(channelId));
    return shared.sharedJobDetail(
      sharedJobs.detail(channelId, String(event.options['id'] ?? '')),
    );
  }

  private async handleComponent(
    actor: ActorContext,
    customId: string,
    values?: Record<string, string>,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireOwner(actor);
    const verified = this.deps.signer.verify(customId, actor.discordUserId);
    if (!verified) return { content: 'That control is no longer valid.', ephemeral: true };
    const handler = this.components.get(verified.kind);
    if (!handler) return { content: 'That control is no longer valid.', ephemeral: true };
    this.buckets.check('interaction', actor.discordUserId);
    return handler(actor, verified.entityId, values);
  }

  /**
   * The single non-privileged route: conversation, with no tool access.
   *
   * Plain text keeps its Phase 1 authorization exactly: the chat whitelist may
   * talk. An ATTACHMENT is different and is owner-only -- see
   * `handleConversationAttachment` for why.
   */
  private async handleMessage(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'message' }>,
  ): Promise<OutboundMessage | undefined> {
    this.deps.authz.requireConversational(actor);
    const attachments = event.attachments ?? [];

    if (attachments.length === 0) {
      // Deterministic rules FIRST, and only for the owner. A matched intent is
      // answered from stored records or a fixed local table; a matched WRITE is
      // proposed and never applied until the owner confirms in their own words.
      // Everything else -- almost every message -- falls through to the provider
      // exactly as it did before.
      const handled = this.deps.intents?.handle(
        actor,
        event.threadKey,
        event.text,
        this.channelRoles.roleOf(event.context),
      );
      if (handled) {
        // Recorded like any other exchange, so a follow-up question still has
        // the context of what was just proposed or answered.
        this.deps.memory?.record(
          actor,
          event.threadKey,
          { userText: event.text, assistantText: handled.content ?? '' },
          event.context,
        );
        return handled;
      }
      /**
       * Deterministic rules have had their say. What is left goes to the
       * model -- and that is the part that needs containing.
       *
       * With the MessageContent intent the bot receives every message in every
       * channel it can read, so before role channels existed conversation
       * answered anywhere. On a small guild that was merely noisy. Once an
       * owner designates a `gpt` channel it is wrong twice over: model output
       * appears in channels chosen for something else, and every stray message
       * spends subscription quota.
       *
       * The check sits HERE and not at the top of this method, because the
       * task and coding channels must still get their proposals: containment
       * is about conversation, not about the deterministic rules that run
       * first. Putting it earlier silenced the coding channel entirely, which
       * a test caught.
       */
      if (this.isSilencedConversationChannel(event.context)) return undefined;

      return this.converse({
        actor,
        userId: actor.discordUserId,
        text: event.text,
        threadKey: event.threadKey,
        ...(event.context ? { context: event.context } : {}),
      });
    }
    return this.handleConversationAttachment(actor, event, attachments);
  }

  /**
   * Conversation with one attachment.
   *
   * The order of these checks IS the security property, so it is written out
   * rather than left to reading order:
   *
   * 1. **Owner-only.** Plain chat stays on the whitelist, but an attachment is
   *    personal data being handed to an external provider, and fetching one
   *    spends the owner's bandwidth and provider budget on a URL somebody else
   *    chose. A whitelist user gets the same refusal they get anywhere else.
   * 2. **One at a time**, refused before anything is inspected further.
   * 3. **Capability**, which is the refusal that matters: if the provider is
   *    not verified AND attachment-capable AND the operator has opted in,
   *    the answer is honest and NO BYTES ARE FETCHED. This is checked before
   *    the rate-limit charge and before any URL is touched.
   * 4. **Metadata policy** -- type, size, HTTPS, exact CDN host -- still
   *    entirely offline.
   * 5. Only then a download, into a private temp file.
   *
   * The handle is disposed in a `finally`, so a provider that throws, hangs
   * past its own timeout, or simply returns leaves nothing on disk.
   */
  private async handleConversationAttachment(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'message' }>,
    attachments: readonly IncomingAttachment[],
  ): Promise<OutboundMessage> {
    this.deps.authz.requireOwner(actor);

    if (attachments.length > CONVERSATION_MAX_ATTACHMENTS_PER_MESSAGE) {
      return { content: TOO_MANY_ATTACHMENTS_MESSAGE, ephemeral: false };
    }

    const config = this.deps.conversationAttachments;
    const provider = this.deps.conversation;
    // An unwired router has no config at all, which refuses exactly as a
    // configured-but-unusable one does. Failing closed here loses a feature;
    // failing open would send the owner's files to an unverified endpoint.
    if (!config || !conversationAttachmentsUsable(provider, config)) {
      return {
        content:
          'I cannot accept files yet — ' +
          `attachments are ${config ? attachmentAvailability(provider, config) : 'not configured'}. ` +
          'Nothing was downloaded.',
        ephemeral: false,
      };
    }

    const meta = attachments[0]!;
    // Charged before the metadata check, so a stream of rejected files still
    // costs budget. Only the owner reaches this line, so it is accident
    // containment rather than an authorization control -- the same reasoning
    // the command buckets carry.
    this.deps.chargeConversationAttachment?.(actor.discordUserId);

    const handle = await downloadConversationAttachment(meta, provider, config);
    try {
      return await this.converse({
        actor,
        userId: actor.discordUserId,
        text: event.text,
        threadKey: event.threadKey,
        // The provider receives the NARROW type, which has no `dispose`: it is
        // structurally unable to keep the bytes alive past this call.
        attachment: handle,
      });
    } finally {
      // Success, provider error, or a throw from anywhere in between.
      await handle.dispose();
    }
  }

  /**
   * One conversational turn, with continuity when it is configured.
   *
   * The history is read for THIS actor and THIS thread only, and the exchange is
   * recorded only after a reply actually came back -- a stored question with no
   * answer would be replayed as if Ducky had ignored it. Both are no-ops when
   * continuity is off, when the router has no memory service, or when the thread
   * is a configured shared channel.
   */
  /**
   * The owner's own candidates for one kind, bounded, with the ids they can
   * type.
   *
   * Reads only owner-scoped list methods that already existed. Captures and
   * schedule entries are identified by the first 8 characters of their id --
   * which is exactly what `/inbox` already displays -- and `previewEntity`
   * refuses a prefix that could mean two records rather than picking one.
   */
  private forgetCandidates(
    actor: ActorContext,
    target: ForgetEntityTarget,
  ): present.ForgetCandidate[] {
    const d = this.deps;
    switch (target) {
      case 'job':
        return d.jobs.list(actor, 10).map((j) => ({
          id: j.publicId,
          describes: `${j.repoSlug} · ${j.state.replace(/_/g, ' ')}`,
        }));
      case 'task':
        return d.tasks.list(actor, 'all', 10).map((t) => ({
          id: t.publicId,
          describes: `${t.status} · ${t.title}`,
        }));
      case 'reminder':
        return d.reminders.list(actor, 'all', 10).map((r) => ({
          id: r.publicId,
          describes: `${r.status} · ${r.text}`,
        }));
      case 'capture':
        return d.captures.list(actor, 'all').slice(0, 10).map((c) => ({
          id: c.id.slice(0, 8),
          describes: `${c.status} · ${c.content}`,
        }));
      case 'schedule':
        return d.schedules.list(actor, 10).map((row) => ({
          id: row.id.slice(0, 8),
          describes: `${row.startsAt} · ${row.title}`,
        }));
    }
  }

  private async converse(input: {
    actor: ActorContext;
    userId: string;
    text: string;
    threadKey: string;
    context?: IncomingContext;
    attachment?: ConversationAttachment;
  }): Promise<OutboundMessage> {
    const memory = this.deps.memory;
    const history = memory?.history(input.actor, input.threadKey, input.context) ?? [];

    let reply;
    try {
      reply = await this.deps.conversation.reply({
        userId: input.userId,
        text: input.text,
        threadKey: input.threadKey,
        ...(input.attachment ? { attachment: input.attachment } : {}),
        ...(history.length > 0 ? { history } : {}),
      });
    } catch (err) {
      // "The owner asked and got no answer" was invisible in the trail. Records
      // the PROVIDER and the error code, never the message the owner sent and
      // never the provider's raw error text.
      this.deps.onProviderFailure?.({
        provider: this.deps.conversation.name,
        code: isDuckyError(err) ? err.code : 'unknown',
      });
      throw err;
    }
    // A stand-in reply is always visibly marked so it cannot be mistaken for a
    // real assistant answer.
    const content = reply.mock ? `[mock] ${reply.text}` : reply.text;
    // Recorded AFTER the reply exists, and it can never fail the reply.
    memory?.record(
      input.actor,
      input.threadKey,
      { userText: input.text, assistantText: content },
      input.context,
    );
    return { content, ephemeral: false };
  }

  // ------------------------------------------------------------- commands --

  private registerCommands(): void {
    const d = this.deps;

    /**
     * `/forget <kind> [id]`.
     *
     * Two-step for every kind that names a record: the command SHOWS what will
     * go and returns a signed confirm control, and only pressing it deletes.
     * `conversation` is one step, because there is no id to confirm and no
     * live-work reason it could be refused.
     *
     * With no id, the command LISTS the owner's candidates with the ids they can
     * type. Discovery lives here rather than in the other surfaces so that
     * captures and schedule entries -- which have no short public handle -- are
     * still reachable without adding a command, and so `/forget` is
     * self-contained.
     *
     * There is deliberately no `/forget all`, no filter and no wildcard.
     * `FORGET_TARGETS` cannot express one, so this route has nothing broader to
     * offer, and every kind here is a CHOICE on a command that was already
     * owner-only -- the owner-only surface is not widened by any of them.
     */
    this.commands.set('forget', async (actor, e) => {
      this.buckets.check('interaction', actor.discordUserId);
      const forget = d.forget;
      if (!forget) {
        return { content: 'Deletion is not configured on this instance.', ephemeral: true };
      }

      const raw = String(e.options['target'] ?? 'job').trim().toLowerCase();
      if (!isForgetTarget(raw)) {
        return {
          content: `Choose one of: ${FORGET_TARGETS.join(', ')}.`,
          ephemeral: true,
        };
      }
      if (raw === 'conversation') {
        return { content: forget.forgetConversation(actor).message, ephemeral: true };
      }

      const target: ForgetEntityTarget = raw;
      const id = String(e.options['id'] ?? '').trim();
      if (id === '') return present.forgetCandidates(target, this.forgetCandidates(actor, target));

      const preview = forget.previewEntity(actor, target, id);
      if (!preview.found) return { content: preview.message, ephemeral: true };

      return present.forgetConfirm(preview, d.signer.sign({
        kind: 'forget_confirm',
        // The kind travels WITH the id: a control minted for a task must not be
        // replayable as a job id, and the handler must not have to guess.
        //
        // `.` and not `:` -- the signed custom id is itself colon-delimited and
        // parsed as exactly five segments, so a colon here silently invalidated
        // the signature and the egress sanitizer dropped the button before it
        // could render. `.` is inside the entity-segment character class the
        // sanitizer allows, and no id of any kind contains one.
        entityId: `${target}.${preview.id}`,
        actorUserId: actor.discordUserId,
      }));
    });

    this.commands.set('capture', async (actor, e) => {
      this.buckets.check('capture', actor.discordUserId);
      const row = d.captures.create(actor, String(e.options['text'] ?? ''));
      return present.captureAck(row);
    });

    this.commands.set('inbox', async (actor, e) => {
      this.buckets.check('jobRead', actor.discordUserId);
      const status = (e.options['status'] as CaptureState | 'all' | undefined) ?? 'open';
      const rows = d.captures.list(actor, status);
      const buttons: OutboundRow[] = rows.slice(0, 5).map((r) => ({
        buttons: [
          ...(['inbox_done', 'inbox_archive', 'inbox_delete'] as const).map((kind) => ({
            customId: d.signer.sign({ kind, entityId: r.id, actorUserId: actor.discordUserId }),
            label: `${kind.split('_')[1]} ${r.id.slice(0, 4)}`,
            style: kind === 'inbox_delete' ? ('danger' as const) : ('secondary' as const),
          })),
          ...(r.status === 'open'
            ? [{
                customId: d.signer.sign({
                  kind: 'inbox_task', entityId: r.id, actorUserId: actor.discordUserId,
                }),
                label: `task ${r.id.slice(0, 4)}`,
                style: 'primary' as const,
              }]
            : []),
        ],
      }));
      return present.inboxList(rows, buttons);
    });

    this.commands.set('schedule', async (actor, e) => {
      this.buckets.check('schedule', actor.discordUserId);
      let text = String(e.options['text'] ?? '');
      let kind: 'text' | 'file' = 'text';
      if (e.attachment) {
        if (!d.readAttachment) {
          throw new DuckyError('attachment_rejected', 'Attachments are not enabled here.');
        }
        text = await d.readAttachment(e.attachment);
        kind = 'file';
      }
      if (text.trim() === '') {
        return { content: 'Send the schedule as text, or attach a .txt or .csv file.', ephemeral: true };
      }
      const outcome = await d.schedules.preview(actor, { kind, text });
      if (outcome.kind === 'empty') {
        return {
          content: 'No schedule entries found in that. Nothing was saved.',
          ephemeral: true,
        };
      }
      const rows: OutboundRow[] = [
        {
          buttons: [
            {
              customId: d.signer.sign({
                kind: 'sched_confirm',
                entityId: outcome.draft.draftId,
                actorUserId: actor.discordUserId,
              }),
              label: `Confirm ${outcome.draft.entries.length}`,
              style: 'success',
            },
            {
              customId: d.signer.sign({
                kind: 'sched_edit',
                entityId: outcome.draft.draftId,
                actorUserId: actor.discordUserId,
              }),
              label: 'Correct',
              style: 'primary',
            },
            {
              customId: d.signer.sign({
                kind: 'sched_discard',
                entityId: outcome.draft.draftId,
                actorUserId: actor.discordUserId,
              }),
              label: 'Discard',
              style: 'secondary',
            },
          ],
        },
      ];
      return present.schedulePreview(outcome.draft, rows);
    });

    this.commands.set('jobs', async (actor) => {
      this.buckets.check('jobRead', actor.discordUserId);
      return present.jobsList(d.jobs.list(actor));
    });

    this.commands.set('job', async (actor, e) => {
      const sub = e.subcommand ?? 'status';
      switch (sub) {
        case 'submit': {
          this.buckets.check('jobSubmit', actor.discordUserId);
          const input = JobSubmitInputSchema.parse({
            repoSlug: String(e.options['repo'] ?? ''),
            task: String(e.options['task'] ?? ''),
            ...(e.options['context'] === undefined ? {} : { context: String(e.options['context']) }),
            bootstrap: e.options['bootstrap'] === true,
          });
          // Recorded only when this really is a configured shared channel, so
          // the column can never hold an id that was not shared at write time.
          const sharedChannelId = this.sharedPolicy.isSharedRequest(e.context)
            ? e.context?.channelId
            : undefined;
          const job = d.jobs.submit(actor, input, { sharedChannelId });
          return {
            content: `Job \`${job.publicId}\` created for \`${job.repoSlug}\` (${job.state.replace(/_/g, ' ')}).`,
            ephemeral: true,
          };
        }
        case 'cancel': {
          this.buckets.check('jobRead', actor.discordUserId);
          const r = d.jobs.requestCancel(actor, String(e.options['id'] ?? ''));
          return { content: `${r.note} (state: ${r.state})`, ephemeral: true };
        }
        case 'answer': {
          this.buckets.check('jobRead', actor.discordUserId);
          const input = JobAnswerInputSchema.parse({
            publicId: String(e.options['id'] ?? ''),
            answer: String(e.options['answer'] ?? ''),
          });
          const r = d.jobs.submitOwnerInput(actor, input.publicId, input.answer);
          return { content: `${r.note} (state: ${r.state})`, ephemeral: true };
        }
        case 'cleanup': {
          this.buckets.check('jobRead', actor.discordUserId);
          const r = d.jobs.cleanup(actor, String(e.options['id'] ?? ''), e.options['force'] === true);
          return { content: r.note, ephemeral: true };
        }
        case 'execute': {
          this.buckets.check('jobRead', actor.discordUserId);
          const r = await d.approvals.execute(actor, String(e.options['id'] ?? ''));
          return { content: r.note, ephemeral: true };
        }
        default: {
          this.buckets.check('jobRead', actor.discordUserId);
          const detail = d.jobs.detail(actor, String(e.options['id'] ?? ''));
          const rows: OutboundRow[] = [];
          const pending = detail.approvals.filter((a) => a.state === 'pending');
          if (pending.length > 0) {
            rows.push(
              ...pending.slice(0, 4).map((a) => ({
                buttons: (['approve', 'reject', 'approval_details'] as const).map((kind) => ({
                  customId: d.signer.sign({ kind, entityId: a.id, actorUserId: actor.discordUserId }),
                  label: `${kind === 'approval_details' ? 'details' : kind} #${a.actionIndex + 1}`,
                  style: kind === 'approve'
                    ? ('success' as const)
                    : kind === 'reject'
                      ? ('danger' as const)
                      : ('primary' as const),
                })),
              })),
            );
          }
          const approved = detail.approvals.filter((a) => a.state === 'approved').slice(0, 4);
          rows.push(
            ...approved.map((a) => ({
              buttons: [{
                customId: d.signer.sign({
                  kind: 'execute_approval', entityId: a.id, actorUserId: actor.discordUserId,
                }),
                label: `execute #${a.actionIndex + 1}`,
                style: 'success' as const,
              }],
            })),
          );
          if (detail.job.state === 'needs_owner_input') {
            rows.push({
              buttons: [
                {
                  customId: d.signer.sign({
                    kind: 'job_answer',
                    entityId: detail.job.publicId,
                    actorUserId: actor.discordUserId,
                  }),
                  label: 'Answer',
                  style: 'primary',
                },
              ],
            });
          }
          const reservation = undefined;
          void reservation;
          return present.jobDetail(
            detail.job,
            detail.events,
            detail.approvals,
            detail.result?.summaryRedacted ?? null,
            rows,
            detail.dependencies,
            d.jobs.placementHold(detail.job.repoSlug),
          );
        }
      }
    });

    this.commands.set('repo', async (actor, e) => {
      this.buckets.check('jobRead', actor.discordUserId);
      const summary = await d.github.repoStatus(actor, String(e.options['slug'] ?? ''));
      return present.repoStatus(summary);
    });

    this.commands.set('watch', async (actor, e) => {
      this.buckets.check('jobRead', actor.discordUserId);
      switch (e.subcommand ?? 'list') {
        case 'add':
          return assistant.watchAdded(d.githubWatches.add(actor, {
            repoSlug: String(e.options['repo'] ?? ''),
            ...(e.options['every'] === undefined ? {} : { everyMinutes: e.options['every'] }),
          }));
        case 'remove':
        case 'cancel':
          return assistant.watchCancelled(
            d.githubWatches.cancel(actor, String(e.options['id'] ?? '')),
          );
        default: {
          const all = e.options['filter'] === 'all';
          const rows = d.githubWatches.list(actor, all);
          return assistant.watchesList(rows, this.watchRows(actor, rows), all);
        }
      }
    });

    this.commands.set('status', async (actor) => {
      this.buckets.check('jobRead', actor.discordUserId);
      d.authz.requireOwner(actor);
      return present.statusEmbed(d.status());
    });

    // ---- daily assistant (2B). Owner-only, ephemeral, never shared. --------

    this.commands.set('task', async (actor, e) => {
      this.buckets.check('assistant', actor.discordUserId);
      switch (e.subcommand ?? 'list') {
        case 'add': {
          const row = d.tasks.add(actor, {
            title: String(e.options['title'] ?? ''),
            ...(e.options['due'] === undefined ? {} : { due: String(e.options['due']) }),
            ...(e.options['priority'] === undefined
              ? {}
              : { priority: String(e.options['priority']) }),
          });
          return assistant.taskAdded(row, d.tasks.timeZone);
        }
        case 'done':
          return assistant.taskClosed(d.tasks.complete(actor, String(e.options['id'] ?? '')));
        case 'cancel':
          return assistant.taskClosed(d.tasks.cancel(actor, String(e.options['id'] ?? '')));
        default: {
          const raw = e.options['filter'];
          const filter: TaskListFilter = isTaskListFilter(raw) ? raw : 'open';
          const rows = d.tasks.list(actor, filter);
          return assistant.tasksList(rows, d.tasks.timeZone, filter, this.taskRows(actor, rows));
        }
      }
    });

    this.commands.set('reminder', async (actor, e) => {
      this.buckets.check('assistant', actor.discordUserId);
      switch (e.subcommand ?? 'list') {
        case 'add': {
          const row = d.reminders.add(actor, {
            text: String(e.options['text'] ?? ''),
            at: String(e.options['at'] ?? ''),
            ...(e.options['every'] === undefined ? {} : { every: String(e.options['every']) }),
            ...(e.options['count'] === undefined ? {} : { count: e.options['count'] }),
          });
          return assistant.reminderAdded(row, d.reminders.timeZone);
        }
        case 'cancel':
          return assistant.reminderCancelled(
            d.reminders.cancel(actor, String(e.options['id'] ?? '')),
          );
        default: {
          const filter: ReminderListFilter = e.options['filter'] === 'all' ? 'all' : 'scheduled';
          const rows = d.reminders.list(actor, filter);
          return assistant.remindersList(
            rows,
            d.reminders.timeZone,
            filter,
            this.reminderRows(actor, rows),
          );
        }
      }
    });

    /**
     * Deterministic in full: `BriefingService` reads stored rows and counts
     * them. No provider is reachable from here, so nothing in a briefing can
     * be generated -- which is the point, because a briefing that invents a
     * deadline is worse than no briefing at all.
     */
    this.commands.set('briefing', async (actor, e) => {
      this.buckets.check('assistant', actor.discordUserId);
      const raw = e.options['when'];
      // An unrecognised value falls back to the time-of-day default rather
      // than erroring: the owner asked for a briefing either way.
      const kind = isBriefingKind(raw) ? raw : undefined;
      return assistant.briefingMessage(d.briefing.build(actor, kind));
    });
  }

  /**
   * Controls for the first few OPEN tasks.
   *
   * Bounded by Discord's five-action-row limit, and attached only to open
   * rows: a Done button on a cancelled task is a control that cannot act.
   * Signed and actor-bound like every other component, and verified through
   * the identical path on the way back in.
   */
  private taskRows(actor: ActorContext, rows: readonly { publicId: string; status: string }[]): OutboundRow[] {
    return rows
      .filter((r) => r.status === 'open')
      .slice(0, 4)
      .map((r) => ({
        buttons: (['task_done', 'task_cancel'] as const).map((kind) => ({
          customId: this.deps.signer.sign({
            kind,
            entityId: r.publicId,
            actorUserId: actor.discordUserId,
          }),
          label: `${kind === 'task_done' ? 'done' : 'cancel'} ${r.publicId}`,
          style: kind === 'task_done' ? ('success' as const) : ('secondary' as const),
        })),
      }));
  }

  private watchRows(
    actor: ActorContext,
    rows: readonly { publicId: string; state: string }[],
  ): OutboundRow[] {
    const active = rows.filter((r) => r.state === 'active').slice(0, 5);
    if (active.length === 0) return [];
    return [{
      buttons: active.map((watch) => ({
        customId: this.deps.signer.sign({
          kind: 'watch_cancel', entityId: watch.publicId, actorUserId: actor.discordUserId,
        }),
        label: `cancel ${watch.publicId}`,
        style: 'secondary' as const,
      })),
    }];
  }

  private reminderRows(
    actor: ActorContext,
    rows: readonly { publicId: string; status: string }[],
  ): OutboundRow[] {
    const cancellable = rows.filter((r) => r.status === 'scheduled').slice(0, 5);
    if (cancellable.length === 0) return [];
    return [
      {
        buttons: cancellable.map((r) => ({
          customId: this.deps.signer.sign({
            kind: 'reminder_cancel',
            entityId: r.publicId,
            actorUserId: actor.discordUserId,
          }),
          label: `cancel ${r.publicId}`,
          style: 'secondary' as const,
        })),
      },
    ];
  }

  // ----------------------------------------------------------- components --

  private registerComponents(): void {
    const d = this.deps;

    const setStatus = (status: CaptureState): ComponentHandler => async (actor, entityId) => {
      d.captures.setStatus(actor, entityId, status);
      return { content: `Marked ${status}.`, ephemeral: true };
    };

    this.components.set('inbox_done', setStatus('done'));
    this.components.set('inbox_archive', setStatus('archived'));
    this.components.set('inbox_delete', async (actor, entityId) => {
      d.captures.delete(actor, entityId);
      return { content: 'Deleted.', ephemeral: true };
    });
    this.components.set('inbox_task', async (actor, entityId) =>
      assistant.taskPromoted(d.tasks.promoteCapture(actor, entityId), d.tasks.timeZone),
    );

    this.components.set('sched_confirm', async (actor, entityId) => {
      const { saved } = d.schedules.confirm(actor, entityId);
      return { content: `Saved ${saved} schedule entr${saved === 1 ? 'y' : 'ies'}.`, ephemeral: true };
    });
    /**
     * The button opens a modal (handled in the transport); the submission
     * arrives here with the edited text. One entry per line, in the same shape
     * the extractor emits, so a correction is a re-parse rather than a
     * free-form edit that could smuggle anything past validation.
     */
    this.components.set('sched_edit', async (actor, entityId, values) => {
      const raw = values?.['entries'];
      if (!raw) {
        const draft = d.schedules.pendingDraft(actor, entityId);
        if (!draft) {
          return {
            content: 'This schedule preview expired. Send it again.',
            ephemeral: true,
          };
        }
        return {
          content:
            'Edit the entries and submit again, one per line:\n```\n' +
            draft.entries
              .map((e) =>
                [e.startsAt, e.title, e.location ?? '', e.notes ?? '']
                  .join(' | ')
                  .replace(/\s*\|\s*$/, ''),
              )
              .join('\n') +
            '\n```',
          ephemeral: true,
        };
      }
      const corrected = await d.schedules.correctFromText(actor, entityId, raw);
      if (corrected.entries.length === 0) {
        return { content: 'No schedule entries found in that. Nothing was saved.', ephemeral: true };
      }
      const rows: OutboundRow[] = [
        {
          buttons: [
            {
              customId: d.signer.sign({
                kind: 'sched_confirm',
                entityId,
                actorUserId: actor.discordUserId,
              }),
              label: `Confirm ${corrected.entries.length}`,
              style: 'success',
            },
            {
              customId: d.signer.sign({
                kind: 'sched_edit',
                entityId,
                actorUserId: actor.discordUserId,
              }),
              label: 'Correct',
              style: 'primary',
            },
          ],
        },
      ];
      return present.schedulePreview(corrected, rows);
    });

    this.components.set('sched_discard', async (actor, entityId) => {
      d.schedules.discard(actor, entityId);
      return { content: 'Discarded. Nothing was saved.', ephemeral: true };
    });

    this.components.set('job_answer', async (actor, entityId, values) => {
      const answer = values?.['answer'];
      if (!answer) {
        return { content: `Use \`/job answer id:${entityId} answer:<your answer>\`.`, ephemeral: true };
      }
      const parsed = JobAnswerInputSchema.parse({ publicId: entityId, answer });
      const r = d.jobs.submitOwnerInput(actor, parsed.publicId, parsed.answer);
      return { content: `${r.note} (state: ${r.state})`, ephemeral: true };
    });

    this.components.set('job_cleanup', async (actor, entityId) => {
      const r = d.jobs.cleanup(actor, entityId, false);
      return { content: r.note, ephemeral: true };
    });

    this.components.set('approve', async (actor, entityId) => {
      const outcome = d.approvals.decide(actor, entityId, 'approved');
      return { content: `${outcome.note} Job is now ${outcome.jobState}.`, ephemeral: true };
    });
    this.components.set('reject', async (actor, entityId) => {
      const outcome = d.approvals.decide(actor, entityId, 'rejected');
      return { content: `${outcome.note} Job is now ${outcome.jobState}.`, ephemeral: true };
    });
    this.components.set('approval_details', async (actor, entityId) => {
      const detail = d.approvals.detail(actor, entityId);
      return present.approvalDetails(detail.approval, detail.job);
    });
    this.components.set('execute_approval', async (actor, entityId) => {
      const outcome = await d.approvals.execute(actor, entityId);
      return { content: outcome.note, ephemeral: true };
    });

    // The entity id is the short public handle, not the internal UUID: the
    // outbound redactor rewrites any bare GUID it sees, so a UUID shown in a
    // label would reach the owner unreadable. The service re-checks owner
    // ownership on the way in regardless of what the signature says.
    this.components.set('task_done', async (actor, entityId) =>
      assistant.taskClosed(d.tasks.complete(actor, entityId)),
    );
    this.components.set('task_cancel', async (actor, entityId) =>
      assistant.taskClosed(d.tasks.cancel(actor, entityId)),
    );
    this.components.set('reminder_cancel', async (actor, entityId) =>
      assistant.reminderCancelled(d.reminders.cancel(actor, entityId)),
    );
    this.components.set('watch_cancel', async (actor, entityId) =>
      assistant.watchCancelled(d.githubWatches.cancel(actor, entityId)),
    );
    // The signature is already verified and bound to the owner before this
    // runs; the service re-checks ownership anyway.
    this.components.set('forget_confirm', async (actor, entityId) => {
      if (!d.forget) {
        return { content: 'Deletion is not configured on this instance.', ephemeral: true };
      }
      // `kind.id`, or a bare job id from a control minted before the other
      // kinds existed. An unsigned or re-signed value cannot reach here.
      const sep = entityId.indexOf('.');
      const kind = sep < 0 ? 'job' : entityId.slice(0, sep);
      const id = sep < 0 ? entityId : entityId.slice(sep + 1);
      if (!isForgetEntityTarget(kind)) {
        return { content: 'That control is no longer valid.', ephemeral: true };
      }
      const result = d.forget.forgetEntity(actor, kind, id);
      return { content: result.message, ephemeral: true };
    });
  }
}

export const CONVERSATION_ROUTE_NAME = CONVERSATIONAL_ROUTE;

function errorReply(err: unknown): OutboundMessage {
  if (isDuckyError(err)) return { content: err.ownerMessage, ephemeral: true };
  if (err instanceof Error && err.name === 'ZodError') {
    return { content: 'That input was not valid.', ephemeral: true };
  }
  return { content: 'Something went wrong handling that.', ephemeral: true };
}

export type { OwnerOnlyCommand, OwnerOnlyInteractionKind };
