import {
  DeterministicScheduleExtractor, FileCredentialStore, GhCliReader, HerdrCli,
  DisabledConversationProvider, DisabledFrontDoor, FrontDoorCli, MemoryCredentialStore,
  MockConversationProvider, GatewayOpenClawProvider,
  assertPrivateGatewayUrl,
  GitHubCiDependencyChecker, UnavailableDependencyChecker,
  type ConversationProvider, type DependencyChecker, type ExecutorCredentialStore,
  type FrontDoorPort, type GitHubReader, type ScheduleExtractionProvider,
} from '@ducky/adapters';
import {
  AUDIT_OWNER_REF, COMMAND_BUCKETS, CONVERSATIONAL_ROUTE, DuckyError,
  type ConversationProviderMode, type DuckyProfile,
} from '@ducky/contracts';
import { RetentionService, retentionPolicyFrom } from './domain/retention.service.js';
import { ForgetService } from './domain/forget.service.js';
import { ConversationMemoryService } from './domain/conversation-memory.service.js';
import {
  ConversationThreadPolicy, ConversationThreadService,
} from './domain/conversation-threads.js';
import {
  SharedLedger, createStore, defaultAccountCgroupDir, observeAccountMemory, openDatabase, runMigrations,
  type Store,
} from '@ducky/persistence';
import type { SharedAdmissionLedgerPort } from '@ducky/contracts';
import {
  cdnHosts, loadEnv, readReposFile, resolveApprovedActionsEnabled, resolveBriefingSchedule, resolveChannelRoles, resolveConversationMemory, resolveConversationProvider, resolveEngineering, resolveSharedAdmission, resolveGitHubFeed, resolveOwnerTimeZone, resolvePaths, resolvePhoneCapture, resolveProfileSecrets, resolveSharedChannelIds, resolveSkillBridge, resolveThreadParentChannelIds, type Env, type ProfileSecrets, type ResolvedPaths,
} from './config.js';
import { parsePhoneVerifier, phoneSessionKey } from './http/phone-auth.js';
import type { PhoneCaptureConfig } from './http/phone.js';
import { commandScopeFor, resolveDiscordProfile, type DiscordProfileConfig } from './discord/profile-config.js';
import { Authorizer, loadAuthzConfig } from './security/authz.js';
import { ComponentSigner } from './security/component-signing.js';
import { RepoAllowlist } from './domain/allowlist.js';
import { CapturesService } from './domain/captures.service.js';
import { PendingScheduleStore } from './domain/pending-schedules.js';
import { SchedulesService } from './domain/schedules.service.js';
import { JobsService } from './domain/jobs.service.js';
import { SharedAdmissionService } from './domain/shared-admission.service.js';
import { ApprovalsService } from './domain/approvals.service.js';
import { type ActionPerformer } from './domain/action-performer.js';
import { GitActionPerformer } from './domain/git-action-performer.js';
import { GitHubService } from './domain/github.service.js';
import { GitHubWatchService } from './domain/github-watches.service.js';
import { GitHubFeedService } from './domain/github-feed.service.js';
import { Reconciler } from './domain/reconciler.js';
import { JobNotifier } from './domain/notifications.service.js';
import { SharedJobsService } from './domain/shared-jobs.service.js';
import { SharedChannelPolicy } from './domain/shared-visibility.js';
import { ChannelRolePolicy, describeChannelRoles } from './domain/channel-roles.js';
import { ReplyPersistencePolicy } from './domain/reply-persistence.js';
import { ConfiguredOwnerClock, type OwnerClock } from './domain/owner-clock.js';
import { TasksService } from './domain/tasks.service.js';
import { TaskReminderLinker } from './domain/task-reminders.js';
import { TaskCaptureService } from './domain/task-capture.service.js';
import { RemindersService } from './domain/reminders.service.js';
import { BriefingService } from './domain/briefing.service.js';
import { ReminderNotifier } from './domain/reminder-notifications.service.js';
import { BriefingNotifier } from './domain/briefing-notifications.service.js';
import { IntentsService } from './domain/intents.service.js';
import { SkillBridgeService, type WorkflowRepository } from './domain/skill-bridge.service.js';
import { DependencyResolver } from './domain/dependency-resolver.js';
import { DuckyRouter } from './discord/router.js';
import { MockDiscordTransport } from './discord/mock.transport.js';
import { DiscordJsTransport } from './discord/discordjs.transport.js';
import { fetchTextAttachment } from './discord/attachments.js';
import {
  attachmentAvailability, type ConversationAttachmentConfig,
} from './discord/conversation-attachments.js';
import { CommandBuckets, HourlyBudget } from './discord/command-buckets.js';
import type { DiscordSink, DiscordTransport, Incoming } from './discord/transport.js';
import type { SendTarget } from './discord/message.js';
import { toDiscordPayload } from './discord/payload.js';
import type { ProviderStatus } from './discord/presenters.js';

export interface AppOverrides {
  readonly store?: Store;
  readonly credentials?: ExecutorCredentialStore;
  readonly conversation?: ConversationProvider;
  readonly github?: GitHubReader;
  readonly extractor?: ScheduleExtractionProvider;
  readonly transport?: DiscordTransport;
  readonly allowlistJson?: string;
  readonly herdrVerified?: boolean;
  /** Test/integration override for the explicitly invoked action performer. */
  readonly actionPerformer?: ActionPerformer;
  /**
   * Test/integration override for the installed workflow helper. The real one
   * creates GitHub issues, so every test drives a recording stand-in.
   */
  readonly frontDoor?: FrontDoorPort;
  /**
   * Injected clock for the daily assistant. Tests drive reminder
   * materialization, due dates and briefing day boundaries through this
   * instead of waiting for real time to pass.
   */
  readonly clock?: OwnerClock;
  /**
   * Injected `fetch` for the conversation-attachment download. Tests use it to
   * exercise the byte path without a network; nothing in production supplies
   * it, so the global `fetch` is what actually runs.
   */
  readonly conversationFetch?: typeof fetch;
  /**
   * Answers "is this dependency ready yet?". Omitted in production, which
   * gets `UnavailableDependencyChecker` -- a checker that only ever answers
   * `pending`, so no job is ever resumed on the strength of a check that did
   * not happen.
   */
  readonly dependencyChecker?: DependencyChecker;
  /**
   * TEST ONLY. A ledger over a scratch file, used instead of opening the
   * configured path (which production refuses under a temporary root). The
   * pins and executor list are still required from the environment.
   */
  readonly sharedAdmissionLedger?: SharedAdmissionLedgerPort;
  /**
   * TEST ONLY: runs engineering with the coordinator-local slot alone, the way
   * every test did before the shared ledger existed. `main.ts` never sets it and
   * a source scan asserts that, so production cannot fall back to local-only
   * admission.
   */
  readonly localOnlyAdmissionForTests?: true;
}

export interface App {
  readonly env: Env;
  readonly paths: ResolvedPaths;
  readonly discordProfile: DiscordProfileConfig;
  readonly store: Store;
  readonly authz: Authorizer;
  readonly signer: ComponentSigner;
  readonly allowlist: RepoAllowlist;
  readonly captures: CapturesService;
  readonly schedules: SchedulesService;
  readonly jobs: JobsService;
  /** Ducky's side of the shared engineering admission, or undefined when it is not eligible. */
  readonly sharedAdmission: SharedAdmissionService | undefined;
  /** Why engineering is configured on but cannot run, or undefined. For the boot report. */
  readonly engineeringHeldOff: string | undefined;
  readonly approvals: ApprovalsService;
  readonly github: GitHubService;
  readonly githubWatches: GitHubWatchService;
  /** Actionable GitHub events and the daily commit digest. Off unless enabled. */
  readonly githubFeed: GitHubFeedService;
  readonly reconciler: Reconciler;
  readonly notifier: JobNotifier;
  readonly clock: OwnerClock;
  readonly tasks: TasksService;
  /** Pasted task lists, from the phone page and from Discord. One path for both. */
  readonly taskCapture: TaskCaptureService;
  readonly reminders: RemindersService;
  readonly briefing: BriefingService;
  readonly reminderNotifier: ReminderNotifier;
  /** Pushes the morning/evening briefing. Off unless the operator enabled it. */
  readonly briefingNotifier: BriefingNotifier;
  readonly dependencies: DependencyResolver;
  readonly retention: RetentionService;
  readonly forget: ForgetService;
  /** Bounded conversation continuity. Off unless the operator enabled it. */
  readonly conversationMemory: ConversationMemoryService;
  /** Native Discord threads as conversations. Off unless a parent is named. */
  readonly conversationThreads: ConversationThreadService;
  /** Deterministic natural-language intents. Owner-only, provider-free. */
  readonly intents: IntentsService;
  /** The owner-only repository workflow bridge. Off unless configured. */
  readonly skillBridge: SkillBridgeService;
  /** Reported by /status and asserted by tests; off by default. */
  readonly conversationAttachments: ConversationAttachmentConfig;
  readonly sharedPolicy: SharedChannelPolicy;
  /** The owner's private assistant channels. Presentation only, never authority. */
  readonly channelRoles: ChannelRolePolicy;
  readonly sharedJobs: SharedJobsService;
  readonly router: DuckyRouter;
  /**
   * The phone capture surface, or undefined when it is off. `main.ts` hands it
   * to the HTTP server; undefined means the routes are never registered at
   * all, rather than registered and refusing.
   */
  readonly phone: PhoneCaptureConfig | undefined;
  readonly transport: DiscordTransport;
  readonly credentials: ExecutorCredentialStore;
  readonly conversation: ConversationProvider;
  readonly status: () => ProviderStatus;
  close(): void;
}

/**
 * Composition root. Every provider is chosen here and reported through
 * /status, so the owner can always see which parts are real.
 */
export function createApp(
  envSource: NodeJS.ProcessEnv = process.env,
  overrides: AppOverrides = {},
): App {
  const env = loadEnv(envSource);
  const paths = resolvePaths(env);
  // Fails closed for production without its own credentials, and never reads
  // the other profile's variables.
  const discordProfile = resolveDiscordProfile(env.DUCKY_PROFILE, envSource);

  // Resolved HERE, before any filesystem or database work, because it is a pure
  // configuration decision and a misconfigured instance should fail on the
  // cheapest check rather than after a confusing unrelated error. Production
  // refuses an unset value and refuses `mock` outright.
  const conversationMode = resolveConversationProvider(env);
  assertModeUsable(conversationMode, env.DUCKY_PROFILE);

  /**
   * The owner's phone surface, resolved HERE with the other pure configuration
   * checks and before any filesystem or database work.
   *
   * It is the cheapest place for "you asked for the capture page with no
   * credential" or "...while bound to every interface" to fail, and it must
   * fail at boot rather than when a phone first taps the shortcut. `enabled`
   * false leaves `phone` undefined below, which is what stops the routes from
   * being registered at all.
   */
  const phoneSettings = resolvePhoneCapture(env);

  // Secrets for THIS profile only. Production never falls back to a shared or
  // development value.
  const secrets = resolveProfileSecrets(env);

  const store = overrides.store ?? createStoreFromEnv(env, paths);
  const authz = new Authorizer(loadAuthzConfig({
    OWNER_DISCORD_USER_ID: env.OWNER_DISCORD_USER_ID,
    CHAT_WHITELIST_USER_IDS: env.CHAT_WHITELIST_USER_IDS,
    DUCKY_ADDITIONAL_USER_AI_ENABLED: env.DUCKY_ADDITIONAL_USER_AI_ENABLED,
  }));
  const signer = new ComponentSigner(secrets.componentSigningKey);

  const allowlist = RepoAllowlist.fromJson(
    overrides.allowlistJson ?? readReposFile(paths.reposFile),
  );
  // Config is authoritative; the tables mirror it. Placements are replaced
  // rather than merged, so a host taken OUT of the configuration stops being
  // listed instead of lingering as a path nobody reviewed any more.
  for (const row of allowlist.toRepoRows()) {
    store.repos.upsert(row);
    store.repos.replacePlacements(row.slug, allowlist.toPlacementRows(row.slug));
  }

  // Audit only -- never consulted for authorization.
  store.audit.observe(authz.ownerId, 'owner');
  for (const id of authz.allConfiguredIds().slice(1)) store.audit.observe(id, 'chat');
  store.audit.revokeMissing(authz.allConfiguredIds());

  const credentials = overrides.credentials ?? credentialStoreFor(env, paths, secrets);
  const conversation = overrides.conversation ?? conversationFromEnv(env, conversationMode);

  // Retention deletes the owner's own records, so it is OFF unless configured.
  // `/forget` is always wired -- the owner acting deliberately on one named
  // entity is a different thing from a scheduled sweep.
  // Now that the store exists, a refusal can be recorded. Attached rather than
  // constructed with, because authorization is built before the database.
  authz.onRefused(({ role }) => {
    try {
      store.auditLog.record({
        event: 'authz.refused',
        actorKind: role === 'owner' ? 'owner' : 'system',
        actorRef: role === 'owner' ? AUDIT_OWNER_REF : role,
        subjectKind: 'route',
        subjectRef: 'privileged',
        outcome: 'refused',
        detail: `role ${role} refused on a privileged surface`,
      });
    } catch {
      /* a record is never worth failing a refusal */
    }
  });

  // Created here rather than inside the router so the audit sink can be
  // attached to the SAME instance the router uses.
  const buckets = new CommandBuckets();
  buckets.onExhausted(({ bucket }) => {
    /**
     * WHO is attributed, and why it is not always the owner any more.
     *
     * Every bucket was owner-only once, so recording a rate limit as the
     * owner's doing was true without anybody having to be told. Issue #4 gave
     * a conversation participant two controls and a thread, so `interaction`
     * and `threadCreate` are reachable by the configured chat user -- and
     * attributing their limit to the owner would put a false statement in a
     * long-lived record.
     *
     * A shared bucket is therefore recorded as `system` against the
     * conversation route: the honest answer is "a limit fired on a surface
     * more than one person can reach", because the sink is handed the BUCKET
     * and nothing else. It deliberately stays that way -- the fix for a vague
     * audit row is not to start logging Discord ids.
     */
    const ownerOnly = COMMAND_BUCKETS[bucket].ownerOnly;
    try {
      store.auditLog.record({
        event: 'rate_limit.exceeded',
        actorKind: ownerOnly ? 'owner' : 'system',
        actorRef: ownerOnly ? AUDIT_OWNER_REF : CONVERSATIONAL_ROUTE,
        subjectKind: 'route',
        subjectRef: bucket,
        outcome: 'refused',
        ...(ownerOnly ? {} : { detail: 'shared surface; the actor is not recorded' }),
      });
    } catch {
      /* a record is never worth failing the limit */
    }
  });

  const retention = new RetentionService({
    store,
    policy: retentionPolicyFrom(env),
    // `schedules.starts_at` is wall-clock text in this zone (ADR 0014), so
    // retention needs it to decide whether an event is genuinely past.
    timeZone: resolveOwnerTimeZone(env),
    // From frozen configuration, never from the database: conversation windows
    // differ for the owner and for a whitelist guest.
    ownerId: authz.ownerId,
  });
  // Continuity is off by default. The service exists regardless, because
  // `/forget conversation` must be able to delete rows an earlier run stored
  // even after the flag has been turned off again.
  const conversationMemory = new ConversationMemoryService({
    store,
    config: resolveConversationMemory(env),
  });
  // `conversation` is passed for ONE reason: so `/forget` can report the second
  // store honestly (ADR 0024). Nothing in ForgetService calls `reply`.
  const forget = new ForgetService({ store, authz, memory: conversationMemory, conversation });
  const extractor = overrides.extractor ?? new DeterministicScheduleExtractor();
  const githubReader = overrides.github ?? new GhCliReader();

  // One clock and one timezone for the whole assistant, validated here so a
  // bad DUCKY_OWNER_TIMEZONE fails at boot rather than at the first briefing.
  const clock = overrides.clock ?? new ConfiguredOwnerClock(resolveOwnerTimeZone(env));

  const pending = new PendingScheduleStore();
  const captures = new CapturesService(store, authz);
  const schedules = new SchedulesService({ store, authz, pending, extractor });
  // Engineering reaches an executor only when it is enabled AND the shared
  // admission integration is explicitly eligible (ADR 0031). Enabled alone is
  // held off, loudly, rather than falling back to the local-only slot: that slot
  // does not cover the other profile or Agent Flow. `localOnlyAdmissionForTests`
  // exists for isolated fixtures and is never set by `main.ts`.
  const engineering = resolveEngineering(env);
  const sharedConfig = resolveSharedAdmission(env);
  const sharedAdmission = sharedConfig
    ? new SharedAdmissionService({
        store,
        ledger: overrides.sharedAdmissionLedger ?? new SharedLedger({
          path: sharedConfig.path,
          expectedLedgerId: sharedConfig.ledgerId,
          expectedPolicyDigest: sharedConfig.policyDigest,
          observe: () => observeAccountMemory(
            sharedConfig.cgroupDir ?? defaultAccountCgroupDir(process.getuid?.() ?? 0),
          ),
        }),
        expectedLedgerId: sharedConfig.ledgerId,
        expectedPolicyDigest: sharedConfig.policyDigest,
        executors: sharedConfig.executors,
        reserveBytes: sharedConfig.reserveBytes,
        onStatus: ({ ok, reason }) => {
          try {
            store.auditLog.record({
              event: 'engineering.shared_admission',
              actorKind: 'system', actorRef: 'shared-admission',
              subjectKind: 'config', subjectRef: 'shared_admission',
              outcome: ok ? 'ok' : 'refused',
              detail: ok ? 'engineering may admit' : `engineering stopped: ${reason}`,
            });
          } catch {
            /* a record is never worth failing a claim */
          }
        },
      })
    : undefined;
  const localOnly = overrides.localOnlyAdmissionForTests === true;
  const engineeringRuns = engineering.enabled && (sharedAdmission !== undefined || localOnly);
  const engineeringHeldOff =
    engineering.enabled && !engineeringRuns
      ? 'DUCKY_ENGINEERING_ENABLED is set but DUCKY_SHARED_ADMISSION_ELIGIBLE is not; no job is submitted and no claim is answered'
      : undefined;
  const jobs = new JobsService({
    store, authz, allowlist,
    engineering: { enabled: engineeringRuns, attemptBudgetMs: engineering.attemptBudgetMs },
    ...(sharedAdmission ? { shared: sharedAdmission } : {}),
  });
  const actionPerformer = overrides.actionPerformer ?? new GitActionPerformer({
    allowlist,
    enabled: resolveApprovedActionsEnabled(env),
  });
  const approvals = new ApprovalsService({ store, authz, performer: actionPerformer });
  const github = new GitHubService(authz, allowlist, githubReader);
  // The deadline-to-notification link, shared by every path that can create or
  // move a task: one place decides what a deadline owes, so the slash command,
  // a pasted list and the phone page cannot drift apart.
  const taskReminderLinker = new TaskReminderLinker({ store, clock });
  const tasks = new TasksService({ store, authz, clock, linker: taskReminderLinker });
  const taskCapture = new TaskCaptureService({
    store, authz, clock, linker: taskReminderLinker,
  });
  const reminders = new RemindersService({ store, authz, clock });
  const briefing = new BriefingService({ store, authz, clock });
  const reconciler = new Reconciler({ store, approvals, pending });
  // Deterministic rules over the owner's own messages: no provider, no new
  // command, and no inferred write applied without an explicit confirmation.
  //
  // `IntentsService` is handed NO job capability at all, and that is the
  // change issue #7 makes to this wiring. It used to receive a `submitJob`
  // function so a confirmed `implement in <repo>: <task>` could reach
  // `JobsService.submit`. Engineering work now starts at `$grill-me` /
  // `$ticket` / `$agentize` and nowhere else, so the function is removed
  // rather than left unused: a capability that is not passed cannot be
  // reached by a later edit that forgets why it was off.
  const intents = new IntentsService({
    clock, tasks, reminders, captures, briefing, ownerId: authz.ownerId,
  });

  // Which checker answers a dependency wait. The default still answers
  // `pending` for everything, so a wait ends at the owner's desk rather than
  // being declared ready by something that never looked. `github` reads CI
  // status from the read-only `gh` surface: it can FAIL a job on a definite CI
  // failure, and it cannot resume one, because it reports itself unverified and
  // the resolver refuses a `ready` from an unexercised checker.
  const dependencyChecker = overrides.dependencyChecker ??
    (env.DUCKY_DEPENDENCY_CHECKER === 'github'
      ? new GitHubCiDependencyChecker(githubReader, (slug) => {
          const repo = allowlist.list().find((r) => r.slug === slug);
          return repo?.github ? { owner: repo.github.owner, repo: repo.github.repo } : undefined;
        })
      : new UnavailableDependencyChecker());
  const dependencies = new DependencyResolver({ store, checker: dependencyChecker });

  /**
   * The installed workflow front door.
   *
   * `DisabledFrontDoor` is the shipped default and refuses everything, so an
   * instance that was never configured for the workflow cannot reach it.
   * Publication and onboarding need their OWN flag on top of the bridge being
   * enabled -- the same two-key shape the approved-action performer has.
   */
  const bridgeConfig = resolveSkillBridge(env);
  const frontDoor: FrontDoorPort =
    overrides.frontDoor ??
    (bridgeConfig.enabled && bridgeConfig.program
      ? new FrontDoorCli({
          program: bridgeConfig.program,
          interpreter: bridgeConfig.interpreter,
          mutationEnabled: bridgeConfig.mutationEnabled,
        })
      : new DisabledFrontDoor());

  // Opt-in, profile-scoped, and empty by default: with nothing configured the
  // shared surface does not exist at all.
  const sharedPolicy = new SharedChannelPolicy(resolveSharedChannelIds(env));
  // Refuses a channel that is both shared and role-configured, at boot.
  const channelRoles = new ChannelRolePolicy(resolveChannelRoles(env));
  const sharedJobs = new SharedJobsService({ store, allowlist });

  /**
   * ONE persistence rule, handed to both callers that need it.
   *
   * The transport must decide visibility at `deferReply`, before routing; the
   * router sets the flag on what it returns. Building them from the same object
   * is what stops them disagreeing -- and they did disagree, which produced a
   * bug that looked like the feature working.
   */
  const replyPersistence = new ReplyPersistencePolicy(channelRoles, authz.ownerId);
  const transport =
    overrides.transport ??
    transportForProfile(
      discordProfile,
      (event) =>
        replyPersistence.persists({
          userId: event.userId,
          kind: event.kind,
          context: event.kind === 'component' ? undefined : event.context,
          ...(event.kind === 'command' ? { commandName: event.name } : {}),
        }),
      // One question only: may this person converse? It decides whether a
      // reply anchor that missed the message cache may cost a REST call, and
      // it grants nothing.
      (userId) => authz.mayConverse(userId),
    );

  /**
   * Native conversation threads.
   *
   * Off unless an operator NAMES the channels that may sprout one: creating a
   * thread is Ducky writing into the owner's guild, so it is opt-in per
   * channel rather than a boolean, and the list is refused at boot if it names
   * a shared channel or a non-conversational role channel.
   *
   * The starter is the TRANSPORT's, handed in as a function so the service
   * holds no Discord dependency of its own and a test can drive the whole path
   * with the mock. A transport that cannot create threads leaves the service
   * refusing rather than pretending.
   */
  const conversationThreads = new ConversationThreadService({
    store,
    policy: new ConversationThreadPolicy(
      { parentChannelIds: resolveThreadParentChannelIds(env) },
      authz,
      sharedPolicy,
    ),
    authz,
    startThread: transport.startThread ? (req) => transport.startThread!(req) : undefined,
    // The SAME buckets instance every other surface uses, so a thread opened
    // here counts against one budget rather than a second private one.
    chargeThreadCreate: (userId) => buckets.check('threadCreate', userId),
  });
  // The decision lives in the domain; the transport only performs it. Absent
  // on a transport that does not support threads, which leaves routing exactly
  // as it was.
  transport.useConversationThreads?.(
    (event) => conversationThreads.enter({ event }),
    (threadId) => conversationThreads.observeGone(threadId),
  );
  const notifier = new JobNotifier({
    store, transport, ownerId: authz.ownerId, signer, sharedPolicy, sharedJobs,
  });
  // A free-standing reminder goes to the owner's DM and nowhere else. A
  // reminder that belongs to a TASK may go to a configured channel with the
  // owner's mention -- the only reminder with a shape worth posting where
  // somebody else might see it, and even then the controls on it refuse
  // everybody but the owner.
  const reminderNotifier = new ReminderNotifier({
    store, transport, ownerId: authz.ownerId, clock, signer,
    // Opt-in and profile-scoped. Unconfigured means the DM every reminder has
    // always used, and only TASK-LINKED reminders are ever routed elsewhere.
    reminderChannelId: channelRoles.channelFor('reminder'),
  });
  // Rides the SAME interval as everything else, holds no provider, and sends to
  // the owner's DM only. Off by default: a briefing is pulled unless somebody
  // deliberately asks for it to be pushed.
  const briefingNotifier = new BriefingNotifier({
    store, transport, ownerId: authz.ownerId, clock, briefing,
    config: resolveBriefingSchedule(env),
  });
  const githubWatches = new GitHubWatchService({
    store, authz, allowlist, reader: githubReader, transport, ownerId: authz.ownerId, clock,
  });
  /**
   * The GitHub feed rides the SAME coordinator interval and holds no model
   * provider, so a paused subscription quota cannot stop it. It is handed the
   * allowlist only to READ the selected list's seeds from; it never writes to it.
   * The selected list is reconciled here, once, from frozen configuration.
   */
  const githubFeed = new GitHubFeedService({
    store, reader: githubReader, transport, ownerId: authz.ownerId, clock, allowlist,
    config: resolveGitHubFeed(env),
  });
  githubFeed.reconcileSelection();

  /**
   * The repository workflow bridge.
   *
   * It is handed NO `JobsService`, deliberately: the dispatcher's queue and
   * Ducky's own executor are two different admission paths, and this one must
   * be unable to reach the other. The repositories it can address are the
   * configured ones that carry a GitHub identity -- frozen configuration,
   * never a database read.
   */
  const workflowRepositories = (): readonly WorkflowRepository[] =>
    allowlist
      .list()
      .filter((r) => r.enabled && r.github !== null)
      .map((r) => ({
        slug: r.slug,
        repository: `${r.github!.owner}/${r.github!.repo}`,
        checkoutRoot: r.absolutePath,
      }));

  const skillBridge = new SkillBridgeService({
    store,
    authz,
    signer,
    frontDoor,
    transport,
    conversation,
    clock,
    config: {
      enabled: bridgeConfig.enabled,
      ...(bridgeConfig.grillSkillPath === undefined
        ? {}
        : { grillSkillPath: bridgeConfig.grillSkillPath }),
    },
    repositories: workflowRepositories,
    audit: ({ command, outcome, status }) => {
      try {
        store.auditLog.record({
          event: 'workflow.requested',
          actorKind: 'owner',
          actorRef: AUDIT_OWNER_REF,
          subjectKind: 'route',
          subjectRef: 'workflow',
          outcome: outcome === 'ok' ? 'ok' : outcome === 'refused' ? 'refused' : 'failed',
          // The COMMAND and the resulting status word, never the repository,
          // the issue body or anything the owner typed.
          detail: `${command} -> ${status}`,
        });
      } catch {
        /* a record is never worth failing a command */
      }
    },
  });
  const attachmentBudget = new HourlyBudget(env.SCHEDULE_ATTACHMENTS_PER_HOUR);
  const conversationAttachmentBudget = new HourlyBudget(env.CONVERSATION_ATTACHMENTS_PER_HOUR);
  const hosts = cdnHosts(env);

  /**
   * Conversation attachments are off unless the operator says otherwise, and
   * even then the router still requires the provider to be verified AND
   * attachment-capable. Every host in the allowlist is the SAME
   * `DISCORD_CDN_HOSTS` the schedule surface uses -- one list, one place to
   * get wrong.
   */
  const conversationAttachments: ConversationAttachmentConfig = {
    enabled: env.CONVERSATION_ATTACHMENTS_ENABLED,
    allowedHosts: hosts,
    maxBytes: env.CONVERSATION_MAX_ATTACHMENT_BYTES,
    ...(overrides.conversationFetch ? { fetchImpl: overrides.conversationFetch } : {}),
  };

  const phone: PhoneCaptureConfig | undefined =
    phoneSettings.enabled && phoneSettings.verifierRaw !== undefined
      ? {
          verifier: parsePhoneVerifier(phoneSettings.verifierRaw, 'DUCKY_PHONE_PASSCODE_VERIFIER'),
          sessionKey: phoneSessionKey(phoneSettings.verifierRaw),
          capture: taskCapture,
          authz,
          nowMs: () => clock.nowMs(),
        }
      : undefined;

  const scope = discordProfile.token ? commandScopeFor(discordProfile) : undefined;
  const status = (): ProviderStatus => ({
    profile: `${discordProfile.profile} (${paths.instanceLabel})`,
    discord:
      transport.kind === 'real'
        ? `real (${discordProfile.profile} bot, ${scope?.kind === 'guild' ? 'guild' : 'global'} commands)`
        : `mock (no ${discordProfile.profile} token)`,
    conversation: conversation.verified ? conversation.name : `${conversation.name} (unverified)`,
    conversationAttachments: attachmentAvailability(conversation, conversationAttachments),
    proactiveBriefings: briefingNotifier.enabled
      ? `on — ${env.DUCKY_BRIEFING_MORNING_AT} and ${env.DUCKY_BRIEFING_EVENING_AT} in ${clock.timeZone}, to your DM`
      : 'off — briefings are only sent when you ask with /briefing',
    conversationMemory: conversationMemory.enabled
      ? `on — the last ${env.DUCKY_CONVERSATION_MEMORY_TURNS} turns per thread, ` +
        `or the full transcript of a native thread while it lives; up to ` +
        `${env.DUCKY_CONVERSATION_CONTEXT_BUDGET_BYTES} bytes of context per turn; ` +
        '/forget conversation deletes them'
      : 'off — nothing you say in conversation is stored',
    conversationThreads: conversationThreads.describe(),
    orchestrator: overrides.herdrVerified ? 'herdr-pi (verified)' : 'herdr-pi (experimental)',
    scheduleExtraction: `${extractor.name} (binary: ${
      extractor.supportsBinary && env.SCHEDULE_BINARY_EXTRACTION_ENABLED ? 'enabled' : 'disabled'
    })`,
    ownerTimezone: clock.timeZone,
    dependencyChecker: dependencies.checkerVerified
      ? `${dependencies.checkerName} (verified)`
      : `${dependencies.checkerName} — dependency waits end at your desk, never auto-resumed`,
    phoneCapture: phoneSettings.reason,
    reminderDelivery: channelRoles.channelFor('reminder')
      ? 'task reminders post in your reminders channel with a mention; everything else is a DM'
      : 'every reminder is a DM',
    channelRoles: describeChannelRoles(channelRoles.configured),
    sharedChannels: sharedPolicy.enabled
      ? `${sharedPolicy.configuredChannelIds.length} shared channel(s): job status is visible there`
      : 'none (all job information is owner-only)',
    actions: actionPerformer.enabled
      ? 'enabled only after owner approval and /job execute'
      : 'recorded, not executed (disabled)',
    executors: String(store.executors.listExecutors().filter((e) => e.state === 'active').length),
    githubWatches: `${store.githubWatches.countActive(authz.ownerId)} active`,
    githubFeed: githubFeed.statusLine(),
    repositoryWorkflow: skillBridge.describe(),
  });

  const router = new DuckyRouter({
    authz,
    signer,
    captures,
    schedules,
    jobs,
    approvals,
    github,
    githubWatches,
    tasks,
    taskCapture,
    reminders,
    briefing,
    conversation,
    forget,
    memory: conversationMemory,
    threads: conversationThreads,
    intents,
    skillBridge,
    buckets,
    onProviderFailure: ({ provider, code }) => {
      try {
        store.auditLog.record({
          event: 'provider.failed',
          actorKind: 'system',
          actorRef: 'conversation',
          subjectKind: 'provider',
          subjectRef: provider,
          outcome: 'failed',
          detail: `reply refused or failed: ${code}`,
        });
      } catch {
        /* a record is never worth failing the reply path */
      }
    },
    status,
    sharedPolicy,
    channelRoles,
    replyPersistence,
    sharedJobs,
    readAttachment: async (a) => {
      attachmentBudget.check(authz.ownerId);
      const { text } = await fetchTextAttachment(a, {
        binaryExtractionEnabled:
          env.SCHEDULE_BINARY_EXTRACTION_ENABLED && extractor.supportsBinary,
        allowedHosts: hosts,
        maxBytes: env.SCHEDULE_MAX_ATTACHMENT_BYTES,
      });
      return text;
    },
    conversationAttachments,
    chargeConversationAttachment: (userId) => conversationAttachmentBudget.check(userId),
  });

  return {
    env, paths, discordProfile, store, authz, signer, allowlist, captures, schedules, jobs,
    sharedAdmission, engineeringHeldOff,
    approvals, github, githubWatches, githubFeed, reconciler, notifier, sharedPolicy, channelRoles, sharedJobs, router, transport, phone,
    credentials, conversation, status,
    clock, tasks, taskCapture, reminders, briefing, reminderNotifier, briefingNotifier,
    conversationAttachments, dependencies,
    retention, forget, conversationMemory, conversationThreads, intents, skillBridge,
    close: () => store.db.close(),
  };
}

function createStoreFromEnv(env: Env, paths: ResolvedPaths): Store {
  const db = openDatabase({ location: paths.dbPath });
  runMigrations(db);
  return createStore(db);
}

/**
 * The credential file is profile-scoped, so a development coordinator can never
 * load production executor credentials by inheriting a shared variable.
 */
function credentialStoreFor(
  env: Env,
  paths: ResolvedPaths,
  secrets: ProfileSecrets,
): ExecutorCredentialStore {
  // An explicitly configured, profile-scoped file always wins.
  if (secrets.credentialsFile) return new FileCredentialStore(secrets.credentialsFile);
  if (secrets.inlineCredentials) {
    return new MemoryCredentialStore(secrets.inlineCredentials, env.NODE_ENV);
  }
  // Otherwise the PROFILE'S OWN default path -- which resolvePaths already
  // computed per profile. Production reaches its own default here; what it
  // must never do is inherit a shared or development value, and
  // resolveProfileSecrets has already refused to hand it one.
  return new FileCredentialStore(paths.credentialsFile);
}

/**
 * The SELECTED profile's token chooses the gateway. Development without a
 * token runs on the mock; production without one never gets this far, because
 * profile resolution already failed closed.
 *
 * Nothing falls back to the mock when a token is present -- that would
 * silently drop real traffic -- and nothing reads the other profile's token.
 */
function transportForProfile(
  config: DiscordProfileConfig,
  persists?: (event: Incoming) => boolean,
  mayConverse?: (userId: string) => boolean,
): DiscordTransport {
  if (!config.token) return new MockDiscordTransport();
  return new DiscordJsTransport(
    config.token, channelAwareSink, undefined, persists, mayConverse,
  );
}

/**
 * Delivers a proactive message to either a user's DM or a channel.
 *
 * The message arrives here ALREADY sanitized -- `DiscordJsTransport.send`
 * calls `sanitizeOutbound` before any sink is consulted -- so both branches
 * are past the egress choke point and neither can reintroduce raw text.
 *
 * `ephemeral` is forced false on both: a proactive message has no interaction
 * token to be ephemeral against. For the channel branch that is also the
 * intent -- it is meant to be seen.
 *
 * The client is typed STRUCTURALLY rather than against discord.js, because
 * this module must not import it (asserted by a test).
 */
export function channelAwareSink(client: unknown): DiscordSink {
  const c = client as {
    users?: { fetch(id: string): Promise<{ send(payload: unknown): Promise<unknown> }> };
    channels?: { fetch(id: string): Promise<unknown> };
  };

  /**
   * Resolves whichever destination the target names, once.
   *
   * Shared by `deliver` and the card methods so the two cannot drift about
   * what a missing channel means -- which is the kind of divergence that turns
   * a retryable outage into a silently dropped message.
   */
  const resolve = async (
    target: SendTarget,
  ): Promise<{
    send: (p: unknown) => Promise<unknown>;
    messages?: { fetch(id: string): Promise<unknown> };
  }> => {
    if (target.kind === 'channel') {
      if (!c.channels) throw new DuckyError('not_found', 'The Discord client is not connected.');
      const channel = (await c.channels.fetch(target.channelId)) as
        | {
            isTextBased?: () => boolean;
            send?: (p: unknown) => Promise<unknown>;
            messages?: { fetch(id: string): Promise<unknown> };
          }
        | null;
      // A missing, non-text or unsendable channel fails LOUDLY rather than
      // silently dropping the update: the notifier then leaves that
      // transition pending and retries it on the next sweep.
      if (!channel || channel.isTextBased?.() === false || typeof channel.send !== 'function') {
        throw new DuckyError('not_found', 'That shared channel cannot receive messages.');
      }
      return {
        send: channel.send.bind(channel),
        ...(channel.messages ? { messages: channel.messages } : {}),
      };
    }

    if (!c.users) throw new DuckyError('not_found', 'The Discord client is not connected.');
    const user = (await c.users.fetch(target.userId)) as {
      send(payload: unknown): Promise<unknown>;
      dmChannel?: { messages?: { fetch(id: string): Promise<unknown> } } | null;
    };
    return {
      send: user.send.bind(user),
      ...(user.dmChannel?.messages ? { messages: user.dmChannel.messages } : {}),
    };
  };

  return {
    deliver: async (target, message) => {
      const { send } = await resolve(target);
      await send(toDiscordPayload({ ...message, ephemeral: false }));
    },

    /**
     * Sends and reports the id, when the client gives one back.
     *
     * A client that returns something without an `id` is not an error: the
     * caller treats `undefined` as "this card cannot be edited" and posts a
     * fresh one next time. Losing in-place editing is a worse experience;
     * guessing an id would be a wrong one.
     */
    deliverCard: async (target, message) => {
      const { send } = await resolve(target);
      const sent = (await send(toDiscordPayload({ ...message, ephemeral: false }))) as
        | { id?: unknown }
        | undefined;
      return typeof sent?.id === 'string' ? sent.id : undefined;
    },

    /**
     * Edits a message this instance sent.
     *
     * Returns false for a message that is gone, which is NORMAL -- the owner
     * may have deleted the card. It throws only for a destination that cannot
     * be reached at all, so a real outage is still retried rather than being
     * mistaken for a deleted message.
     */
    editCard: async (target, messageId, message) => {
      const { messages } = await resolve(target);
      if (!messages) return false;
      let existing: { edit?: (p: unknown) => Promise<unknown> } | null;
      try {
        existing = (await messages.fetch(messageId)) as { edit?: (p: unknown) => Promise<unknown> };
      } catch {
        return false;
      }
      if (!existing || typeof existing.edit !== 'function') return false;
      const payload = toDiscordPayload({ ...message, ephemeral: false });
      // An edit must not restate visibility; the original send fixed it.
      delete payload.flags;
      await existing.edit(payload);
      return true;
    },
  };
}

/**
 * Chooses the conversational backend from an EXPLICIT mode.
 *
 * This used to be `if (!OPENCLAW_BASE_URL) return mock`, with no profile check
 * at all -- so a production instance with the variable unset (the default; it
 * is not even in `.env.example`) silently answered the owner from a canned
 * mock. `resolveConversationMode` now refuses that at startup.
 *
 * Every branch fails at STARTUP rather than at first use, so a misconfigured
 * instance never reaches a person.
 */
function conversationFromEnv(env: Env, mode: ConversationProviderMode): ConversationProvider {
  if (mode === 'disabled') return new DisabledConversationProvider();
  if (mode === 'mock') return new MockConversationProvider();

  // openclaw: a URL is mandatory, and it must be private. Both are checked here
  // so the failure is at boot, not on the owner's first message.
  if (!env.OPENCLAW_BASE_URL) {
    throw new DuckyError(
      'invalid_input',
      'DUCKY_CONVERSATION_PROVIDER=openclaw requires OPENCLAW_BASE_URL (loopback or tailnet).',
    );
  }
  assertPrivateGatewayUrl(env.OPENCLAW_BASE_URL);

  return new GatewayOpenClawProvider(env.OPENCLAW_BASE_URL, {
    profile: env.OPENCLAW_PROFILE,
    timeoutMs: env.OPENCLAW_TIMEOUT_MS,
    ...(env.OPENCLAW_BIN === undefined ? {} : { bin: env.OPENCLAW_BIN }),
    // Instructions, not authorization. Never logged: nothing prints the
    // prompt, and this is part of it.
    ...(env.DUCKY_ASSISTANT_PERSONA === undefined
      ? {}
      : { persona: env.DUCKY_ASSISTANT_PERSONA }),
  });
}

/**
 * Whether the SELECTED mode can work on this profile at all.
 *
 * Runs with the other pure configuration checks, before any filesystem or
 * database work, because that is the cheapest place for a misconfigured
 * instance to fail -- and because a confusing unrelated error (a missing
 * credential file, say) would otherwise mask the real problem.
 *
 * Production selecting `openclaw` while no contract has been recorded used to
 * boot happily and then throw on the owner's first message: exactly the
 * "discover it in production" outcome the provider modes exist to prevent. A
 * private URL proves the address is not public; it proves nothing about whether
 * anything there speaks a contract we have recorded.
 *
 * A contract IS recorded now, so this gate passes and production may select
 * openclaw. What it still does not check is whether THIS host is signed in to
 * a model provider, and that omission is deliberate: checking would mean
 * running the CLI at boot, and a login that expired overnight would then stop
 * the coordinator from starting rather than making one reply fail. A signed-out
 * host produces a per-request refusal naming the remedy -- which is a different
 * thing from the failure this gate exists for, because it refuses rather than
 * fabricating an answer.
 *
 * Non-networked on purpose. Reachability at boot would not prove the API
 * either, and a gateway that is merely down should not stop a correctly
 * configured instance from starting.
 */
function assertModeUsable(mode: ConversationProviderMode, profile: DuckyProfile): void {
  if (mode !== 'openclaw' || profile !== 'production') return;

  const init = GatewayOpenClawProvider.initializable();
  if (!init.ok) {
    throw new DuckyError(
      'integration_not_verified',
      'DUCKY_CONVERSATION_PROVIDER=openclaw cannot be used on the production profile: ' +
        `${init.reason} Until then use DUCKY_CONVERSATION_PROVIDER=disabled, which ` +
        'refuses conversation clearly instead of faking it.',
    );
  }
}

export { HerdrCli };
