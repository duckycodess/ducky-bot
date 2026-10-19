import {
  FORGET_TARGETS, isForgetEntityTarget, isForgetTarget, type ForgetEntityTarget,
  ALL_INTERACTION_KINDS, CONVERSATIONAL_INTERACTION_KINDS, CONVERSATIONAL_ROUTE,
  CONVERSATION_ANCHOR_TEXT_MAX, CONVERSATION_MAX_ATTACHMENTS_PER_MESSAGE,
  DuckyError, JobAnswerInputSchema, JobSubmitInputSchema,
  OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS, SCHEDULE_ROLLBACK_CODE_LENGTH, SHARED_READABLE_ROUTES,
  cleanUntrusted,
  isBriefingKind, isConversationalInteractionKind, isDuckyError, isSharedReadableRoute,
  isTaskListFilter, looksLikeBulkTaskList,
  TASK_CARDS_PER_MESSAGE, discordTimestamp,
  type CaptureState, type ConversationalInteractionKind, type OwnerOnlyCommand,
  type OwnerOnlyInteractionKind, type ReminderListFilter, type TaskListFilter,
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
import type { AssistantWatchService } from '../domain/assistant-watch.service.js';
import type { ForgetService } from '../domain/forget.service.js';
import type { ConversationMemoryService } from '../domain/conversation-memory.service.js';
import { threadNameFor, type ConversationThreadService } from '../domain/conversation-threads.js';
import type { IntentsService } from '../domain/intents.service.js';
import type { SkillBridgeService } from '../domain/skill-bridge.service.js';
import type { SharedJobsService } from '../domain/shared-jobs.service.js';
import type { TasksService } from '../domain/tasks.service.js';
import type { TaskCaptureService, TaskCaptureOutcome } from '../domain/task-capture.service.js';
import { clarificationMessage, editableListText } from '../domain/task-capture.service.js';
import type { RemindersService } from '../domain/reminders.service.js';
import type { BriefingService } from '../domain/briefing.service.js';
import { conversationReply } from './assistant-presenters.js';
import { bulkPreview, deadlineLine, taskCard, taskCardRow } from './task-cards.js';
import { SharedChannelPolicy } from '../domain/shared-visibility.js';
import { ChannelRolePolicy } from '../domain/channel-roles.js';
import { ReplyPersistencePolicy } from '../domain/reply-persistence.js';
import type { OutboundMessage, OutboundRow } from './message.js';
import type {
  Incoming, IncomingAttachment, IncomingContext, IncomingReference,
} from './transport.js';
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
  readonly assistantWatch: AssistantWatchService;
  /**
   * The daily assistant. Owner-only in full: none of these is reachable from
   * `handleSharedRead`, and no shared route names any of their commands.
   */
  readonly tasks: TasksService;
  /**
   * Pasted task lists. OMITTING IT DISABLES THE PATH ENTIRELY: an unwired
   * router reads no message as a list and offers no preview, which is the same
   * fail-closed posture `forget` and the shared-visibility wiring take.
   */
  readonly taskCapture?: TaskCaptureService;
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
   * Native Discord threads as conversations. OMITTING IT means no message ever
   * routes into a thread and the Branch and Compact controls never appear --
   * the same fail-closed posture `memory` and `forget` take.
   */
  readonly threads?: ConversationThreadService;
  /**
   * Deterministic natural-language intents on the conversation route. OMITTING
   * IT means every message goes straight to the provider, exactly as before.
   */
  readonly intents?: IntentsService;
  /**
   * The owner's repository workflow: `$grill-me`, `$ticket`, `$agentize`.
   *
   * OMITTING IT DISABLES THE WHOLE BRIDGE, which is the same fail-closed
   * posture `forget`, `memory` and the attachment config take: an
   * incompletely wired router must lose a feature, never gain a way to
   * publish. With it absent, those three tokens are ordinary text.
   */
  readonly skillBridge?: SkillBridgeService;
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
  /**
   * The one rule deciding reply visibility. Supplied by the composition root
   * so the transport and the router share an instance.
   */
  readonly replyPersistence?: ReplyPersistencePolicy;
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
/** Notification targets shown per page of `/watch list targets`. */
const WATCH_TARGET_PAGE = 15;

export class DuckyRouter {
  private readonly commands = new Map<string, CommandHandler>();
  private readonly components = new Map<string, ComponentHandler>();
  /**
   * The conversational controls, in their OWN map.
   *
   * Separate from `components` so the owner-only assertion stays exact: the
   * owner-only map must equal `OWNER_ONLY_INTERACTION_KINDS` with nothing
   * added, and a control a non-owner may press cannot be allowed to hide in
   * it. The two maps are asserted disjoint and their union asserted equal to
   * `ALL_INTERACTION_KINDS`, so neither can grow by omission.
   */
  private readonly conversationalComponents = new Map<string, ComponentHandler>();
  private readonly buckets: CommandBuckets;
  private readonly sharedPolicy: SharedChannelPolicy;
  private readonly channelRoles: ChannelRolePolicy;
  /** Shared with the transport, so the two cannot decide differently. */
  private readonly replyPersistence: ReplyPersistencePolicy;

  constructor(private readonly deps: RouterDeps) {
    this.buckets = deps.buckets ?? new CommandBuckets();
    // An empty policy answers false to everything, so an unwired router is a
    // fully private one. `handleSharedRead` additionally requires
    // `deps.sharedJobs`, so both halves must be present for anything to be
    // shared.
    this.sharedPolicy = deps.sharedPolicy ?? new SharedChannelPolicy();
    this.channelRoles = deps.channelRoles ?? new ChannelRolePolicy();
    this.replyPersistence =
      deps.replyPersistence ?? new ReplyPersistencePolicy(this.channelRoles, deps.authz.ownerId);
    this.registerCommands();
    this.registerComponents();
    this.registerConversationalComponents();
    this.assertSurfaceMatchesManifest();
  }

  registeredCommands(): string[] {
    return [...this.commands.keys()].sort();
  }

  /** The OWNER-ONLY interaction kinds. Deliberately still only those. */
  registeredComponentKinds(): string[] {
    return [...this.components.keys()].sort();
  }

  /** The controls a conversation participant may press. */
  registeredConversationalComponentKinds(): string[] {
    return [...this.conversationalComponents.keys()].sort();
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
    this.assertConversationalSurfaceMatchesManifest();
    this.assertSharedSurfaceIsReadOnly();
  }

  /**
   * The non-owner control surface equals its manifest, exactly, and overlaps
   * the owner-only one nowhere.
   *
   * Three separate assertions because three separate mistakes are possible: a
   * control registered without being declared, a declared control nobody
   * implemented, and -- the one that matters -- a kind on BOTH manifests,
   * which would make an owner-only control reachable through the
   * conversational gate.
   */
  private assertConversationalSurfaceMatchesManifest(): void {
    const kinds = new Set(this.conversationalComponents.keys());
    for (const k of CONVERSATIONAL_INTERACTION_KINDS) {
      if (!kinds.delete(k)) throw new Error(`conversational interaction not registered: ${k}`);
    }
    if (kinds.size > 0) {
      throw new Error(
        `interaction outside CONVERSATIONAL_INTERACTION_KINDS: ${[...kinds].join(', ')}`,
      );
    }
    for (const k of CONVERSATIONAL_INTERACTION_KINDS) {
      if (this.components.has(k)) {
        throw new Error(`interaction kind is both owner-only and conversational: ${k}`);
      }
    }
    const all = new Set([
      ...this.components.keys(),
      ...this.conversationalComponents.keys(),
    ]);
    if (all.size !== ALL_INTERACTION_KINDS.length) {
      throw new Error('registered interaction kinds do not match ALL_INTERACTION_KINDS');
    }
    for (const k of ALL_INTERACTION_KINDS) {
      if (!all.has(k)) throw new Error(`interaction kind not registered: ${k}`);
    }
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
    for (const kind of ALL_INTERACTION_KINDS) {
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
    if (context.channelId === gpt) return false;
    /**
     * A THREAD under the GPT channel is the GPT channel, for containment.
     *
     * This is the bug the roadmap recorded: containment compared the incoming
     * channel id against the configured one, a thread's id is not its
     * parent's, so every thread under the channel designated for conversation
     * was silenced -- which is the opposite of what configuring it meant.
     */
    if (context.parentChannelId === gpt) return false;
    /**
     * A thread under any CONFIGURED CONVERSATION PARENT is a conversation by
     * construction: Ducky opened it to hold one. Silencing it would mean
     * creating a thread and then refusing to speak in it.
     */
    if (this.deps.threads?.isNativeThread(context.channelId ?? '')) return false;
    return true;
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

    /**
     * The SAME policy object the transport defers on.
     *
     * That is the whole point of it being an object rather than a condition
     * written twice. The transport fixes visibility at `deferReply`, before
     * routing; this sets the flag afterwards. When the two were separate rules
     * they disagreed, and the disagreement was invisible: the router marked a
     * reply persistent, the transport had already deferred it ephemeral, and
     * Discord showed the ephemeral one.
     */
    const persists = this.replyPersistence.persists({
      userId: actor.discordUserId,
      kind: event.kind,
      context: event.kind === 'component' ? undefined : event.context,
      ...(event.kind === 'command' ? { commandName: event.name } : {}),
    });
    return persists ? { ...reply, ephemeral: false } : reply;
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
    /**
     * Which GATE applies is chosen from the id's kind segment before the
     * signature is checked, and that is safe for one reason: the choice only
     * ever selects a NARROWER gate, and the signature still has to verify
     * afterwards for anything to run.
     *
     * The kind is covered by the MAC, so a pressed control cannot claim to be
     * a different kind than it was minted as. An owner-only control therefore
     * cannot be routed down the conversational path by editing its text: the
     * edit invalidates the signature, and `verify` refuses it.
     */
    if (isConversationalInteractionKind(peekKind(customId))) {
      return this.handleConversationalComponent(actor, customId, values);
    }

    this.deps.authz.requireOwner(actor);
    const verified =
      this.deps.signer.verify(customId, actor.discordUserId) ?? this.verifyVersioned(actor, customId);
    if (!verified) return { content: 'That control is no longer valid.', ephemeral: true };
    const handler = this.components.get(verified.kind);
    if (!handler) return { content: 'That control is no longer valid.', ephemeral: true };
    this.buckets.check('interaction', actor.discordUserId);
    return handler(actor, verified.entityId, values);
  }

  /**
   * A conversational control press: Branch or Compact.
   *
   * Three independent checks, and all three have to pass. Each exists because
   * the other two do not cover it:
   *
   * 1. **The signature**, bound to the PRESSER. A control copied out of
   *    scrollback by somebody else does not verify for them, so a shared
   *    thread's visible buttons are not usable by every reader of the channel.
   * 2. **Conversational authorization**, from the frozen `Authorizer`. Someone
   *    removed from the whitelist stops being able to press controls they
   *    already hold, with no migration.
   * 3. **Participation**, re-read from the database on every press. A proof is
   *    issued only when a participation row exists, so somebody who can see
   *    the thread but has never spoken in it cannot act on it.
   *
   * Seeing a control is still not permission to press it, and none of these
   * reaches a record, a job or a provider credential.
   */
  private async handleConversationalComponent(
    actor: ActorContext,
    customId: string,
    values?: Record<string, string>,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireConversational(actor);
    const verified = this.deps.signer.verify(customId, actor.discordUserId);
    if (!verified) return { content: 'That control is no longer valid.', ephemeral: true };
    const handler = this.conversationalComponents.get(verified.kind);
    if (!handler) return { content: 'That control is no longer valid.', ephemeral: true };
    this.buckets.check('interaction', actor.discordUserId);
    return handler(actor, verified.entityId, values);
  }

  /**
   * A second verification attempt, for controls signed against a task VERSION.
   *
   * A task card lives in a channel. If its deadline moves, the card above it
   * still shows the old one -- so its controls are signed over the task's
   * `updated_at` as well, and once that changes they stop verifying and the
   * owner acts on the refreshed card instead of one that no longer describes
   * anything.
   *
   * The kind and entity id are read from the custom id WITHOUT being trusted:
   * they are used only to look up a candidate version, and the HMAC still has
   * to match over all four parts. A forged or copied id gets nowhere, and a
   * control for another account's task finds no version at all because
   * `versionOf` is owner-scoped.
   */
  private verifyVersioned(
    actor: ActorContext,
    customId: string,
  ): { kind: string; entityId: string } | undefined {
    const segments = customId.split(':');
    if (segments.length !== 5) return undefined;
    const [, , kind, entityId] = segments as [string, string, string, string, string];
    if (!VERSIONED_INTERACTION_KINDS.has(kind)) return undefined;
    const version = this.deps.tasks.versionOf(actor, entityId);
    if (version === undefined) return undefined;
    return this.deps.signer.verify(customId, actor.discordUserId, version);
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

    /**
     * A delivery-only channel hears nothing.
     *
     * The GitHub-updates channel is somewhere other people may be reading, so
     * it is not a place the owner converses, writes records or starts a
     * repository workflow from. This is checked BEFORE the workflow bridge, the
     * pasted-list capture, the deterministic intents, the attachment path and
     * the provider -- every one of which can write or spend model capacity --
     * and it applies to the owner and everybody else alike. A thread under the
     * channel inherits the role, so it is silent too. Nothing is recorded in
     * conversation memory, because nothing was said to anyone.
     */
    if (this.channelRoles.isDeliveryOnly(event.context)) return undefined;

    const attachments = event.attachments ?? [];

    if (attachments.length === 0) {
      /**
       * The repository workflow comes FIRST, and before the containment rule
       * below.
       *
       * Order is the behaviour here. `$grill-me` opens an interview and the
       * owner's plain replies continue it, so those replies must be read as
       * part of the grill before a coding channel's ordinary silence applies
       * to them -- otherwise configuring a channel for the workflow would make
       * the workflow unusable in it.
       *
       * A configured SHARED channel never reaches the bridge at all. A channel
       * other people can read is a place to show information, never a place
       * from which to publish, and a message there stays ordinary
       * conversation.
       */
      if (!this.sharedPolicy.isSharedRequest(event.context)) {
        const workflow = await this.deps.skillBridge?.handle(actor, {
          threadKey: event.threadKey,
          text: event.text,
          ...(event.context ? { context: event.context } : {}),
        });
        if (workflow) {
          // Recorded like any other exchange, so a follow-up has the context
          // of what was just asked.
          this.deps.memory?.record(
            actor,
            event.threadKey,
            { userText: event.text, assistantText: workflow.content ?? '' },
            event.context,
          );
          return workflow;
        }
      }

      /**
       * A pasted list of deadlines, before anything else looks at the text.
       *
       * It runs first because it is the most SPECIFIC reading: two or more
       * numbered lines, every line numbered, no quote and no code fence. A
       * message that is not one falls through untouched, which is almost every
       * message. Quoted text and code blocks are DATA and never a list, and a
       * non-owner never reaches here at all -- their message is conversation,
       * exactly as it was before.
       */
      const pasted = this.handlePastedList(actor, event);
      if (pasted) {
        this.deps.memory?.record(
          actor,
          event.threadKey,
          { userText: event.text, assistantText: pasted.content ?? 'a task preview' },
          event.context,
        );
        return pasted;
      }

      // Deterministic rules FIRST, and only for the owner. A matched intent is
      // answered from stored records or a fixed local table; a matched WRITE is
      // proposed and never applied until the owner confirms in their own words.
      // Everything else -- almost every message -- falls through to the provider
      // exactly as it did before.
      const handled = await this.deps.intents?.handle(
        actor,
        event.threadKey,
        event.text,
        this.channelRoles.roleOf(event.context),
        // A message reply is a channel message unless this is a DM. The owner's
        // capture inbox and repository digest are only ever put in a DM.
        { privateReply: event.context?.guildId === undefined },
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
        ...(event.reference ? { reference: event.reference } : {}),
        ...(event.messageId ? { messageId: event.messageId } : {}),
      });
    }
    return this.handleConversationAttachment(actor, event, attachments);
  }

  /**
   * A message that is a pasted task list, or nothing.
   *
   * Returns undefined for anything else, so the message continues to the
   * deterministic rules and then to the provider exactly as before.
   *
   * Role narrowing is the same rule the intents service follows, and it only
   * ever NARROWS: a DM and an unconfigured channel behave as they always have,
   * a `task` channel is exactly where a list belongs, and the coding,
   * briefing, reminder and gpt channels are left alone -- a list pasted into
   * the channel where reminders are DELIVERED should not quietly become
   * another list of them.
   */
  private handlePastedList(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'message' }>,
  ): OutboundMessage | undefined {
    const capture = this.deps.taskCapture;
    if (!capture) return undefined;
    if (actor.discordUserId !== this.deps.authz.ownerId) return undefined;
    /**
     * A configured SHARED channel is closed to this path entirely, and it is
     * checked FIRST because it is the only one of these conditions where
     * getting it wrong discloses something.
     *
     * A shared channel exists so other people can read a narrow projection of
     * job status. A pasted list is the owner's own task text, the preview is a
     * visible channel message rather than an ephemeral reply, and it carries
     * signed controls -- so a list pasted there would publish titles and
     * deadlines to everyone who can read the channel and leave buttons in
     * their scrollback. A shared channel has no ROLE, so the role check below
     * would have waved it through.
     *
     * Failing closed costs the feature in one channel. Failing open costs the
     * owner their task list, which is precisely the trade ADR 0012 settles.
     * The message falls through to conversation exactly as it did before this
     * feature existed.
     */
    if (this.sharedPolicy.isSharedRequest(event.context)) return undefined;
    const role = this.channelRoles.roleOf(event.context);
    if (role !== undefined && role !== 'task') return undefined;
    if (!looksLikeBulkTaskList(event.text)) return undefined;

    try {
      return this.presentCapture(actor, capture.preview(actor, event.text, 'discord'));
    } catch (err) {
      return errorReply(err);
    }
  }

  /** One rendering for a preview, however the owner got there. */
  private presentCapture(actor: ActorContext, outcome: TaskCaptureOutcome): OutboundMessage {
    const capture = this.deps.taskCapture;
    switch (outcome.kind) {
      case 'needs_clarification':
        return { content: clarificationMessage(outcome.problems), ephemeral: false };
      case 'empty':
        return { content: 'I found no tasks in that. Nothing was saved.', ephemeral: false };
      default: {
        const sign = (kind: 'bulk_save' | 'bulk_edit' | 'bulk_discard'): string =>
          this.deps.signer.sign({
            kind,
            entityId: outcome.preview.previewId,
            actorUserId: actor.discordUserId,
          });
        return bulkPreview(
          outcome.preview,
          { save: sign('bulk_save'), edit: sign('bulk_edit'), discard: sign('bulk_discard') },
          capture?.timeZone ?? this.deps.tasks.timeZone,
          this.deps.tasks.nowMs(),
        );
      }
    }
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
        return d.schedules.listRecords(actor, 10);
    }
  }

  private async converse(input: {
    actor: ActorContext;
    userId: string;
    text: string;
    threadKey: string;
    context?: IncomingContext;
    reference?: IncomingReference;
    /** The Discord message this turn came from, when the transport knew it. */
    messageId?: string;
    attachment?: ConversationAttachment;
    /** Seeds a freshly branched thread; never read from another conversation. */
    anchorNote?: string;
  }): Promise<OutboundMessage> {
    const memory = this.deps.memory;
    /**
     * Controls are offered only when this thread is BOTH a recorded native
     * thread and one memory applies to.
     *
     * The second half is not redundant. A channel can be added to
     * `DUCKY_*_SHARED_CHANNEL_IDS` after a thread under it was created -- the
     * boot check refuses a shared channel as a thread PARENT, but it cannot
     * retroactively unmake a thread. Memory already excludes such a thread
     * from storage, and this makes the controls follow the same exclusion
     * rather than leaving a signed button in a channel other people read.
     */
    const native = (this.deps.threads?.isNativeThread(input.threadKey) ?? false)
      && (memory?.applies(input.threadKey, input.context) ?? false);

    /**
     * The context, bounded. `contextFor` compacts when it must and THROWS when
     * even a compacted context will not fit -- which reaches the owner as a
     * refusal rather than as a quietly truncated conversation.
     */
    const ctx = memory?.contextFor(input.actor, input.threadKey, input.text, input.context)
      ?? { turns: [], compacted: false };
    const history = ctx.turns;

    const anchor = this.resolveAnchor(input.threadKey, input.reference);

    let reply;
    try {
      reply = await this.deps.conversation.reply({
        userId: input.userId,
        text: input.text,
        threadKey: input.threadKey,
        ...(input.attachment ? { attachment: input.attachment } : {}),
        ...(history.length > 0 ? { history } : {}),
        ...(ctx.checkpoint ? { checkpoint: ctx.checkpoint } : {}),
        ...(anchor.turn ? { reference: anchor.turn } : {}),
        // Zero for every conversation that has never been forgotten, so the
        // provider key is unchanged for existing sessions.
        ...(memory ? { sessionEpoch: memory.epochFor(input.actor, input.threadKey) } : {}),
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
      {
        userText: input.text,
        assistantText: content,
        ...(input.messageId ? { userMessageId: input.messageId } : {}),
      },
      input.context,
    );

    const notes = [
      ...(anchor.note ? [anchor.note] : []),
      ...(ctx.compacted
        ? ['Older turns were compacted to fit the model context. Nothing was deleted.']
        : []),
      ...(input.anchorNote ? [input.anchorNote] : []),
    ];
    return conversationReply(content, reply.mock, {
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      ...(native
        ? { rows: this.conversationRows(input.actor, input.threadKey, input.messageId) }
        : {}),
    });
  }

  /**
   * The one earlier message a reply points at, if it is usable.
   *
   * Usable means: present, carrying text, and **in this same visible thread**.
   * A reference to another channel or another thread is labelled unavailable
   * and dropped -- importing it would silently pull another conversation into
   * this one, which is the leak a per-thread conversation exists to prevent. A
   * reference never changes which conversation the message belongs to either
   * way.
   */
  private resolveAnchor(
    threadKey: string,
    reference: IncomingReference | undefined,
  ): { turn?: { role: 'user' | 'assistant'; text: string }; note?: string } {
    if (!reference) return {};
    if (reference.channelId !== undefined && reference.channelId !== threadKey) {
      return {
        note: 'The message you replied to is in another conversation, so I did not use it.',
      };
    }
    const text = cleanUntrusted(reference.text ?? '').trim();
    if (text === '') {
      return { note: 'I could not read the message you replied to, so I did not use it.' };
    }
    const clipped = text.length > CONVERSATION_ANCHOR_TEXT_MAX
      ? `${text.slice(0, CONVERSATION_ANCHOR_TEXT_MAX - 1)}\u2026`
      : text;
    /**
     * Whose words these are, POSITIVELY identified, or the anchor is dropped.
     *
     * The first version of this inferred the `assistant` label: anything whose
     * author was not on the frozen whitelist was treated as Ducky's own
     * output. A native thread is PUBLIC, so that is exactly backwards -- a
     * stranger who can see the channel can post in the thread, the owner can
     * reply to them, and the stranger's text would then reach the model
     * labelled as something the assistant had said. That is both a
     * misattribution and an injection path: text presented as the assistant's
     * own prior output is the most persuasive thing a prompt can contain.
     *
     * So there is no inference left. `assistant` requires the TRANSPORT to say
     * the message was Ducky's, because the transport is the only layer that
     * knows the bot's own id. `user` requires the frozen `Authorizer` to
     * recognise the author as a conversational actor. Anything else -- an
     * unknown author, an unreadable one, a stranger in a public thread -- is
     * dropped and labelled unavailable, which is the same fail-closed
     * direction a cross-thread reference takes.
     */
    if (reference.authorIsSelf === true) {
      return { turn: { role: 'assistant', text: clipped } };
    }
    if (
      reference.authorId !== undefined &&
      this.deps.authz.roleOf(reference.authorId) !== 'none'
    ) {
      return { turn: { role: 'user', text: clipped } };
    }
    return {
      note:
        reference.authorId === undefined
          ? 'I could not tell who wrote the message you replied to, so I did not use it.'
          : 'The message you replied to was not written by you or by me, so I did not use it.',
    };
  }

  /**
   * Branch and Compact, as real buttons on the reply.
   *
   * Signed and bound to the presser like every other control, and carrying the
   * THREAD and the anchor message in the entity id so the handler never has to
   * trust a channel the press claims to come from.
   */
  private conversationRows(
    actor: ActorContext,
    threadKey: string,
    anchorMessageId?: string,
  ): OutboundRow[] {
    const buttons = [
      {
        customId: this.deps.signer.sign({
          kind: 'conv_compact',
          entityId: threadKey,
          actorUserId: actor.discordUserId,
        }),
        label: 'Compact',
        style: 'secondary' as const,
      },
      /**
       * Branch is offered only when there IS an anchor to branch from.
       *
       * A Branch button with no selected message would have to invent one --
       * "the most recent", say -- and a control that guesses which part of a
       * conversation you meant is how a branch ends up carrying something the
       * presser did not choose.
       */
      ...(anchorMessageId
        ? [{
            customId: this.deps.signer.sign({
              kind: 'conv_branch',
              entityId: `${threadKey}.${anchorMessageId}`,
              actorUserId: actor.discordUserId,
            }),
            label: 'Branch',
            style: 'secondary' as const,
          }]
        : []),
    ];
    return [{ buttons }];
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
      // The rollback is its own mode of this command, never mixed with a preview: a
      // pasted schedule and a state flip must not share one invocation.
      const rollback = e.options['rollback'];
      if (rollback !== undefined && rollback !== null) {
        if (e.options['text'] !== undefined || e.attachment) {
          return {
            content: 'Use `rollback` on its own, without `text` or a file. Nothing was changed.',
            ephemeral: true,
          };
        }
        return this.scheduleRollback(actor, String(rollback).trim().toLowerCase());
      }
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
          return this.cancelWatch(actor, String(e.options['id'] ?? ''));
        case 'monitoring': {
          // An explicit state, never a toggle: repeating it is harmless, and a typo is
          // refused rather than read as the other value.
          const state = String(e.options['state'] ?? '').trim().toLowerCase();
          if (state !== 'on' && state !== 'off') {
            return { content: 'Say `/watch monitoring state:on` or `state:off`. Nothing was changed.', ephemeral: true };
          }
          return assistant.watchMonitoring(d.assistantWatch.setMonitoring(actor, state === 'on'));
        }
        default: {
          // `targets` lists the notification-only selection, a page at a time.
          if (e.options['filter'] === 'targets') {
            const page = Math.max(0, Math.floor(Number(e.options['page'] ?? 1)) - 1);
            return assistant.assistantWatchesList(
              d.assistantWatch.list(actor, true, WATCH_TARGET_PAGE, page * WATCH_TARGET_PAGE),
              d.assistantWatch.counts(actor),
              page,
              WATCH_TARGET_PAGE,
            );
          }
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
      // The owner's capture inbox and repository digest are put in the reply only
      // when that reply is GUARANTEED private. A reply in one of the owner's role
      // channels persists (ADR 0023) and can be read by anyone who can read the
      // channel, so there they are left out; the same rule the transport uses to
      // choose ephemerality decides it, so the two cannot drift apart.
      const privateReply = !this.replyPersistence.persists({
        userId: actor.discordUserId, context: e.context, kind: 'command', commandName: 'briefing',
      });
      return assistant.briefingMessage(await d.briefing.assemble(actor, kind, { includePrivate: privateReply }));
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

  /**
   * The signed controls for one task card.
   *
   * Signed over the task's `updated_at` as well as the owner id, so a card
   * whose deadline has since moved stops acting and the owner presses the
   * refreshed one instead.
   */
  private taskCardControls(actor: ActorContext, task: { publicId: string; updatedAt: string }) {
    const sign = (kind: 'task_done' | 'task_edit' | 'task_snooze'): string =>
      this.deps.signer.sign({
        kind,
        entityId: task.publicId,
        actorUserId: actor.discordUserId,
        version: task.updatedAt,
      });
    return { done: sign('task_done'), edit: sign('task_edit'), snooze: sign('task_snooze') };
  }

  /** `preview` shows what a rollback would do and its code; the code (and only it) confirms. */
  private scheduleRollback(actor: ActorContext, arg: string): OutboundMessage {
    const schedules = this.deps.schedules;
    if (arg === 'preview') return assistant.scheduleRollbackPreview(schedules.previewRollback(actor));
    if (new RegExp(`^[0-9a-f]{${SCHEDULE_ROLLBACK_CODE_LENGTH}}$`).test(arg)) {
      return assistant.scheduleRollbackResult(schedules.confirmRollback(actor, arg));
    }
    return {
      content: 'Send `/schedule rollback:preview` first, then `/schedule rollback:<code>` with the code it shows. ' +
        'Nothing was changed.',
      ephemeral: true,
    };
  }

  /**
   * Cancels a watch by its handle, whichever kind it is.
   *
   * An ordinary watch keeps its allowlist rules; a notification-only target is
   * looked up in its own table. The handle namespace is shared and allocated
   * against both, so one handle names exactly one watch.
   */
  private cancelWatch(actor: ActorContext, id: string): OutboundMessage {
    const d = this.deps;
    if (d.assistantWatch.owns(actor, id)) {
      return assistant.assistantWatchCancelled(d.assistantWatch.cancel(actor, id));
    }
    return assistant.watchCancelled(d.githubWatches.cancel(actor, id));
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
    /**
     * The deadline controls on a task card.
     *
     * Each one re-reads the task through the owner-scoped service, so the
     * signature decides nothing about ownership: it stops a stale or copied
     * control from being replayed, and the service refuses anything that is
     * not the owner's own row. A card in a channel other people can read is
     * therefore information and nothing more.
     */
    this.components.set('task_edit', async (actor, entityId, values) => {
      const typed = values?.['deadline'];
      if (typed === undefined) {
        /**
         * Edit asks Discord for a short form, and the deadline typed there
         * comes back through this same handler. Reaching here means the form
         * did not open.
         *
         * So this says what is true and offers only what actually works. It
         * used to invite the owner to "send a new one", which nothing
         * consumes: there is no pending-edit state and their next message
         * would be read as ordinary conversation. A promise the code does not
         * keep is worse than a plain refusal.
         */
        const task = d.tasks.get(actor, entityId);
        return {
          content:
            'Nothing changed: the edit box did not open. ' +
            `${deadlineLine(task, d.tasks.timeZone, d.tasks.nowMs())}. Press Edit again.`,
          ephemeral: true,
        };
      }
      const { task, sync } = d.tasks.setDeadline(actor, entityId, d.tasks.parseDeadline(typed));
      return taskCard(task, {
        timeZone: d.tasks.timeZone,
        nowMs: d.tasks.nowMs(),
        heading: sync.scheduled > 0 ? 'Deadline updated.' : 'Deadline updated. Nothing left to remind you about.',
        controls: this.taskCardControls(actor, task),
        ephemeral: true,
      });
    });

    this.components.set('task_snooze', async (actor, entityId) => {
      const { task, reminder } = d.tasks.snooze(actor, entityId);
      return taskCard(task, {
        timeZone: d.tasks.timeZone,
        nowMs: d.tasks.nowMs(),
        // Says plainly that the DEADLINE did not move. A snooze that looked
        // like a reschedule would be the most damaging kind of convenience.
        heading:
          `I will mention this again ${discordTimestamp(reminder.firstFireAt, 'R')}. ` +
          'The deadline is unchanged.',
        controls: this.taskCardControls(actor, task),
        ephemeral: true,
      });
    });

    /**
     * The three preview controls.
     *
     * Save is the only one that writes, and it is idempotent on the preview it
     * names -- a double press replays the same tasks rather than creating a
     * second set.
     */
    this.components.set('bulk_save', async (actor, entityId) => {
      const capture = d.taskCapture;
      if (!capture) return { content: 'Task capture is not configured here.', ephemeral: true };
      const saved = capture.save(actor, entityId);
      if (saved.tasks.length === 0) {
        return { content: 'Nothing was saved.', ephemeral: true };
      }
      const cards = saved.tasks.slice(0, TASK_CARDS_PER_MESSAGE);
      return {
        content: saved.replayed
          ? `Already saved. The same ${saved.tasks.length} task(s), not a second copy.`
          : `Saved ${saved.tasks.length} task(s).`,
        embeds: cards.map(
          (task) =>
            taskCard(task, { timeZone: d.tasks.timeZone, nowMs: d.tasks.nowMs() }).embeds![0]!,
        ),
        rows: cards.map((task) => taskCardRow(this.taskCardControls(actor, task))),
        ephemeral: false,
      };
    });

    this.components.set('bulk_edit', async (actor, entityId, values) => {
      const capture = d.taskCapture;
      if (!capture) return { content: 'Task capture is not configured here.', ephemeral: true };
      const raw = values?.['items'];
      if (raw === undefined) {
        const pending = capture.pendingPreview(actor, entityId);
        if (!pending) {
          return { content: 'That list is no longer waiting to be saved.', ephemeral: true };
        }
        /**
         * Same situation as `task_edit`, with one difference that makes a
         * different answer honest: a numbered list pasted back IS read as a
         * list, so inviting that works. It starts a NEW preview rather than
         * correcting this one, and saying so is the whole point -- the owner
         * should not be left wondering which draft they are about to save.
         */
        return {
          content:
            'The edit box did not open. Paste this back as a new list to change it. ' +
            'This preview is untouched, and nothing is saved either way:\n```\n' +
            editableListText(pending.items, capture.timeZone, d.tasks.nowMs()) +
            '\n```',
          ephemeral: true,
        };
      }
      // Re-parsed through the same grammar, so an edit cannot introduce a
      // deadline the parser would never have produced.
      return this.presentCapture(actor, capture.correct(actor, entityId, raw));
    });

    this.components.set('bulk_discard', async (actor, entityId) => {
      const capture = d.taskCapture;
      if (!capture) return { content: 'Task capture is not configured here.', ephemeral: true };
      capture.discard(actor, entityId);
      return { content: 'Discarded. Nothing was saved.', ephemeral: true };
    });

    this.components.set('reminder_cancel', async (actor, entityId) =>
      assistant.reminderCancelled(d.reminders.cancel(actor, entityId)),
    );
    this.components.set('watch_cancel', async (actor, entityId) =>
      this.cancelWatch(actor, entityId),
    );
    /**
     * The repository-workflow card controls.
     *
     * Both are owner-signed and both re-check ownership in the service, like
     * every other control. An unwired bridge answers the same way a revoked
     * control does, so a card left in scrollback by a previous configuration
     * cannot act.
     */
    this.components.set('agent_details', async (actor, entityId) => {
      if (!d.skillBridge) return { content: 'That control is no longer valid.', ephemeral: true };
      return d.skillBridge.details(actor, entityId);
    });
    this.components.set('agent_cancel', async (actor, entityId) => {
      if (!d.skillBridge) return { content: 'That control is no longer valid.', ephemeral: true };
      return d.skillBridge.cancel(actor, entityId);
    });

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

  // ------------------------------------------- conversational components --

  /**
   * The two controls a conversation participant may press.
   *
   * Registered into their own map, so the owner-only manifest assertion above
   * stays exact and neither of these can be mistaken for a privileged control.
   * Both re-check authorization AND participation on every press: the
   * signature proves who minted it for whom, and the database proves they are
   * still in the conversation.
   */
  private registerConversationalComponents(): void {
    const unavailable = (): OutboundMessage => ({
      content: 'That control is no longer valid.',
      ephemeral: true,
    });

    /**
     * Compact: summarize the older turns of THIS thread and keep the recent
     * ones.
     *
     * It changes what the model is sent and nothing else. No stored turn is
     * removed and no Discord message is touched, which the reply says in so
     * many words -- "compact" in other tools often means "delete", and an
     * owner should not have to find out which this is by trying it.
     */
    this.conversationalComponents.set('conv_compact', async (actor, entityId) => {
      const memory = this.deps.memory;
      if (!memory) return unavailable();
      if (!memory.participation(actor, entityId)) {
        return {
          content: 'You are not part of that conversation, so I cannot compact it.',
          ephemeral: true,
        };
      }
      return { content: memory.compact(actor, entityId).message, ephemeral: true };
    });

    /**
     * Branch: a separate visible thread, seeded with ONE explicitly selected
     * anchor.
     *
     * The anchor travels in the signed entity id, is resolved only against the
     * thread the presser holds a proof for, and is written into the new thread
     * as a labelled checkpoint rather than as a turn -- it was said elsewhere,
     * and claiming otherwise would put words in somebody's mouth. Nothing else
     * crosses: the branch has its own thread key, so its memory, its
     * participation and its provider session are all separate by construction.
     */
    this.conversationalComponents.set('conv_branch', async (actor, entityId) => {
      const memory = this.deps.memory;
      const threads = this.deps.threads;
      if (!memory || !threads) return unavailable();

      const sep = entityId.indexOf('.');
      if (sep < 0) return unavailable();
      const sourceThreadId = entityId.slice(0, sep);
      const anchorMessageId = entityId.slice(sep + 1);

      if (!memory.participation(actor, sourceThreadId)) {
        return {
          content: 'You are not part of that conversation, so I cannot branch from it.',
          ephemeral: true,
        };
      }
      const anchor = memory.anchorFor(actor, sourceThreadId, anchorMessageId);
      if (!anchor) {
        return {
          content:
            'That message is not part of this conversation any more, so there is nothing to ' +
            'branch from. Nothing was created.',
          ephemeral: true,
        };
      }

      const outcome = await threads.branch({
        sourceThreadId,
        anchorMessageId,
        startedBy: actor.discordUserId,
        name: threadNameFor(anchor.text, 'Branch'),
      });
      if (outcome.kind !== 'thread') {
        return {
          content: outcome.kind === 'refused' ? outcome.message : 'I could not open that branch.',
          ephemeral: true,
        };
      }

      memory.seedBranch(actor, outcome.threadId, anchor);
      return {
        content:
          `Branched into <#${outcome.threadId}>. It starts with just the message you picked; ` +
          'nothing else from this thread was copied, and this conversation is unchanged.',
        ephemeral: true,
      };
    });
  }
}

/**
 * The kind segment of a custom id, WITHOUT verifying it.
 *
 * Used only to choose which authorization gate applies, never to decide that
 * anything may happen: the signature covers the kind, so a forged or edited id
 * fails verification inside whichever gate it was routed to. Returns an empty
 * string for anything that is not shaped like one of our ids, which falls
 * through to the owner-only gate -- the conservative direction.
 */
function peekKind(customId: string): string {
  const segments = customId.split(':');
  return segments.length === 5 ? segments[2]! : '';
}

/**
 * The kinds whose controls carry a task VERSION.
 *
 * Kept beside the router rather than on the contracts manifest because it is
 * not a permission: every one of these is already on
 * `OWNER_ONLY_INTERACTION_KINDS`, and this only says which signatures also
 * expire when the row they describe changes.
 */
const VERSIONED_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  'task_done',
  'task_edit',
  'task_snooze',
]);

export const CONVERSATION_ROUTE_NAME = CONVERSATIONAL_ROUTE;

function errorReply(err: unknown): OutboundMessage {
  if (isDuckyError(err)) return { content: err.ownerMessage, ephemeral: true };
  if (err instanceof Error && err.name === 'ZodError') {
    return { content: 'That input was not valid.', ephemeral: true };
  }
  return { content: 'Something went wrong handling that.', ephemeral: true };
}

export type { ConversationalInteractionKind, OwnerOnlyCommand, OwnerOnlyInteractionKind };
